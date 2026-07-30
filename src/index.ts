/**
 * Shopify integration facade — talks to the Storefront GraphQL API.
 *
 * Everything is exported from this root, including the React helpers, so a
 * consumer only needs `@apptile/sdk-shopify`. The `/react` subpath is still
 * published for back-compat.
 */
export { shopify, shopify as default } from './shopify';
export { formatMoney, applyMoneyFormat, shop } from './money';
export { getMoneyFormat, getCurrencyCode } from './client';
export type * from './types';

// React helpers. Requires `react` (a peer dependency) — this SDK targets React
// Native, so the root is React-aware by design.
export {
  ShopifyProvider,
  useShopify,
  useCart,
  useWishlist,
  type ShopifyProviderProps,
} from './react';
