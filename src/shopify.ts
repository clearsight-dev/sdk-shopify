/**
 * The Shopify integration facade.
 *
 * Lives in its own module (not index.ts) so that `react/ShopifyProvider` can use
 * it WITHOUT importing back through the barrel. index.ts re-exports the React
 * helpers, so if the provider imported `../index` the two would form a require
 * cycle — which a minified bundle resolves to `undefined` (React error #130).
 * Dependency direction stays one-way: index -> react -> shopify.
 */
import { blogs } from './blogs';
import { cart } from './cart';
import { collections } from './collections';
import { customer } from './customer';
import { products } from './products';
import { wishlist } from './wishlist';
import { isConfigured, setConfig } from './client';
import { shop, formatMoney } from './money';
import { configureTileCredit, getTileCreditClient, redeemAndApplyToCart } from './tileCredit';
import type { ShopifyConfig, ShopifyIntegration } from './types';

export const shopify: ShopifyIntegration = {
  async init(config: ShopifyConfig): Promise<void> {
    setConfig(config);
    // Load the shop's moneyFormat so all currency fields format like the store
    // (e.g. "Rs. {{amount}}"). Best-effort — never blocks init on failure.
    await shop.load();
  },
  isReady(): boolean {
    return isConfigured();
  },
  isMock: false,
  products,
  collections,
  cart,
  customer,
  blogs,
  wishlist,
  shop,
  formatMoney,
  tileCredit: {
    configure: configureTileCredit,
    client: getTileCreditClient,
    redeemAndApplyToCart,
  },
};
