// Storage layout: one JSON array of `{ productId, basic, addedAt }` under `storageKey`.
// Init rehydrates from it instantly, then background-refreshes the full products.
import { request } from './client';
import { normalizeProduct } from './products';
import { nodesAsProductsQuery } from './queries';
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

interface WishlistState {
  ready: boolean;
  items: WishlistItem[];
  index: Map<string, number>;    // productId → items[] index
  storage: WishlistStorageAdapter | null;
  storageKey: string;
  batchSize: number;
  listeners: Set<WishlistChangeListener>;
}

const state: WishlistState = {
  ready: false,
  items: [],
  index: new Map(),
  storage: null,
  storageKey: DEFAULT_STORAGE_KEY,
  batchSize: DEFAULT_BATCH_SIZE,
  listeners: new Set(),
};

function defaultStorage(): WishlistStorageAdapter | null {
  if (typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage !== 'undefined') {
    return (globalThis as any).localStorage as WishlistStorageAdapter;
  }
  return null;
}

async function loadFromStorage(): Promise<WishlistItem[]> {
  if (!state.storage) return [];
  try {
    const raw = await Promise.resolve(state.storage.getItem(state.storageKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidItemShape);
  } catch {
    return [];
  }
}

async function saveToStorage(): Promise<void> {
  if (!state.storage) return;
  const serialized = JSON.stringify(state.items.map(stripHydrated));
  try {
    await Promise.resolve(state.storage.setItem(state.storageKey, serialized));
  } catch {
    // Storage full or unavailable — in-memory state stays correct regardless.
  }
}

/** Drops the hydrated `product` before persisting — it is large and refreshable. */
function stripHydrated(item: WishlistItem): Omit<WishlistItem, 'product'> {
  return { productId: item.productId, basic: item.basic, addedAt: item.addedAt };
}

function isValidItemShape(v: any): v is WishlistItem {
  return (
    v && typeof v === 'object' &&
    typeof v.productId === 'string' &&
    typeof v.addedAt === 'number' &&
    v.basic && typeof v.basic === 'object'
  );
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
    const data = await request<NodesResponse>(nodesAsProductsQuery(), { ids: chunk });
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
  return out;
}

async function init(opts?: WishlistInitOptions): Promise<WishlistItem[]> {
  state.storage    = opts?.storage    ?? defaultStorage();
  state.storageKey = opts?.storageKey ?? DEFAULT_STORAGE_KEY;
  state.batchSize  = Math.max(1, Math.min(250, opts?.batchSize ?? DEFAULT_BATCH_SIZE));
  state.items      = await loadFromStorage();
  rebuildIndex();
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
  if (state.storage) {
    try { await Promise.resolve(state.storage.removeItem(state.storageKey)); } catch { /* ignore */ }
  }
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
