/**
 * Shopify integration facade — talks to the Storefront GraphQL API.
 */
import { blogs } from './blogs';
import { cart } from './cart';
import { collections } from './collections';
import { customer } from './customer';
import { products } from './products';
import { wishlist } from './wishlist';
import { isConfigured, setConfig } from './client';
import type { ShopifyConfig, ShopifyIntegration } from './types';

export const shopify: ShopifyIntegration = {
  async init(config: ShopifyConfig): Promise<void> {
    setConfig(config);
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
};

export type * from './types';
export default shopify;
