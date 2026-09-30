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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { peekProduct, type CachedProduct, type ProductBase } from '../productStore';
import { shopify } from '../shopify';
import { useShopify } from './ShopifyProvider';
import { REVALIDATE_AFTER_MS } from './useProductFeed';
import type { Product } from '../types';

export interface UseProductOptions {
  onError?: (error: unknown, context: { at: string; handle: string }) => void;
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

function fromCache(entry: CachedProduct | null, reading: boolean): UseProductState {
  if (!entry) return { ...EMPTY, loading: reading };
  const full = entry.full;
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

  // First render: whatever the store knows, so the page paints on frame one.
  const [state, setState] = useState<UseProductState>(() =>
    fromCache(configured && handle ? peekProduct(handle) : null, !!handle),
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

    if (cached?.full && !fresh && Date.now() - cached.fullAt < REVALIDATE_AFTER_MS) {
      setState(fromCache(cached, false));
      return;
    }
    setState((current) => {
      if (cached) return fromCache(cached, true);
      // A refresh keeps what is on screen until the fresh product lands.
      if (fresh && current.preview) return { ...current, refreshing: true, error: false };
      return { ...EMPTY, loading: true };
    });

    shopify.products
      .byHandle(handle, { fresh })
      .then((product) => {
        if (requestId.current !== id) return;
        if (!product) {
          setState({ ...EMPTY, notFound: true });
          return;
        }
        setState({
          product,
          preview: {
            id: product.id,
            handle: product.handle,
            title: product.title,
            featuredImage: product.featuredImage ?? null,
            priceRange: product.priceRange,
            compareAtPriceRange: product.compareAtPriceRange ?? null,
          },
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
  }, [configured, handle, attempt]);

  const refresh = useCallback(() => {
    freshNext.current = true;
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, refresh };
}
