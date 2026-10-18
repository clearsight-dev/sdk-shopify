/**
 * Products from the shopper's past orders (0.17.0), for a "buy again" row: the products on their
 * newest orders, newest first, each once, with the size they bought. Either sign-in, as `useOrders`:
 *
 * 1. One read of the orders: each line's product and variant ids (`orderedProducts` in `orders.ts`;
 *    the Customer Account API for a Shopify sign-in, the Storefront API for email and password).
 * 2. One read of the products, through `useProductsById` (a `nodes(ids:)` batch, kept for the session),
 *    so a product already shown elsewhere isn't read again.
 *
 * A product the store no longer has is left out, and the next one is read in its place. Signed out,
 * nothing is read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrderedProduct } from '../orders';
import type { ImageTransform, Product } from '../types';
import { useCustomer } from './ShopifyProvider';
import { sourceFor, useShopper } from './useOrders';
import { isGoneFromStore, useProductsById } from './useProductsById';

/** Orders read unless `orders` says otherwise, and products shown unless `limit` does. */
export const PAST_ORDERS_READ = 5;
export const PAST_ORDER_PRODUCTS_SHOWN = 12;

export interface UsePastOrderProductsOptions {
  /** How many of the newest orders the products come from. Default 5; rounded, 1–10. */
  orders?: number;
  /** Products shown, at most. Default 12; rounded, 1–24. */
  limit?: number;
  /** For the cards' images: a grid's card size keeps them in the same image cache as the grids. */
  imageTransform?: ImageTransform;
  /** Read and show them. Off: none, and nothing read. @default true */
  enabled?: boolean;
}

export interface PastOrderItem {
  product: Product;
  /** The variant (size) bought; null when the product no longer has it. */
  variantId: string | null;
  /** When the order was placed (its `processedAt`). */
  orderedAt: string;
}

export interface PastOrderProducts {
  /** `items`' products, in the same order. */
  products: Product[];
  /**
   * Newest order first, each product once (from its newest order), at most `limit`. Products the
   * store no longer has are left out.
   */
  items: PastOrderItem[];
  /**
   * Nothing to show yet: while a stored session is read on app open, then until the orders and their
   * products arrive. A refresh keeps what is shown.
   */
  loading: boolean;
  /** The last read (of the orders or the products) failed; whatever was shown stays. */
  error: boolean;
  signedIn: boolean;
  /**
   * Reads the orders again (pull to refresh), keeping what is shown; a product already read this
   * session is reused. Joins a read already on its way.
   */
  refresh(): void;
}

function wholeNumberIn(value: unknown, fallback: number, lowest: number, highest: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(highest, Math.max(lowest, Math.round(value)));
}

/** The variant bought, while the product (as read: its first 100 variants) still has it. */
function variantStillThere(product: Product, variantId: string | null): string | null {
  return variantId && product.variants.some((variant) => variant.id === variantId) ? variantId : null;
}

interface OrdersRead {
  /** Whose orders, and how many: a new value starts from nothing. Null when nothing is to be read. */
  owner: string | null;
  ordered: OrderedProduct[];
  answered: boolean;
  error: boolean;
}

const nothingRead = (owner: string | null): OrdersRead => ({ owner, ordered: [], answered: false, error: false });

export function usePastOrderProducts(options: UsePastOrderProductsOptions = {}): PastOrderProducts {
  const customer = useCustomer();
  const shopper = useShopper(customer);
  const enabled = options.enabled ?? true;
  const orderCount = wholeNumberIn(options.orders, PAST_ORDERS_READ, 1, 10);
  const shown = wholeNumberIn(options.limit, PAST_ORDER_PRODUCTS_SHOWN, 1, 24);
  const { imageTransform } = options;
  const owner = enabled && shopper ? `${shopper}|${orderCount}` : null;

  const customerRef = useRef(customer);
  customerRef.current = customer;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const orderCountRef = useRef(orderCount);
  orderCountRef.current = orderCount;

  const [stored, setStored] = useState<OrdersRead>(() => nothingRead(owner));
  // Another shopper's products never show, not even for the render before the effect below clears them.
  const read = stored.owner === owner ? stored : nothingRead(owner);
  const reading = useRef<{ owner: string; done: Promise<void> } | null>(null);

  const readOrders = useCallback((): Promise<void> => {
    const forOwner = ownerRef.current;
    if (!forOwner) return Promise.resolve();
    if (reading.current?.owner === forOwner) return reading.current.done;
    const source = sourceFor(customerRef.current);
    const update = (change: Partial<OrdersRead>) =>
      setStored((state) => (state.owner === forOwner ? { ...state, ...change } : state));
    const flight = { owner: forOwner, done: Promise.resolve() };
    flight.done = (async () => {
      try {
        const ordered = await source.orderedProducts(orderCountRef.current);
        update({ ordered, answered: true, error: false });
      } catch {
        update({ answered: true, error: true });
      } finally {
        if (reading.current === flight) reading.current = null;
      }
    })();
    reading.current = flight;
    return flight.done;
  }, []);

  // A new shopper (or none) starts from nothing; signed out, nothing is read.
  useEffect(() => {
    setStored((state) => (state.owner === owner ? state : nothingRead(owner)));
    if (owner) void readOrders();
  }, [owner, readOrders]);

  const refresh = useCallback(() => {
    void readOrders();
  }, [readOrders]);

  // A product found gone is left out at once, so the next one is read in its place.
  const wanted = read.ordered.filter((item) => !isGoneFromStore(item.productId, imageTransform)).slice(0, shown);
  const found = useProductsById(
    wanted.map((item) => item.productId),
    { enabled: owner !== null, imageTransform },
  );
  const wantedKey = wanted.map((item) => item.productId).join(',');
  const items = useMemo(() => {
    const list: PastOrderItem[] = [];
    for (const item of wanted) {
      const product = found.byId[item.productId];
      if (product) list.push({ product, variantId: variantStillThere(product, item.variantId), orderedAt: item.orderedAt });
    }
    return list;
    // `wanted` follows `read.ordered` and `wantedKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read.ordered, wantedKey, found.byId]);
  const products = useMemo(() => items.map((item) => item.product), [items]);

  // A product not here yet is on its way: `found` can be a render behind a new list of ids.
  const productsComing = !found.error && wanted.some((item) => !found.byId[item.productId]);
  const restoring = enabled && customer.restoring && shopper === null;
  const loading = restoring || (owner !== null && (!read.answered || productsComing));
  const error = read.error || found.error;
  const signedIn = customer.loggedIn;
  return useMemo(
    () => ({ products, items, loading, error, signedIn, refresh }),
    [products, items, loading, error, signedIn, refresh],
  );
}
