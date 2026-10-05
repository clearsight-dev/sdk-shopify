import { request, assertNoUserErrors, getConfig } from './client';
import {
  CART_ATTRIBUTES_UPDATE_MUTATION,
  CART_BUYER_IDENTITY_UPDATE_MUTATION,
  CART_CREATE_MUTATION,
  CART_DISCOUNT_CODES_UPDATE_MUTATION,
  CART_GET_QUERY,
  CART_GIFT_CARD_CODES_ADD_MUTATION,
  CART_GIFT_CARD_CODES_REMOVE_MUTATION,
  CART_GIFT_CARD_CODES_UPDATE_MUTATION,
  CART_LINES_ADD_MUTATION,
  CART_LINES_REMOVE_MUTATION,
  CART_LINES_UPDATE_MUTATION,
  CART_NOTE_UPDATE_MUTATION,
} from './queries';
import type {
  AppliedGiftCard,
  Cart,
  CartLineInput,
  CartLineSellingPlan,
  CartLineSnapshot,
  CartLineUpdateInput,
  ShopifyCartAPI,
  UserError,
  ImageOptions,
  ImageTransform,
  Money,
} from './types';

interface CartCreatePayload { cartCreate: { cart: any; userErrors: UserError[] } }
interface CartGetPayload    { cart: any | null }
interface CartAddPayload    { cartLinesAdd: { cart: any; userErrors: UserError[] } }
interface CartUpdPayload    { cartLinesUpdate: { cart: any; userErrors: UserError[] } }
interface CartRmPayload     { cartLinesRemove: { cart: any; userErrors: UserError[] } }
interface CartDiscPayload   { cartDiscountCodesUpdate: { cart: any; userErrors: UserError[] } }
interface CartBuyPayload    { cartBuyerIdentityUpdate: { cart: any; userErrors: UserError[] } }
interface CartGcSetPayload  { cartGiftCardCodesUpdate: { cart: any; userErrors: UserError[] } }
interface CartGcAddPayload  { cartGiftCardCodesAdd: { cart: any; userErrors: UserError[] } }
interface CartGcRmPayload   { cartGiftCardCodesRemove: { cart: any; userErrors: UserError[] } }
interface CartNotePayload   { cartNoteUpdate: { cart: any; userErrors: UserError[] } }
interface CartAttrPayload   { cartAttributesUpdate: { cart: any; userErrors: UserError[] } }

/**
 * `money` times a whole number, worked in the amount's own smallest unit so `0.1 × 3` is `0.3`, and
 * written with as many decimals as Shopify gave. Null in, null out.
 */
function timesQuantity(money: Money | null | undefined, quantity: number): Money | null {
  if (!money || typeof money.amount !== 'string') return null;
  const decimals = money.amount.split('.')[1]?.length ?? 0;
  const scale = 10 ** decimals;
  const smallestUnits = Math.round(Number(money.amount) * scale) * quantity;
  if (!Number.isFinite(smallestUnits)) return null;
  return { amount: (smallestUnits / scale).toFixed(decimals), currencyCode: money.currencyCode };
}

/**
 * A line's selling-plan allocation as `CartLine.sellingPlan`: the plan, and its two amounts for the
 * whole line. Shopify gives the amounts per unit (a line of 2 at $250 said $250 left to pay,
 * 2026-10-05), so they are multiplied by the quantity here. Null for a line bought outright.
 */
function lineSellingPlan(allocation: any, quantity: number): CartLineSellingPlan | null {
  const plan = allocation?.sellingPlan;
  if (!plan?.id) return null;
  return {
    id: plan.id,
    name: plan.name ?? '',
    checkoutCharge: timesQuantity(allocation.checkoutChargeAmount, quantity),
    remainingBalance: timesQuantity(allocation.remainingBalanceChargeAmount, quantity),
  };
}

function normalize(c: any): Cart {
  return {
    id: c.id,
    checkoutUrl: c.checkoutUrl,
    totalQuantity: c.totalQuantity,
    // Shopify reports "no note" as an empty string; collapsed to null so callers have one falsy
    // value to test rather than two.
    note: c.note ? c.note : null,
    attributes: c.attributes ?? [],
    buyerIdentity: {
      countryCode: c.buyerIdentity?.countryCode ?? null,
      email: c.buyerIdentity?.email ?? null,
      phone: c.buyerIdentity?.phone ?? null,
    },
    lines: (c.lines?.nodes ?? []).map((line: any) => ({
      id: line.id,
      quantity: line.quantity,
      attributes: line.attributes ?? [],
      sellingPlanId: line.sellingPlanAllocation?.sellingPlan?.id ?? null,
      sellingPlan: lineSellingPlan(line.sellingPlanAllocation, line.quantity),
      merchandise: line.merchandise,
      product: line.merchandise?.product ?? null,
      cost: line.cost,
    })),
    cost: c.cost,
    discountCodes: c.discountCodes ?? [],
    appliedGiftCards: c.appliedGiftCards ?? [],
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * The lines of `cart` in the shape a new cart can be created from. Shopify has no copy-cart API
 * and an expired cart cannot be read, so this is the only way its lines outlive it. Attributes are
 * copied verbatim: other apps' tags ride on them.
 */
export function toLineSnapshot(cart: Cart): CartLineSnapshot[] {
  return cart.lines
    .filter((line) => !!line.merchandise?.id)
    .map((line) => ({
      merchandiseId: line.merchandise.id,
      quantity: line.quantity,
      sellingPlanId: line.sellingPlanId ?? null,
      attributes: line.attributes.map(({ key, value }) => ({ key, value })),
    }));
}

// Shopify rejects an unknown CartLineInput field, so the SDK-only `source` and `maxQuantity` never go on the wire.
const toShopifyLines = (lines?: CartLineInput[]) => lines?.map(({ source: _source, maxQuantity: _ceiling, ...line }) => line);

/**
 * Whether a gift card's last characters (`AppliedGiftCard.lastCharacters`, `TileCreditRedeemResult.last4`)
 * are the end of a code or of another card's last characters. Codes are case-insensitive. At least four
 * characters must match, so an empty ending matches nothing.
 */
function sameEnding(a: string, b: string): boolean {
  const one = a.trim().toLowerCase();
  const other = b.trim().toLowerCase();
  const shorter = one.length <= other.length ? one : other;
  return shorter.length >= 4 && (one.endsWith(other) || other.endsWith(one));
}

/** The gift cards on `cart` whose last characters match one of `endings` (a code, or its last four). */
export function giftCardsEndingIn(cart: Cart | null, endings: string[]): AppliedGiftCard[] {
  if (!cart) return [];
  return cart.appliedGiftCards.filter((card) => endings.some((ending) => sameEnding(card.lastCharacters, ending)));
}

/** The codes no gift card on `cart` ends like: what Shopify didn't apply. */
export function giftCardCodesNotOnCart(cart: Cart, codes: string[]): string[] {
  return codes.filter((code) => giftCardsEndingIn(cart, [code]).length === 0);
}

/** A cart's line-image transform: the call's own, else the provider-wide `imageTransforms.cart`. */
function cartImages(opts?: ImageOptions): { imageTransform?: ImageTransform } {
  return { imageTransform: opts?.imageTransform ?? getConfig().imageTransforms?.cart };
}

export const cart: ShopifyCartAPI = {
  async create(input, opts?: ImageOptions): Promise<Cart> {
    /**
     * Built key by key rather than spreading `input`, so an unknown field cannot reach Shopify and
     * fail the whole mutation — but every key `CartInput` accepts and a caller can set belongs
     * here. It once carried only `lines` and `discountCodes`, and the two it dropped were both
     * ones no later write can substitute for: an attribute a discount function needs at pricing
     * time, and the `countryCode` that fixes the cart's currency. Neither failure surfaced as an
     * error — the cart came back fine, just without them.
     */
    const payload = {
      lines: toShopifyLines(input?.lines),
      discountCodes: input?.discountCodes,
      attributes: input?.attributes,
      buyerIdentity: input?.buyerIdentity,
    };
    const data = await request<CartCreatePayload>(CART_CREATE_MUTATION, { input: payload }, cartImages(opts));
    assertNoUserErrors('cartCreate', data.cartCreate.userErrors);
    return normalize(data.cartCreate.cart);
  },

  async get(cartId: string, opts?: ImageOptions): Promise<Cart | null> {
    const data = await request<CartGetPayload>(CART_GET_QUERY, { id: cartId }, cartImages(opts));
    return data.cart ? normalize(data.cart) : null;
  },

  async addLines(cartId: string, lines: CartLineInput[], opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartAddPayload>(CART_LINES_ADD_MUTATION, { cartId, lines: toShopifyLines(lines) }, cartImages(opts));
    assertNoUserErrors('cartLinesAdd', data.cartLinesAdd.userErrors);
    return normalize(data.cartLinesAdd.cart);
  },

  async updateLines(cartId: string, lines: CartLineUpdateInput[], opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartUpdPayload>(CART_LINES_UPDATE_MUTATION, { cartId, lines }, cartImages(opts));
    assertNoUserErrors('cartLinesUpdate', data.cartLinesUpdate.userErrors);
    return normalize(data.cartLinesUpdate.cart);
  },

  async removeLines(cartId: string, lineIds: string[], opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartRmPayload>(CART_LINES_REMOVE_MUTATION, { cartId, lineIds }, cartImages(opts));
    assertNoUserErrors('cartLinesRemove', data.cartLinesRemove.userErrors);
    return normalize(data.cartLinesRemove.cart);
  },

  async applyDiscountCodes(cartId: string, codes: string[], opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartDiscPayload>(CART_DISCOUNT_CODES_UPDATE_MUTATION, {
      cartId,
      discountCodes: codes,
    }, cartImages(opts));
    assertNoUserErrors('cartDiscountCodesUpdate', data.cartDiscountCodesUpdate.userErrors);
    return normalize(data.cartDiscountCodesUpdate.cart);
  },

  async setBuyerIdentity(cartId, identity, opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartBuyPayload>(CART_BUYER_IDENTITY_UPDATE_MUTATION, {
      cartId,
      buyerIdentity: {
        email: identity.email,
        countryCode: identity.countryCode,
        customerAccessToken: identity.customerAccessToken,
      },
    }, cartImages(opts));
    assertNoUserErrors('cartBuyerIdentityUpdate', data.cartBuyerIdentityUpdate.userErrors);
    return normalize(data.cartBuyerIdentityUpdate.cart);
  },

  /** REPLACES the cart's gift cards: a card not in `codes` comes off. Adding one is `addGiftCardCodes`. */
  async applyGiftCardCodes(cartId: string, codes: string[], opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartGcSetPayload>(CART_GIFT_CARD_CODES_UPDATE_MUTATION, {
      cartId,
      giftCardCodes: codes,
    }, cartImages(opts));
    assertNoUserErrors('cartGiftCardCodesUpdate', data.cartGiftCardCodesUpdate.userErrors);
    return normalize(data.cartGiftCardCodesUpdate.cart);
  },

  /** Adds codes and keeps the cards already on the cart. Shopify can skip a code without an error. */
  async addGiftCardCodes(cartId: string, codes: string[], opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartGcAddPayload>(CART_GIFT_CARD_CODES_ADD_MUTATION, {
      cartId,
      giftCardCodes: codes,
    }, cartImages(opts));
    assertNoUserErrors('cartGiftCardCodesAdd', data.cartGiftCardCodesAdd.userErrors);
    return normalize(data.cartGiftCardCodesAdd.cart);
  },

  /**
   * The shopper's order note — the free-text box on the cart, read by the merchant on the order.
   *
   * Its own mutation rather than a cart attribute: attributes are key/value metadata for the app's
   * own bookkeeping (Cart Hold's expiry stamp is one), while the note is content the shopper wrote.
   */
  async updateNote(cartId: string, note: string | null, opts?: ImageOptions): Promise<Cart> {
    // `?? ''` is load-bearing: the argument is `String!`, so a null variable fails the whole
    // mutation rather than clearing the note.
    const data = await request<CartNotePayload>(CART_NOTE_UPDATE_MUTATION, { cartId, note: note ?? '' }, cartImages(opts));
    assertNoUserErrors('cartNoteUpdate', data.cartNoteUpdate.userErrors);
    return normalize(data.cartNoteUpdate.cart);
  },

  async updateAttributes(cartId: string, attributes, opts?: ImageOptions): Promise<Cart> {
    // Shopify replaces the set wholesale, so this is a write of the final list, not a merge into
    // the existing one. Callers holding a cart should send its current attributes plus theirs.
    const data = await request<CartAttrPayload>(CART_ATTRIBUTES_UPDATE_MUTATION, { cartId, attributes }, cartImages(opts));
    assertNoUserErrors('cartAttributesUpdate', data.cartAttributesUpdate.userErrors);
    return normalize(data.cartAttributesUpdate.cart);
  },

  async removeGiftCardCodes(cartId: string, appliedGiftCardIds: string[], opts?: ImageOptions): Promise<Cart> {
    const data = await request<CartGcRmPayload>(CART_GIFT_CARD_CODES_REMOVE_MUTATION, {
      cartId,
      appliedGiftCardIds,
    }, cartImages(opts));
    assertNoUserErrors('cartGiftCardCodesRemove', data.cartGiftCardCodesRemove.userErrors);
    return normalize(data.cartGiftCardCodesRemove.cart);
  },
};

/**
 * Adds gift-card codes to `current` so they can pay for it:
 *
 * 1. **A country first, only when the cart has none** (Shopify takes a gift card only on a cart with
 *    `buyerIdentity.countryCode`). `cartBuyerIdentityUpdate` REPLACES the identity, so the cart's email
 *    is sent again, and the shopper's token (`customerAccessToken`) keeps it linked to them. A cart that
 *    already has a country isn't touched: the identity can't be read back whole (the token), so the
 *    safest identity write is none.
 * 2. **`cartGiftCardCodesAdd`**, which keeps the cart's other gift cards.
 *
 * `notApplied` lists the codes no card on the returned cart ends like: Shopify answered without
 * applying them (it does that without an error for a code it doesn't take).
 */
export async function addGiftCardsKeepingBuyer(
  current: Cart,
  codes: string[],
  options: { countryCode: () => Promise<string>; customerAccessToken?: string | null },
): Promise<{ cart: Cart; notApplied: string[] }> {
  let next = current;
  if (!next.buyerIdentity?.countryCode) {
    next = await cart.setBuyerIdentity(next.id, {
      countryCode: await options.countryCode(),
      ...(next.buyerIdentity?.email ? { email: next.buyerIdentity.email } : {}),
      ...(options.customerAccessToken ? { customerAccessToken: options.customerAccessToken } : {}),
    });
  }
  next = await cart.addGiftCardCodes(next.id, codes);
  return { cart: next, notApplied: giftCardCodesNotOnCart(next, codes) };
}
