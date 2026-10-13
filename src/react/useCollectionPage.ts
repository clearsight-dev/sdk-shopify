import { useCallback, useEffect, useRef, useState } from "react";
import type { Product } from "../types";
import { useShopify } from "./ShopifyProvider";
import {
  COLLECTION_PAGE_SIZE,
  useCollectionProducts,
  type CollectionSort,
  type UseCollectionProductsOptions,
  type UseCollectionProductsResult,
} from "./useCollectionProducts";

/**
 * The orders a collection's sort sheet offers (0.15.0, amore-v2's five, the 2026-10-08 listing's):
 * `featured` (Recommended) is the collection's own order and how it opens; then What's New, Best
 * Selling, and price both ways.
 */
export type CollectionSortId = "featured" | "created-descending" | "best-selling" | "price-ascending" | "price-descending";

/** Shopify's sort for each `CollectionSortId`. `featured` needs none. */
export const COLLECTION_SORTS: Readonly<Record<CollectionSortId, CollectionSort | undefined>> = {
  featured: undefined,
  "created-descending": { key: "CREATED", reverse: true },
  "best-selling": { key: "BEST_SELLING" },
  "price-ascending": { key: "PRICE" },
  "price-descending": { key: "PRICE", reverse: true },
};

export interface UseCollectionPageOptions extends Omit<UseCollectionProductsOptions, "sort" | "pageSize"> {
  /** Products per page. Default: `ShopifyProvider productsPerPage`, else `COLLECTION_PAGE_SIZE`. */
  pageSize?: number;
  /**
   * Called once per collection, when its first page has products (production's `collectionView`):
   * the handle, the collection's title (null until Shopify names it) and the products shown.
   */
  onView?: (collection: { handle: string; title: string | null; products: Product[] }) => void;
}

export interface CollectionPage extends UseCollectionProductsResult {
  /** The order the shopper chose; `featured` until they choose. */
  sortId: CollectionSortId;
  setSortId: (sortId: CollectionSortId) => void;
  /** Takes one filter off (a chip's ×), keeping the rest. */
  removeFilter: (input: string) => void;
}

/**
 * A collection's page or tab (0.15.0, moved from amore-v2's `useCollectionTab` and `useCollectionPage`):
 * `useCollectionProducts` (cache first, paged, the store's filters) with the shopper's sort, a chip's
 * filter removal and the collection's view reported once. Paging is the feed's own: `loadMore` does
 * nothing while a page is on its way or at the end, so a grid can call it on every scroll.
 */
export function useCollectionPage(options: UseCollectionPageOptions): CollectionPage {
  const { productsPerPage } = useShopify();
  const { onView, pageSize, ...feedOptions } = options;
  const [sortId, setSortId] = useState<CollectionSortId>("featured");
  const feed = useCollectionProducts({
    ...feedOptions,
    pageSize: pageSize ?? productsPerPage ?? COLLECTION_PAGE_SIZE,
    sort: COLLECTION_SORTS[sortId],
  });

  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const reportedHandle = useRef<string | null>(null);
  const { handle } = options;
  const { products, loading, title } = feed;
  useEffect(() => {
    if (!handle || loading || !products.length || reportedHandle.current === handle) return;
    reportedHandle.current = handle;
    onViewRef.current?.({ handle, title, products });
  }, [handle, loading, products, title]);

  const { selectedFilters, setFilters } = feed;
  const removeFilter = useCallback(
    (input: string) => setFilters(selectedFilters.filter((applied) => applied !== input)),
    [selectedFilters, setFilters],
  );

  return { ...feed, sortId, setSortId, removeFilter };
}
