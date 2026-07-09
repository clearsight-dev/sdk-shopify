/**
 * Real Shopify products via Storefront API.
 */
import { request } from './client';
import {
  PRODUCTS_LIST_QUERY,
  PRODUCT_BY_HANDLE_QUERY,
  PRODUCT_BY_ID_QUERY,
  PRODUCT_RECOMMENDATIONS_QUERY,
} from './queries';
import type {
  Connection,
  ListOptions,
  PageInfo,
  Product,
  ShopifyProductsAPI,
} from './types';

interface ProductsRaw {
  products: { nodes: any[]; pageInfo: PageInfo };
}
interface ProductRaw { product: any | null }
interface RecommendedRaw { productRecommendations: any[] | null }

/**
 * Storefront API exposes prices as `priceRange.minVariantPrice / maxVariantPrice`
 * but we expose them as `priceRange.min / max`. Shape-match here so callers
 * don't see the GraphQL nesting.
 */
export function normalizeProduct(p: any): Product {
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
    priceRange: {
      min: p.priceRange.minVariantPrice,
      max: p.priceRange.maxVariantPrice,
    },
    compareAtPriceRange: p.compareAtPriceRange?.minVariantPrice
      ? {
          min: p.compareAtPriceRange.minVariantPrice,
          max: p.compareAtPriceRange.maxVariantPrice,
        }
      : null,
    options: p.options ?? [],
    variants: p.variants?.nodes ?? [],
    images: p.images?.nodes ?? [],
    featuredImage: p.featuredImage ?? null,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
  };
}

export const products: ShopifyProductsAPI = {
  async list(opts?: ListOptions): Promise<Connection<Product>> {
    const data = await request<ProductsRaw>(PRODUCTS_LIST_QUERY, {
      first: opts?.first ?? 20,
      after: opts?.after,
      query: opts?.query,
      sortKey: opts?.sortKey,
      reverse: opts?.reverse ?? false,
    });
    return {
      nodes: data.products.nodes.map(normalizeProduct),
      pageInfo: data.products.pageInfo,
    };
  },

  async byHandle(handle: string): Promise<Product | null> {
    const data = await request<ProductRaw>(PRODUCT_BY_HANDLE_QUERY, { handle });
    return data.product ? normalizeProduct(data.product) : null;
  },

  async byId(id: string): Promise<Product | null> {
    const data = await request<ProductRaw>(PRODUCT_BY_ID_QUERY, { id });
    return data.product ? normalizeProduct(data.product) : null;
  },

  async search(query: string, opts?: Omit<ListOptions, 'query'>): Promise<Connection<Product>> {
    return this.list({ ...opts, query });
  },

  async recommended(productId: string): Promise<Product[]> {
    const data = await request<RecommendedRaw>(PRODUCT_RECOMMENDATIONS_QUERY, { productId });
    return (data.productRecommendations ?? []).map(normalizeProduct);
  },
};
