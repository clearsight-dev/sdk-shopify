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
import type { ImageTransform, ProductFilter } from '../types';

/** `key` is a Storefront `SearchSortKeys` value: `RELEVANCE` or `PRICE`. */
export interface SearchSort {
  key: string;
  reverse?: boolean;
}

export const SEARCH_PAGE_SIZE = 12;
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The search sent for a term (0.22.0): `template` with `{query}` replaced by the term, e.g.
 * `{query}* -tag:hidden` for prefix matches without the store's hidden products. A template without
 * `{query}` is added after the term. No template, or no term: the term as it is.
 */
export function searchQueryFrom(term: string, template?: string | null): string {
  const query = term.trim();
  const shape = template?.trim();
  if (!query || !shape) return query;
  return shape.includes('{query}') ? shape.split('{query}').join(query) : `${query} ${shape}`;
}

export interface UseSearchOptions {
  sort?: SearchSort;
  /** Filters the app always applies; the shopper's selection (`setFilters`) goes on top. */
  filters?: ProductFilter[];
  pageSize?: number;
  /** How long typing must pause before the term is searched. Default 300 ms. */
  debounceMs?: number;
  /** What is sent for the term, `{query}` standing for it (`searchQueryFrom`). Default: the term as typed. */
  queryTemplate?: string | null;
  /** Resize/convert the results' images on Shopify's CDN. */
  imageTransform?: ImageTransform;
  onError?: (error: unknown, context: { at: string; query: string }) => void;
}

export interface UseSearchResult extends ProductFeedResult {
  /** The term actually searched: the input, trimmed, after the debounce. */
  query: string;
}

export type SearchState = ProductFeedState;

export function useSearch(term: string, options: UseSearchOptions = {}): UseSearchResult {
  const { sort, filters, pageSize = SEARCH_PAGE_SIZE, debounceMs = SEARCH_DEBOUNCE_MS, imageTransform, queryTemplate, onError } = options;
  const [query, setQuery] = useState(() => term.trim());

  useEffect(() => {
    const next = term.trim();
    if (next === query) return;
    const timer = setTimeout(() => setQuery(next), Math.max(0, debounceMs));
    return () => clearTimeout(timer);
  }, [term, debounceMs, query]);

  const sortKey = sort ? `${sort.key}:${sort.reverse ? 'desc' : 'asc'}` : '';
  const sent = searchQueryFrom(query, queryTemplate);
  const feed = useProductFeed({
    id: query ? `search:${sent.toLowerCase()}` : null,
    paramsKey: `${sortKey}|${pageSize}|${imageTransform ? JSON.stringify(imageTransform) : ''}`,
    fixedFilters: filters,
    fetch: async ({ after, filters: applied, fresh }) => {
      const page = await shopify.products.search(sent, {
        first: pageSize,
        after,
        sortKey: sort?.key,
        reverse: sort?.reverse,
        filters: applied,
        fresh,
        imageTransform,
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
