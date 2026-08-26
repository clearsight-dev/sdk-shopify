/**
 * useCollectionProducts — one collection's products, cursor-paginated.
 *
 * Pages on a cursor (`after: endCursor`) and APPENDS, rather than growing `first` and refetching the
 * whole list each step. Growing `first` breaks on large collections: the Storefront API rejects
 * `first > 250`, so a shopper scrolling deep eventually sends an over-cap request that errors — and a
 * screen that replaces its grid on that error destroys everything already loaded, with a retry that
 * re-sends the same failing request. Cursor paging has no such cap, never re-downloads earlier pages,
 * and — because `loadMore` failing only stops growth — leaves the loaded products in place.
 *
 * Every response is checked against the request that is current (`requestId`), so a page resolving
 * after the sort or filters changed cannot merge into the new list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { shopify } from '../shopify';
import { useShopify } from './ShopifyProvider';
import type { Filter, Product, ProductFilter } from '../types';

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
  /** Shopify's own product filters — a `FilterValue.input` parsed and handed back, never hand-built. */
  filters?: ProductFilter[];
  pageSize?: number;
  /**
   * Called with any transport error (first page or paging) so the host app can log it — the hook has
   * no logger of its own. Optional; when omitted the error only surfaces as `error` / a stopped feed.
   */
  onError?: (error: unknown, context: { at: string; handle: string }) => void;
}

export interface CollectionProductsState {
  products: Product[];
  /** Null until the first read resolves, so a screen can render its own heading first. */
  title: string | null;
  /** The facets Shopify offers for this collection under the current filters. */
  availableFilters: Filter[];
  /** A first page is in flight: the grid has nothing to show yet. */
  loading: boolean;
  /** A later page is in flight: the grid keeps what it has and shows a footer spinner. */
  loadingMore: boolean;
  hasMore: boolean;
  error: boolean;
}

export interface UseCollectionProductsResult extends CollectionProductsState {
  loadMore: () => void;
  retry: () => void;
}

const IDLE: CollectionProductsState = {
  products: [],
  title: null,
  availableFilters: [],
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: false,
};

export function useCollectionProducts({
  handle,
  sort,
  filters,
  pageSize = COLLECTION_PAGE_SIZE,
  onError,
}: UseCollectionProductsOptions): UseCollectionProductsResult {
  const { ready } = useShopify();

  const [state, setState] = useState<CollectionProductsState>(IDLE);
  const [attempt, setAttempt] = useState(0);

  /**
   * Identifies the request the state belongs to. Bumped on every fresh read; an append carries the
   * value it started with, so a response whose counter has moved on is dropped rather than merged.
   */
  const requestId = useRef(0);
  /** The cursor for the next page, held in a ref so `loadMore` does not need a fresh callback. */
  const cursor = useRef<string | null>(null);

  /**
   * The filter array and sort object are rebuilt on every render of the screen that owns them, so the
   * effect depends on their serialisation rather than their identity — otherwise every keystroke
   * elsewhere on the screen would refetch.
   */
  const filterKey = filters?.length ? JSON.stringify(filters) : '';
  const sortKey = sort ? `${sort.key}:${sort.reverse ? 'desc' : 'asc'}` : '';

  useEffect(() => {
    // A client that is not up yet, or no handle to read, is not a failed load — it is no load.
    if (!ready || !handle) {
      requestId.current += 1;
      cursor.current = null;
      setState(IDLE);
      return;
    }

    const id = (requestId.current += 1);
    cursor.current = null;
    setState({ ...IDLE, loading: true });

    shopify.collections
      .products(handle, {
        first: pageSize,
        sortKey: sort?.key,
        reverse: sort?.reverse ?? false,
        filters: filters?.length ? filters : undefined,
      })
      .then((page) => {
        if (requestId.current !== id) return;
        cursor.current = page.pageInfo.endCursor;
        setState({
          products: page.nodes,
          title: page.collection?.title ?? null,
          availableFilters: page.filters ?? [],
          loading: false,
          loadingMore: false,
          hasMore: page.pageInfo.hasNextPage,
          error: false,
        });
      })
      .catch((caught) => {
        onError?.(caught, { at: 'useCollectionProducts', handle });
        if (requestId.current !== id) return;
        // A first-page failure genuinely has nothing to show, so the consumer renders its error state.
        setState({ ...IDLE, error: true });
      });
    // Keyed on the serialised filters and sort; both change identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, handle, sortKey, filterKey, pageSize, attempt]);

  /**
   * Guarded on both in-flight flags as well as on `hasMore`: a list's `onEndReached` fires every
   * time the end stays in view, so an ungated version would run through the collection a page a frame.
   */
  const loadMore = useCallback(() => {
    if (state.loading || state.loadingMore || !state.hasMore || !cursor.current) return;

    const id = requestId.current;
    const after = cursor.current;
    // Claim the cursor synchronously. `onEndReached` fires repeatedly and the `loadingMore` guard
    // reads a `state` snapshot that is stale until the next render, so a second call in the same frame
    // would otherwise fetch this SAME page again and append it twice — duplicate keys. Nulling the ref
    // now makes the re-entrant call bail on `!cursor.current`; the fetch restores it, a failure leaves
    // it null (paging has stopped anyway).
    cursor.current = null;
    setState((current) => ({ ...current, loadingMore: true }));

    shopify.collections
      .products(handle as string, {
        first: pageSize,
        after,
        sortKey: sort?.key,
        reverse: sort?.reverse ?? false,
        filters: filters?.length ? filters : undefined,
      })
      .then((page) => {
        if (requestId.current !== id) return;
        cursor.current = page.pageInfo.endCursor;
        setState((current) => {
          // Defensive against any overlap between pages: never append a product already held.
          const seen = new Set(current.products.map((p) => p.id));
          const fresh = page.nodes.filter((p) => !seen.has(p.id));
          return {
            ...current,
            products: fresh.length ? [...current.products, ...fresh] : current.products,
            loadingMore: false,
            hasMore: page.pageInfo.hasNextPage,
          };
        });
      })
      .catch((caught) => {
        onError?.(caught, { at: 'useCollectionProducts.loadMore', handle: handle as string });
        if (requestId.current !== id) return;
        // A failed page is not a failed collection: what is on screen stays, and the end simply stops
        // growing rather than the grid being replaced by an error.
        setState((current) => ({ ...current, loadingMore: false, hasMore: false }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loading, state.loadingMore, state.hasMore, handle, sortKey, filterKey, pageSize]);

  return {
    ...state,
    loadMore,
    retry: () => setAttempt((n) => n + 1),
  };
}
