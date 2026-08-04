/**
 * Tile Credit — customer wallet + gift-card mint client.
 *
 * A typed, error-normalized wrapper around the tile-credit Cloud Run
 * service. Talks to `/public/*` on behalf of one signed-in customer.
 * The service resolves shop → appId internally; callers never pass an
 * appId, only the shop domain + the customer access token.
 *
 * See `docs/tile-credit-integration.md` for the mobile flow (wallet
 * screen → redeem sheet → apply to cart), the idempotency contract, and
 * the error taxonomy. This file is deliberately dependency-free (pure
 * `fetch`) so it can be lifted into any tile SDK.
 */
import { getConfig } from './client';
import { cart as cartApi } from './cart';
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

export class TileCreditClient implements TileCreditAPI {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly shopDomain: string;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;

  constructor(config: TileCreditConfig) {
    if (!config.baseUrl) throw new Error('TileCreditClient: baseUrl is required');
    if (!config.customerAccessToken) throw new Error('TileCreditClient: customerAccessToken is required');
    if (!config.shopDomain) throw new Error('TileCreditClient: shopDomain is required');
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.customerAccessToken;
    this.shopDomain = config.shopDomain.toLowerCase();
    this.signal = config.signal;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  // ─── HTTP core ──────────────────────────────────────────────────────────

  private async call<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
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
          Authorization: `Customer ${this.token}`,
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
      if (!res.ok) {
        const code = statusToCode(res.status);
        const msg = (body && (body.message || body.error)) || `${res.status} ${res.statusText}`;
        throw new TileCreditError(code, msg, res.status, body?.details ?? undefined);
      }
      return body as T;
    } catch (e) {
      if (e instanceof TileCreditError) throw e;
      // fetch throws on network / timeout / abort — normalize to `network`.
      const msg = e instanceof Error ? e.message : String(e);
      throw new TileCreditError('network', `${url} → ${msg}`);
    } finally {
      clearTimeout(timer);
      if (this.signal) this.signal.removeEventListener('abort', outerAbort);
    }
  }

  // ─── Public API — one method per endpoint (docs §4) ─────────────────────

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
   * Ledger + gift-cards joined into one history feed (docs §4.6). Each redeem
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
// Facade — configured once, reused across screens (docs §7)
// ---------------------------------------------------------------------------

let activeClient: TileCreditClient | null = null;

/** Configure the singleton client for the current customer session. Safe to
 *  call multiple times — replaces the instance. Rebuild on logout / new
 *  customer (`token` is baked in for the lifetime of the instance). */
export function configureTileCredit(config: TileCreditConfig): TileCreditAPI {
  activeClient = new TileCreditClient(config);
  return activeClient;
}

export function getTileCreditClient(): TileCreditAPI | null {
  return activeClient;
}

/**
 * Mint a gift card and apply it to the given cart — the "one function that
 * does it all" from the integration guide (§5.7). If `countryFallback` is
 * omitted, the shop's `localization.country.isoCode` is used. The buyer
 * identity update is a no-op when the cart already has a countryCode, so
 * calling this on a freshly created cart is safe.
 */
export async function redeemAndApplyToCart(opts: {
  cartId: string;
  amountCents: number;
  idempotencyKey?: string;
  reason?: string;
  countryFallback?: string;
}): Promise<{ redeemed: TileCreditRedeemResult; cart: Cart }> {
  if (!activeClient) {
    throw new TileCreditError('unauthorized', 'Tile Credit not configured — call shopify.tileCredit.configure(...)');
  }
  // Ensure the Shopify SDK is initialized — we need its Storefront client
  // to run cartBuyerIdentityUpdate + cartGiftCardCodesUpdate below.
  getConfig(); // throws with a friendly message if init() wasn't called

  // 1. Mint the credit (idempotent — pass a key if you want crash-safe retry).
  const redeemed = await activeClient.redeem({
    amountCents: opts.amountCents,
    idempotencyKey: opts.idempotencyKey,
    reason: opts.reason ?? 'Wallet redemption',
  });

  // 2. Ensure the cart has a buyerIdentity.countryCode so Shopify accepts
  //    the gift card as a payment tender. No-op if already set to the same
  //    value; belt-and-suspenders per the integration guide.
  const country = opts.countryFallback ?? (await shop.countryCode()) ?? 'US';
  await cartApi.setBuyerIdentity(opts.cartId, { countryCode: country });

  // 3. Apply. `applyGiftCardCodes` asserts no userErrors internally.
  const cart = await cartApi.applyGiftCardCodes(opts.cartId, [redeemed.code]);
  return { redeemed, cart };
}
