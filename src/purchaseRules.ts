/**
 * What a shopper can do with one size: pre-order it, buy it, or neither (SDK move 6). One rule for every
 * screen that sells a size, so a product page and a waitlist card never disagree again:
 *
 * - `preorderPlanFor(variant, { blocked })`: the plan to pre-order on, or null.
 * - `purchaseModeFor(...)`: what a product page's buy bar offers.
 * - `waitlistActionFor(variant, cart, { blocked })`: what a waitlist card's button does.
 *
 * From amore-v2, whose product page (`preorderPlanFor` and the bar's mode) and Waitlist (`canPreOrder`)
 * had two rules that disagreed in two cases. The Head of Engineering decided both on 2026-10-06, for the
 * product page's rule:
 *
 * - **Stock not tracked** (`quantityAvailable` null), for sale, with a plan: "Add to Cart". Untracked
 *   stock is always available, and pre-order applies only when Shopify says the size is sold out. (The
 *   Waitlist counted null as 0 and offered Preauthorize Now.)
 * - **A sold-out size with a plan on a blocked product** (an auction: `SEARCH-BLOCKED`): "Auction
 *   notice wins". It can't be pre-ordered anywhere, and a waitlist card shows it as not buyable too.
 *   (The Waitlist didn't know about auctions and offered Preauthorize Now.)
 *
 * Pure: no React, no network.
 */
import { quantityInCart, stockCeiling, withinCeiling } from './productPage';
import type { Cart } from './types';

/** Just what the pre-order rule reads of a variant: a product page's `ProductVariant` or a waitlist's `StandaloneVariant`. */
export interface PreorderVariant<Plan extends { id: string } = { id: string; name: string }> {
  /** The variant's own selling plan (a pre-order), or null. */
  sellingPlan?: Plan | null;
  availableForSale: boolean;
  /** Units left; null when Shopify doesn't track the stock. */
  quantityAvailable: number | null;
}

export interface PreorderOptions {
  /**
   * The product can't be bought at all right now (an auction: the product page's `isBlocked`, status
   * `blocked`). Nothing is pre-ordered then.
   */
  blocked?: boolean;
}

/**
 * The plan to pre-order this size on, or null. A size is pre-ordered when it is sold out (Shopify's
 * count is known and 0 or less), still for sale, and enrolled in a plan of its own
 * (`variant.sellingPlan`, which also names the plan to add with). Never when `blocked`.
 *
 * - A count Shopify doesn't track (null) isn't sold out: that size is bought ("Add to Cart", decided
 *   2026-10-06).
 * - An oversold count (below 0) is sold out.
 */
export function preorderPlanFor<Plan extends { id: string }>(
  variant: PreorderVariant<Plan> | null | undefined,
  options: PreorderOptions = {},
): Plan | null {
  if (options.blocked) return null;
  if (!variant?.sellingPlan || !variant.availableForSale) return null;
  const unitsLeft = variant.quantityAvailable;
  return unitsLeft != null && unitsLeft <= 0 ? variant.sellingPlan : null;
}

/**
 * What a product page's buy bar offers, in this order (the first that applies):
 *
 * - `blocked`: the product can't be bought (an auction). Wins over everything, a pre-order included.
 * - `preorder`: `preorderPlanFor` has a plan for the chosen size.
 * - `soldOut`: the chosen size can't be bought (the page's status `unavailable`).
 * - `heldInOtherCarts`: a reservation service just refused it: every unit is in other carts, though
 *   Shopify still calls it sellable (Cart Hold's held out).
 * - `allInCart`: this cart already holds every unit Shopify has (`canAddMore` is false).
 * - `buy`: anything else, including while the page is still loading.
 */
export type PurchaseMode = 'blocked' | 'preorder' | 'soldOut' | 'heldInOtherCarts' | 'allInCart' | 'buy';

export interface PurchaseModeInput {
  /** `useProductPage().status`. */
  status: 'loading' | 'unknown' | 'available' | 'unavailable' | 'blocked';
  /** The chosen size (`useProductPage().selection.variant`). */
  variant: PreorderVariant | null | undefined;
  /** One more of the chosen size fits under its stock (`useProductPage().cart.canAddMore`). */
  canAddMore: boolean;
  /** A reservation service just refused this size as sold out (Cart Hold's `useHeldOut`). */
  heldInOtherCarts?: boolean;
}

/** What a product page's buy bar offers for the chosen size. See `PurchaseMode`. */
export function purchaseModeFor({ status, variant, canAddMore, heldInOtherCarts = false }: PurchaseModeInput): PurchaseMode {
  if (status === 'blocked') return 'blocked';
  if (preorderPlanFor(variant)) return 'preorder';
  if (status === 'unavailable') return 'soldOut';
  if (heldInOtherCarts) return 'heldInOtherCarts';
  if (variant && status === 'available' && !canAddMore) return 'allInCart';
  return 'buy';
}

/**
 * What a waitlist card's button does for a size the shopper waits on:
 *
 * - `blocked`: the product can't be bought (an auction), whatever its stock or plan. Shown as not
 *   buyable ("Auction notice wins", decided 2026-10-06).
 * - `preorder`: `preorderPlanFor` has a plan.
 * - `addToCart`: back in stock (for sale, with units left or a count Shopify doesn't track) with a unit
 *   beyond what the cart already holds (the product page's `canAddMore` rule).
 * - `inCart`: back in stock, but the cart already holds every unit.
 * - `waiting`: anything else (sold out, or no longer for sale).
 */
export type WaitlistAction = 'blocked' | 'preorder' | 'addToCart' | 'inCart' | 'waiting';

/** What a waitlist card offers for this size, given the cart. See `WaitlistAction`. */
export function waitlistActionFor(
  variant: PreorderVariant & { id: string },
  cart: Pick<Cart, 'lines'> | null | undefined,
  options: PreorderOptions = {},
): WaitlistAction {
  if (options.blocked) return 'blocked';
  if (preorderPlanFor(variant)) return 'preorder';
  const inStock = variant.availableForSale && (variant.quantityAvailable == null || variant.quantityAvailable > 0);
  if (!inStock) return 'waiting';
  const inThisCart = quantityInCart(cart, variant.id);
  if (withinCeiling(stockCeiling(variant), inThisCart, 1)) return 'addToCart';
  return inThisCart > 0 ? 'inCart' : 'waiting';
}
