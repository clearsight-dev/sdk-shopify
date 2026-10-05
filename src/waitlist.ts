// The waitlist: sizes or colours a shopper is waiting on, newest first, kept on the device by
// `storedList` (the storage rules, shared with the wishlist). Each entry is a superset of every shape
// an app's waitlist key has held:
//   - `id` (the numeric variant id) and `handle` (the product's): Apptile's engine, whose key an app
//     migrating from it keeps using;
//   - `variantId`, `productId`, `addedAt`: the shape an app's own waitlist used (`addedAt` read as an
//     ISO date or ms, written as ms);
//   - `variant`: the variant as last fetched, with its product's card fields and pre-order plan, so
//     the list draws offline (`null`: the store no longer has it).
// Init reads it, merges any `migrateFrom` keys once, shows it at once, then refreshes the variants in
// the background. A refresh that fails keeps what was stored.
//
// This tracks interest on the device. A back-in-stock notification is the app's to request (an
// analytics event the platform's push automation selects on), since it needs the signed-in customer.
import { getConfig } from './client';
import { createStoredList } from './storedList';
import { variants } from './variants';
import type {
  ShopifyWaitlistAPI,
  StandaloneVariant,
  WaitlistChangeListener,
  WaitlistEntryInput,
  WaitlistInitOptions,
  WaitlistItem,
  WishlistStorageAdapter,
} from './types';

const DEFAULT_STORAGE_KEY = 'tile:shopify:waitlist:v1';
const DEFAULT_BATCH_SIZE = 100;
const VARIANT_GID = 'gid://shopify/ProductVariant/';
const PRODUCT_GID = 'gid://shopify/Product/';

interface WaitlistState {
  ready: boolean;
  items: WaitlistItem[];
  index: Map<string, number>;    // variantId → items[] index
  batchSize: number;
  listeners: Set<WaitlistChangeListener>;
}

const state: WaitlistState = {
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

/** Apptile's engine kept numeric ids; everything else here is the GID. */
const toGid = (prefix: string, id: string) => (/^\d+$/.test(id) ? `${prefix}${id}` : id);
const numericId = (gid: string) => gid.split('/').pop() ?? gid;

function isStoredVariant(v: unknown, variantId: string): v is StandaloneVariant {
  const x = v as Partial<StandaloneVariant> | null;
  return !!x && typeof x === 'object' && x.id === variantId && !!x.price && !!x.product && typeof x.product.handle === 'string';
}

function readDate(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

const stored = createStoredList<WaitlistItem>({
  idOf: (item) => item.variantId,
  addedAt: (item) => item.addedAt,
  read(v) {
    if (!v || typeof v !== 'object') return null;
    const e = v as Record<string, unknown>;
    const rawId =
      typeof e.variantId === 'string' ? e.variantId : typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id) : '';
    if (!rawId) return null;
    const variantId = toGid(VARIANT_GID, rawId);
    const productHandle =
      typeof e.productHandle === 'string' ? e.productHandle : typeof e.handle === 'string' ? e.handle : undefined;
    const item: WaitlistItem = {
      variantId,
      ...(typeof e.productId === 'string' ? { productId: toGid(PRODUCT_GID, e.productId) } : {}),
      ...(productHandle ? { productHandle } : {}),
      addedAt: readDate(e.addedAt),
    };
    if (e.variant === null) item.variant = null;
    else if (isStoredVariant(e.variant, variantId)) item.variant = e.variant;
    return item;
  },
  write(item, details) {
    const handle = item.productHandle ?? item.variant?.product.handle;
    const entry: Record<string, unknown> = {
      variantId: item.variantId,
      id: numericId(item.variantId),
      ...(handle ? { handle, productHandle: handle } : {}),
      ...(item.productId ? { productId: item.productId } : {}),
      addedAt: item.addedAt,
    };
    if (item.variant === null) entry.variant = null;
    else if (details !== undefined) entry.variant = details;
    return entry;
  },
  detailsOf: (item) => item.variant ?? undefined,
});

function rebuildIndex(): void {
  state.index.clear();
  state.items.forEach((it, i) => state.index.set(it.variantId, i));
}

function notify(): void {
  const snapshot = state.items.slice();
  state.listeners.forEach((fn) => {
    try { fn(snapshot); } catch { /* listener errors don't break others */ }
  });
}

async function init(opts?: WaitlistInitOptions): Promise<WaitlistItem[]> {
  stored.open(opts?.storage ?? defaultStorage(), opts?.storageKey ?? DEFAULT_STORAGE_KEY);
  state.batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? DEFAULT_BATCH_SIZE));
  state.items     = await stored.mergeOnce(await stored.load(), opts?.migrateFrom ?? []);
  rebuildIndex();
  state.ready = true;

  if (opts?.hydrateOnInit !== false && state.items.length > 0) {
    // Fire-and-forget: stored items already render; offline this fails and keeps them.
    void refresh().catch(() => {});
  }
  notify();
  return state.items.slice();
}

function isReady(): boolean {
  return state.ready;
}

async function add(entry: WaitlistEntryInput): Promise<WaitlistItem> {
  const existing = state.index.get(entry.variantId);
  const prev = existing != null ? state.items[existing] : undefined;
  const variant = entry.variant ?? prev?.variant;
  const productId = entry.productId ?? entry.variant?.product.id ?? prev?.productId;
  const productHandle = entry.productHandle ?? entry.variant?.product.handle ?? prev?.productHandle;
  const item: WaitlistItem = {
    variantId: entry.variantId,
    ...(productId ? { productId } : {}),
    ...(productHandle ? { productHandle } : {}),
    addedAt: Date.now(),
    ...(variant !== undefined ? { variant } : {}),
  };
  // Joining again moves it to the front rather than listing it twice.
  state.items = [item, ...state.items.filter((it) => it.variantId !== entry.variantId)];
  rebuildIndex();
  await stored.save(state.items);
  notify();
  return item;
}

async function remove(variantId: string): Promise<boolean> {
  const idx = state.index.get(variantId);
  if (idx == null) return false;
  state.items.splice(idx, 1);
  rebuildIndex();
  await stored.save(state.items);
  notify();
  return true;
}

function has(variantId: string): boolean {
  return state.index.has(variantId);
}

function list(): WaitlistItem[] {
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

async function refresh(): Promise<WaitlistItem[]> {
  if (state.items.length === 0) {
    notify();
    return [];
  }
  const ids = state.items.map((it) => it.variantId);
  const asked = new Set(ids);
  const found = await variants.byIds(ids, { batchSize: state.batchSize, imageTransform: getConfig().imageTransforms?.waitlist });
  const byId = new Map(found.map((v) => [v.id, v]));
  // Applied to the list as it is now, which may have changed while the request was out.
  state.items = state.items.map((item) => {
    if (!asked.has(item.variantId)) return item;
    const variant = byId.get(item.variantId);
    if (!variant) return { ...item, variant: null };
    return { ...item, variant, productId: variant.product.id, productHandle: variant.product.handle };
  });
  rebuildIndex();
  await stored.save(state.items);
  notify();
  return state.items.slice();
}

function onChange(listener: WaitlistChangeListener): () => void {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

export const waitlist: ShopifyWaitlistAPI = {
  init,
  isReady,
  add,
  remove,
  has,
  list,
  count,
  clear,
  refresh,
  onChange,
};

export default waitlist;
