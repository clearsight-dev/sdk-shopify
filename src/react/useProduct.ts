/**
 * useProduct — one product (a product page), cache first, built to open instantly.
 *
 * First render, synchronously from the product store (memory, else the device store: MMKV on
 * native, read by key in microseconds):
 * - the **full** product, if this device has read it before; or
 * - the **base** keys (`PRODUCT_BASE_KEYS`: title, image, price), which every collection, search,
 *   recommendation and wishlist read records. A product tapped in a grid always has these.
 *
 * Then the full product is read in the background and replaces what is shown, with `refreshing` true
 * meanwhile rather than a spinner. A full product read under `REVALIDATE_AFTER_MS` ago is not read
 * again. Render `preview` straight away; render what needs variants (the picker, add to cart) once
 * `product` is set.
 *
 * `metafields` / `variantMetafields` (0.23.0): metafields only this page needs, read on its own read on
 * top of the configured ones. They stay with this page (never in the product store or on the device), so
 * `product` is set only by a read that asked for them, each time the page opens (a repeat inside the
 * request cache's short window gets the same answer from memory); `preview` still paints at once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { extraMetafieldsKey, metafieldIds } from '../metafields';
import { peekProduct, toProductBase, type CachedProduct, type ProductBase } from '../productStore';
import { shopify } from '../shopify';
import { useShopify } from './ShopifyProvider';
import { REVALIDATE_AFTER_MS } from './useProductFeed';
import type { ImageTransform, MetafieldIdentifier, Product } from '../types';

export interface UseProductOptions {
  /**
   * Resize/convert the full product's images on Shopify's CDN (the gallery). The first-render
   * `preview.featuredImage` is whatever the grid that showed the product fetched, which is the image
   * already on screen and in the image cache.
   */
  imageTransform?: ImageTransform;
  onError?: (error: unknown, context: { at: string; handle: string }) => void;
  /** Product metafields only this page needs (0.23.0), on top of `ShopifyConfig.productMetafields`. */
  metafields?: readonly MetafieldIdentifier[];
  /** Variant metafields only this page needs (0.23.0), on top of `ShopifyConfig.variantMetafields`. */
  variantMetafields?: readonly MetafieldIdentifier[];
}

/** Whether `product` was read with every one of the page's own metafields. */
function readWith(product: Product | null, own: { metafields: string[]; variantMetafields: string[] }): boolean {
  if (!product) return false;
  return (
    own.metafields.every((id) => product.metafieldsRead?.includes(id)) &&
    own.variantMetafields.every((id) => product.variantMetafieldsRead?.includes(id))
  );
}

export interface UseProductState {
  /** The full product: variants, media, description. Null until known. */
  product: Product | null;
  /** What can render right away: title, image and price. Set whenever anything is known. */
  preview: ProductBase | null;
  /** How much is known: `'full'`, `'base'` (preview only), or null (nothing yet). */
  level: 'full' | 'base' | null;
  /** Nothing to show yet: no cached copy, and the read is in flight. */
  loading: boolean;
  /** A cached copy is on screen while the fresh one is read. */
  refreshing: boolean;
  /** The read failed. A cached copy, if any, is still shown. */
  error: boolean;
  /** Shopify has no product with this handle. */
  notFound: boolean;
}

export interface UseProductResult extends UseProductState {
  /** Read the product from the network again (pull-to-refresh). */
  refresh: () => void;
}

const EMPTY: UseProductState = {
  product: null,
  preview: null,
  level: null,
  loading: false,
  refreshing: false,
  error: false,
  notFound: false,
};

function fromCache(entry: CachedProduct | null, reading: boolean, own: { metafields: string[]; variantMetafields: string[] }): UseProductState {
  if (!entry) return { ...EMPTY, loading: reading };
  // A copy read without the page's own metafields is only a preview here.
  const full = readWith(entry.full, own) ? entry.full : null;
  return {
    product: full,
    preview: entry.base,
    level: full ? 'full' : 'base',
    loading: false,
    refreshing: reading,
    error: false,
    notFound: false,
  };
}

export function useProduct(handle: string | null | undefined, options: UseProductOptions = {}): UseProductResult {
  const { ready } = useShopify();
  const configured = ready || isConfigured();
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const transformKey = options.imageTransform ? JSON.stringify(options.imageTransform) : '';
  const transformRef = useRef(options.imageTransform);
  transformRef.current = options.imageTransform;
  const ownKey = extraMetafieldsKey(options);
  const ownRef = useRef({ metafields: options.metafields, variantMetafields: options.variantMetafields });
  ownRef.current = { metafields: options.metafields, variantMetafields: options.variantMetafields };
  const ownIds = () => ({ metafields: metafieldIds(ownRef.current.metafields ?? []), variantMetafields: metafieldIds(ownRef.current.variantMetafields ?? []) });

  // First render: whatever the store knows, so the page paints on frame one.
  const [state, setState] = useState<UseProductState>(() =>
    fromCache(configured && handle ? peekProduct(handle) : null, !!handle, ownIds()),
  );
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  const freshNext = useRef(false);

  useEffect(() => {
    if (!handle || !configured) {
      requestId.current += 1;
      setState(EMPTY);
      return;
    }
    const id = (requestId.current += 1);
    const fresh = freshNext.current;
    freshNext.current = false;
    const cached = peekProduct(handle);
    const own = ownIds();

    if (cached?.full && readWith(cached.full, own) && !fresh && Date.now() - cached.fullAt < REVALIDATE_AFTER_MS) {
      setState(fromCache(cached, false, own));
      return;
    }
    setState((current) => {
      if (cached) return fromCache(cached, true, own);
      // A refresh keeps what is on screen until the fresh product lands.
      if (fresh && current.preview) return { ...current, refreshing: true, error: false };
      return { ...EMPTY, loading: true };
    });

    shopify.products
      .byHandle(handle, { fresh, imageTransform: transformRef.current, ...ownRef.current })
      .then((product) => {
        if (requestId.current !== id) return;
        if (!product) {
          setState({ ...EMPTY, notFound: true });
          return;
        }
        setState({
          product,
          preview: toProductBase(product),
          level: 'full',
          loading: false,
          refreshing: false,
          error: false,
          notFound: false,
        });
      })
      .catch((caught) => {
        onErrorRef.current?.(caught, { at: 'useProduct', handle });
        if (requestId.current !== id) return;
        // Whatever was shown stays; the page can say the fresh read failed.
        setState((current) => ({ ...current, loading: false, refreshing: false, error: true }));
      });
    // Keyed on the transform's serialisation; the object changes identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, handle, attempt, transformKey, ownKey]);

  const refresh = useCallback(() => {
    freshNext.current = true;
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, refresh };
}
