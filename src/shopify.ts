// Separate from index.ts so ShopifyProvider can import the facade without going
// through the barrel — that would be a require cycle, which minified bundles
// resolve to `undefined` (React error #130). Direction: index -> react -> shopify.
import { blogs } from './blogs';
import { cart } from './cart';
import { collections } from './collections';
import { customer } from './customer';
import { products } from './products';
import { variants } from './variants';
import { wishlist } from './wishlist';
import { isConfigured, setConfig } from './client';
import { shop, formatMoney } from './money';
import { setCartPolicy } from './cartPolicy';
import { message, patchMessages, setMessageResolver, setMessages } from './messages';
import { configureTileCredit, getTileCreditClient, redeemAndApplyToCart } from './tileCredit';
import type { ShopifyConfig, ShopifyIntegration } from './types';

export const shopify: ShopifyIntegration = {
  async init(config: ShopifyConfig): Promise<void> {
    setConfig(config);
    // Alert copy and cart rules are usable before the network settles — a
    // limit refusal or an offline error toast must not wait on shop.load().
    setMessages(config.messages);
    setMessageResolver(config.translate);
    setCartPolicy(config.cart);
    await shop.load();
  },
  isReady(): boolean {
    return isConfigured();
  },
  isMock: false,
  products,
  variants,
  collections,
  cart,
  customer,
  blogs,
  wishlist,
  shop,
  formatMoney,
  alerts: {
    message,
    setMessages,
    patchMessages,
    setPolicy: setCartPolicy,
  },
  tileCredit: {
    configure: configureTileCredit,
    client: getTileCreditClient,
    redeemAndApplyToCart,
  },
};
