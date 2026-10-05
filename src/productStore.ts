/**
 * The product store: what every product read has seen, kept so a product page can open with data on
 * its first frame, and a list can show its last first page before the network answers.
 *
 * - **Base** keys (`PRODUCT_BASE_KEYS`) are recorded from EVERY read that returns products:
 *   collections, search, recommendations, lists, `byIds`, the wishlist. They are what a product page
 *   shows instantly: title, image, price, the variant picker (options, variants), stock state and the
 *   description. Every one of those reads fetches them anyway; only the gallery's media waits for
 *   the product's own read.
 * - **Full** products are recorded by `byHandle` / `byId`, for returning to a product page.
 * - **Lists**: the first page of each collection or search, for `useCollectionProducts` /
 *   `useSearch` to show before revalidating.
 *
 * Memory is the working copy (capped, least recently used first out). The device store behind it
 * (`deviceStore`: MMKV on native, `localStorage` on web) keeps it across cold starts, one small key
 * per product, so nothing is loaded in bulk at launch: a key is read the moment something asks.
 *
 * Keys carry a schema version and a scope (store, market, API version, metafields), so a store,
 * market or SDK change never shows mismatched data. Entries older than `MAX_AGE_MS` are dropped.
 * Public catalogue data only: nothing personal is ever written here.
 */
import { getConfig, isConfigured } from './client';
import { deviceStore } from './deviceStore';
import { hashKey } from './deviceStoreCore';
import type { Filter, PageInfo, Product } from './types';

/** What any product read records, and what a product page can render before its own read lands. */
export const PRODUCT_BASE_KEYS = [
  'id',
  'handle',
  'title',
  'featuredImage',
  'priceRange',
  'compareAtPriceRange',
  'description',
  'descriptionHtml',
  'options',
  'variants',
  'availableForSale',
  'totalInventory',
  'tags',
  'vendor',
  'productType',
] as const;
export type ProductBase = Pick<Product, (typeof PRODUCT_BASE_KEYS)[number]>;

export interface CachedProduct {
  id: string;
  handle: string;
  base: ProductBase;
  baseAt: number;
  /** The full product, once `byHandle` / `byId` has read it. */
  full: Product | null;
  fullAt: number;
}

export interface CachedList {
  products: Product[];
  pageInfo: PageInfo;
  title: string | null;
  filters: Filter[];
  totalCount?: number;
  at: number;
}

/**
 * v3: every variant carries `sellingPlan` (its pre-order plan, or null), so a stored variant without
 * one is never read as "no plan". v2: base entries carry options, variants, stock and the description
 * (v1 had six keys).
 */
const VERSION = 'v3';
/** Earlier schema versions, cleared from the device once per session. */
const OLD_VERSIONS = ['v1', 'v2'];
const DAY = 24 * 60 * 60 * 1000;
/** Older than this, an entry is dropped rather than shown. */
export const MAX_AGE_MS = 7 * DAY;
const MEMORY_PRODUCTS = 300;
const MEMORY_LISTS = 30;
/**
 * Device caps. A base entry is 3-10 KB with its variants and description (most of it the variants),
 * so 2,500 is roughly 10-25 MB: a whole mid-size catalogue, read one key at a time.
 */
const DEVICE_BASES = 2500;
const DEVICE_FULLS = 30;
const DEVICE_LISTS = 20;

// ---------------------------------------------------------------------------
// Scope and keys
// ---------------------------------------------------------------------------

/** Store, market, API version and metafields: anything that changes what a product read returns. */
function scope(): string {
  const c = getConfig();
  return hashKey(
    [
      c.storeDomain,
      (c.country || '').toUpperCase(),
      (c.language || '').toUpperCase(),
      c.apiVersion || '',
      JSON.stringify(c.productMetafields ?? []),
    ].join('|'),
  );
}

const key = {
  base: (s: string, id: string) => `${VERSION}:${s}:b:${id}`,
  handle: (s: string, handle: string) => `${VERSION}:${s}:h:${handle}`,
  full: (s: string, id: string) => `${VERSION}:${s}:f:${id}`,
  fullIndex: (s: string) => `${VERSION}:${s}:fi`,
  list: (s: string, listKey: string) => `${VERSION}:${s}:l:${hashKey(listKey)}`,
  listIndex: (s: string) => `${VERSION}:${s}:li`,
};

function parse<T>(text: string | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const fresh = (at: number, now: number) => Number.isFinite(at) && now - at < MAX_AGE_MS;

/** Off when not configured yet, or when the app turned reuse off with `cache: false`. */
function enabled(): boolean {
  return isConfigured() && getConfig().cache !== false;
}

// ---------------------------------------------------------------------------
// Memory (least recently used first out: Map order is insertion order, a hit re-inserts)
// ---------------------------------------------------------------------------

const products = new Map<string, CachedProduct>();
const handles = new Map<string, string>();
const lists = new Map<string, CachedList>();

function touch<V>(map: Map<string, V>, k: string, v: V, cap: number): void {
  map.delete(k);
  map.set(k, v);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Memory entries whose full product has already been looked for on the device. A list read after a
 * cold start makes a memory entry with the base keys only, while the full product from an earlier
 * session is still on the device; `peekProduct` checks there once, then trusts memory.
 */
const deviceFullChecked = new Set<string>();

/** Tests only: forget memory but keep the device store, which is what a cold start looks like. */
export function resetProductStoreMemory(): void {
  products.clear();
  handles.clear();
  lists.clear();
  deviceFullChecked.clear();
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function toProductBase(p: Product): ProductBase {
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    featuredImage: p.featuredImage ?? null,
    priceRange: p.priceRange,
    compareAtPriceRange: p.compareAtPriceRange ?? null,
    description: p.description ?? '',
    descriptionHtml: p.descriptionHtml ?? '',
    options: p.options ?? [],
    variants: p.variants ?? [],
    availableForSale: p.availableForSale,
    totalInventory: p.totalInventory ?? null,
    tags: p.tags ?? [],
    vendor: p.vendor ?? '',
    productType: p.productType ?? '',
  };
}

/** Move `id` to the end of a capped index, returning the ids it pushed out. */
function bumpIndex(indexKey: string, id: string, cap: number): string[] {
  const store = deviceStore();
  const ids = (parse<string[]>(store.get(indexKey)) ?? []).filter((x) => x !== id);
  ids.push(id);
  const evicted = ids.length > cap ? ids.splice(0, ids.length - cap) : [];
  store.set(indexKey, JSON.stringify(ids));
  return evicted;
}

let pruneScheduled = false;
/** Trim the base entries past the device cap, once per session and off the hot path. */
function schedulePrune(s: string): void {
  if (pruneScheduled) return;
  pruneScheduled = true;
  setTimeout(() => {
    try {
      const store = deviceStore();
      // Entries from an earlier schema can never be read again: drop them.
      for (const k of store.keys()) if (OLD_VERSIONS.some((v) => k.startsWith(`${v}:`))) store.remove(k);
      const prefix = `${VERSION}:${s}:b:`;
      const baseKeys = store.keys().filter((k) => k.startsWith(prefix));
      if (baseKeys.length <= DEVICE_BASES) return;
      const aged = baseKeys
        .map((k) => ({ k, e: parse<{ b: ProductBase; t: number }>(store.get(k)) }))
        .sort((a, b) => (a.e?.t ?? 0) - (b.e?.t ?? 0));
      for (const { k, e } of aged.slice(0, baseKeys.length - DEVICE_BASES)) {
        store.remove(k);
        if (e?.b?.handle) store.remove(key.handle(s, e.b.handle));
      }
    } catch {
      /* pruning is best effort */
    }
  }, 3000);
}

/**
 * Record products a read returned. `level: 'full'` is for `byHandle` / `byId`: the whole product,
 * kept for a return visit. Every read records the base keys.
 */
export function rememberProducts(list: Array<Product | null | undefined>, level: 'base' | 'full'): void {
  if (!enabled() || !list.length) return;
  const s = scope();
  const store = deviceStore();
  const now = Date.now();
  for (const p of list) {
    if (!p || !p.id || !p.handle) continue;
    const mk = `${s}|${p.id}`;
    const prev = products.get(mk);
    const base = toProductBase(p);
    const entry: CachedProduct = {
      id: p.id,
      handle: p.handle,
      base,
      baseAt: now,
      full: level === 'full' ? p : prev?.full ?? null,
      fullAt: level === 'full' ? now : prev?.fullAt ?? 0,
    };
    touch(products, mk, entry, MEMORY_PRODUCTS);
    handles.set(`${s}|${p.handle}`, p.id);
    try {
      store.set(key.base(s, p.id), JSON.stringify({ b: base, t: now }));
      if (prev?.handle !== p.handle) store.set(key.handle(s, p.handle), p.id);
      if (level === 'full') {
        store.set(key.full(s, p.id), JSON.stringify({ p, t: now }));
        for (const gone of bumpIndex(key.fullIndex(s), p.id, DEVICE_FULLS)) store.remove(key.full(s, gone));
      }
    } catch {
      /* the device copy is best effort; memory still has it */
    }
  }
  schedulePrune(s);
}

/**
 * What is known about a product, by handle or GID: memory first, then the device. Synchronous, so a
 * product page can call it during its first render. Null when nothing is known, or it is too old.
 */
export function peekProduct(handleOrId: string | null | undefined): CachedProduct | null {
  if (!handleOrId || !enabled()) return null;
  const s = scope();
  const store = deviceStore();
  const now = Date.now();
  const byGid = handleOrId.startsWith('gid://');
  const id = byGid ? handleOrId : handles.get(`${s}|${handleOrId}`) ?? store.get(key.handle(s, handleOrId));
  if (!id) return null;

  const mk = `${s}|${id}`;
  const hit = products.get(mk);
  if (hit && fresh(hit.baseAt, now)) {
    // Base keys in memory (a grid read since launch) don't mean the device has no full product.
    if (!hit.full && !deviceFullChecked.has(mk)) {
      deviceFullChecked.add(mk);
      const full = parse<{ p: Product; t: number }>(store.get(key.full(s, id)));
      if (full && fresh(full.t, now)) {
        hit.full = full.p;
        hit.fullAt = full.t;
      }
    }
    touch(products, mk, hit, MEMORY_PRODUCTS);
    return hit;
  }

  const base = parse<{ b: ProductBase; t: number }>(store.get(key.base(s, id)));
  if (!base || !fresh(base.t, now)) {
    if (base) store.remove(key.base(s, id));
    if (!byGid) store.remove(key.handle(s, handleOrId));
    return null;
  }
  const full = parse<{ p: Product; t: number }>(store.get(key.full(s, id)));
  const entry: CachedProduct = {
    id,
    handle: base.b.handle,
    base: base.b,
    baseAt: base.t,
    full: full && fresh(full.t, now) ? full.p : null,
    fullAt: full && fresh(full.t, now) ? full.t : 0,
  };
  touch(products, mk, entry, MEMORY_PRODUCTS);
  handles.set(`${s}|${entry.handle}`, id);
  return entry;
}

/** Drop one product, e.g. after the cart reports it out of stock. */
export function forgetProduct(id: string): void {
  if (!enabled()) return;
  const s = scope();
  const entry = products.get(`${s}|${id}`);
  products.delete(`${s}|${id}`);
  deviceFullChecked.delete(`${s}|${id}`);
  const store = deviceStore();
  store.remove(key.base(s, id));
  store.remove(key.full(s, id));
  if (entry) {
    handles.delete(`${s}|${entry.handle}`);
    store.remove(key.handle(s, entry.handle));
  }
}

// ---------------------------------------------------------------------------
// Lists (first pages)
// ---------------------------------------------------------------------------

/** A list's products without the long descriptions no card shows: a fraction of the size. */
function forCard(p: Product): Product {
  return { ...p, description: '', descriptionHtml: '' };
}

export function peekList(listKey: string): CachedList | null {
  if (!enabled()) return null;
  const s = scope();
  const mk = `${s}|${listKey}`;
  const now = Date.now();
  const hit = lists.get(mk);
  if (hit && fresh(hit.at, now)) {
    touch(lists, mk, hit, MEMORY_LISTS);
    return hit;
  }
  const stored = parse<CachedList & { k: string }>(deviceStore().get(key.list(s, listKey)));
  // `k` guards against two list keys sharing a hash.
  if (!stored || stored.k !== listKey || !fresh(stored.at, now)) return null;
  const { k: _k, ...list } = stored;
  touch(lists, mk, list, MEMORY_LISTS);
  return list;
}

export function rememberList(listKey: string, list: Omit<CachedList, 'at'>): void {
  if (!enabled()) return;
  const s = scope();
  const entry: CachedList = { ...list, products: list.products.map(forCard), at: Date.now() };
  touch(lists, `${s}|${listKey}`, entry, MEMORY_LISTS);
  try {
    const store = deviceStore();
    const dk = key.list(s, listKey);
    store.set(dk, JSON.stringify({ ...entry, k: listKey }));
    for (const gone of bumpIndex(key.listIndex(s), dk, DEVICE_LISTS)) store.remove(gone);
  } catch {
    /* best effort */
  }
}

/** Forget everything this SDK stored, in memory and on the device, for every store and market. */
export function clearProductStore(): void {
  resetProductStoreMemory();
  const store = deviceStore();
  for (const k of store.keys()) if (k.startsWith(`${VERSION}:`)) store.remove(k);
}
