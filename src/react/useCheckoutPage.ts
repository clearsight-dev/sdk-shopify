import { useCallback, useEffect, useRef } from "react";
import { showsInCart } from "../attribution";
import type { Cart } from "../types";
import { useShopify } from "./ShopifyProvider";

export interface UseCheckoutPageOptions {
  /**
   * A checkout of its own link (an auction's wins, which have a cart of their own), in place of the
   * shopper's cart. Its order leaves the shopper's cart alone.
   */
  checkoutUrl?: string | null;
  /** What a checkout of its own link is for, carried on `checkout:completed` (`auctionWins`). */
  source?: string;
  /**
   * The order was placed: the app shows its thank-you page in this one's place. `checkoutOpenedAt`
   * tells the new order from the one before (`useOrderConfirmation`).
   */
  onOrderPlaced?: (placed: { checkoutOpenedAt: number }) => void;
}

export interface CheckoutPage {
  /**
   * What the checkout's web view loads: the link given, else the cart's. Null once the cart has no
   * lines: Shopify serves a dead page for an emptied cart's link, so the app says the cart is empty.
   */
  url: string | null;
  /**
   * Call when the web view reaches a page that says the order is placed (`isOrderPlacedUrl`). Only the
   * first call counts, however often that page reports itself.
   */
  orderPlaced: () => void;
  /** When this page opened, on the phone's clock. */
  openedAt: number;
}

/**
 * A checkout page (0.15.0, moved from amore-v2's `useCheckoutPage`): Shopify's hosted checkout for the
 * cart, or for a link of its own, in the app's web view, and what happens when the order lands.
 *
 * - **The order lands** (`orderPlaced`): `checkout:completed` is raised with the cart as it was and the
 *   shows it holds units from (the analytics SDK reports `purchase`, and `streamPurchase` for a show's
 *   units; Cart Assist marks the cart checked out). Then `onOrderPlaced` (the app replaces this page
 *   with its thank-you page), and only then `reportOrderPlaced`, which announces the order and starts a
 *   fresh cart: after leaving, as the fresh cart's link would otherwise reload this page's checkout for
 *   a moment.
 * - **A checkout of its own link** (`checkoutUrl`) raises `checkout:completed` with its `source` and no
 *   cart, and leaves the shopper's cart alone: marking that cart spent would empty it on the next sync.
 * - **The cart empties while checkout is open** (a reservation ran out and Cart Hold's sweep took the
 *   line): `checkout:reservationExpired` (its alert says so), and `url` turns null.
 *
 * An app with other rules builds its own from `useCart`, `useCheckout().reportOrderPlaced`,
 * `showsInCart` and `isOrderPlacedUrl`.
 */
export function useCheckoutPage(options: UseCheckoutPageOptions = {}): CheckoutPage {
  const { cart: cartState, checkout, report } = useShopify();
  const cart = cartState.cart;
  const ownLink = !!options.checkoutUrl;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const openedAt = useRef(Date.now()).current;
  const cartRef = useRef<Cart | null>(cart);
  cartRef.current = cart;
  const orderLanded = useRef(false);

  // The reservation ran out under an open checkout of the cart.
  const hadLines = useRef(false);
  const lineCount = cart?.lines.length ?? 0;
  useEffect(() => {
    if (ownLink || orderLanded.current) return;
    if (lineCount > 0) {
      hadLines.current = true;
    } else if (hadLines.current) {
      hadLines.current = false;
      report("checkout:reservationExpired");
    }
  }, [lineCount, ownLink, report]);

  const reportOrderPlaced = checkout.reportOrderPlaced;
  const orderPlaced = useCallback(() => {
    if (orderLanded.current) return;
    orderLanded.current = true;
    const { checkoutUrl, source, onOrderPlaced } = optionsRef.current;
    const ofOwnLink = !!checkoutUrl;
    if (ofOwnLink) {
      report("checkout:completed", source ? { source } : undefined);
    } else {
      // The cart as placed, and its shows, before the reset below takes its lines away.
      const placed = cartRef.current;
      report("checkout:completed", placed ? { cart: placed, shows: showsInCart(placed) } : { shows: showsInCart(null) });
    }
    try {
      onOrderPlaced?.({ checkoutOpenedAt: openedAt });
    } catch (routeError) {
      console.warn("[sdk-shopify] onOrderPlaced threw", routeError);
    }
    if (!ofOwnLink) void reportOrderPlaced().catch(() => undefined);
  }, [openedAt, report, reportOrderPlaced]);

  return {
    url: options.checkoutUrl ?? (lineCount > 0 ? cart?.checkoutUrl ?? null : null),
    orderPlaced,
    openedAt,
  };
}
