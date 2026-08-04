/**
 * Real Shopify collections via Storefront API.
 */
import { request } from './client';
import { normalizeProduct } from './products';
import {
  COLLECTIONS_LIST_QUERY,
  COLLECTION_BY_HANDLE_QUERY,
  COLLECTION_PRODUCTS_QUERY,
} from './queries';
import type {
  Collection,
  Connection,
  Filter,
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
  collection: {
    handle: string;
    title: string;
    products: { nodes: any[]; pageInfo: PageInfo; filters?: Filter[] };
  } | null;
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
      filters: opts?.filters,
    });
    if (!data.collection) {
      return { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, filters: [] };
    }
    return {
      nodes: data.collection.products.nodes.map(normalizeProduct),
      pageInfo: data.collection.products.pageInfo,
      filters: data.collection.products.filters ?? [],
      collection: { handle: data.collection.handle, title: data.collection.title },
    };
  },
};
