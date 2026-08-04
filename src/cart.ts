/**
 * Real Shopify cart via Storefront API.
 */
import { request, assertNoUserErrors } from './client';
import {
  CART_ATTRIBUTES_UPDATE_MUTATION,
  CART_BUYER_IDENTITY_UPDATE_MUTATION,
  CART_CREATE_MUTATION,
  CART_DISCOUNT_CODES_UPDATE_MUTATION,
  CART_GET_QUERY,
  CART_LINES_ADD_MUTATION,
  CART_LINES_REMOVE_MUTATION,
  CART_LINES_UPDATE_MUTATION,
  CART_NOTE_UPDATE_MUTATION,
} from './queries';
import type {
  Cart,
  CartAttribute,
  CartLineInput,
  CartLineUpdateInput,
  ShopifyCartAPI,
  UserError,
} from './types';

interface CartCreatePayload { cartCreate: { cart: any; userErrors: UserError[] } }
interface CartGetPayload    { cart: any | null }
interface CartAddPayload    { cartLinesAdd: { cart: any; userErrors: UserError[] } }
interface CartUpdPayload    { cartLinesUpdate: { cart: any; userErrors: UserError[] } }
interface CartRmPayload     { cartLinesRemove: { cart: any; userErrors: UserError[] } }
interface CartDiscPayload   { cartDiscountCodesUpdate: { cart: any; userErrors: UserError[] } }
interface CartBuyPayload    { cartBuyerIdentityUpdate: { cart: any; userErrors: UserError[] } }
interface CartNotePayload   { cartNoteUpdate: { cart: any; userErrors: UserError[] } }
interface CartAttrPayload   { cartAttributesUpdate: { cart: any; userErrors: UserError[] } }

/** GraphQL returns `lines.nodes`; we hoist to `lines` (an array). */
function normalize(c: any): Cart {
  return {
    id: c.id,
    checkoutUrl: c.checkoutUrl,
    totalQuantity: c.totalQuantity,
    lines: (c.lines?.nodes ?? []).map((line: any) => ({
      id: line.id,
      quantity: line.quantity,
      merchandise: line.merchandise,
      cost: line.cost,
    })),
    cost: c.cost,
    discountCodes: c.discountCodes ?? [],
    note: c.note ?? null,
    attributes: c.attributes ?? [],
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export const cart: ShopifyCartAPI = {
  async create(input): Promise<Cart> {
    const payload = {
      lines: input?.lines,
      discountCodes: input?.discountCodes,
    };
    const data = await request<CartCreatePayload>(CART_CREATE_MUTATION, { input: payload });
    assertNoUserErrors('cartCreate', data.cartCreate.userErrors);
    return normalize(data.cartCreate.cart);
  },

  async get(cartId: string): Promise<Cart | null> {
    const data = await request<CartGetPayload>(CART_GET_QUERY, { id: cartId });
    return data.cart ? normalize(data.cart) : null;
  },

  async addLines(cartId: string, lines: CartLineInput[]): Promise<Cart> {
    const data = await request<CartAddPayload>(CART_LINES_ADD_MUTATION, { cartId, lines });
    assertNoUserErrors('cartLinesAdd', data.cartLinesAdd.userErrors);
    return normalize(data.cartLinesAdd.cart);
  },

  async updateLines(cartId: string, lines: CartLineUpdateInput[]): Promise<Cart> {
    const data = await request<CartUpdPayload>(CART_LINES_UPDATE_MUTATION, { cartId, lines });
    assertNoUserErrors('cartLinesUpdate', data.cartLinesUpdate.userErrors);
    return normalize(data.cartLinesUpdate.cart);
  },

  async removeLines(cartId: string, lineIds: string[]): Promise<Cart> {
    const data = await request<CartRmPayload>(CART_LINES_REMOVE_MUTATION, { cartId, lineIds });
    assertNoUserErrors('cartLinesRemove', data.cartLinesRemove.userErrors);
    return normalize(data.cartLinesRemove.cart);
  },

  async applyDiscountCodes(cartId: string, codes: string[]): Promise<Cart> {
    const data = await request<CartDiscPayload>(CART_DISCOUNT_CODES_UPDATE_MUTATION, {
      cartId,
      discountCodes: codes,
    });
    assertNoUserErrors('cartDiscountCodesUpdate', data.cartDiscountCodesUpdate.userErrors);
    return normalize(data.cartDiscountCodesUpdate.cart);
  },

  async setBuyerIdentity(cartId, identity): Promise<Cart> {
    const data = await request<CartBuyPayload>(CART_BUYER_IDENTITY_UPDATE_MUTATION, {
      cartId,
      buyerIdentity: {
        email: identity.email,
        countryCode: identity.countryCode,
        customerAccessToken: identity.customerAccessToken,
      },
    });
    assertNoUserErrors('cartBuyerIdentityUpdate', data.cartBuyerIdentityUpdate.userErrors);
    return normalize(data.cartBuyerIdentityUpdate.cart);
  },

  async updateNote(cartId: string, note: string | null): Promise<Cart> {
    // Storefront types `note` as String! — clearing is an empty string, and
    // Shopify reports an unset note as '' rather than null.
    const data = await request<CartNotePayload>(CART_NOTE_UPDATE_MUTATION, {
      cartId,
      note: note ?? '',
    });
    assertNoUserErrors('cartNoteUpdate', data.cartNoteUpdate.userErrors);
    return normalize(data.cartNoteUpdate.cart);
  },

  async updateAttributes(cartId: string, attributes: CartAttribute[]): Promise<Cart> {
    const data = await request<CartAttrPayload>(CART_ATTRIBUTES_UPDATE_MUTATION, {
      cartId,
      attributes,
    });
    assertNoUserErrors('cartAttributesUpdate', data.cartAttributesUpdate.userErrors);
    return normalize(data.cartAttributesUpdate.cart);
  },
};
