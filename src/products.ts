/**
 * Real Shopify products via Storefront API.
 */
import { request } from './client';
import { ShopifyError } from './types';
import {
  NODES_AS_PRODUCTS_QUERY,
  SEARCH_PRODUCTS_QUERY,
  PRODUCTS_LIST_QUERY,
  PRODUCT_BY_HANDLE_QUERY,
  PRODUCT_BY_ID_QUERY,
  PRODUCT_RECOMMENDATIONS_QUERY,
} from './queries';
import type {
  Connection,
  Filter,
  ListOptions,
  PageInfo,
  Product,
  ProductMedia,
  ProductMediaKind,
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

/** Shopify's video media content types. `MODEL_3D` and `IMAGE` are not videos. */
const VIDEO_CONTENT_TYPES = new Set(['VIDEO', 'EXTERNAL_VIDEO']);

/** Exported so `variants.ts` decides on a play badge by the same rule this module uses. */
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
 * Ordered videos → images → 3D models. Shopify appends video after the images, but a PDP gallery
 * leads with it, so the video ends up at index 0 and `selectInitialMediaIndex`-style callers can
 * choose between opening on it or on the first still.
 *
 * 3D models sort last and keep `kind: 'model-3d'` rather than being folded in with the images: all
 * this resolves for them is a preview still, and a consumer that cannot render one should be able to
 * tell it apart from a photo instead of silently showing a frozen model.
 *
 * Anything whose URL cannot be resolved is dropped so the result is always renderable.
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

/**
 * The `search` root sorts by `SearchSortKeys`, which is only `RELEVANCE | PRICE` — a much smaller
 * set than the `ProductSortKeys` that `list` and `collections.products` take.
 *
 * Rejecting the rest rather than dropping it: silently returning relevance-ordered results to a
 * caller that asked for `TITLE` is the bug this replaced. Undefined means "let Shopify default".
 */
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

/**
 * Resolve many product GIDs in one go, in the order given.
 *
 * Overloaded on `keepMissing` because the two modes return genuinely different shapes: the default
 * drops what it cannot read, while `keepMissing` leaves a positional `null`. Declaring one signature
 * for both would force every caller of the common case to null-check what can never be null.
 */
async function byIds(
  ids: string[],
  opts?: { batchSize?: number; keepMissing?: false }
): Promise<Product[]>;
async function byIds(
  ids: string[],
  opts: { batchSize?: number; keepMissing: true }
): Promise<(Product | null)[]>;
async function byIds(
  ids: string[],
  opts?: { batchSize?: number; keepMissing?: boolean }
): Promise<(Product | null)[]> {
  if (!ids.length) return [];
  // 100 keeps a batch under Shopify's per-call cost ceiling for this fragment.
  const batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? 100));
  const out: (Product | null)[] = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const data = await request<NodesRaw>(NODES_AS_PRODUCTS_QUERY, { ids: chunk });
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    for (let j = 0; j < chunk.length; j++) {
      const node = nodes[j];
      // `nodes(ids:)` answers positionally, with null for anything unreadable.
      if (node && node.__typename === 'Product') out.push(normalizeProduct(node));
      else if (opts?.keepMissing) out.push(null);
    }
  }
  return out;
}

/**
 * Storefront API exposes prices as `priceRange.minVariantPrice / maxVariantPrice`
 * but we expose them as `priceRange.min / max`. Shape-match here so callers
 * don't see the GraphQL nesting.
 */
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
    variants: p.variants?.nodes ?? [],
    images: p.images?.nodes ?? [],
    featuredImage: p.featuredImage ?? null,
    onlineStoreUrl: p.onlineStoreUrl ?? null,
    mediaContentTypes: mediaTypes,
    hasVideo: mediaTypes.some((type: string) => VIDEO_CONTENT_TYPES.has(type)),
    media: toMedia(p.media?.nodes ?? []),
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

  byIds: byIds as ShopifyProductsAPI['byIds'],

  async search(query: string, opts?: Omit<ListOptions, 'query'>): Promise<Connection<Product>> {
    const data = await request<SearchRaw>(SEARCH_PRODUCTS_QUERY, {
      query,
      first: opts?.first ?? 20,
      after: opts?.after,
      productFilters: opts?.filters,
      sortKey: toSearchSortKey(opts?.sortKey),
      reverse: opts?.reverse,
    });
    return {
      // `types: [PRODUCT]` still yields a union, so anything that is not a Product arrives as an
      // empty object rather than being dropped by the server — narrow on `id` instead of casting,
      // or it would map to a card with no title and no price.
      nodes: (data.search.nodes ?? []).filter((node) => node && 'id' in node).map(normalizeProduct),
      pageInfo: data.search.pageInfo,
      filters: data.search.productFilters ?? [],
      totalCount: data.search.totalCount,
    };
  },

  async recommended(productId: string): Promise<Product[]> {
    const data = await request<RecommendedRaw>(PRODUCT_RECOMMENDATIONS_QUERY, { productId });
    return (data.productRecommendations ?? []).map(normalizeProduct);
  },
};
