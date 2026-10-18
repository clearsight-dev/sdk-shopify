/**
 * Products by their Shopify ids, in the order given: a list someone else chose (the products in a
 * clip, a list a PM picked by hand). Read in batches (`shopify.products.byIds`) and kept for the session
 * by id and image size, so a second list naming the same products shows them at once. A product the
 * store no longer has is left out.
 *
 * Every read also lands in the product store, so a product tapped from the list opens with its picker
 * and Add to Cart in the first frame, as a grid's card does.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { shopify } from '../shopify';
import type { ImageTransform, Product } from '../types';
import { useShopify } from './ShopifyProvider';

export interface UseProductsByIdOptions {
  /** Read them. @default true */
  enabled?: boolean;
  /** For the cards' images: a grid's card size keeps them in the same image cache as the grids. */
  imageTransform?: ImageTransform;
  onError?: (error: unknown, context: { at: string; ids: string[] }) => void;
}

export interface ProductsById {
  /** The products in the order of `ids`, without the ones the store no longer has. */
  products: Product[];
  /** The same products by id. */
  byId: Record<string, Product>;
  /** Reading, with some not known yet. */
  loading: boolean;
  /** The last read failed; whatever was known stays. */
  error: boolean;
}

/** This session's reads, by id and image size: a product, or null when the store has none. */
const session = new Map<string, Product | null>();

const keyOf = (id: string, transformKey: string) => `${id}|${transformKey}`;

function known(ids: readonly string[], transformKey: string) {
  const products: Product[] = [];
  const byId: Record<string, Product> = {};
  for (const id of ids) {
    const product = session.get(keyOf(id, transformKey));
    if (product) {
      products.push(product);
      byId[id] = product;
    }
  }
  return { products, byId };
}

export function useProductsById(
  ids: readonly string[] | null | undefined,
  options: UseProductsByIdOptions = {},
): ProductsById {
  const { ready } = useShopify();
  const configured = ready || isConfigured();
  const enabled = options.enabled ?? true;
  const transformKey = options.imageTransform ? JSON.stringify(options.imageTransform) : '';
  const latest = useRef(options);
  latest.current = options;

  // The ids as one key, so a new array with the same ids reads nothing again.
  const wanted = useMemo(() => [...new Set((ids ?? []).filter(Boolean))], [ids]);
  const idsKey = wanted.join(',');

  const [state, setState] = useState<ProductsById>(() => ({
    ...known(wanted, transformKey),
    loading: false,
    error: false,
  }));

  useEffect(() => {
    const list = idsKey ? idsKey.split(',') : [];
    if (!enabled || !configured || list.length === 0) {
      setState({ ...known(list, transformKey), loading: false, error: false });
      return;
    }
    const missing = list.filter((id) => !session.has(keyOf(id, transformKey)));
    if (missing.length === 0) {
      setState({ ...known(list, transformKey), loading: false, error: false });
      return;
    }
    let live = true;
    setState({ ...known(list, transformKey), loading: true, error: false });
    const { imageTransform, onError } = latest.current;
    shopify.products
      .byIds(missing, { keepMissing: true, imageTransform })
      .then((found) => {
        missing.forEach((id, index) => session.set(keyOf(id, transformKey), found[index] ?? null));
        if (live) setState({ ...known(list, transformKey), loading: false, error: false });
      })
      .catch((error) => {
        onError?.(error, { at: 'useProductsById', ids: missing });
        if (live) setState((current) => ({ ...current, loading: false, error: true }));
      });
    return () => {
      live = false;
    };
  }, [idsKey, enabled, configured, transformKey]);

  return state;
}

/** Forget this session's reads (tests, or a new store). */
export function clearProductsById(): void {
  session.clear();
}
