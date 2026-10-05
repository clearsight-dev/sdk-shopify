/**
 * useTileCredit — customer wallet + redeem hook, for a caller that holds the token itself.
 *
 * @deprecated For the cart use `useCartStoreCredit()`, and for a balance `useStoreCredit()`: both read
 * the provider's session (the token fresh for every request, renewed once on a 401) and need no token
 * passed in. Kept for existing callers.
 *
 * Fixed 2026-10-05:
 * - **Another shopper's wallet never shows.** What was read is held with the token it was read for, and
 *   a new token reads again; it used to keep shopper A's wallet for shopper B (re-reading only when
 *   the token went from none to some).
 * - `redeemAndApply` adds the card through the provider's cart queue (`useCart().addGiftCardCodes`),
 *   keeping the cart's other gift cards and its buyer; it used to replace both. `removeAppliedGiftCards`
 *   goes through the queue too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shopify } from '../shopify';
import { DEFAULT_TILE_CREDIT_BASE_URL, TileCreditClient } from '../tileCredit';
import { TileCreditError } from '../types';
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
  /** Redeem N cents and add the card to the current cart (from `useCart`).
   *  Throws if no cart is loaded yet, or `TileCreditError('cart_refused')` when the card didn't go on. */
  redeemAndApply: (amountCents: number, opts?: {
    idempotencyKey?: string;
    reason?: string;
    /** No longer used: the provider sets the cart's country (its `config.country`, else the shop's). */
    countryFallback?: string;
  }) => Promise<{ redeemed: TileCreditRedeemResult; cart: Cart }>;
  /** Remove one or more applied gift cards from the current cart, by `AppliedGiftCard.id`. */
  removeAppliedGiftCards: (appliedGiftCardIds: string[]) => Promise<Cart>;
}

/** What was read, and for which token: shown only while that token is the current one. */
interface Read {
  token: string | null;
  wallet: TileCreditWallet | null;
  config: TileCreditPublicConfig | null;
  error: Error | null;
}

export function useTileCredit(opts: UseTileCreditOptions): UseTileCreditState {
  const { baseUrl = DEFAULT_TILE_CREDIT_BASE_URL, customerAccessToken, shopDomain, autoLoad = true } = opts;
  const cartState = useCart();
  const token = customerAccessToken || null;

  const [read, setRead] = useState<Read>({ token: null, wallet: null, config: null, error: null });
  const [loadingFor, setLoadingFor] = useState<string | null>(null);
  const current: Read = read.token === token ? read : { token, wallet: null, config: null, error: null };
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // The client for the current token; also configured as the shared one, as before.
  const client = useMemo(() => {
    if (!token) return null;
    shopify.tileCredit.configure({ baseUrl, customerAccessToken: token, shopDomain });
    return new TileCreditClient({ baseUrl, customerAccessToken: token, shopDomain });
  }, [baseUrl, token, shopDomain]);

  const refresh = useCallback(async () => {
    if (!client || !token) return;
    setLoadingFor(token);
    try {
      const [w, c] = await Promise.all([client.getWallet(), client.getConfig()]);
      if (tokenRef.current === token) setRead({ token, wallet: w, config: c, error: null });
    } catch (e) {
      if (tokenRef.current === token) {
        const error = e instanceof Error ? e : new Error(String(e));
        setRead((before) => (before.token === token ? { ...before, error } : { token, wallet: null, config: null, error }));
      }
    } finally {
      setLoadingFor((now) => (now === token ? null : now));
    }
  }, [client, token]);

  useEffect(() => {
    if (autoLoad && client) void refresh();
  }, [autoLoad, client, refresh]);

  const redeemAndApply = useCallback<UseTileCreditState['redeemAndApply']>(
    async (amountCents, o = {}) => {
      if (!cartState.cart) throw new Error('useTileCredit.redeemAndApply: no cart loaded');
      if (!client) throw new TileCreditError('unauthorized', 'No signed-in customer');
      const redeemed = await client.redeem({
        amountCents,
        idempotencyKey: o.idempotencyKey,
        reason: o.reason ?? 'Wallet redemption',
      });
      let cart: Cart | null;
      try {
        cart = await cartState.addGiftCardCodes([redeemed.code]);
      } catch (e) {
        throw new TileCreditError('cart_refused', e instanceof Error ? e.message : String(e));
      }
      if (!cart) throw new TileCreditError('cart_refused', 'There is no cart to put the credit on');
      void refresh();
      return { redeemed, cart };
    },
    [cartState, client, refresh],
  );

  const removeAppliedGiftCards = useCallback<UseTileCreditState['removeAppliedGiftCards']>(
    async (ids) => {
      const next = await cartState.removeGiftCards(ids);
      if (!next) throw new Error('useTileCredit.removeAppliedGiftCards: no cart loaded');
      return next;
    },
    [cartState],
  );

  const loading = loadingFor !== null && loadingFor === token;
  return useMemo(
    () => ({
      ready: !!token && !loading && (current.wallet !== null || current.error !== null),
      wallet: current.wallet,
      config: current.config,
      loading,
      error: current.error,
      refresh,
      redeemAndApply,
      removeAppliedGiftCards,
    }),
    [token, loading, current.wallet, current.config, current.error, refresh, redeemAndApply, removeAppliedGiftCards],
  );
}
