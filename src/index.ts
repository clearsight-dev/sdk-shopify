export { shopify, shopify as default } from './shopify';
export { formatMoney, applyMoneyFormat, shop } from './money';
export { getMoneyFormat, getCurrencyCode } from './client';
export { clearRequestCache, DEFAULT_CACHE_TTL_MS, type RequestCacheOptions } from './requestCache';
export {
  PRODUCT_BASE_KEYS,
  peekProduct,
  forgetProduct,
  clearProductStore,
  toProductBase,
  type ProductBase,
  type CachedProduct,
} from './productStore';
export { toLineSnapshot } from './cart';
export {
  priceRange,
  priceFilterInput,
  parsePriceFilterInput,
  isPriceFilterInput,
  type PriceRange,
} from './filters';
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
  ALERT_SETTINGS_PATH,
  MAX_LINE_ITEMS_SETTING_PATH,
  ALERT_SETTING_FIELDS,
  MAX_ALERT_LENGTH,
  MAX_LINE_ITEMS_RANGE,
  readAlertSettings,
  readCartPolicy,
  isAlertSilenced,
  type AlertSettings,
} from './alertSettings';
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
export {
  setProductMetafields,
  getProductMetafields,
  productMetafield,
} from './metafields';
export { TileCreditError } from './types';
export type * from './types';

// React helpers re-exported from the ROOT entry so consumers can write
//   import { useShopify, useTileCredit } from '@tiledev/sdk-shopify'
// without paying for the `/react` subpath — the tile-packet-bundler only
// builds a single per-package bundle per platform, so requests to
// `@tiledev/sdk-shopify/react` return no bundle on web preview.
export {
  ShopifyProvider,
  useShopify,
  useCart,
  useWishlist,
  useCustomer,
  useCheckout,
  useShopifyMessage,
  useTileCredit,
  useCollectionProducts,
  COLLECTION_PAGE_SIZE,
  useSearch,
  SEARCH_PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  useProduct,
  REVALIDATE_AFTER_MS,
  useAlertSettings,
  type ShopifyProviderProps,
  type ShopifyEvent,
  type ShopifyEventType,
  type CartState,
  type WishlistState,
  type CustomerState,
  type CheckoutState,
  type UseTileCreditOptions,
  type UseTileCreditState,
  type CollectionSort,
  type UseCollectionProductsOptions,
  type CollectionProductsState,
  type UseCollectionProductsResult,
  type SearchSort,
  type UseSearchOptions,
  type UseSearchResult,
  type SearchState,
  type UseProductOptions,
  type UseProductState,
  type UseProductResult,
  type ProductFeedState,
  type ProductFeedResult,
  type UseAlertSettingsOptions,
  type AlertSettingsProps,
} from './react';
