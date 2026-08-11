export { shopify, shopify as default } from './shopify';
export { formatMoney, applyMoneyFormat, shop } from './money';
export { getMoneyFormat, getCurrencyCode } from './client';
export {
  DEFAULT_MESSAGES,
  message,
  getMessages,
  setMessages,
  patchMessages,
  setMessageResolver,
  limitExceededMessage,
} from './messages';
export {
  setCartPolicy,
  getCartPolicy,
  maxLineItems,
  projectedLineCount,
  wouldExceedLineLimit,
} from './cartPolicy';
export {
  classifyAuthFailure,
  isOutOfStockError,
  isUserErrorRejection,
  userErrorsOf,
} from './errors';
export {
  TileCreditClient,
  configureTileCredit,
  getTileCreditClient,
  redeemAndApplyToCart,
  centsToMoney,
  moneyToCents,
} from './tileCredit';
export { TileCreditError } from './types';
export type * from './types';

// React helpers re-exported from the ROOT entry so consumers can write
//   import { useShopify, useTileCredit } from '@apptile/sdk-shopify'
// without paying for the `/react` subpath — the tile-packet-bundler only
// builds a single per-package bundle per platform, so requests to
// `@apptile/sdk-shopify/react` return no bundle on web preview.
export {
  ShopifyProvider,
  useShopify,
  useCart,
  useWishlist,
  useCustomer,
  useCheckout,
  useShopifyMessage,
  useTileCredit,
  type ShopifyProviderProps,
  type ShopifyEvent,
  type ShopifyEventType,
  type CartState,
  type WishlistState,
  type CustomerState,
  type CheckoutState,
  type UseTileCreditOptions,
  type UseTileCreditState,
} from './react';
