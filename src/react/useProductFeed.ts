/**
 * The engine behind `useCollectionProducts` and `useSearch`: a cursor-paged product list that shows
 * its cached first page first and revalidates in the background.
 *
 * - **Cache first.** The first page last seen for this feed (memory, else the device store: MMKV on
 *   native) renders immediately, on the first frame after a cold start too. Then the network answer
 *   replaces it in place, with `refreshing` true in between rather than a spinner. A cached page
 *   younger than `REVALIDATE_AFTER_MS` is not re-read at all.
 * - **Cursor paging that appends,** never growing `first`: the Storefront API rejects `first > 250`,
 *   and a failed `loadMore` only stops growth instead of replacing the grid.
 * - **Stale answers are dropped.** Every response is checked against the request that is current
 *   (`requestId`), so a page resolving after the query, sort or filters changed can't merge in.
 * - **The shopper's filter selection** (`setFilters`) is held as the `FilterValue.input` strings a
 *   filter sheet works with, and belongs to the feed it was made on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { peekList, rememberList } from '../productStore';
import { useShopify } from './ShopifyProvider';
import type { Filter, PageInfo, Product, ProductFilter } from '../types';

/** A cached first page younger than this is shown without asking the network again. */
export const REVALIDATE_AFTER_MS = 60 * 1000;

export interface FeedPage {
  nodes: Product[];
  pageInfo: PageInfo;
  filters?: Filter[];
  title?: string | null;
  totalCount?: number;
}

export interface FeedSource {
  /** Which feed this is (`collection:<handle>`, `search:<term>`); null when there is nothing to read. */
  id: string | null;
  /** What else shapes the first page: sort, page size. Fixed filters are passed separately. */
  paramsKey: string;
  /** Filters the app always applies; the shopper's selection goes on top. */
  fixedFilters?: ProductFilter[];
  fetch(args: { after?: string; filters: ProductFilter[] | undefined; fresh: boolean }): Promise<FeedPage>;
  onError?: (error: unknown, phase: 'first' | 'more') => void;
}

export interface ProductFeedState {
  products: Product[];
  /** Null until a first page is known, so a screen can render its own heading first. */
  title: string | null;
  /** The facets Shopify offers for these products under the current filters. */
  availableFilters: Filter[];
  /** Search only: how many products match. */
  totalCount?: number;
  /** Nothing to show yet: no cached page, and the first read is in flight. */
  loading: boolean;
  /** A later page is in flight: the grid keeps what it has and shows a footer spinner. */
  loadingMore: boolean;
  /** A cached page is on screen while the fresh one is read. No spinner needed. */
  refreshing: boolean;
  hasMore: boolean;
  error: boolean;
}

export interface ProductFeedResult extends ProductFeedState {
  loadMore: () => void;
  /** Re-reads the first page from the network. The name for an error state's button. */
  retry: () => void;
  /** Re-reads the first page from the network, keeping what is on screen until it lands. */
  refresh: () => void;
  /** The shopper's filter selection, as the `input` strings of the values they picked. */
  selectedFilters: string[];
  /** Replace the selection. An input that isn't a Shopify filter (unparseable JSON) is dropped. */
  setFilters: (inputs: string[]) => void;
  clearFilters: () => void;
  /** True while the shopper has at least one filter selected. */
  filterActive: boolean;
}

/** One stable empty selection, so a screen's memo on `selectedFilters` holds across renders. */
const NO_INPUTS: string[] = [];

/** A `FilterValue.input` as the `ProductFilter` it encodes, or null when it isn't one. */
function parseFilterInput(input: string): ProductFilter | null {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as ProductFilter) : null;
  } catch {
    return null;
  }
}

const IDLE: ProductFeedState = {
  products: [],
  title: null,
  availableFilters: [],
  loading: false,
  loadingMore: false,
  refreshing: false,
  hasMore: false,
  error: false,
};

function fromList(list: NonNullable<ReturnType<typeof peekList>>, refreshing: boolean): ProductFeedState {
  return {
    products: list.products,
    title: list.title,
    availableFilters: list.filters,
    totalCount: list.totalCount,
    loading: false,
    loadingMore: false,
    refreshing,
    hasMore: list.pageInfo.hasNextPage,
    error: false,
  };
}

export function useProductFeed(source: FeedSource): ProductFeedResult {
  const { ready } = useShopify();
  // The provider sets the config on its first render, so reads can start before its own startup
  // (cart, wishlist, customer) finishes; `ready` re-runs the effect if the config came later.
  const configured = ready || isConfigured();

  // The latest source, so the effect and `loadMore` don't depend on a fetch function's identity.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  /**
   * Stored with the feed it was made on. Read against another feed it is empty: facets belong to a
   * collection or a query, and resetting it in an effect would first read the new feed with the old
   * filters.
   */
  const [selection, setSelection] = useState<{ id: string | null; inputs: string[] }>({
    id: source.id,
    inputs: NO_INPUTS,
  });
  const selectedFilters = selection.id === source.id ? selection.inputs : NO_INPUTS;
  const allFilters: ProductFilter[] = [
    ...(source.fixedFilters ?? []),
    ...selectedFilters.map(parseFilterInput).filter((f): f is ProductFilter => f !== null),
  ];
  // Filters and sort objects are rebuilt every render; the effect keys on their serialisation.
  const filterKey = allFilters.length ? JSON.stringify(allFilters) : '';
  const listKey = source.id ? `${source.id}|${source.paramsKey}|${filterKey}` : null;

  // First render: the cached page, if there is one, so the grid paints on frame one.
  const [state, setState] = useState<ProductFeedState>(() => {
    const cached = configured && listKey ? peekList(listKey) : null;
    return cached ? fromList(cached, true) : IDLE;
  });
  const [attempt, setAttempt] = useState(0);

  const requestId = useRef(0);
  /** The cursor for the next page. Null while a first page is being (re)read, which pauses paging. */
  const cursor = useRef<string | null>(null);
  /** Set by `refresh`/`retry` so the next first-page read skips every cache. */
  const freshNext = useRef(false);

  useEffect(() => {
    // No client yet, or nothing to read, is not a failed load — it is no load.
    if (!configured || !listKey) {
      requestId.current += 1;
      cursor.current = null;
      setState(IDLE);
      return;
    }

    const id = (requestId.current += 1);
    const fresh = freshNext.current;
    freshNext.current = false;
    const cached = peekList(listKey);

    if (cached && !fresh && Date.now() - cached.at < REVALIDATE_AFTER_MS) {
      // Recent enough: show it and page on from its cursor, without a network read.
      cursor.current = cached.pageInfo.endCursor;
      setState(fromList(cached, false));
      return;
    }
    // Paging waits for the fresh first page: a cached cursor may no longer match it.
    cursor.current = null;
    setState((current) => {
      if (cached) return fromList(cached, true);
      // A refresh keeps what is on screen until the fresh page lands.
      if (fresh && current.products.length) return { ...current, refreshing: true, error: false };
      return { ...IDLE, loading: true };
    });

    sourceRef.current
      .fetch({ filters: allFilters.length ? allFilters : undefined, fresh })
      .then((page) => {
        if (requestId.current !== id) return;
        cursor.current = page.pageInfo.endCursor;
        rememberList(listKey, {
          products: page.nodes,
          pageInfo: page.pageInfo,
          title: page.title ?? null,
          filters: page.filters ?? [],
          totalCount: page.totalCount,
        });
        setState({
          products: page.nodes,
          title: page.title ?? null,
          availableFilters: page.filters ?? [],
          totalCount: page.totalCount,
          loading: false,
          loadingMore: false,
          refreshing: false,
          hasMore: page.pageInfo.hasNextPage,
          error: false,
        });
      })
      .catch((caught) => {
        sourceRef.current.onError?.(caught, 'first');
        if (requestId.current !== id) return;
        setState((current) => {
          // A failed revalidation leaves the cached page usable: keep it, and page on from it.
          if (current.products.length) {
            cursor.current = cached?.pageInfo.endCursor ?? null;
            return { ...current, refreshing: false };
          }
          return { ...IDLE, error: true };
        });
      });
    // Keyed on the serialised feed; filter and sort objects change identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, listKey, attempt]);

  /**
   * Guarded on the in-flight flags and `hasMore`: a list's `onEndReached` fires every time the end
   * stays in view, so an ungated version would run through the feed a page a frame.
   */
  const loadMore = useCallback(() => {
    if (state.loading || state.loadingMore || state.refreshing || !state.hasMore || !cursor.current) return;
    const id = requestId.current;
    const after = cursor.current;
    // Claim the cursor synchronously: a second call in the same frame would otherwise fetch this
    // same page again and append it twice. The fetch restores it; a failure leaves it null.
    cursor.current = null;
    setState((current) => ({ ...current, loadingMore: true }));

    sourceRef.current
      .fetch({ after, filters: allFilters.length ? allFilters : undefined, fresh: false })
      .then((page) => {
        if (requestId.current !== id) return;
        cursor.current = page.pageInfo.endCursor;
        setState((current) => {
          // Defensive against any overlap between pages: never append a product already held.
          const seen = new Set(current.products.map((p) => p.id));
          const added = page.nodes.filter((p) => !seen.has(p.id));
          return {
            ...current,
            products: added.length ? [...current.products, ...added] : current.products,
            loadingMore: false,
            hasMore: page.pageInfo.hasNextPage,
          };
        });
      })
      .catch((caught) => {
        sourceRef.current.onError?.(caught, 'more');
        if (requestId.current !== id) return;
        // A failed page is not a failed feed: what is on screen stays, and it stops growing.
        setState((current) => ({ ...current, loadingMore: false, hasMore: false }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loading, state.loadingMore, state.refreshing, state.hasMore, listKey]);

  const setFilters = useCallback(
    (inputs: string[]) => {
      const valid = Array.from(new Set(inputs)).filter((input) => parseFilterInput(input) !== null);
      setSelection({ id: source.id, inputs: valid.length ? valid : NO_INPUTS });
    },
    [source.id],
  );
  const clearFilters = useCallback(() => setSelection({ id: source.id, inputs: NO_INPUTS }), [source.id]);
  const refresh = useCallback(() => {
    freshNext.current = true;
    setAttempt((n) => n + 1);
  }, []);

  return {
    ...state,
    loadMore,
    retry: refresh,
    refresh,
    selectedFilters,
    setFilters,
    clearFilters,
    filterActive: selectedFilters.length > 0,
  };
}
