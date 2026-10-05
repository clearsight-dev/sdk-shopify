/**
 * The Tile Credit client for the provider's signed-in shopper. One place builds it, for
 * `useStoreCredit`, `useStoreCreditHistory` and `useCartStoreCredit`, so all three send the same token
 * the same way:
 *
 * - **the token is read before every request** (`customer.getAccessToken`, which refreshes one about to
 *   expire, sharing the session's one refresh);
 * - **a 401 renews it once and sends the request again** (`customer.renewAccessToken`; a password session
 *   can't renew, so it has no second try). A second 401 is `TileCreditError('unauthorized')`, and the
 *   shopper stays signed in: the service also answers 401 for a shop it doesn't know.
 *
 * A new client per use is cheap (it holds no connection); there is no shared instance to go stale.
 */
import { getConfig } from '../client';
import { DEFAULT_TILE_CREDIT_BASE_URL, TileCreditClient } from '../tileCredit';
import type { CustomerState } from './ShopifyProvider';

export function tileCreditClientFor(
  customer: Pick<CustomerState, 'getAccessToken' | 'renewAccessToken'>,
  baseUrl?: string,
): TileCreditClient {
  return new TileCreditClient({
    baseUrl: baseUrl || DEFAULT_TILE_CREDIT_BASE_URL,
    getAccessToken: customer.getAccessToken,
    renewAccessToken: customer.renewAccessToken,
    shopDomain: getConfig().storeDomain,
  });
}
