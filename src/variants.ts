/**
 * Variant resolution by GID.
 *
 * Separate from `products` because a variant resolved on its own needs things a nested variant never
 * does — its parent product's identity, and its selling-plan allocation. Waitlists are the motivating
 * case: you wait on one size or colour, and whether it can be pre-authorised is decided per variant.
 */
import { request } from './client';
import { NODES_AS_VARIANTS_QUERY } from './queries';
import { hasVideoContentType } from './products';
import type { Image, ShopifyVariantsAPI, StandaloneVariant } from './types';

interface RawMoney {
  amount: string;
  currencyCode: string;
}

interface RawVariantNode {
  __typename?: string;
  id: string;
  title: string;
  sku: string | null;
  availableForSale: boolean;
  quantityAvailable: number | null;
  price: RawMoney;
  compareAtPrice: RawMoney | null;
  selectedOptions: { name: string; value: string }[];
  image: Image | null;
  sellingPlanAllocations?: {
    nodes: {
      sellingPlan: { id: string; name: string };
      remainingBalanceChargeAmount?: RawMoney | null;
    }[];
  } | null;
  product: {
    id: string;
    title: string;
    handle: string;
    featuredImage: Image | null;
    media?: { nodes: { mediaContentType: string }[] } | null;
  };
}

interface NodesRaw {
  nodes: (RawVariantNode | null)[];
}

function normalizeVariant(node: RawVariantNode): StandaloneVariant {
  const allocation = node.sellingPlanAllocations?.nodes?.[0] ?? null;

  return {
    id: node.id,
    title: node.title,
    sku: node.sku ?? null,
    availableForSale: node.availableForSale,
    quantityAvailable: node.quantityAvailable,
    price: node.price,
    compareAtPrice: node.compareAtPrice ?? null,
    selectedOptions: node.selectedOptions ?? [],
    // The variant's own image when it has one: an entry is for a specific colour, so the product's
    // featured image can be showing something else entirely.
    image: node.image ?? node.product.featuredImage ?? null,
    product: {
      id: node.product.id,
      title: node.product.title,
      handle: node.product.handle,
      featuredImage: node.product.featuredImage ?? null,
      hasVideo: hasVideoContentType(
        (node.product.media?.nodes ?? []).map((media) => media.mediaContentType)
      ),
    },
    sellingPlan: allocation
      ? {
          id: allocation.sellingPlan.id,
          name: allocation.sellingPlan.name,
          remainingBalance: allocation.remainingBalanceChargeAmount?.amount ?? null,
          currencyCode: allocation.remainingBalanceChargeAmount?.currencyCode ?? null,
        }
      : null,
  };
}

export const variants: ShopifyVariantsAPI = {
  async byIds(ids, opts): Promise<StandaloneVariant[]> {
    if (!ids.length) return [];
    // 100 keeps a batch under Shopify's per-call cost ceiling for this fragment, as in products.byIds.
    const batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? 100));
    const out: StandaloneVariant[] = [];

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const data = await request<NodesRaw>(NODES_AS_VARIANTS_QUERY, { ids: chunk });
      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      // Walked by position over the chunk, as `products.byIds` does: `nodes(ids:)` answers
      // positionally with null for anything unreadable.
      for (let j = 0; j < chunk.length; j++) {
        const node = nodes[j];
        // The union means a non-variant (a Product GID, say) arrives as an object the inline fragment
        // never populated rather than being dropped — so `product` would be missing. Requiring
        // `__typename` and `id` is what keeps `normalizeVariant` off an incomplete node.
        if (node && node.id && node.__typename === 'ProductVariant') {
          out.push(normalizeVariant(node));
        }
      }
    }
    return out;
  },
};
