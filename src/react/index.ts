/**
 * Optional React helpers for the Shopify SDK.
 *
 * Import from '@apptile/sdk-shopify/react'. Requires `react` as a peer
 * dependency. Storage adapter is passed at the provider — window.localStorage
 * on the web by default; consumers on other platforms (React Native, Node,
 * etc.) pass their own AsyncStorage-compatible adapter.
 */
export {
  ShopifyProvider,
  useShopify,
  useCart,
  useWishlist,
  type ShopifyProviderProps,
} from "./ShopifyProvider";
