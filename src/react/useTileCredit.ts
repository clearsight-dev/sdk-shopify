/**
 * useTileCredit — customer wallet + redeem hook.
 *
 * The hook keeps the client wired to the ShopifyProvider's cart so
 * `redeemAndApply(amountCents)` mints a gift card AND applies it in one
 * call. It re-configures the underlying client whenever the customer
 * access token changes (rebuild the client on logout / new customer;
 * the token is baked in for the lifetime of the instance).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { shopify } from '../shopify';
import { DEFAULT_TILE_CREDIT_BASE_URL } from '../tileCredit';
import { useCart } from './ShopifyProvider';
import type {
  Cart,
  TileCreditPublicConfig,
  TileCreditRedeemResult,
  TileCreditWallet,
} from '../types';

export interface UseTileCreditOptions {
  /** Tile-credit service URL, no trailing slash. Optional — defaults to the
   *  hosted service (`https://tile-credit.apptile.io`). */
  baseUrl?: string;
  /** `shcat_…` or classic Storefront customer token. `null` when signed out. */
  customerAccessToken: string | null;
  /** `{shop}.myshopify.com`. */
  shopDomain: string;
  /** Auto-fetch wallet + config on mount / when the token changes. Default true. */
  autoLoad?: boolean;
}

export interface UseTileCreditState {
  ready: boolean;
  wallet: TileCreditWallet | null;
  config: TileCreditPublicConfig | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Redeem N cents and apply to the current cart (from `useCart`).
   *  Throws if no cart is loaded yet. */
  redeemAndApply: (amountCents: number, opts?: {
    idempotencyKey?: string;
    reason?: string;
    countryFallback?: string;
  }) => Promise<{ redeemed: TileCreditRedeemResult; cart: Cart }>;
  /** Remove one or more applied gift cards from the current cart. */
  removeAppliedGiftCards: (appliedGiftCardIds: string[]) => Promise<Cart>;
}

export function useTileCredit(opts: UseTileCreditOptions): UseTileCreditState {
  const { baseUrl = DEFAULT_TILE_CREDIT_BASE_URL, customerAccessToken, shopDomain, autoLoad = true } = opts;
  const cartState = useCart();

  const [wallet, setWallet] = useState<TileCreditWallet | null>(null);
  const [config, setConfig] = useState<TileCreditPublicConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [configured, setConfigured] = useState(false);

  // (Re)configure the client whenever the token / domain / baseUrl changes.
  useEffect(() => {
    if (!customerAccessToken) {
      setConfigured(false);
      setWallet(null);
      return;
    }
    shopify.tileCredit.configure({ baseUrl, customerAccessToken, shopDomain });
    setConfigured(true);
  }, [baseUrl, customerAccessToken, shopDomain]);

  const refresh = useCallback(async () => {
    if (!configured) return;
    const client = shopify.tileCredit.client();
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const [w, c] = await Promise.all([client.getWallet(), client.getConfig()]);
      setWallet(w);
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [configured]);

  useEffect(() => {
    if (autoLoad && configured) void refresh();
  }, [autoLoad, configured, refresh]);

  const redeemAndApply = useCallback<UseTileCreditState['redeemAndApply']>(
    async (amountCents, o = {}) => {
      const currentCart = cartState.cart;
      if (!currentCart) throw new Error('useTileCredit.redeemAndApply: no cart loaded');
      const result = await shopify.tileCredit.redeemAndApplyToCart({
        cartId: currentCart.id,
        amountCents,
        idempotencyKey: o.idempotencyKey,
        reason: o.reason,
        countryFallback: o.countryFallback,
      });
      // Refresh the wallet so the balance debit shows in the UI.
      void refresh();
      // The convenience method already applied; refresh cart state so the
      // provider re-emits with the new totals + appliedGiftCards.
      await cartState.refresh();
      return result;
    },
    [cartState, refresh],
  );

  const removeAppliedGiftCards = useCallback<UseTileCreditState['removeAppliedGiftCards']>(
    async (ids) => {
      const currentCart = cartState.cart;
      if (!currentCart) throw new Error('useTileCredit.removeAppliedGiftCards: no cart loaded');
      const next = await shopify.cart.removeGiftCardCodes(currentCart.id, ids);
      await cartState.refresh();
      return next;
    },
    [cartState],
  );

  return useMemo(
    () => ({
      ready: configured && !loading && (wallet !== null || error !== null),
      wallet,
      config,
      loading,
      error,
      refresh,
      redeemAndApply,
      removeAppliedGiftCards,
    }),
    [configured, wallet, config, loading, error, refresh, redeemAndApply, removeAppliedGiftCards],
  );
}
