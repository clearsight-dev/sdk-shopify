import { request } from './client';
import { rememberProducts } from './productStore';
import { normalizeMetafields } from './metafields';
import { ShopifyError, ImageOptions } from './types';
import {
  nodesAsProductsQuery,
  searchProductsQuery,
  productsListQuery,
  productByHandleQuery,
  productByIdQuery,
  productRecommendationsQuery,
} from './queries';
import type {
  Connection,
  Filter,
  ListOptions,
  PageInfo,
  Product,
  ProductMedia,
  ProductMediaKind,
  ProductVariant,
  ShopifyProductsAPI,
} from './types';

interface ProductsRaw {
  products: { nodes: any[]; pageInfo: PageInfo };
}
interface ProductRaw { product: any | null }
interface RecommendedRaw { productRecommendations: any[] | null }
interface NodesRaw { nodes: ({ __typename?: string } | null)[] }
interface SearchRaw {
  search: {
    totalCount: number;
    nodes: any[];
    pageInfo: PageInfo;
    productFilters?: Filter[];
  };
}

const VIDEO_CONTENT_TYPES = new Set(['VIDEO', 'EXTERNAL_VIDEO']);

/** Exported so `variants.ts` decides on a play badge by the same rule. */
export function hasVideoContentType(mediaContentTypes: string[]): boolean {
  return mediaContentTypes.some((type) => VIDEO_CONTENT_TYPES.has(type));
}

interface RawVideoSource {
  url: string;
  mimeType: string;
  width: number;
  height: number;
}

/** Prefer the largest mp4 — HLS/DASH manifests need a streaming player. */
function pickVideoUrl(sources: RawVideoSource[] | null | undefined): string | null {
  if (!sources?.length) return null;
  const mp4 = sources
    .filter((source) => source.mimeType === 'video/mp4')
    .sort((a, b) => b.width - a.width);
  return mp4[0]?.url ?? sources[0].url;
}

function toMediaKind(mediaContentType: string): ProductMediaKind {
  if (mediaContentType === 'EXTERNAL_VIDEO') return 'external-video';
  if (mediaContentType === 'VIDEO') return 'video';
  if (mediaContentType === 'MODEL_3D') return 'model-3d';
  return 'image';
}

/**
 * Ordered videos → images → 3D models: Shopify appends video after the images, but a
 * PDP gallery leads with it. Models keep their own `kind` so a consumer that cannot
 * render one doesn't show its preview still as a photo. Unresolvable URLs are dropped.
 */
function toMedia(nodes: any[]): ProductMedia[] {
  const videos: ProductMedia[] = [];
  const images: ProductMedia[] = [];
  const models: ProductMedia[] = [];

  nodes.forEach((node, index) => {
    if (!node) return;
    const kind = toMediaKind(node.mediaContentType);
    const item: ProductMedia = {
      id: node.id ?? `${node.mediaContentType}-${index}`,
      kind,
      alt: node.alt ?? node.image?.altText ?? null,
      posterUrl: node.image?.url ?? node.previewImage?.url ?? null,
      width: (node.image ?? node.previewImage)?.width ?? null,
      height: (node.image ?? node.previewImage)?.height ?? null,
      videoUrl: kind === 'video' ? pickVideoUrl(node.sources) : null,
      embeddedUrl: kind === 'external-video' ? (node.embeddedUrl ?? null) : null,
    };

    if (kind === 'image') {
      if (item.posterUrl) images.push(item);
      return;
    }
    if (kind === 'model-3d') {
      if (item.posterUrl) models.push(item);
      return;
    }
    if (item.videoUrl || item.embeddedUrl || item.posterUrl) videos.push(item);
  });

  return [...videos, ...images, ...models];
}

// The `search` root sorts by `SearchSortKeys`, a much smaller set than the `ProductSortKeys`
// `list` takes. Anything else throws rather than silently returning relevance order.
const SEARCH_SORT_KEYS = new Set(['RELEVANCE', 'PRICE']);

function toSearchSortKey(sortKey: string | undefined): string | undefined {
  if (sortKey === undefined) return undefined;
  const key = sortKey.toUpperCase();
  if (!SEARCH_SORT_KEYS.has(key)) {
    throw new ShopifyError(
      `products.search cannot sort by '${sortKey}'. The Storefront search root accepts only ` +
        `${[...SEARCH_SORT_KEYS].join(' or ')}; for the full ProductSortKeys set use ` +
        `products.list({ query }) or collections.products().`
    );
  }
  return key;
}

// Overloaded because the modes return different shapes: the default drops what it cannot
// read, `keepMissing` leaves a positional `null`.
async function byIds(
  ids: string[],
  opts?: { batchSize?: number; keepMissing?: false } & ImageOptions
): Promise<Product[]>;
async function byIds(
  ids: string[],
  opts: { batchSize?: number; keepMissing: true } & ImageOptions
): Promise<(Product | null)[]>;
async function byIds(
  ids: string[],
  opts?: { batchSize?: number; keepMissing?: boolean } & ImageOptions
): Promise<(Product | null)[]> {
  if (!ids.length) return [];
  // 100 keeps a batch under Shopify's per-call query cost ceiling for this fragment.
  const batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? 100));
  const out: (Product | null)[] = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const data = await request<NodesRaw>(nodesAsProductsQuery(), { ids: chunk }, { imageTransform: opts?.imageTransform });
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    for (let j = 0; j < chunk.length; j++) {
      const node = nodes[j];
      // `nodes(ids:)` answers positionally, with null for anything unreadable.
      if (node && node.__typename === 'Product') out.push(normalizeProduct(node));
      else if (opts?.keepMissing) out.push(null);
    }
  }
  rememberProducts(out, 'base');
  return out;
}

/**
 * A product's variant as the SDK returns it: Shopify's fields, with the first selling-plan allocation
 * as `sellingPlan` (`{ id, name }`, or null when the store enrolled it in none).
 */
function normalizeProductVariant(node: any): ProductVariant {
  const { sellingPlanAllocations, ...variant } = node ?? {};
  const plan = sellingPlanAllocations?.nodes?.[0]?.sellingPlan ?? null;
  return { ...variant, sellingPlan: plan ? { id: plan.id, name: plan.name } : null };
}

export function normalizeProduct(p: any): Product {
  const mediaTypes: string[] = (p.media?.nodes ?? [])
    .map((node: { mediaContentType?: string }) => node?.mediaContentType)
    .filter((type: unknown): type is string => typeof type === 'string');

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
    variants: (p.variants?.nodes ?? []).map(normalizeProductVariant),
    images: p.images?.nodes ?? [],
    featuredImage: p.featuredImage ?? null,
    onlineStoreUrl: p.onlineStoreUrl ?? null,
    mediaContentTypes: mediaTypes,
    hasVideo: mediaTypes.some((type: string) => VIDEO_CONTENT_TYPES.has(type)),
    media: toMedia(p.media?.nodes ?? []),
    metafields: normalizeMetafields(p.metafields),
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
  };
}

export const products: ShopifyProductsAPI = {
  async list(opts?: ListOptions): Promise<Connection<Product>> {
    const data = await request<ProductsRaw>(productsListQuery(), {
      first: opts?.first ?? 20,
      after: opts?.after,
      query: opts?.query,
      sortKey: opts?.sortKey,
      reverse: opts?.reverse ?? false,
    }, { imageTransform: opts?.imageTransform });
    const nodes = data.products.nodes.map(normalizeProduct);
    rememberProducts(nodes, 'base');
    return { nodes, pageInfo: data.products.pageInfo };
  },

  async byHandle(handle: string, opts?: { fresh?: boolean } & ImageOptions): Promise<Product | null> {
    const data = await request<ProductRaw>(productByHandleQuery(), { handle }, { fresh: opts?.fresh, imageTransform: opts?.imageTransform });
    const product = data.product ? normalizeProduct(data.product) : null;
    rememberProducts([product], 'full');
    return product;
  },

  async byId(id: string, opts?: { fresh?: boolean } & ImageOptions): Promise<Product | null> {
    const data = await request<ProductRaw>(productByIdQuery(), { id }, { fresh: opts?.fresh, imageTransform: opts?.imageTransform });
    const product = data.product ? normalizeProduct(data.product) : null;
    rememberProducts([product], 'full');
    return product;
  },

  byIds: byIds as ShopifyProductsAPI['byIds'],

  async search(query: string, opts?: Omit<ListOptions, 'query'>): Promise<Connection<Product>> {
    const data = await request<SearchRaw>(searchProductsQuery(), {
      query,
      first: opts?.first ?? 20,
      after: opts?.after,
      productFilters: opts?.filters,
      sortKey: toSearchSortKey(opts?.sortKey),
      reverse: opts?.reverse,
    }, { fresh: opts?.fresh, imageTransform: opts?.imageTransform });
    // `types: [PRODUCT]` still yields a union: a non-Product arrives as an empty object
    // rather than being dropped, and would map to a card with no title and no price.
    const nodes = (data.search.nodes ?? []).filter((node) => node && 'id' in node).map(normalizeProduct);
    rememberProducts(nodes, 'base');
    return {
      nodes,
      pageInfo: data.search.pageInfo,
      filters: data.search.productFilters ?? [],
      totalCount: data.search.totalCount,
    };
  },

  async recommended(productId: string, opts?: ImageOptions): Promise<Product[]> {
    const data = await request<RecommendedRaw>(productRecommendationsQuery(), { productId }, { imageTransform: opts?.imageTransform });
    const list = (data.productRecommendations ?? []).map(normalizeProduct);
    rememberProducts(list, 'base');
    return list;
  },
};
