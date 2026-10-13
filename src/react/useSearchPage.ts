import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shopify } from "../shopify";
import type { ImageTransform, Product } from "../types";
import { useCollectionProducts } from "./useCollectionProducts";
import { useSearch, type SearchSort, type UseSearchResult } from "./useSearch";

/** The orders a search's sort sheet offers (0.15.0): relevance (Recommended, how results open), then price both ways. */
export type SearchSortId = "relevance" | "price-ascending" | "price-descending";

/** Shopify's search order for each `SearchSortId`. Shopify's search sorts by price, or by nothing else. */
export const SEARCH_SORTS: Readonly<Record<SearchSortId, SearchSort | undefined>> = {
  relevance: undefined,
  "price-ascending": { key: "PRICE" },
  "price-descending": { key: "PRICE", reverse: true },
};

/** How many products a search with no match shows under its message (production's row). */
export const SEARCH_FALLBACK_COUNT = 10;
/** How many products the start page's row shows (Amore's "Recommended for you"). */
export const SEARCH_RECOMMENDED_COUNT = 8;

export interface UseSearchPageOptions {
  /** The term to open on (a link, a push); a new one later replaces what is typed. */
  query?: string;
  imageTransform?: ImageTransform;
  /** The start page's row: this collection's first products, before anything is typed. */
  recommendedCollection?: string | null;
  /** How many the start page's row shows. Default `SEARCH_RECOMMENDED_COUNT` (8). */
  recommendedCount?: number;
  /** How many products a search with no match shows. Default `SEARCH_FALLBACK_COUNT` (10). */
  fallbackCount?: number;
  /**
   * Called once per term the shopper settled on (the debounced one), once its answer is in, with every
   * match counted (production's `search` event).
   */
  onSearched?: (search: { term: string; totalCount: number }) => void;
}

export interface SearchPage {
  /** What the field shows. */
  term: string;
  setTerm: (term: string) => void;
  /** The term searched: `term` trimmed, after the debounce. */
  query: string;
  /** A term is being searched (not the start page). */
  searching: boolean;
  /** The search itself (`useSearch`): its results, filters, paging and states. */
  results: UseSearchResult;
  /** The term has matches. */
  hasResults: boolean;
  /**
   * The results' header (the count, the filters and their chips) shows: there are matches, or the
   * shopper's filters left none, so its chips can take them off.
   */
  resultsShown: boolean;
  /**
   * The term matched nothing, with no filter of the shopper's to blame: the page says so over the
   * store's products. Filters that leave nothing are not this: the results header stays, so its chips
   * can take them off, and the grid says it's empty.
   */
  noMatch: boolean;
  /** What the grid shows: the results, or under `noMatch` the store's products. */
  products: Product[];
  /** The grid's first load: the results', or the store's products' under `noMatch`. */
  loading: boolean;
  /** The next page of results: nothing under `noMatch` (the store's products are one row). */
  loadMore: () => void;
  /** The start page's row (`recommendedCollection`), loaded once and kept while the shopper types. */
  recommended: Product[];
  sortId: SearchSortId;
  setSortId: (sortId: SearchSortId) => void;
  /** Takes one filter off (a chip's ×). */
  removeFilter: (input: string) => void;
}

/** Fetched once per launch, the first time a search finds nothing. */
let fallbackProducts: Product[] | null = null;

/** The store's first products, read the first time a search finds nothing (a nicety: a failure shows the message alone). */
function useFallbackProducts(enabled: boolean, count: number, imageTransform: ImageTransform | undefined): { products: Product[]; loading: boolean } {
  const [products, setProducts] = useState<Product[]>(fallbackProducts ?? []);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    if (fallbackProducts) {
      setProducts(fallbackProducts);
      setLoading(false);
      return;
    }
    let stillMounted = true;
    setLoading(true);
    shopify.products
      .list({ first: count, imageTransform })
      .then((firstPage) => {
        fallbackProducts = firstPage.nodes;
        if (stillMounted) setProducts(firstPage.nodes);
      })
      .catch(() => undefined)
      .finally(() => {
        if (stillMounted) setLoading(false);
      });
    return () => {
      stillMounted = false;
    };
    // The count and transform are read once: the row is fetched once per launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return { products, loading };
}

/**
 * A search page (0.15.0, moved from amore-v2's `useSearchPage`): the field's term, the search
 * (`useSearch`: debounced, cache first, paged, the store's filters) in the shopper's order, the start
 * page's row before anything is typed, the store's products under a search with no match, and the
 * search reported once per settled term. A new term starts with no filters (`useSearch` keeps them per
 * term); the order is kept from one term to the next.
 */
export function useSearchPage(options: UseSearchPageOptions = {}): SearchPage {
  const { query: openedWith, imageTransform, recommendedCollection, recommendedCount = SEARCH_RECOMMENDED_COUNT, fallbackCount = SEARCH_FALLBACK_COUNT } = options;
  const [term, setTerm] = useState(openedWith ?? "");
  useEffect(() => {
    if (openedWith !== undefined) setTerm(openedWith);
  }, [openedWith]);
  const [sortId, setSortId] = useState<SearchSortId>("relevance");

  const results = useSearch(term, { imageTransform, sort: SEARCH_SORTS[sortId] });
  const { query } = results;
  const searching = query.length > 0;
  const hasResults = searching && results.products.length > 0;
  const filtered = results.selectedFilters.length > 0;
  const noMatch = searching && !results.loading && !results.error && results.products.length === 0 && !filtered;
  const fallback = useFallbackProducts(noMatch, fallbackCount, imageTransform);
  const recommendedFeed = useCollectionProducts({
    handle: recommendedCollection?.trim() || null,
    pageSize: recommendedCount,
    imageTransform,
  });

  const onSearchedRef = useRef(options.onSearched);
  onSearchedRef.current = options.onSearched;
  const reported = useRef<string | null>(null);
  const totalCount = results.totalCount ?? results.products.length;
  useEffect(() => {
    if (!searching || results.loading || reported.current === query) return;
    reported.current = query;
    onSearchedRef.current?.({ term: query, totalCount });
  }, [searching, results.loading, query, totalCount]);

  const { selectedFilters, setFilters, loadMore: loadMoreResults } = results;
  const removeFilter = useCallback(
    (input: string) => setFilters(selectedFilters.filter((applied) => applied !== input)),
    [selectedFilters, setFilters],
  );
  const loadMore = useCallback(() => {
    if (hasResults) loadMoreResults();
  }, [hasResults, loadMoreResults]);
  const recommended = useMemo(() => recommendedFeed.products.slice(0, recommendedCount), [recommendedFeed.products, recommendedCount]);

  return {
    term,
    setTerm,
    query,
    searching,
    results,
    hasResults,
    resultsShown: hasResults || (searching && filtered && !results.loading),
    noMatch,
    products: noMatch ? fallback.products : results.products,
    loading: noMatch ? fallback.loading : results.loading,
    loadMore,
    recommended,
    sortId,
    setSortId,
    removeFilter,
  };
}
