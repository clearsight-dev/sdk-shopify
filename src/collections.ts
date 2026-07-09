/**
 * Real Shopify collections via Storefront API.
 */
import { request } from './client';
import {
  COLLECTIONS_LIST_QUERY,
  COLLECTION_BY_HANDLE_QUERY,
  COLLECTION_PRODUCTS_QUERY,
} from './queries';
import type {
  Collection,
  Connection,
  ListOptions,
  PageInfo,
  Product,
  ShopifyCollectionsAPI,
} from './types';

interface CollectionsRaw {
  collections: { nodes: Collection[]; pageInfo: PageInfo };
}
interface CollectionRaw { collection: Collection | null }
interface CollectionProductsRaw {
  collection: { products: { nodes: any[]; pageInfo: PageInfo } } | null;
}

function normalizeProduct(p: any): Product {
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    descriptionHtml: p.descriptionHtml,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags ?? [],
    totalInventory: p.totalInventory ?? null,
    availableForSale: p.availableForSale,
    priceRange: { min: p.priceRange.minVariantPrice, max: p.priceRange.maxVariantPrice },
    compareAtPriceRange: p.compareAtPriceRange?.minVariantPrice
      ? { min: p.compareAtPriceRange.minVariantPrice, max: p.compareAtPriceRange.maxVariantPrice }
      : null,
    options: p.options ?? [],
    variants: p.variants?.nodes ?? [],
    images: p.images?.nodes ?? [],
    featuredImage: p.featuredImage ?? null,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
  };
}

export const collections: ShopifyCollectionsAPI = {
  async list(opts?: ListOptions): Promise<Connection<Collection>> {
    const data = await request<CollectionsRaw>(COLLECTIONS_LIST_QUERY, {
      first: opts?.first ?? 20,
      after: opts?.after,
      query: opts?.query,
      sortKey: opts?.sortKey,
      reverse: opts?.reverse ?? false,
    });
    return data.collections;
  },

  async byHandle(handle: string): Promise<Collection | null> {
    const data = await request<CollectionRaw>(COLLECTION_BY_HANDLE_QUERY, { handle });
    return data.collection;
  },

  async products(handle: string, opts?: ListOptions): Promise<Connection<Product>> {
    const data = await request<CollectionProductsRaw>(COLLECTION_PRODUCTS_QUERY, {
      handle,
      first: opts?.first ?? 20,
      after: opts?.after,
      sortKey: opts?.sortKey,
      reverse: opts?.reverse ?? false,
    });
    if (!data.collection) {
      return { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    return {
      nodes: data.collection.products.nodes.map(normalizeProduct),
      pageInfo: data.collection.products.pageInfo,
    };
  },
};
