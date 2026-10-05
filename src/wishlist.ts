// The wishlist: products a shopper saved, newest first, kept on the device by `storedList` (the
// storage rules, shared with the waitlist). Each entry is a superset of every shape the key has held,
// so whatever reads it finds what it expects:
//   - `productId`, `basic`, `addedAt`: sdk-shopify up to 0.8, which an older bundle (an OTA rollback)
//     still reads;
//   - `id` (the numeric product id) and `handle`: Apptile's engine, whose key an app migrating from it
//     keeps using;
//   - `product`: the product as last fetched, trimmed, so the list draws offline (`null`: gone).
// Init reads it, merges any `migrateFrom` keys once, shows it at once, then refreshes the products in
// the background. A refresh that fails keeps what was stored.
import { request, getConfig } from './client';
import { normalizeProduct } from './products';
import { peekProduct, rememberProducts } from './productStore';
import { nodesAsProductsQuery } from './queries';
import { createStoredList } from './storedList';
import type {
  Product,
  ShopifyWishlistAPI,
  WishlistChangeListener,
  WishlistInitOptions,
  WishlistItem,
  WishlistRefreshOptions,
  WishlistStorageAdapter,
} from './types';

const DEFAULT_STORAGE_KEY = 'tile:shopify:wishlist:v1';
const DEFAULT_BATCH_SIZE = 100;
const PRODUCT_GID = 'gid://shopify/Product/';

interface WishlistState {
  ready: boolean;
  items: WishlistItem[];
  index: Map<string, number>;    // productId → items[] index
  batchSize: number;
  listeners: Set<WishlistChangeListener>;
}

const state: WishlistState = {
  ready: false,
  items: [],
  index: new Map(),
  batchSize: DEFAULT_BATCH_SIZE,
  listeners: new Set(),
};

function defaultStorage(): WishlistStorageAdapter | null {
  if (typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage !== 'undefined') {
    return (globalThis as any).localStorage as WishlistStorageAdapter;
  }
  return null;
}

/** Apptile's engine kept the numeric id; everything else here is the GID. */
function toProductGid(id: string): string {
  return /^\d+$/.test(id) ? `${PRODUCT_GID}${id}` : id;
}

function numericId(gid: string): string {
  return gid.startsWith(PRODUCT_GID) ? gid.slice(PRODUCT_GID.length) : gid;
}

function isStoredProduct(v: unknown, productId: string): v is Product {
  const p = v as Partial<Product> | null;
  return !!p && typeof p === 'object' && p.id === productId && typeof p.handle === 'string' && !!p.priceRange;
}

/**
 * What is kept of a product: everything a card and a product page's instant view use, without the
 * gallery (images past the first, media), which a product page fetches anyway. `hasVideo` stays.
 */
function trimProduct(p: Product): Product {
  return { ...p, images: p.images.slice(0, 1), media: [], mediaContentTypes: [] };
}

const stored = createStoredList<WishlistItem>({
  idOf: (item) => item.productId,
  addedAt: (item) => item.addedAt,
  read(v) {
    if (!v || typeof v !== 'object') return null;
    const e = v as Record<string, unknown>;
    const rawId =
      typeof e.productId === 'string' ? e.productId : typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id) : '';
    if (!rawId) return null;
    const productId = toProductGid(rawId);
    const basic: WishlistItem['basic'] = e.basic && typeof e.basic === 'object' ? { ...(e.basic as WishlistItem['basic']) } : {};
    if (!basic.handle && typeof e.handle === 'string') basic.handle = e.handle;
    const product = e.product === null ? null : isStoredProduct(e.product, productId) ? e.product : undefined;
    return { productId, basic, addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0, product };
  },
  write(item, details) {
    const entry: Record<string, unknown> = {
      productId: item.productId,
      id: numericId(item.productId),
      handle: item.basic.handle ?? item.product?.handle,
      basic: item.basic,
      addedAt: item.addedAt,
    };
    if (item.product === null) entry.product = null;
    else if (details !== undefined) entry.product = details;
    return entry;
  },
  detailsOf: (item) => (item.product ? trimProduct(item.product) : undefined),
});

async function saveToStorage(): Promise<boolean> {
  return stored.save(state.items);
}

function rebuildIndex(): void {
  state.index.clear();
  state.items.forEach((it, i) => state.index.set(it.productId, i));
}

function notify(): void {
  const snapshot = state.items.slice();
  state.listeners.forEach((fn) => {
    try { fn(snapshot); } catch { /* listener errors don't break others */ }
  });
}

function basicFromProduct(p: Product): WishlistItem['basic'] {
  return {
    handle: p.handle,
    title: p.title,
    image: p.featuredImage?.url ?? p.images?.[0]?.url,
    price: p.priceRange?.min,
  };
}

interface NodesResponse {
  nodes: Array<{ __typename?: string } | null>;
}

/** Position-preserving: same length as `ids`, `null` where a product no longer resolves. */
async function fetchProductsByIds(ids: string[]): Promise<Array<Product | null>> {
  if (ids.length === 0) return [];
  const out: Array<Product | null> = [];
  for (let i = 0; i < ids.length; i += state.batchSize) {
    const chunk = ids.slice(i, i + state.batchSize);
    const data = await request<NodesResponse>(nodesAsProductsQuery(), { ids: chunk }, { imageTransform: getConfig().imageTransforms?.wishlist });
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    for (let j = 0; j < chunk.length; j++) {
      const node = nodes[j];
      if (node && (node as any).__typename === 'Product') {
        out.push(normalizeProduct(node));
      } else {
        out.push(null);
      }
    }
  }
  rememberProducts(out, 'base');
  return out;
}

async function init(opts?: WishlistInitOptions): Promise<WishlistItem[]> {
  stored.open(opts?.storage ?? defaultStorage(), opts?.storageKey ?? DEFAULT_STORAGE_KEY);
  state.batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? DEFAULT_BATCH_SIZE));
  state.items     = await stored.mergeOnce(await stored.load(), opts?.migrateFrom ?? []);
  rebuildIndex();
  // A saved product opened offline still gets its product page's instant view: what was stored seeds
  // the product store wherever it has nothing newer.
  rememberProducts(
    state.items.map((item) => item.product).filter((p): p is Product => !!p && !peekProduct(p.id)),
    'base',
  );
  state.ready = true;

  if (opts?.hydrateOnInit !== false && state.items.length > 0) {
    // Fire-and-forget: cached items already render, and a caller that needs the
    // hydrated products can await `refresh()` itself.
    void refresh({ keepDeleted: opts?.keepDeleted }).catch(() => {});
  }
  notify();
  return state.items.slice();
}

function isReady(): boolean {
  return state.ready;
}

async function add(a: Product | string, b?: WishlistItem['basic']): Promise<WishlistItem> {
  const productId = typeof a === 'string' ? a : a.id;
  const basic = typeof a === 'string' ? (b ?? {}) : basicFromProduct(a);
  const existingIdx = state.index.get(productId);
  if (existingIdx != null) {
    // Refresh the snapshot but preserve `addedAt`.
    const existing = state.items[existingIdx];
    const merged: WishlistItem = { ...existing, basic: { ...existing.basic, ...basic } };
    if (typeof a !== 'string') merged.product = a;
    state.items[existingIdx] = merged;
    await saveToStorage();
    notify();
    return merged;
  }
  const item: WishlistItem = {
    productId,
    basic,
    addedAt: Date.now(),
    product: typeof a === 'string' ? undefined : a,
  };
  state.items.unshift(item);
  rebuildIndex();
  await saveToStorage();
  notify();
  return item;
}

async function remove(productId: string): Promise<boolean> {
  const idx = state.index.get(productId);
  if (idx == null) return false;
  state.items.splice(idx, 1);
  rebuildIndex();
  await saveToStorage();
  notify();
  return true;
}

async function toggle(a: Product | string, b?: WishlistItem['basic']): Promise<boolean> {
  const productId = typeof a === 'string' ? a : a.id;
  if (state.index.has(productId)) {
    await remove(productId);
    return false;
  }
  await add(a as any, b);
  return true;
}

function has(productId: string): boolean {
  return state.index.has(productId);
}

function list(): WishlistItem[] {
  return state.items.slice();
}

function count(): number {
  return state.items.length;
}

async function clear(): Promise<void> {
  state.items = [];
  state.index.clear();
  await stored.clear();
  notify();
}

async function refresh(opts?: WishlistRefreshOptions): Promise<WishlistItem[]> {
  if (state.items.length === 0) {
    notify();
    return [];
  }
  const ids = state.items.map((it) => it.productId);
  const hydrated = await fetchProductsByIds(ids);

  const nextItems: WishlistItem[] = [];
  const keepDeleted = opts?.keepDeleted === true;
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const product = hydrated[i];
    if (product == null && !keepDeleted) continue;
    const nextBasic = product ? { ...item.basic, ...basicFromProduct(product) } : item.basic;
    nextItems.push({ ...item, basic: nextBasic, product });
  }
  state.items = nextItems;
  rebuildIndex();
  await saveToStorage();
  notify();
  return state.items.slice();
}

function onChange(listener: WishlistChangeListener): () => void {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

export const wishlist: ShopifyWishlistAPI = {
  init,
  isReady,
  add: add as ShopifyWishlistAPI['add'],
  remove,
  toggle: toggle as ShopifyWishlistAPI['toggle'],
  has,
  list,
  count,
  clear,
  refresh,
  onChange,
};

export default wishlist;
