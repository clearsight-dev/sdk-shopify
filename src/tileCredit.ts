/**
 * Tile Credit — customer wallet + gift-card mint client.
 *
 * A typed, error-normalized wrapper around the tile-credit service (`https://tile-credit.apptile.io`).
 * Talks to `/public/*` on behalf of one signed-in customer: `Authorization: Customer <token>` and
 * `x-shopify-shop-domain`. The service resolves shop → appId itself.
 *
 * How the money moves (the service's reserve-at-mint model): **redeeming reserves, it doesn't charge.**
 * `redeem` mints a Shopify gift card for the amount and reserves it; the wallet is charged only for
 * what an order actually uses (`orders/create`), so the balance is unchanged by a redeem. One card is
 * active per customer: a new redeem disables the previous one. The same idempotency key returns the
 * same card (`duplicate: true`), but two redeems at once with different keys mint two cards, so a
 * caller allows one at a time (`useCartStoreCredit` does).
 *
 * The token is read before every request (`getAccessToken`) and renewed once on a 401
 * (`renewAccessToken`). This file is dependency-free (pure `fetch`).
 */
import { getConfig } from './client';
import { addGiftCardsKeepingBuyer, cart as cartApi } from './cart';
import { shop } from './money';
import type {
  Cart,
  TileCreditAPI,
  TileCreditConfig,
  TileCreditErrorCode,
  TileCreditGiftCardStatus,
  TileCreditHistoryEntry,
  TileCreditHistoryPage,
  TileCreditIssuedGiftCard,
  TileCreditLedgerEntry,
  TileCreditLedgerPage,
  TileCreditPublicConfig,
  TileCreditRedeemInput,
  TileCreditRedeemResult,
  TileCreditWallet,
} from './types';
import { TileCreditError } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `1500 → "15.00"`. Use everywhere the wire cents get rendered — never
 *  hand-roll `amount / 100`. Negatives keep the sign. */
export function centsToMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

/** `"15.00" | 15.0 → 1500`. Rounds half-up on the second decimal. */
export function moneyToCents(money: string | number): number {
  const n = typeof money === 'string' ? parseFloat(money) : money;
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

function randomKey(prefix = 'redeem'): string {
  // Not a security-grade token — just enough to disambiguate retries.
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Math.floor(Date.now() / 1000).toString(36);
  return `${prefix}-${ts}-${rand}`;
}

function statusToCode(status: number, bodyMsg?: string): TileCreditErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'validation';
  if (status === 402) return 'insufficient_balance';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'shopify_upstream';
  if (status >= 500) return 'internal';
  return 'internal';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 20_000;

interface SentRequest {
  status: number;
  ok: boolean;
  statusText: string;
  body: any;
}

/** Default tile-credit service base URL when the caller doesn't supply one. */
export const DEFAULT_TILE_CREDIT_BASE_URL = 'https://tile-credit.apptile.io';

export class TileCreditClient implements TileCreditAPI {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly renewAccessToken: (() => Promise<string | null>) | null;
  private readonly shopDomain: string;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;

  constructor(config: TileCreditConfig) {
    const fixed = config.customerAccessToken;
    if (!config.getAccessToken && !fixed) throw new Error('TileCreditClient: getAccessToken or customerAccessToken is required');
    if (!config.shopDomain) throw new Error('TileCreditClient: shopDomain is required');
    // baseUrl is optional — falls back to the hosted tile-credit service.
    this.baseUrl = (config.baseUrl || DEFAULT_TILE_CREDIT_BASE_URL).replace(/\/+$/, '');
    this.getAccessToken = config.getAccessToken ?? (async () => fixed ?? null);
    this.renewAccessToken = config.renewAccessToken ?? null;
    this.shopDomain = config.shopDomain.toLowerCase();
    this.signal = config.signal;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  // ─── HTTP core ──────────────────────────────────────────────────────────

  /**
   * One request with a token read just now. A 401 renews the token once (`renewAccessToken`) and sends
   * the request again; a second 401, or no new token, is `unauthorized`. Nothing here signs anyone out:
   * the service also answers 401 for a shop it doesn't know.
   */
  private async call<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
    const token = await this.tokenOrThrow(() => this.getAccessToken());
    const first = await this.send(path, init, token);
    if (first.status !== 401 || !this.renewAccessToken) return this.read<T>(first);
    const renew = this.renewAccessToken;
    const renewed = await this.tokenOrThrow(() => renew()).catch((error: unknown) => {
      // No new token: the service's own answer stands.
      if (error instanceof TileCreditError && error.code === 'unauthorized') return null;
      throw error;
    });
    if (!renewed) return this.read<T>(first);
    return this.read<T>(await this.send(path, init, renewed));
  }

  /** A token from `source`, or `unauthorized` (signed out) / `network` (couldn't be renewed). */
  private async tokenOrThrow(source: () => Promise<string | null>): Promise<string> {
    let token: string | null;
    try {
      token = await source();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new TileCreditError('network', `Couldn't get the customer's token: ${msg}`);
    }
    if (!token) throw new TileCreditError('unauthorized', 'No signed-in customer');
    return token;
  }

  private async send(path: string, init: { method?: 'GET' | 'POST'; body?: unknown }, token: string): Promise<SentRequest> {
    // Combine the constructor signal with a per-request timeout signal so
    // either can cancel the fetch; AbortController.abort() is idempotent.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const outerAbort = () => controller.abort();
    if (this.signal) {
      if (this.signal.aborted) controller.abort();
      else this.signal.addEventListener('abort', outerAbort);
    }
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          Authorization: `Customer ${token}`,
          'x-shopify-shop-domain': this.shopDomain,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: any = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 500) }; }
      }
      return { status: res.status, ok: res.ok, statusText: res.statusText, body };
    } catch (e) {
      // fetch throws on network / timeout / abort — normalize to `network`.
      const msg = e instanceof Error ? e.message : String(e);
      throw new TileCreditError('network', `${url} → ${msg}`);
    } finally {
      clearTimeout(timer);
      if (this.signal) this.signal.removeEventListener('abort', outerAbort);
    }
  }

  private read<T>(res: SentRequest): T {
    if (!res.ok) {
      const code = statusToCode(res.status);
      const msg = (res.body && (res.body.message || res.body.error)) || `${res.status} ${res.statusText}`;
      throw new TileCreditError(code, msg, res.status, res.body?.details ?? undefined);
    }
    return res.body as T;
  }

  // ─── Public API — one method per endpoint ───────────────────────────────

  async getWallet(): Promise<TileCreditWallet> {
    const raw = await this.call<{ ok: boolean } & Omit<TileCreditWallet, ''>>('/public/me');
    return {
      appId: raw.appId,
      customer: raw.customer,
      balanceCents: raw.balanceCents,
      lifetimeEarnedCents: raw.lifetimeEarnedCents,
      lifetimeRedeemedCents: raw.lifetimeRedeemedCents,
      expiringCents: raw.expiringCents,
    };
  }

  async getLedger(opts: { limit?: number; before?: string } = {}): Promise<TileCreditLedgerPage> {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', opts.before);
    const path = `/public/me/ledger${q.toString() ? `?${q}` : ''}`;
    const raw = await this.call<{ entries: TileCreditLedgerEntry[]; nextCursor: string | null }>(path);
    return { entries: raw.entries ?? [], nextCursor: raw.nextCursor ?? null };
  }

  async listGiftCards(): Promise<{ giftCards: TileCreditIssuedGiftCard[] }> {
    const raw = await this.call<{ giftCards: TileCreditIssuedGiftCard[] }>('/public/me/gift-cards');
    return { giftCards: raw.giftCards ?? [] };
  }

  async getConfig(): Promise<TileCreditPublicConfig> {
    const raw = await this.call<TileCreditPublicConfig & { ok: boolean }>('/public/config');
    return {
      currency: raw.currency,
      redemptionMinCents: raw.redemptionMinCents ?? 0,
      redemptionMaxCents: raw.redemptionMaxCents ?? null,
    };
  }

  /**
   * Ledger + gift-cards joined into one history feed. Each redeem
   * row gets `.card` populated with the masked info (last4 / status / expiry)
   * so you can render "•••• adf7 · depleted" in one pass. Non-redeem rows
   * pass through unchanged with `card: null`.
   *
   * Note: the join happens client-side. If you paginate the ledger with a
   * cursor, the gift-cards call is a full re-fetch on every page — cache the
   * `giftCards` map at the caller if you paginate deep.
   */
  async getHistory(opts: { limit?: number; before?: string } = {}): Promise<TileCreditHistoryPage> {
    const [ledger, cards] = await Promise.all([
      this.getLedger(opts),
      this.listGiftCards(),
    ]);
    const cardByGid = new Map<string, TileCreditIssuedGiftCard>(
      cards.giftCards.map((g) => [g.shopifyGiftCardGid, g]),
    );
    const entries: TileCreditHistoryEntry[] = ledger.entries.map((entry) => {
      const card = entry.giftCardGid ? cardByGid.get(entry.giftCardGid) : undefined;
      return {
        ...entry,
        card: card ? {
          last4: card.last4,
          status: card.status,
          expiresAt: card.expiresAt,
          initialAmountCents: card.initialAmountCents,
        } : null,
      };
    });
    return { entries, nextCursor: ledger.nextCursor };
  }

  async redeem(input: TileCreditRedeemInput): Promise<TileCreditRedeemResult> {
    if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
      throw new TileCreditError('validation', 'amountCents must be a positive integer');
    }
    const body = {
      amountCents: input.amountCents,
      idempotencyKey: input.idempotencyKey ?? randomKey('redeem'),
      reason: input.reason,
    };
    return this.call<TileCreditRedeemResult>('/public/me/redeem', { method: 'POST', body });
  }
}

// ---------------------------------------------------------------------------
// Facade — one client for callers without React
// ---------------------------------------------------------------------------

let activeClient: TileCreditClient | null = null;

/** Configure the shared client. Safe to call multiple times — it replaces the instance. With a fixed
 *  `customerAccessToken`, configure again for each new token; with `getAccessToken` it stays fresh. */
export function configureTileCredit(config: TileCreditConfig): TileCreditAPI {
  activeClient = new TileCreditClient(config);
  return activeClient;
}

export function getTileCreditClient(): TileCreditAPI | null {
  return activeClient;
}

/**
 * @deprecated Use `useCartStoreCredit()` in a React app: it allows one Apply at a time, finds its card
 * on the cart, and writes through the provider's cart queue (this writes to the cart directly, so the
 * provider's cart state is stale until it reads the cart again). Kept for callers without React.
 *
 * Mints a gift card with the shared client and adds it to the cart, keeping the cart's other gift
 * cards (`cartGiftCardCodesAdd`; this used `cartGiftCardCodesUpdate`, which took them off). The cart's
 * country is set only when it has none (`countryFallback`, else the shop's), keeping its email, and the
 * shopper when `customerAccessToken` is passed; it used to replace the identity with the country alone,
 * which dropped both. Throws `TileCreditError('cart_refused')` when Shopify didn't put the card on the
 * cart; the card then only holds the credit (nothing is charged), and the next redeem disables it.
 */
export async function redeemAndApplyToCart(opts: {
  cartId: string;
  amountCents: number;
  idempotencyKey?: string;
  reason?: string;
  countryFallback?: string;
  customerAccessToken?: string;
}): Promise<{ redeemed: TileCreditRedeemResult; cart: Cart }> {
  if (!activeClient) {
    throw new TileCreditError('unauthorized', 'Tile Credit not configured — call shopify.tileCredit.configure(...)');
  }
  // Ensure the Shopify SDK is initialized — its Storefront client writes the cart below.
  getConfig(); // throws with a friendly message if init() wasn't called
  const current = await cartApi.get(opts.cartId);
  if (!current) throw new TileCreditError('cart_refused', 'The cart no longer exists');

  // Mint the credit (the same key returns the same card, so a retry never mints a second).
  const redeemed = await activeClient.redeem({
    amountCents: opts.amountCents,
    idempotencyKey: opts.idempotencyKey,
    reason: opts.reason ?? 'Wallet redemption',
  });

  const { cart, notApplied } = await addGiftCardsKeepingBuyer(current, [redeemed.code], {
    countryCode: async () => opts.countryFallback ?? (await shop.countryCode()) ?? 'US',
    customerAccessToken: opts.customerAccessToken,
  });
  if (notApplied.length) {
    throw new TileCreditError('cart_refused', `Shopify didn't apply the gift card ending in ${redeemed.last4}`, undefined, {
      last4: redeemed.last4,
      giftCardGid: redeemed.giftCardGid,
    });
  }
  return { redeemed, cart };
}
