/**
 * "You may also like": Shopify's related products for a product (Storefront `productRecommendations`,
 * the same list the online store's product page shows).
 *
 * Read once per product and kept for the session, so reopening a product shows them at once. Every
 * product read also lands in the product store (base keys, variants included), so a recommendation
 * tapped opens with its picker and Add to Cart in the first frame, like a grid's card.
 */
import { useEffect, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { shopify } from '../shopify';
import type { ImageTransform, Product } from '../types';
import { useShopify } from './ShopifyProvider';

export interface UseProductRecommendationsOptions {
  /** Read them. Below the fold on most pages: pass false until the page has settled. @default true */
  enabled?: boolean;
  /** At most this many. @default 10 */
  limit?: number;
  /** For the cards' images. A grid's card size keeps them in the same image cache as the grids. */
  imageTransform?: ImageTransform;
  /** Leave a product out (e.g. one that can't be bought). The product itself is always left out. */
  exclude?: (product: Product) => boolean;
  onError?: (error: unknown, context: { at: string; productId: string }) => void;
}

export interface ProductRecommendations {
  products: Product[];
  /** Reading, with nothing to show yet. */
  loading: boolean;
  /** The read failed; whatever was shown stays. */
  error: boolean;
}

export const DEFAULT_RECOMMENDATION_LIMIT = 10;

/** This session's reads, by product and image size: the first render of a reopened product has them. */
const session = new Map<string, Product[]>();

const keyOf = (productId: string, transform: ImageTransform | undefined) =>
  `${productId}|${transform ? JSON.stringify(transform) : ''}`;

function pick(list: Product[], productId: string, limit: number, exclude?: (product: Product) => boolean) {
  return list.filter((product) => product.id !== productId && !exclude?.(product)).slice(0, limit);
}

export function useProductRecommendations(
  productId: string | null | undefined,
  options: UseProductRecommendationsOptions = {},
): ProductRecommendations {
  const { ready } = useShopify();
  const configured = ready || isConfigured();
  const enabled = options.enabled ?? true;
  const limit = Math.max(1, Math.round(options.limit ?? DEFAULT_RECOMMENDATION_LIMIT));
  const transformKey = options.imageTransform ? JSON.stringify(options.imageTransform) : '';
  const latest = useRef(options);
  latest.current = options;

  const cached = productId ? session.get(keyOf(productId, options.imageTransform)) : undefined;
  const [state, setState] = useState<ProductRecommendations>(() => ({
    products: cached ? pick(cached, productId!, limit, options.exclude) : [],
    loading: false,
    error: false,
  }));

  useEffect(() => {
    if (!productId || !enabled || !configured) return;
    const { imageTransform, exclude } = latest.current;
    const key = keyOf(productId, imageTransform);
    const known = session.get(key);
    if (known) {
      setState({ products: pick(known, productId, limit, exclude), loading: false, error: false });
      return;
    }
    let live = true;
    setState((current) => ({ ...current, loading: current.products.length === 0, error: false }));
    shopify.products
      .recommended(productId, { imageTransform })
      .then((list) => {
        session.set(key, list);
        if (live) setState({ products: pick(list, productId, limit, latest.current.exclude), loading: false, error: false });
      })
      .catch((error) => {
        latest.current.onError?.(error, { at: 'useProductRecommendations', productId });
        if (live) setState((current) => ({ ...current, loading: false, error: true }));
      });
    return () => {
      live = false;
    };
    // The options object is new every render; what it changes is read through `latest`.
  }, [productId, enabled, configured, limit, transformKey]);

  return state;
}

/** Tests only: forget this session's reads. */
export function clearRecommendationSession(): void {
  session.clear();
}
