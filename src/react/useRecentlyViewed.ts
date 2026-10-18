/**
 * Recently viewed (0.17.0): the products the shopper opened, newest first, as the store has them today
 * (price, stock). The ids are kept on the device by `shopify.recentlyViewed`; the products are read
 * through `useProductsById`, so they share its batch read and its session cache with every other list.
 *
 * - A product recorded on any screen shows at once in every `useRecentlyViewed`.
 * - A product the store no longer has is left out, and taken off the stored list.
 * - Nothing is recorded by itself (no hidden side effects): the product page's screen calls `record`
 *   when a product opens, and passes that product as `leaveOut` to a list on the same page.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { recentlyViewed, RECENTLY_VIEWED_MAX_LIMIT } from '../recentlyViewed';
import type { ImageTransform, Product } from '../types';
import { isGoneFromStore, useProductsById } from './useProductsById';

/** Products shown unless `limit` says otherwise. */
export const RECENTLY_VIEWED_SHOWN = 10;

export interface UseRecentlyViewedOptions {
  /** Products shown, newest first. Default 10; rounded, 1–50. The device keeps the provider's `recentlyViewed.limit`. */
  limit?: number;
  /** The product a product page has open, by id or handle: not shown. */
  leaveOut?: string | null;
  /** For the cards' images: a grid's card size keeps them in the same image cache as the grids. */
  imageTransform?: ImageTransform;
  /** Show and read the products. Off: none, and nothing read; `record` and `clear` still work. @default true */
  enabled?: boolean;
}

export interface RecentlyViewedProducts {
  /** Newest first, at most `limit`, without `leaveOut` and without products the store no longer has. */
  products: Product[];
  /** The stored list is being read, or products in it are. */
  loading: boolean;
  /** The last product read failed; whatever was shown stays. */
  error: boolean;
  /** The product a product page just opened: to the front of the list. */
  record(product: { id: string; handle: string }): void;
  /** Empties the list, on the device too. */
  clear(): void;
}

const subscribe = (onListChange: () => void) => recentlyViewed.onChange(onListChange);
const currentList = () => recentlyViewed.list();

function shownFrom(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return RECENTLY_VIEWED_SHOWN;
  return Math.min(RECENTLY_VIEWED_MAX_LIMIT, Math.max(1, Math.round(limit)));
}

export function useRecentlyViewed(options: UseRecentlyViewedOptions = {}): RecentlyViewedProducts {
  const entries = useSyncExternalStore(subscribe, currentList, currentList);
  const enabled = options.enabled ?? true;
  const shown = shownFrom(options.limit);
  const leaveOut = options.leaveOut || null;
  const { imageTransform } = options;

  // Read once the stored list is: one read of the whole list, not one before it and one after.
  // A product found gone is left out at once, so the next one is read in its place.
  const listRead = recentlyViewed.isReady();
  const ids = enabled && listRead
    ? entries
        .filter((entry) => entry.id !== leaveOut && entry.handle !== leaveOut && !isGoneFromStore(entry.id, imageTransform))
        .slice(0, shown)
        .map((entry) => entry.id)
    : [];
  const found = useProductsById(ids, { enabled, imageTransform });

  // ...and taken off the stored list, which every other `useRecentlyViewed` then shows.
  const goneKey = entries
    .filter((entry) => isGoneFromStore(entry.id, imageTransform))
    .map((entry) => entry.id)
    .join(',');
  useEffect(() => {
    if (!goneKey) return;
    for (const id of goneKey.split(',')) void recentlyViewed.remove(id);
  }, [goneKey]);

  const record = useCallback((product: { id: string; handle: string }) => {
    void recentlyViewed.record(product);
  }, []);
  const clear = useCallback(() => {
    void recentlyViewed.clear();
  }, []);

  // A product not here yet is on its way: `found` can be a render behind a new list of ids.
  const productsComing = !found.error && ids.some((id) => !found.byId[id]);
  const loading = enabled && (!listRead || productsComing);
  // From the ids of this render, so a product just opened (`leaveOut`) never shows for a frame.
  const idsKey = ids.join(',');
  const products = useMemo(
    () => (idsKey ? idsKey.split(',') : []).map((id) => found.byId[id]).filter((product): product is Product => !!product),
    [idsKey, found.byId],
  );
  return useMemo(
    () => ({ products, loading, error: found.error, record, clear }),
    [products, loading, found.error, record, clear],
  );
}
