/**
 * The signed-in shopper's orders: `useOrders` for the list, `useOrder` for one order with Buy again.
 * Either sign-in: Shopify's reads the Customer Account API, email and password the Storefront API
 * (`orders.ts`). Signed out, both are empty, with no error, and send nothing.
 *
 * Fixed from production Amber (the audit's §3.13–3.14):
 * - The list pages by cursor; production stopped at 25 and ignored `hasNextPage`.
 * - A refresh keeps what is on screen, and a failed one keeps it and sets `error`; production
 *   replaced the list with a spinner on every visit.
 * - A refresh asked for while a read is on its way joins it, so a screen that refreshes on focus
 *   doesn't read twice on mount (production did).
 * - Buy again keeps to the stock the store has left (production ignored it).
 *
 * `useLatestOrderSince` (SDK move 6) is the order just placed, for an Order Confirmed page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shopify } from '../shopify';
import {
  customerAccountOrders,
  placedSince,
  planBuyAgain,
  ORDER_CLOCK_LEEWAY_MS,
  storefrontOrders,
  withFreshFirstPage,
  withNextPage,
  type OrderSource,
} from '../orders';
import { quantityInCart } from '../productPage';
import { useCart, useCustomer, type CustomerState } from './ShopifyProvider';
import type { OrderDetails, OrderSummary } from '../types';

/** Orders per page, unless `useOrders({ pageSize })` says otherwise. */
export const ORDERS_PAGE_SIZE = 25;

export interface UseOrdersOptions {
  /** Orders per page. Default `ORDERS_PAGE_SIZE` (25). */
  pageSize?: number;
}

export interface OrdersState {
  /** Newest first. Empty when signed out. */
  orders: OrderSummary[];
  /**
   * True only before the first answer: while a stored session is read on app open, then until the
   * first page arrives. A refresh never sets it; the list stays on screen.
   */
  loading: boolean;
  /** A next page is on its way (`loadMore`). */
  loadingMore: boolean;
  /** The last read failed. Whatever was shown stays. Cleared by the next read that works. */
  error: Error | null;
  /** More orders than are loaded. */
  hasMore: boolean;
  /** Reads the next page. Does nothing while another read is on its way, or when there is no more. */
  loadMore: () => void;
  /**
   * Reads the first page again (pull to refresh, a screen coming back into view), keeping the list on
   * screen and the pages loaded after the first. Joins a read already on its way. Never rejects.
   */
  refresh: () => Promise<void>;
}

export interface BuyAgainResult {
  /**
   * Lines that went into the cart, some perhaps fewer than ordered: cut to the stock left, or by the
   * cart's guard (Cart Hold takes only the units still free). A cut isn't reported.
   */
  added: number;
  /**
   * Lines that didn't: no variant any more, not for sale, `skipVariant` said so, no stock left, or
   * refused by the cart.
   */
  skipped: number;
}

export interface OrderState {
  order: OrderDetails | null;
  /** True only before the first answer (and while a stored session is read on app open). */
  loading: boolean;
  /** The last read failed. An order already shown stays. */
  error: Error | null;
  /** Shopify answered, and this shopper has no order with that id. */
  notFound: boolean;
  /** Reads the order again, keeping it on screen. Joins a read already on its way. Never rejects. */
  refresh: () => Promise<void>;
  /**
   * Puts the order's lines back in the cart through the cart's own add (`addLines`: its guard, its
   * line limit, one `cart:add`). Stock is read fresh first: a line whose variant is gone or not for
   * sale is skipped, and a quantity over what is left (counting what the cart holds) is cut to it.
   * Never throws; anything that fails counts as skipped.
   *
   * `options.skipVariant`: lines whose variant it returns true for are skipped before anything is
   * claimed (the app passes Cart Hold's `isHeldOut`). The add is quiet (`addLines(…, { quiet: true })`):
   * the guard and the line-by-line retry say nothing per line, and the caller shows one summary.
   */
  buyAgain: (options?: { skipVariant?: (variantId: string) => boolean }) => Promise<BuyAgainResult>;
}

function sourceFor(customer: CustomerState): OrderSource {
  return customer.sessionKind === 'shopify'
    ? customerAccountOrders(customer.request)
    : storefrontOrders(customer.getAccessToken);
}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/**
 * Whose orders these are: a new value for each session, and for a different customer within one.
 * Null when signed out. The profile arriving after the session began (app open, sign-in) is the same
 * shopper, so it doesn't count; keying on the profile would read everything twice. Also keys
 * `useStoreCreditHistory`.
 */
export function useShopper(customer: CustomerState): string | null {
  const seen = useRef<{ kind: string | null; id: string | null; count: number }>({ kind: null, id: null, count: 0 });
  const kind = customer.loggedIn ? customer.sessionKind : null;
  const id = customer.customer?.id ?? null;
  const last = seen.current;
  if (kind !== last.kind) {
    last.kind = kind;
    last.id = id;
    last.count += 1;
  } else if (id !== null && last.id !== null && id !== last.id) {
    last.id = id;
    last.count += 1;
  } else if (id !== null) {
    last.id = id;
  }
  return kind ? `${kind}:${last.count}` : null;
}

/** A read on its way, for one shopper, that a second call joins. */
interface Flight {
  owner: string;
  done: Promise<void>;
}

// ── useOrders ──────────────────────────────────────────────────────────────

interface ListState {
  owner: string | null;
  orders: OrderSummary[];
  endCursor: string | null;
  hasMore: boolean;
  answered: boolean;
  loadingMore: boolean;
  error: Error | null;
}

const emptyList = (owner: string | null): ListState => ({
  owner, orders: [], endCursor: null, hasMore: false, answered: false, loadingMore: false, error: null,
});

/** The signed-in shopper's orders, newest first, a page at a time. */
export function useOrders(options: UseOrdersOptions = {}): OrdersState {
  const customer = useCustomer();
  const owner = useShopper(customer);
  const customerRef = useRef(customer);
  customerRef.current = customer;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const pageSizeRef = useRef(ORDERS_PAGE_SIZE);
  pageSizeRef.current = Math.max(1, Math.floor(options.pageSize ?? ORDERS_PAGE_SIZE)) || ORDERS_PAGE_SIZE;

  const [stored, setStored] = useState<ListState>(() => emptyList(owner));
  // Another shopper's orders never show, not even for the render before the effect below clears them.
  const shown = stored.owner === owner ? stored : emptyList(owner);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const firstPage = useRef<Flight | null>(null);
  const nextPage = useRef<{ owner: string } | null>(null);

  const update = useCallback((forOwner: string, change: (state: ListState) => Partial<ListState>) => {
    setStored((state) => (state.owner === forOwner ? { ...state, ...change(state) } : state));
  }, []);

  const readFirstPage = useCallback((): Promise<void> => {
    const forOwner = ownerRef.current;
    if (!forOwner) return Promise.resolve();
    const running = firstPage.current;
    if (running?.owner === forOwner) return running.done;
    // The list's start is about to change, so a next page still on its way would land on the wrong list.
    nextPage.current = null;
    const source = sourceFor(customerRef.current);
    const flight: Flight = { owner: forOwner, done: Promise.resolve() };
    flight.done = (async () => {
      try {
        const page = await source.list(pageSizeRef.current, null);
        update(forOwner, (state) => ({
          ...withFreshFirstPage(state, page), answered: true, loadingMore: false, error: null,
        }));
      } catch (error) {
        update(forOwner, () => ({ answered: true, loadingMore: false, error: toError(error) }));
      } finally {
        if (firstPage.current === flight) firstPage.current = null;
      }
    })();
    firstPage.current = flight;
    return flight.done;
  }, [update]);

  const loadMore = useCallback(() => {
    const forOwner = ownerRef.current;
    const now = shownRef.current;
    if (!forOwner || !now.answered || !now.hasMore || !now.endCursor) return;
    if (firstPage.current?.owner === forOwner || nextPage.current?.owner === forOwner) return;
    const flight = { owner: forOwner };
    nextPage.current = flight;
    const source = sourceFor(customerRef.current);
    const after = now.endCursor;
    update(forOwner, () => ({ loadingMore: true }));
    void (async () => {
      try {
        const page = await source.list(pageSizeRef.current, after);
        if (nextPage.current !== flight) return;
        update(forOwner, (state) => ({ ...withNextPage(state, page), loadingMore: false, error: null }));
      } catch (error) {
        if (nextPage.current !== flight) return;
        update(forOwner, () => ({ loadingMore: false, error: toError(error) }));
      } finally {
        if (nextPage.current === flight) nextPage.current = null;
      }
    })();
  }, [update]);

  // A new shopper (or none) starts from nothing; signed out, nothing is read.
  useEffect(() => {
    setStored((state) => (state.owner === owner ? state : emptyList(owner)));
    if (owner) void readFirstPage();
  }, [owner, readFirstPage]);

  const restoring = customer.restoring && owner === null;
  const loading = restoring || (owner !== null && !shown.answered);
  return useMemo(
    () => ({
      orders: shown.orders,
      loading,
      loadingMore: shown.loadingMore,
      error: shown.error,
      hasMore: shown.hasMore,
      loadMore,
      refresh: readFirstPage,
    }),
    [shown.orders, loading, shown.loadingMore, shown.error, shown.hasMore, loadMore, readFirstPage],
  );
}

// ── useLatestOrderSince ────────────────────────────────────────────────────

/**
 * Shopify can take a few seconds to list a new order: until it does, the newest order is read again
 * after these many seconds.
 */
export const LATEST_ORDER_READ_AGAIN_SECONDS: readonly number[] = [3, 8];

export interface UseLatestOrderSinceOptions {
  /** Seconds after which the newest order is read again while it isn't the new one yet. Default 3 and 8. */
  readAgainAfterSeconds?: readonly number[];
  /** How far the phone's clock may be ahead of Shopify's, in ms. Default `ORDER_CLOCK_LEEWAY_MS` (2 minutes). */
  clockLeewayMs?: number;
}

export interface LatestOrderSince {
  /**
   * The shopper's newest order, once it was placed at or after `since` (less the clock leeway). Null
   * until Shopify lists it, when it never does, and when signed out: no number rather than a wrong one.
   */
  order: OrderSummary | null;
}

/**
 * The order the shopper just placed, for an Order Confirmed page: the newest order, but only once it
 * was placed at or after `since` (when checkout opened, on the phone's clock). Until then the newest
 * is the order before, which production showed. While it isn't listed yet, the newest is read again
 * after 3 and 8 seconds. Signed out, nothing is read and `order` is null (a guest's order isn't known
 * here). `since` left out takes the newest order, whatever its date.
 */
export function useLatestOrderSince(
  since: number | null | undefined,
  options: UseLatestOrderSinceOptions = {},
): LatestOrderSince {
  const customer = useCustomer();
  const { orders, refresh } = useOrders({ pageSize: 1 });
  const newest = orders[0];
  const isTheNewOrder = !!newest && placedSince(newest, since, options.clockLeewayMs ?? ORDER_CLOCK_LEEWAY_MS);

  const readAgainAfterSeconds = options.readAgainAfterSeconds ?? LATEST_ORDER_READ_AGAIN_SECONDS;
  const readAgainRef = useRef(readAgainAfterSeconds);
  readAgainRef.current = readAgainAfterSeconds;
  // By value, so a list written inline doesn't start the timers again on every render.
  const readAgainKey = readAgainAfterSeconds.join(',');

  useEffect(() => {
    if (!customer.loggedIn || isTheNewOrder) return;
    const timers = readAgainRef.current.map((seconds) => setTimeout(() => void refresh(), seconds * 1000));
    return () => timers.forEach(clearTimeout);
  }, [customer.loggedIn, isTheNewOrder, refresh, readAgainKey]);

  return { order: customer.loggedIn && isTheNewOrder ? newest : null };
}

// ── useOrder ───────────────────────────────────────────────────────────────

interface OneState {
  owner: string | null;
  order: OrderDetails | null;
  answered: boolean;
  notFound: boolean;
  error: Error | null;
}

const emptyOrder = (owner: string | null): OneState => ({ owner, order: null, answered: false, notFound: false, error: null });

/** One of the signed-in shopper's orders, by the `id` `useOrders` gave. Nothing is read without an id. */
export function useOrder(id: string | undefined): OrderState {
  const customer = useCustomer();
  const cart = useCart();
  const shopper = useShopper(customer);
  const owner = shopper && id ? `${shopper}|${id}` : null;
  const customerRef = useRef(customer);
  customerRef.current = customer;
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const idRef = useRef(id);
  idRef.current = id;

  const [stored, setStored] = useState<OneState>(() => emptyOrder(owner));
  const shown = stored.owner === owner ? stored : emptyOrder(owner);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const reading = useRef<Flight | null>(null);

  const read = useCallback((): Promise<void> => {
    const forOwner = ownerRef.current;
    const orderId = idRef.current;
    if (!forOwner || !orderId) return Promise.resolve();
    const running = reading.current;
    if (running?.owner === forOwner) return running.done;
    const source = sourceFor(customerRef.current);
    const flight: Flight = { owner: forOwner, done: Promise.resolve() };
    const update = (change: Partial<OneState>) =>
      setStored((state) => (state.owner === forOwner ? { ...state, ...change } : state));
    flight.done = (async () => {
      try {
        const order = await source.get(orderId);
        update({ order, answered: true, notFound: order === null, error: null });
      } catch (error) {
        update({ answered: true, error: toError(error) });
      } finally {
        if (reading.current === flight) reading.current = null;
      }
    })();
    reading.current = flight;
    return flight.done;
  }, []);

  useEffect(() => {
    setStored((state) => (state.owner === owner ? state : emptyOrder(owner)));
    if (owner) void read();
  }, [owner, read]);

  const buyAgain = useCallback(async (
    options: { skipVariant?: (variantId: string) => boolean } = {},
  ): Promise<BuyAgainResult> => {
    const lines = shownRef.current.order?.lineItems ?? [];
    if (lines.length === 0) return { added: 0, skipped: 0 };
    try {
      const variantIds = [...new Set(lines.map((line) => line.variantId).filter((v): v is string => !!v))];
      const variants = variantIds.length > 0 ? await shopify.variants.byIds(variantIds) : [];
      // The cart as it is now, after the stock read: the ref follows every render.
      const { cart: before, addLines } = cartRef.current;
      const plan = planBuyAgain(lines, variants, before, { skipVariant: options.skipVariant });
      if (plan.inputs.length === 0) return { added: 0, skipped: lines.length };
      // Quiet: the caller shows one summary for the whole order, not a message per refused line.
      const after = await addLines(plan.inputs, { quiet: true });
      if (!after) return { added: 0, skipped: lines.length };
      // `addLines` keeps the lines Shopify accepted and drops the rest, so a line landed if its variant
      // grew. A line the guard cut (Cart Hold taking only the units still free) grew too: it counts as
      // added, and the cut isn't reported.
      const added = plan.inputs.filter(
        (input) => quantityInCart(after, input.merchandiseId) > quantityInCart(before, input.merchandiseId),
      ).length;
      return { added, skipped: lines.length - added };
    } catch (error) {
      console.warn('[sdk-shopify] buy again failed', error);
      return { added: 0, skipped: lines.length };
    }
  }, []);

  const restoring = customer.restoring && shopper === null;
  const loading = restoring || (owner !== null && !shown.answered);
  return useMemo(
    () => ({
      order: shown.order,
      loading,
      error: shown.error,
      notFound: shown.notFound,
      refresh: read,
      buyAgain,
    }),
    [shown.order, loading, shown.error, shown.notFound, read, buyAgain],
  );
}
