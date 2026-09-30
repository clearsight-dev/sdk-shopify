/**
 * useSearch — product search (a search page), cache first.
 *
 * The same engine as `useCollectionProducts` (`useProductFeed`): the last first page for this query
 * renders immediately, the network answer replaces it in place, and paging is by cursor. The typed
 * term is debounced, so each keystroke is not a request; the first render uses the term as given, so
 * a search page opened with a query paints from cache at once.
 *
 * Every product a search returns records its base keys in the product store, so tapping a result
 * opens its product page with title, image and price already there.
 */
import { useEffect, useState } from 'react';
import { shopify } from '../shopify';
import { useProductFeed, type ProductFeedResult, type ProductFeedState } from './useProductFeed';
import type { ProductFilter } from '../types';

/** `key` is a Storefront `SearchSortKeys` value: `RELEVANCE` or `PRICE`. */
export interface SearchSort {
  key: string;
  reverse?: boolean;
}

export const SEARCH_PAGE_SIZE = 12;
export const SEARCH_DEBOUNCE_MS = 300;

export interface UseSearchOptions {
  sort?: SearchSort;
  /** Filters the app always applies; the shopper's selection (`setFilters`) goes on top. */
  filters?: ProductFilter[];
  pageSize?: number;
  /** How long typing must pause before the term is searched. Default 300 ms. */
  debounceMs?: number;
  onError?: (error: unknown, context: { at: string; query: string }) => void;
}

export interface UseSearchResult extends ProductFeedResult {
  /** The term actually searched: the input, trimmed, after the debounce. */
  query: string;
}

export type SearchState = ProductFeedState;

export function useSearch(term: string, options: UseSearchOptions = {}): UseSearchResult {
  const { sort, filters, pageSize = SEARCH_PAGE_SIZE, debounceMs = SEARCH_DEBOUNCE_MS, onError } = options;
  const [query, setQuery] = useState(() => term.trim());

  useEffect(() => {
    const next = term.trim();
    if (next === query) return;
    const timer = setTimeout(() => setQuery(next), Math.max(0, debounceMs));
    return () => clearTimeout(timer);
  }, [term, debounceMs, query]);

  const sortKey = sort ? `${sort.key}:${sort.reverse ? 'desc' : 'asc'}` : '';
  const feed = useProductFeed({
    id: query ? `search:${query.toLowerCase()}` : null,
    paramsKey: `${sortKey}|${pageSize}`,
    fixedFilters: filters,
    fetch: async ({ after, filters: applied, fresh }) => {
      const page = await shopify.products.search(query, {
        first: pageSize,
        after,
        sortKey: sort?.key,
        reverse: sort?.reverse,
        filters: applied,
        fresh,
      });
      return {
        nodes: page.nodes,
        pageInfo: page.pageInfo,
        filters: page.filters ?? [],
        title: null,
        totalCount: page.totalCount,
      };
    },
    onError: onError
      ? (error, phase) => onError(error, { at: phase === 'first' ? 'useSearch' : 'useSearch.loadMore', query })
      : undefined,
  });

  return { ...feed, query };
}
