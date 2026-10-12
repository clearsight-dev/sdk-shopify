import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canIncreaseLine,
  cartAmountsDueNow,
  cartLineFacts,
  cartRefreshDelays,
  increaseAddsLine,
  orderCartLines,
  preorderAmounts,
  type CartAmountsDueNow,
  type CartLineFacts,
  type CartLineOrder,
} from "../cartPage";
import type { CheckoutPreparation } from "../checkout";
import { stockCeiling } from "../productPage";
import type { Cart, CartLine, Money } from "../types";
import { useCheckout, useShopify } from "./ShopifyProvider";
import { useAppDiscountCode } from "./useAppDiscountCode";

export interface UseCartPageOptions {
  /** The order lines show in (default `newestFirst`, Shopify's). See `orderCartLines`. */
  lineOrder?: CartLineOrder;
  /** The app's own discount code, applied once per cart and kept with the codes already on it. */
  appDiscountCode?: string | null;
  /** A write that failed in the background: the note (`at: 'cart.note'`), the app's code (`at: 'cart.appDiscountCode'`). */
  onError?: (error: unknown, context: { at: string }) => void;
}

/** One line as the cart page shows it: the line, what other SDKs know about it, and what it can do. */
export interface CartPageLine extends CartLineFacts {
  id: string;
  line: CartLine;
  quantity: number;
  /** What one unit costs: a prize's price now, any other line's price. */
  unitPrice: Money;
  /** + can add one more (a pre-order always can; any other line, up to its stock). */
  canIncrease: boolean;
  /** A pre-order line's amounts, now and when it ships; null for any other line. */
  preOrder: { dueNow: Money | null; dueLater: Money | null } | null;
  /** A write on this line is running. */
  busy: boolean;
}

export interface CartPage {
  /** `loading` until the cart is first read; then `empty` or `ready`. */
  status: "loading" | "empty" | "ready";
  cart: Cart | null;
  /** In `lineOrder`. */
  lines: CartPageLine[];
  /** The summary's figures (`cartAmountsDueNow`). */
  amounts: CartAmountsDueNow;
  /** The line + just added (on a line that adds a new one), for a list to scroll to; null otherwise. */
  justAddedLineId: string | null;
  increase: (lineId: string) => void;
  /** At 1, removes the line. */
  decrease: (lineId: string) => void;
  remove: (lineId: string) => void;
  note: { value: string | null; save: (note: string | null) => Promise<boolean> };
  checkout: {
    /** Waits for a note still saving, reports `checkout:started`, then `useCheckout().prepare`. Never throws. */
    start: () => Promise<CheckoutPreparation>;
    starting: boolean;
  };
  /** Call each time the page comes into view: reports `cart:viewed`. */
  viewed: () => void;
  refresh: () => Promise<Cart | null>;
}

const NO_LINES: ReadonlySet<string> = new Set();

/**
 * Everything a cart page needs, in the style of `useProductPage` (0.14.0, moved from amore-v2's
 * `useCartPage`): the lines with their facts, the summary's figures, the writes, the note and checkout.
 * No words, no formatting, no navigation: the app maps it onto its own components.
 *
 * - **+ on a line an extension marks (Cart Hold: a reserved line) adds a new line** with its own
 *   reservation; `justAddedLineId` names it once the add lands. Otherwise + and − change the line; − at 1
 *   removes it. A pre-order line always grows in place.
 * - **Line facts** come from the provider's `cartExtensions` (`cartLineFacts`): a reservation's expiry,
 *   a giveaway prize and its price, a service line. A prize or service line shows no reservation.
 * - **The cart is read again** when an extension asks (Cart Hold: after a reservation runs out, so the
 *   swept line goes).
 * - **Checkout** waits for a note still saving, reports `checkout:started` (with the cart's shows), then
 *   prepares the cart (`useCheckout().prepare`, which asks the extensions about a lapsed reservation).
 *
 * An app that needs other rules writes its own hook from the same pieces: `useCart`, `useCheckout`,
 * `cartLineFacts`, `orderCartLines`, `canIncreaseLine`, `preorderAmounts`, `cartAmountsDueNow`.
 */
export function useCartPage(options: UseCartPageOptions = {}): CartPage {
  const { lineOrder = "newestFirst", appDiscountCode, onError } = options;
  const { cart: cartState, cartPage } = useShopify();
  const { cart, loading, addLine, updateLine, removeLine, updateNote, refresh } = cartState;
  const { prepare, preparing } = useCheckout();
  const extensions = cartPage.extensions;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const reportError = useCallback((error: unknown, at: string) => {
    try {
      onErrorRef.current?.(error, { at });
    } catch {
      // A failing reporter must not fail the cart.
    }
  }, []);

  const cartRef = useRef<Cart | null>(cart);
  cartRef.current = cart;

  useAppDiscountCode(appDiscountCode, { onError: (error) => reportError(error, "cart.appDiscountCode") });

  // Read the cart again when an extension asks (after a reservation runs out).
  useEffect(() => {
    if (!cart) return;
    const timers = cartRefreshDelays(cart, Date.now(), extensions).map((delay) =>
      setTimeout(() => {
        refresh().catch(() => undefined);
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [cart, extensions, refresh]);

  const [busyLineIds, setBusyLineIds] = useState<ReadonlySet<string>>(NO_LINES);
  const [justAddedLineId, setJustAddedLineId] = useState<string | null>(null);

  const withLineBusy = useCallback(async (lineId: string, write: () => Promise<unknown>) => {
    setBusyLineIds((current) => new Set(current).add(lineId));
    try {
      await write();
    } catch {
      // The provider has already raised the write's alert.
    } finally {
      setBusyLineIds((current) => {
        const next = new Set(current);
        next.delete(lineId);
        return next;
      });
    }
  }, []);

  const lineById = useCallback((id: string) => cartRef.current?.lines.find((line) => line.id === id) ?? null, []);

  const increase = useCallback(
    (id: string) => {
      const line = lineById(id);
      if (!line) return;
      if (increaseAddsLine(line, extensions)) {
        const linesBefore = new Set((cartRef.current?.lines ?? []).map((cartLine) => cartLine.id));
        void withLineBusy(id, async () => {
          const result = await addLine({ merchandiseId: line.merchandise.id, quantity: 1, maxQuantity: stockCeiling(line.merchandise) });
          const added = result.ok ? result.cart?.lines.find((cartLine) => !linesBefore.has(cartLine.id)) : undefined;
          if (added) setJustAddedLineId(added.id);
        });
        return;
      }
      void withLineBusy(id, () => updateLine(id, line.quantity + 1));
    },
    [addLine, extensions, lineById, updateLine, withLineBusy],
  );

  const decrease = useCallback(
    (id: string) => {
      const line = lineById(id);
      if (!line) return;
      void withLineBusy(id, () => (line.quantity <= 1 ? removeLine(id) : updateLine(id, line.quantity - 1)));
    },
    [lineById, removeLine, updateLine, withLineBusy],
  );

  const remove = useCallback((id: string) => void withLineBusy(id, () => removeLine(id)), [removeLine, withLineBusy]);

  const noteSaving = useRef<Promise<boolean> | null>(null);
  const saveNote = useCallback(
    async (note: string | null) => {
      const saving = updateNote(note).then(
        () => true,
        (error: unknown) => {
          reportError(error, "cart.note");
          return false;
        },
      );
      noteSaving.current = saving;
      try {
        return await saving;
      } finally {
        if (noteSaving.current === saving) noteSaving.current = null;
      }
    },
    [reportError, updateNote],
  );

  const start = useCallback(async (): Promise<CheckoutPreparation> => {
    if (noteSaving.current) await noteSaving.current;
    cartPage.reportCheckoutStarted(cartRef.current);
    return prepare();
  }, [cartPage, prepare]);

  const viewed = useCallback(() => cartPage.reportViewed(cartRef.current), [cartPage]);

  const lines = useMemo<CartPageLine[]>(() => {
    if (!cart) return [];
    return orderCartLines(cart.lines, lineOrder).map((line) => {
      const facts = cartLineFacts(line, cart, extensions);
      return {
        ...facts,
        id: line.id,
        line,
        quantity: line.quantity,
        unitPrice: facts.prize ? facts.prize.nowPerUnit : line.merchandise.price,
        canIncrease: canIncreaseLine(line, cart),
        preOrder: preorderAmounts(line),
        busy: busyLineIds.has(line.id),
      };
    });
  }, [cart, lineOrder, extensions, busyLineIds]);

  const amounts = useMemo(() => cartAmountsDueNow(cart), [cart]);
  const lineCount = cart?.lines.length ?? 0;

  return {
    status: lineCount > 0 ? "ready" : loading ? "loading" : "empty",
    cart,
    lines,
    amounts,
    justAddedLineId,
    increase,
    decrease,
    remove,
    note: { value: cart?.note ?? null, save: saveNote },
    checkout: { start, starting: preparing },
    viewed,
    refresh,
  };
}
