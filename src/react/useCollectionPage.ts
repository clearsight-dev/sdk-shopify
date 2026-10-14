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
 * The orders a collection's sort sheet can offer. 0.15.0's five (amore-v2's, the 2026-10-08 listing's):
 * `featured` (Recommended) is the collection's own order and how it opens unless the app says otherwise
 * (`initialSortId`); then newest first, best selling, and price both ways. 0.16.0 adds the name both
 * ways and oldest first (K-Marie's sheet offers all eight).
 */
export type CollectionSortId =
  | "featured"
  | "created-descending"
  | "best-selling"
  | "price-ascending"
  | "price-descending"
  | "title-ascending"
  | "title-descending"
  | "created-ascending";

/** Shopify's sort for each `CollectionSortId` (`ProductCollectionSortKeys`). `featured` needs none. */
export const COLLECTION_SORTS: Readonly<Record<CollectionSortId, CollectionSort | undefined>> = {
  featured: undefined,
  "created-descending": { key: "CREATED", reverse: true },
  "best-selling": { key: "BEST_SELLING" },
  "price-ascending": { key: "PRICE" },
  "price-descending": { key: "PRICE", reverse: true },
  "title-ascending": { key: "TITLE" },
  "title-descending": { key: "TITLE", reverse: true },
  "created-ascending": { key: "CREATED" },
};

/** The order a page starts on: `id` when it is one of `COLLECTION_SORTS`, else `featured`. */
function startingSortId(id: CollectionSortId | undefined): CollectionSortId {
  return id !== undefined && Object.prototype.hasOwnProperty.call(COLLECTION_SORTS, id) ? id : "featured";
}

export interface UseCollectionPageOptions extends Omit<UseCollectionProductsOptions, "sort" | "pageSize"> {
  /** Products per page. Default: `ShopifyProvider productsPerPage`, else `COLLECTION_PAGE_SIZE`. */
  pageSize?: number;
  /**
   * The order the page opens on, read when it opens (0.16.0). Default: `featured`, the collection's own
   * order. Its first page is read in this order, once; the shopper's choice (`setSortId`) wins after that,
   * and a later value here is ignored. An id that isn't one of `COLLECTION_SORTS` opens on `featured`.
   */
  initialSortId?: CollectionSortId;
  /**
   * Called once per collection, when its first page has products (production's `collectionView`):
   * the handle, the collection's title (null until Shopify names it) and the products shown.
   */
  onView?: (collection: { handle: string; title: string | null; products: Product[] }) => void;
}

export interface CollectionPage extends UseCollectionProductsResult {
  /** The order the shopper chose; `initialSortId` (default `featured`) until they choose. */
  sortId: CollectionSortId;
  setSortId: (sortId: CollectionSortId) => void;
  /** Takes one filter off (a chip's ×), keeping the rest. */
  removeFilter: (input: string) => void;
}

/**
 * A collection's page or tab (0.15.0, moved from amore-v2's `useCollectionTab` and `useCollectionPage`):
 * `useCollectionProducts` (cache first, paged, the store's filters) with the shopper's sort, a chip's
 * filter removal and the collection's view reported once. Paging is the feed's own: `loadMore` does
 * nothing while a page is on its way or at the end, so a grid can call it on every scroll. The order is
 * the page's: it opens on `initialSortId`, and a new `handle` on the same page keeps the order on screen
 * (as 0.15.0 did, and as a search keeps its order from one term to the next); filters belong to the
 * collection they were picked on.
 */
export function useCollectionPage(options: UseCollectionPageOptions): CollectionPage {
  const { productsPerPage } = useShopify();
  const { onView, pageSize, initialSortId, ...feedOptions } = options;
  // The first render already holds the starting order, so the first page is read once, in it.
  const [sortId, setSortId] = useState<CollectionSortId>(() => startingSortId(initialSortId));
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
