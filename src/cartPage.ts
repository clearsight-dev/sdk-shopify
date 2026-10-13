/**
 * The cart page's rules, without React: what each line shows, the order they show in, and what the
 * summary counts. `useCartPage` (react/useCartPage) puts them together; an app writing its own cart
 * hook uses them directly.
 *
 * Other SDKs add what they know about a line through a `CartExtension`, set once on
 * `ShopifyProvider`'s `cartExtensions`: Cart Hold its reservations, live selling its giveaway prizes.
 * This package can't import them, so they come to it (0.14.0, moved from amore-v2's `useCartPage`).
 */
import { quantityInCart, stockCeiling, withinCeiling } from './productPage';
import type { Cart, CartLine, Money } from './types';

/** A giveaway prize's price on the cart page. */
export interface CartLinePrize {
  /** What one unit costs now (usually nothing, once the store has repriced the line). */
  nowPerUnit: Money;
  /** It is free: the store repriced it to nothing, or the cart's giveaway codes pay for it. */
  costsNothing: boolean;
  /** The full price, to show struck through when it costs less now; null to show none. */
  fullPrice: Money | null;
}

/** What other SDKs know about a cart line, for the cart page. */
export interface CartLineFacts {
  /** When the line's reservation runs out (ms since 1970); null when it isn't held. */
  holdExpiresAt: number | null;
  /** A giveaway prize, with its price; null for any other line. */
  prize: CartLinePrize | null;
  /** A line an app adds itself (a protection fee): no controls, no reservation. */
  isServiceLine: boolean;
}

const NO_FACTS: CartLineFacts = { holdExpiresAt: null, prize: null, isServiceLine: false };

/**
 * How another SDK adds to the cart page: set once on `ShopifyProvider`'s `cartExtensions`, in a list
 * that keeps its identity (a module constant). Every part is optional and must never throw.
 */
export interface CartExtension {
  /** Who it is, for error reports. */
  name: string;
  /** What it knows about a line. Called on every cart change, so keep it cheap and pure. */
  lineFacts?(line: CartLine, cart: Cart): Partial<CartLineFacts>;
  /** + on this line adds a new line rather than raising its quantity (a held line: a unit with its own clock). */
  increaseAddsLine?(line: CartLine): boolean;
  /** When to read the cart again, in ms from `now` (after a reservation runs out, so its line goes). */
  refreshDelays?(cart: Cart, now: number): number[];
  /** A line's reservation has run out, so checkout must wait (`useCheckout().prepare` answers `lapsedHold`). */
  hasLapsedHold?(lines: CartLine[]): boolean;
  /**
   * Every unit of this variant is in other shoppers' carts right now, though Shopify still sells it
   * (Cart Hold just refused it). The product page offers the waitlist for it, and Buy again skips it
   * (0.15.0, `useVariantHeldOut`, `useOrder().buyAgain`).
   */
  isHeldOut?(variantId: string): boolean;
  /** Tells `listener` whenever `isHeldOut` may answer differently; returns the way to stop. */
  subscribeHeldOut?(listener: () => void): () => void;
}

/** One extension's answer, or nothing when it throws: an extension never breaks the cart. */
function ask<T>(extension: CartExtension, question: () => T | undefined): T | undefined {
  try {
    return question();
  } catch (error) {
    console.warn(`[cartExtensions] ${extension.name} failed`, error);
    return undefined;
  }
}

/**
 * What every extension knows about a line, later ones over earlier ones. A prize or a service line is
 * never shown as held: neither has controls, and a reservation clock on it would only confuse.
 */
export function cartLineFacts(line: CartLine, cart: Cart, extensions: readonly CartExtension[]): CartLineFacts {
  let facts: CartLineFacts = NO_FACTS;
  for (const extension of extensions) {
    if (!extension.lineFacts) continue;
    const found = ask(extension, () => extension.lineFacts?.(line, cart));
    if (found) facts = { ...facts, ...found };
  }
  return facts.prize || facts.isServiceLine ? { ...facts, holdExpiresAt: null } : facts;
}

/** + on this line adds a new line: an extension says so, and it isn't a pre-order (which grows in place). */
export function increaseAddsLine(line: CartLine, extensions: readonly CartExtension[]): boolean {
  if (line.sellingPlanId) return false;
  return extensions.some((extension) => ask(extension, () => extension.increaseAddsLine?.(line)) === true);
}

/** Some extension says every unit of this variant is in other shoppers' carts (`CartExtension.isHeldOut`). */
export function isVariantHeldOut(variantId: string | null | undefined, extensions: readonly CartExtension[]): boolean {
  if (!variantId) return false;
  return extensions.some((extension) => ask(extension, () => extension.isHeldOut?.(variantId)) === true);
}

/** Every extension's re-reads, soonest first, without repeats. */
export function cartRefreshDelays(cart: Cart, now: number, extensions: readonly CartExtension[]): number[] {
  const delays = extensions.flatMap((extension) => ask(extension, () => extension.refreshDelays?.(cart, now)) ?? []);
  return [...new Set(delays.filter((delay) => Number.isFinite(delay) && delay > 0))].sort((a, b) => a - b);
}

/** Some extension says a reservation in these lines has run out. */
export function hasLapsedHoldIn(lines: CartLine[], extensions: readonly CartExtension[]): boolean {
  return extensions.some((extension) => ask(extension, () => extension.hasLapsedHold?.(lines)) === true);
}

/**
 * The order lines show in. Shopify lists a cart's newest line first (`newestFirst`, its own order);
 * `oldestFirst` puts a line just added at the bottom, so a list of lines stays where the shopper is
 * (amore-v2, decided 2026-10-09).
 */
export type CartLineOrder = 'newestFirst' | 'oldestFirst';

export function orderCartLines(lines: readonly CartLine[], order: CartLineOrder = 'newestFirst'): CartLine[] {
  return order === 'oldestFirst' ? [...lines].reverse() : [...lines];
}

/** + can add one more: a pre-order always can; any other line, while the cart holds less than its stock. */
export function canIncreaseLine(line: CartLine, cart: Pick<Cart, 'lines'> | null | undefined): boolean {
  return !!line.sellingPlanId || withinCeiling(stockCeiling(line.merchandise), quantityInCart(cart, line.merchandise.id));
}

/**
 * A pre-order line (bought on a selling plan): what checkout takes for the whole line now and what is
 * charged when it ships. Null for any other line. Either amount is null when the cart was read before
 * the SDK asked for it.
 */
export function preorderAmounts(line: CartLine): { dueNow: Money | null; dueLater: Money | null } | null {
  if (!line.sellingPlanId) return null;
  return { dueNow: line.sellingPlan?.checkoutCharge ?? null, dueLater: line.sellingPlan?.remainingBalance ?? null };
}

/**
 * What the cart's pre-order lines leave to be charged when they ship (each line's plan says it, for the
 * whole line), so a summary can count what checkout takes now. A pre-order line whose amount wasn't read
 * falls back on Shopify's `checkoutChargeAmount` (the subtotal less everything deferred); with neither,
 * null: keep Shopify's full figures rather than guess (a missing amount is unknown, never 0).
 */
export function amountChargedWhenShipped(cart: Cart | null | undefined): number | null {
  if (!cart) return 0;
  let later = 0;
  for (const line of cart.lines) {
    if (!line.sellingPlanId) continue;
    const remaining = line.sellingPlan?.remainingBalance;
    if (!remaining) {
      const dueNow = cart.cost.checkoutChargeAmount;
      if (!dueNow) return null;
      return Math.max(0, Number(cart.cost.subtotalAmount.amount) - Number(dueNow.amount));
    }
    later += Number(remaining.amount);
  }
  return Number.isFinite(later) ? later : null;
}

/** What a cart costs now, for a summary: every figure a `Money`, for the app to format. */
export interface CartAmountsDueNow {
  /** The subtotal less what pre-order lines leave until they ship; null with no cart. */
  subtotalNow: Money | null;
  /** The whole cart's discounts, but not one off shipping; null when there are none. */
  orderDiscount: Money | null;
  /** The codes behind `orderDiscount`, by name (an automatic discount has none). */
  orderDiscountCodes: string[];
  /** The store credit's gift cards; null when none is on the cart. */
  storeCredit: Money | null;
  /** `subtotalNow` less the order discount and the store credit, never below 0; before tax. */
  totalNow: Money | null;
}

/**
 * The summary's figures (amore-v2's "Option A", decided 2026-10-08): the subtotal, less what pre-order
 * lines leave for later; then what comes off it, each from what Shopify says it is (the whole cart's
 * discounts, not one off shipping, since a store's automatic free shipping sits on every cart before any
 * shipping is charged; the store credit's gift cards); and the total. Never Shopify's `totalAmount`,
 * which may or may not count a gift card. Counted in cents, so $0.10 three times is $0.30.
 */
export function cartAmountsDueNow(cart: Cart | null | undefined): CartAmountsDueNow {
  const subtotalNow = lessDeferred(cart?.cost.subtotalAmount, amountChargedWhenShipped(cart));
  const orderDiscounts = (cart?.discounts ?? []).filter((discount) => !discount.onShipping);
  const orderDiscountCents = orderDiscounts.reduce((sum, discount) => sum + centsOf(discount.amount), 0);
  const creditCents = (cart?.appliedGiftCards ?? []).reduce((sum, card) => sum + centsOf(card.presentmentAmountUsed), 0);
  const currencyCode = subtotalNow?.currencyCode;
  const asMoney = (cents: number): Money | null => (currencyCode ? { amount: (cents / 100).toFixed(2), currencyCode } : null);
  return {
    subtotalNow: subtotalNow ?? null,
    orderDiscount: orderDiscountCents > 0 ? asMoney(orderDiscountCents) : null,
    orderDiscountCodes: [...new Set(orderDiscounts.map((discount) => discount.code).filter((code): code is string => !!code))],
    storeCredit: creditCents > 0 ? asMoney(creditCents) : null,
    totalNow: subtotalNow ? asMoney(Math.max(0, centsOf(subtotalNow) - orderDiscountCents - creditCents)) : null,
  };
}

/** An amount in cents, counted whole; nothing for a missing or unreadable one. */
function centsOf(money: Money | null | undefined): number {
  const cents = Math.round(Number(money?.amount ?? 0) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

/** An amount less what's charged later, never below 0; unchanged when that isn't known. */
function lessDeferred(money: Money | undefined, deferred: number | null): Money | undefined {
  if (!money || deferred === null || deferred <= 0) return money;
  return { amount: Math.max(0, Number(money.amount) - deferred).toFixed(2), currencyCode: money.currencyCode };
}
