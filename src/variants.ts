// Separate from `products` because a variant resolved on its own needs what a nested one never
// does — its parent product's identity, and its selling-plan allocation (pre-order eligibility
// is a per-variant fact).
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
    // The variant's own image first: it is for one specific colour, which the product's
    // featured image may not be showing.
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
    // 100 keeps a batch under Shopify's per-call query cost ceiling, as in products.byIds.
    const batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? 100));
    const out: StandaloneVariant[] = [];

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const data = await request<NodesRaw>(NODES_AS_VARIANTS_QUERY, { ids: chunk });
      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      // `nodes(ids:)` answers positionally, with null for anything unreadable. A non-variant GID
      // arrives as an object the inline fragment never populated, so the `__typename` check is
      // what keeps `normalizeVariant` off a node with no `product`.
      for (let j = 0; j < chunk.length; j++) {
        const node = nodes[j];
        if (node && node.id && node.__typename === 'ProductVariant') {
          out.push(normalizeVariant(node));
        }
      }
    }
    return out;
  },
};
