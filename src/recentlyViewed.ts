// Recently viewed (0.17.0): the products a shopper opened, newest first, kept on the device by
// `storedList` (the storage rules the wishlist and the waitlist share). Each entry is the product's id,
// its handle and when it was last opened; never the product itself, which `useRecentlyViewed` reads
// fresh. Opening a product again moves it to the front, and past `limit` the oldest goes.
//
// Nothing here records a view by itself: the product page's screen calls `record` when a product
// opens. A fresh key: no earlier app kept this list, so there is nothing to migrate.
import { createStoredList } from './storedList';
import type {
  RecentlyViewedChangeListener,
  RecentlyViewedEntry,
  RecentlyViewedOptions,
  ShopifyRecentlyViewedAPI,
  WishlistStorageAdapter,
} from './types';

export const RECENTLY_VIEWED_STORAGE_KEY = 'tile:shopify:recentlyViewed:v1';
/** Products kept unless `limit` says otherwise, and the most it can say. */
export const RECENTLY_VIEWED_LIMIT = 20;
export const RECENTLY_VIEWED_MAX_LIMIT = 50;

const PRODUCT_GID = 'gid://shopify/Product/';

/** One change to the list: the list before in, the list after out. */
type Change = (entries: RecentlyViewedEntry[]) => RecentlyViewedEntry[];

/** Newest first; replaced, never changed in place, so `list()` is the same array until it changes. */
let entries: RecentlyViewedEntry[] = [];
let limit = RECENTLY_VIEWED_LIMIT;
/** The stored list has been read. */
let ready = false;
/** A read of the stored list is on its way. */
let reading = false;
/** Counts `init` calls, so only the newest read's answer is used. */
let reads = 0;
/** Changes made while the stored list was being read: made again on it once it is read. */
let madeWhileReading: Change[] = [];
/** The storage and key the list belongs to, once `init` named them. */
let keptIn: { storage: WishlistStorageAdapter | null; key: string } | null = null;
const listeners = new Set<RecentlyViewedChangeListener>();

function defaultStorage(): WishlistStorageAdapter | null {
  if (typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage !== 'undefined') {
    return (globalThis as any).localStorage as WishlistStorageAdapter;
  }
  return null;
}

/** A product's GID from a GID or a numeric id; null for anything else, which a `nodes` read would refuse. */
function productIdFrom(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return `${PRODUCT_GID}${value}`;
  if (typeof value !== 'string') return null;
  if (/^\d+$/.test(value)) return `${PRODUCT_GID}${value}`;
  return value.startsWith(PRODUCT_GID) && value.length > PRODUCT_GID.length ? value : null;
}

function limitFrom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return RECENTLY_VIEWED_LIMIT;
  return Math.min(RECENTLY_VIEWED_MAX_LIMIT, Math.max(1, Math.round(value)));
}

const stored = createStoredList<RecentlyViewedEntry>({
  idOf: (entry) => entry.id,
  addedAt: (entry) => entry.viewedAt,
  read(v) {
    if (!v || typeof v !== 'object') return null;
    const e = v as Record<string, unknown>;
    const id = productIdFrom(e.id);
    if (!id) return null;
    return {
      id,
      handle: typeof e.handle === 'string' ? e.handle : '',
      viewedAt: typeof e.viewedAt === 'number' && Number.isFinite(e.viewedAt) ? e.viewedAt : 0,
    };
  },
  write: (entry) => ({ id: entry.id, handle: entry.handle, viewedAt: entry.viewedAt }),
  detailsOf: () => undefined,
});

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener(entries);
    } catch {
      /* one listener failing doesn't stop the others */
    }
  });
}

/** Makes a change in memory at once, then stores the list; while it is being read, after the read. */
async function change(next: Change): Promise<void> {
  entries = next(entries);
  if (reading) madeWhileReading.push(next);
  notify();
  if (!ready || reading) return;
  if (entries.length === 0) await stored.clear();
  else await stored.save(entries);
}

async function init(options: RecentlyViewedOptions = {}): Promise<readonly RecentlyViewedEntry[]> {
  const read = ++reads;
  reading = true;
  const storage = options.storage ?? defaultStorage();
  const key = options.storageKey ?? RECENTLY_VIEWED_STORAGE_KEY;
  // The list of another storage or key isn't this one's. A product recorded before the first `init`
  // stays: it was recorded for whichever list is read.
  if (keptIn && (keptIn.storage !== storage || keptIn.key !== key)) {
    entries = [];
    madeWhileReading = [];
    notify();
  }
  keptIn = { storage, key };
  stored.open(storage, key);
  limit = limitFrom(options.limit);
  const loaded = await stored.load();
  // A newer `init` started while this one read: its read is the one used, with every change since.
  if (read !== reads) return entries;
  const changes = madeWhileReading;
  madeWhileReading = [];
  reading = false;
  ready = true;
  entries = changes.reduce((list, next) => next(list), loaded.slice(0, limit));
  if (changes.length > 0 || loaded.length > limit) await stored.save(entries);
  notify();
  return entries;
}

async function record(product: { id: string; handle: string }): Promise<void> {
  const id = productIdFrom(product?.id);
  if (!id) return;
  const entry: RecentlyViewedEntry = { id, handle: typeof product.handle === 'string' ? product.handle : '', viewedAt: Date.now() };
  await change((list) => [entry, ...list.filter((other) => other.id !== id)].slice(0, limit));
}

async function remove(productId: string): Promise<boolean> {
  const id = productIdFrom(productId);
  if (!id || !entries.some((entry) => entry.id === id)) return false;
  await change((list) => list.filter((entry) => entry.id !== id));
  return true;
}

export const recentlyViewed: ShopifyRecentlyViewedAPI = {
  init,
  isReady: () => ready && !reading,
  record,
  list: () => entries,
  remove,
  clear: () => change(() => []),
  onChange(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export default recentlyViewed;
