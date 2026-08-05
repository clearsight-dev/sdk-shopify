export { shopify, shopify as default } from './shopify';
export { formatMoney, applyMoneyFormat, shop } from './money';
export { getMoneyFormat, getCurrencyCode } from './client';
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
  useTileCredit,
  type ShopifyProviderProps,
  type ShopifyEvent,
  type UseTileCreditOptions,
  type UseTileCreditState,
} from './react';
