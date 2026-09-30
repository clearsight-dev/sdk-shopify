/**
 * useCollectionProducts — one collection's products (a product listing page), cache first.
 *
 * The collection's last first page renders immediately (memory, else the device store, so after a
 * cold start too), then the network answer replaces it in place. Cursor-paged, appending. The
 * shopper's filter selection is held here as `FilterValue.input` strings. The engine, and why each
 * part is shaped the way it is, is `useProductFeed`.
 */
import { shopify } from '../shopify';
import { useProductFeed, type ProductFeedResult, type ProductFeedState } from './useProductFeed';
import type { ImageTransform, ProductFilter } from '../types';

/** How a collection is ordered. `key` is a Storefront `ProductCollectionSortKeys` value. */
export interface CollectionSort {
  key: string;
  reverse?: boolean;
}

/** Default page size — 12 is six rows of two, a full first screenful on a phone. */
export const COLLECTION_PAGE_SIZE = 12;

export interface UseCollectionProductsOptions {
  handle: string | null | undefined;
  /** Storefront sort. Omit for the merchant's own collection order. */
  sort?: CollectionSort;
  /**
   * Filters the app always applies, e.g. in stock only. Shopify's own product filters: a
   * `FilterValue.input` parsed and handed back, never hand-built. The shopper's selection
   * (`setFilters`) is applied on top.
   */
  filters?: ProductFilter[];
  pageSize?: number;
  /** Resize/convert the products' images on Shopify's CDN, e.g. `{ maxWidth: 330, scale: 2 }`. */
  imageTransform?: ImageTransform;
  /**
   * Called with any transport error (first page or paging) so the host app can log it — the hook has
   * no logger of its own. Optional; when omitted the error only surfaces as `error` / a stopped feed.
   */
  onError?: (error: unknown, context: { at: string; handle: string }) => void;
}

export type CollectionProductsState = ProductFeedState;
export type UseCollectionProductsResult = ProductFeedResult;

export function useCollectionProducts({
  handle,
  sort,
  filters,
  pageSize = COLLECTION_PAGE_SIZE,
  imageTransform,
  onError,
}: UseCollectionProductsOptions): UseCollectionProductsResult {
  const sortKey = sort ? `${sort.key}:${sort.reverse ? 'desc' : 'asc'}` : '';
  return useProductFeed({
    id: handle ? `collection:${handle}` : null,
    // The transform is part of the key: a page cached at one image size is not another's.
    paramsKey: `${sortKey}|${pageSize}|${imageTransform ? JSON.stringify(imageTransform) : ''}`,
    fixedFilters: filters,
    fetch: async ({ after, filters: applied, fresh }) => {
      const page = await shopify.collections.products(handle as string, {
        first: pageSize,
        after,
        sortKey: sort?.key,
        reverse: sort?.reverse ?? false,
        filters: applied,
        fresh,
        imageTransform,
      });
      return {
        nodes: page.nodes,
        pageInfo: page.pageInfo,
        filters: page.filters ?? [],
        title: page.collection?.title ?? null,
      };
    },
    onError: onError
      ? (error, phase) =>
          onError(error, {
            at: phase === 'first' ? 'useCollectionProducts' : 'useCollectionProducts.loadMore',
            handle: handle as string,
          })
      : undefined,
  });
}
