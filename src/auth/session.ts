/**
 * The shopper's session, for both ways of signing in (`AuthMethod`):
 *
 * - `password`: a Storefront `customerAccessToken` from email and password.
 * - `shopify`: Shopify's web sign-in for new customer accounts, OAuth 2 authorization code with PKCE
 *   against `shopify.com/authentication/<shopId>`, then the Customer Account API with that token.
 *
 * One session at a time; signing in one way ends a session of the other. Framework-free, so the
 * base cases are tested without React (test/auth-*.test.mjs). `ShopifyProvider` holds one and mirrors
 * its state into `useCustomer()`.
 *
 * Failure rules, the same for both:
 * - The shopper's own answer (wrong password, a refused sign-in) resolves `false` and emits
 *   `auth:loginFailed`. Backing out of the sign-in page resolves `false` and emits nothing.
 * - The store being unreachable throws, and never ends a session: being offline is not being signed out.
 * - A session Shopify no longer accepts ends: silently on app open, with `auth:sessionExpired` later.
 */
import { shopify } from '../shopify';
import { assertNoUserErrors } from '../client';
import { classifyAuthFailure } from '../errors';
import { ShopifyError } from '../types';
import type {
  Address,
  AuthMethod,
  AuthOptions,
  Customer,
  CustomerAccessToken,
  CustomerAccountConfig,
  RandomBytes,
  SecureStorageAdapter,
  SignInAttempt,
  UserError,
} from '../types';
import { base64urlDecodeText, createPkce, type PkcePair } from './pkce';

export type AuthEventType =
  | 'auth:loginSuccess'
  | 'auth:loginFailed'
  | 'auth:signup'
  | 'auth:logout'
  | 'auth:recoverSent'
  | 'auth:sessionExpired';

export interface SessionState {
  /** How the current session was signed in; null when signed out. */
  kind: AuthMethod | null;
  customer: Customer | null;
  /** The current access token; may be stale. `getAccessToken()` returns a fresh one. */
  accessToken: string | null;
  loading: boolean;
  /** Reading a stored session on app open. */
  restoring: boolean;
}

export interface SignupInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  acceptsMarketing?: boolean;
}

/** What `updateProfile` can change. A field left out is left as it is. */
export interface ProfileChanges {
  firstName?: string;
  lastName?: string;
  /** Email marketing consent. */
  acceptsMarketing?: boolean;
}

export interface CustomerSessionDeps {
  /** Where the tokens live. Read on every use, so the host can pass the adapter late. */
  storage: () => SecureStorageAdapter | null;
  /** Where SDK 0.8 and earlier kept the password token (the provider's `storage`): read once, then moved. */
  legacyStorage?: () => SecureStorageAdapter | null;
  options: () => AuthOptions | undefined;
  /** `ShopifyConfig.apiVersion`, the default Customer Account API version. */
  apiVersion?: () => string | undefined;
  emit: (type: AuthEventType, error?: unknown) => void;
  /** Tests move time. */
  now?: () => number;
}

/**
 * Production Amber's keychain keys, so its signed-in shoppers stay signed in after updating to a
 * Tile build. `expiresAt` is epoch milliseconds as a decimal string.
 */
export const SHOPIFY_SESSION_KEYS = {
  accessToken: 'auth.token',
  refreshToken: 'auth.refreshToken',
  expiresAt: 'auth.expiresAt',
  /** Kept only to sign out with: Shopify's logout endpoint identifies the session by `id_token_hint`. */
  idToken: 'auth.idToken',
} as const;

/**
 * The password session. Every key here is valid for expo-secure-store, which takes only letters,
 * digits, `.`, `-` and `_`: a `:` makes it throw, so SDK 0.8's `shopify:customer-token:v1` can't
 * be used in the keychain (it failed restore on an iPhone, 2026-10-02).
 */
export const PASSWORD_SESSION_KEYS = {
  accessToken: 'auth.storefrontToken',
  expiresAt: 'auth.storefrontExpiresAt',
} as const;

/** Where SDK 0.8 and earlier kept the password token, in the provider's `storage`. Moved on first read. */
export const LEGACY_PASSWORD_TOKEN_KEY = 'shopify:customer-token:v1';

/** Refresh a little early, so a request in flight can't land on a token that just expired. */
export const EXPIRY_SKEW_MS = 60_000;
/** A password token is renewed on app open once it has less than this left. */
export const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SCOPES = ['openid', 'email', 'customer-account-api:full'];
const DEFAULT_CUSTOMER_ACCOUNT_API_VERSION = '2025-07';

interface ShopifyTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when Shopify didn't say. */
  expiresAt: number | null;
  idToken: string | null;
}

interface PasswordToken {
  accessToken: string;
  expiresAt: number | null;
}

/** Shopify refused the grant (`invalid_grant` and kin): a final answer, unlike a network failure. */
class TokenRejected extends Error {
  constructor(public readonly code: string) {
    super(`Shopify refused the token request: ${code}`);
    this.name = 'TokenRejected';
  }
}

export function customerAccountUrls(c: CustomerAccountConfig, fallbackVersion?: string) {
  const auth = `https://shopify.com/authentication/${c.shopId}`;
  const version = c.apiVersion || fallbackVersion || DEFAULT_CUSTOMER_ACCOUNT_API_VERSION;
  return {
    authorize: `${auth}/oauth/authorize`,
    token: `${auth}/oauth/token`,
    logout: `${auth}/logout`,
    graphql: `https://shopify.com/${c.shopId}/account/customer/api/${version}/graphql`,
    redirectUri: c.redirectUri || `shop.${c.shopId}.app://callback`,
  };
}

/** `a=1&b=2`, by hand: React Native's `URLSearchParams` is incomplete. */
function form(params: Record<string, string>): string {
  return Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

/** The query and fragment parameters of a redirect URL. */
export function callbackParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const parts = [q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : '', h >= 0 ? url.slice(h + 1) : ''];
  for (const part of parts) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
      const value = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

function jwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    return JSON.parse(base64urlDecodeText(jwt.split('.')[1] ?? '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const PROFILE_QUERY = /* GraphQL */ `
  query CustomerProfile {
    customer {
      id
      firstName
      lastName
      emailAddress { emailAddress marketingState }
      phoneNumber { phoneNumber }
      defaultAddress { id firstName lastName address1 address2 city province country zip phoneNumber }
    }
  }
`;

interface RawAccountCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  emailAddress: { emailAddress: string | null; marketingState: string | null } | null;
  phoneNumber: { phoneNumber: string | null } | null;
  defaultAddress: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    country: string | null;
    zip: string | null;
    phoneNumber: string | null;
  } | null;
}

/** Names only: the Customer Account API's `CustomerUpdateInput` has no other field a shopper edits. */
const NAME_UPDATE_MUTATION = /* GraphQL */ `
  mutation CustomerNameUpdate($input: CustomerUpdateInput!) {
    customerUpdate(input: $input) {
      userErrors { field message code }
    }
  }
`;

/**
 * Consent has a mutation per direction, each acting on the signed-in shopper with no arguments, so
 * the wanted state picks the document.
 */
const MARKETING_SUBSCRIBE_MUTATION = /* GraphQL */ `
  mutation CustomerEmailMarketingSubscribe {
    customerEmailMarketingSubscribe {
      emailAddress { marketingState }
      userErrors { field message code }
    }
  }
`;

const MARKETING_UNSUBSCRIBE_MUTATION = /* GraphQL */ `
  mutation CustomerEmailMarketingUnsubscribe {
    customerEmailMarketingUnsubscribe {
      emailAddress { marketingState }
      userErrors { field message code }
    }
  }
`;

type UserErrorsPayload = { userErrors: UserError[] } | null;

/**
 * The fields of `changes` that differ from the loaded profile, so nothing Shopify already holds is
 * written again. An unset name counts as `''`. With no profile loaded (offline on app open), every
 * field given counts as changed.
 */
function changedProfileFields(current: Customer | null, changes: ProfileChanges): ProfileChanges {
  const changed: ProfileChanges = {};
  if (changes.firstName !== undefined && (!current || (current.firstName ?? '') !== changes.firstName)) {
    changed.firstName = changes.firstName;
  }
  if (changes.lastName !== undefined && (!current || (current.lastName ?? '') !== changes.lastName)) {
    changed.lastName = changes.lastName;
  }
  if (changes.acceptsMarketing !== undefined && (!current || current.acceptsMarketing !== changes.acceptsMarketing)) {
    changed.acceptsMarketing = changes.acceptsMarketing;
  }
  return changed;
}

/** A Customer Account API customer in the SDK's `Customer` shape, so screens don't care which sign-in it was. */
export function toCustomer(raw: RawAccountCustomer): Customer {
  const a = raw.defaultAddress;
  const address: Address | null = a
    ? {
        id: a.id,
        firstName: a.firstName ?? undefined,
        lastName: a.lastName ?? undefined,
        address1: a.address1 ?? '',
        address2: a.address2 ?? undefined,
        city: a.city ?? '',
        province: a.province ?? undefined,
        country: a.country ?? '',
        zip: a.zip ?? '',
        phone: a.phoneNumber ?? undefined,
      }
    : null;
  return {
    id: raw.id,
    email: raw.emailAddress?.emailAddress ?? '',
    firstName: raw.firstName,
    lastName: raw.lastName,
    phone: raw.phoneNumber?.phoneNumber ?? null,
    defaultAddress: address,
    // Only SUBSCRIBED is consent; every other marketing state reads as opted out.
    acceptsMarketing: raw.emailAddress?.marketingState === 'SUBSCRIBED',
  };
}

function defaultRandom(): RandomBytes | null {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) return null;
  return (n) => c.getRandomValues!(new Uint8Array(n));
}

export type CustomerSession = ReturnType<typeof createCustomerSession>;

export function createCustomerSession(deps: CustomerSessionDeps) {
  const now = deps.now ?? (() => Date.now());
  let state: SessionState = { kind: null, customer: null, accessToken: null, loading: false, restoring: true };
  const listeners = new Set<() => void>();
  let shopifyTokens: ShopifyTokens | null = null;
  let passwordToken: PasswordToken | null = null;
  /** Bumped whenever the session changes hands, so work started for an old one can't write over a new one. */
  let generation = 0;
  let refreshInFlight: Promise<string | null> | null = null;
  let latestAttempt = 0;
  let busyCount = 0;

  function set(patch: Partial<SessionState>) {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  }

  async function busy<T>(work: () => Promise<T>): Promise<T> {
    busyCount += 1;
    if (busyCount === 1) set({ loading: true });
    try {
      return await work();
    } finally {
      busyCount -= 1;
      if (busyCount === 0) set({ loading: false });
    }
  }

  function storage(): SecureStorageAdapter {
    const s = deps.storage();
    if (!s) throw new ShopifyError('ShopifyProvider: no storage for the customer session; pass auth.secureStorage');
    return s;
  }

  async function read(key: string): Promise<string | null> {
    const s = deps.storage();
    return s ? (await Promise.resolve(s.getItem(key))) ?? null : null;
  }

  /** Per key and error-tolerant: the token must go even if another key's delete fails. */
  async function removeKeys(keys: string[]) {
    const s = deps.storage();
    if (!s) return;
    await Promise.all(keys.map((key) => Promise.resolve().then(() => s.removeItem(key)).catch(() => undefined)));
  }

  function customerAccount(): CustomerAccountConfig {
    const c = deps.options()?.customerAccount;
    if (!c?.shopId || !c?.clientId) {
      throw new ShopifyError('ShopifyProvider: auth.customerAccount { shopId, clientId } is required for Shopify sign-in');
    }
    return c;
  }

  const urls = () => customerAccountUrls(customerAccount(), deps.apiVersion?.());

  // ── Storage ────────────────────────────────────────────────────────────────

  async function saveShopifyTokens(tokens: ShopifyTokens) {
    const s = storage();
    const k = SHOPIFY_SESSION_KEYS;
    await Promise.all([
      s.setItem(k.accessToken, tokens.accessToken),
      tokens.refreshToken ? s.setItem(k.refreshToken, tokens.refreshToken) : s.removeItem(k.refreshToken),
      tokens.expiresAt !== null ? s.setItem(k.expiresAt, String(tokens.expiresAt)) : s.removeItem(k.expiresAt),
      tokens.idToken ? s.setItem(k.idToken, tokens.idToken) : s.removeItem(k.idToken),
    ]);
    shopifyTokens = tokens;
  }

  async function savePasswordToken(token: CustomerAccessToken) {
    const s = storage();
    const expiresAt = Date.parse(token.expiresAt);
    await Promise.all([
      s.setItem(PASSWORD_SESSION_KEYS.accessToken, token.accessToken),
      Number.isFinite(expiresAt) ? s.setItem(PASSWORD_SESSION_KEYS.expiresAt, String(expiresAt)) : s.removeItem(PASSWORD_SESSION_KEYS.expiresAt),
    ]);
    passwordToken = { accessToken: token.accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
  }

  async function readShopifyTokens(): Promise<ShopifyTokens | null> {
    const k = SHOPIFY_SESSION_KEYS;
    const [accessToken, refreshToken, expiresAt, idToken] = await Promise.all([
      read(k.accessToken), read(k.refreshToken), read(k.expiresAt), read(k.idToken),
    ]);
    if (!accessToken) return null;
    return { accessToken, refreshToken, expiresAt: expiresAt ? Number(expiresAt) : null, idToken };
  }

  async function readPasswordToken(): Promise<PasswordToken | null> {
    let accessToken = await read(PASSWORD_SESSION_KEYS.accessToken);
    const legacy = deps.legacyStorage?.() ?? null;
    if (!accessToken && legacy) {
      // Moved from its 0.8 key (plain storage) to the keychain key, once.
      accessToken = (await Promise.resolve(legacy.getItem(LEGACY_PASSWORD_TOKEN_KEY))) ?? null;
      if (accessToken) {
        await Promise.resolve(storage().setItem(PASSWORD_SESSION_KEYS.accessToken, accessToken));
        await Promise.resolve(legacy.removeItem(LEGACY_PASSWORD_TOKEN_KEY));
      }
    }
    if (!accessToken) return null;
    const expiresAt = await read(PASSWORD_SESSION_KEYS.expiresAt);
    return { accessToken, expiresAt: expiresAt ? Number(expiresAt) : null };
  }

  /**
   * Ends the session locally. `expired`: Shopify stopped accepting it, as opposed to the shopper
   * signing out; it emits `auth:sessionExpired`, except on app open (see `restore`).
   */
  async function endSession(reason: 'signed-out' | 'expired' | 'replaced') {
    const announce = reason === 'expired' && state.kind !== null && !state.restoring;
    generation += 1;
    shopifyTokens = null;
    passwordToken = null;
    await removeKeys([...Object.values(SHOPIFY_SESSION_KEYS), ...Object.values(PASSWORD_SESSION_KEYS)]);
    const legacy = deps.legacyStorage?.() ?? null;
    if (legacy) await Promise.resolve().then(() => legacy.removeItem(LEGACY_PASSWORD_TOKEN_KEY)).catch(() => undefined);
    if (reason !== 'replaced') set({ kind: null, customer: null, accessToken: null });
    if (announce) deps.emit('auth:sessionExpired');
  }

  // ── Shopify (new customer accounts) ───────────────────────────────────────

  async function tokenRequest(params: Record<string, string>): Promise<ShopifyTokens> {
    let res: Response;
    try {
      res = await fetch(urls().token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form(params),
      });
    } catch (error) {
      throw new ShopifyError(`Customer Account token request failed: ${describe(error)}`);
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(await res.text()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const code = typeof json?.error === 'string' ? json.error : '';
      // 400/401 with an OAuth error code is Shopify's final answer; anything else (5xx, 429, a
      // proxy's HTML page) may pass, so it's a failure to reach the store, not a rejection.
      if ((res.status === 400 || res.status === 401) && code) throw new TokenRejected(code);
      throw new ShopifyError(`Customer Account token request: HTTP ${res.status}`);
    }
    if (!json || typeof json.access_token !== 'string') {
      throw new ShopifyError('Customer Account token response had no access_token');
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in);
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : null,
      idToken: typeof json.id_token === 'string' ? json.id_token : null,
    };
  }

  /**
   * Shopify rotates the refresh token on use, so a second refresh with the same token is refused, and
   * a refused refresh ends the session. Every caller wanting a token at once shares one refresh.
   */
  function refreshShopify(): Promise<string | null> {
    if (refreshInFlight) return refreshInFlight;
    const started = generation;
    const current = shopifyTokens;
    const run = async (): Promise<string | null> => {
      if (!current?.refreshToken) {
        await endSession('expired');
        return null;
      }
      let next: ShopifyTokens;
      try {
        next = await tokenRequest({
          grant_type: 'refresh_token',
          client_id: customerAccount().clientId,
          refresh_token: current.refreshToken,
        });
      } catch (error) {
        if (error instanceof TokenRejected) {
          if (started === generation) await endSession('expired');
          return null;
        }
        throw error;
      }
      // Signed out (or in again) while this was in flight: the result belongs to a session that's gone.
      if (started !== generation) return null;
      // A refresh response doesn't always carry a new refresh or id token; keep the ones we have.
      await saveShopifyTokens({
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? current.refreshToken,
        expiresAt: next.expiresAt,
        idToken: next.idToken ?? current.idToken,
      });
      set({ accessToken: next.accessToken });
      return next.accessToken;
    };
    const flight = run().finally(() => {
      if (refreshInFlight === flight) refreshInFlight = null;
    });
    refreshInFlight = flight;
    return flight;
  }

  /** A usable access token, refreshed or renewed when needed; null when signed out or the session ended. */
  async function getAccessToken(): Promise<string | null> {
    if (state.kind === 'shopify' && shopifyTokens) {
      const { accessToken, expiresAt } = shopifyTokens;
      if (expiresAt === null || expiresAt - EXPIRY_SKEW_MS > now()) return accessToken;
      return refreshShopify();
    }
    if (state.kind === 'password' && passwordToken) {
      const { accessToken, expiresAt } = passwordToken;
      if (expiresAt === null || expiresAt - EXPIRY_SKEW_MS > now()) return accessToken;
      // Classic tokens can only be renewed before they expire; past that, the shopper signs in again.
      await endSession('expired');
      return null;
    }
    return null;
  }

  /**
   * A token renewed now, for a caller whose service just refused the current one (Tile Credit's 401).
   * A Shopify session refreshes, sharing the one refresh in flight with every other caller; a password
   * session can't be renewed early, so null. Never ends the session itself: only Shopify refusing the
   * refresh does, as it would on the next Customer Account API call. Throws when offline.
   */
  async function renewAccessToken(): Promise<string | null> {
    if (state.kind === 'shopify' && shopifyTokens) return refreshShopify();
    return null;
  }

  /**
   * One Customer Account API call. The token goes in `Authorization` bare, with no `Bearer`: that's
   * what this API expects. A 401 refreshes once and retries.
   */
  async function customerAccountRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (state.kind !== 'shopify') throw new ShopifyError('Not signed in with Shopify (new customer accounts)');
    const send = async (token: string) => {
      try {
        return await fetch(urls().graphql, {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables: variables ?? {} }),
        });
      } catch (error) {
        throw new ShopifyError(`Customer Account API request failed: ${describe(error)}`);
      }
    };
    let token = await getAccessToken();
    if (!token) throw new ShopifyError('The customer session has ended');
    let res = await send(token);
    if (res.status === 401) {
      // Shopify can revoke a token before its stated expiry (a password reset, an admin action).
      token = await refreshShopify();
      if (!token) throw new ShopifyError('The customer session has ended');
      res = await send(token);
      if (res.status === 401) {
        await endSession('expired');
        throw new ShopifyError('The customer session has ended');
      }
    }
    let json: { data?: T; errors?: Array<{ message: string }> };
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new ShopifyError(`Customer Account API HTTP ${res.status}: not JSON`);
    }
    if (json.errors?.length) throw new ShopifyError(`GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    if (!json.data) throw new ShopifyError(`Customer Account API HTTP ${res.status}: no data`);
    return json.data;
  }

  async function loadShopifyProfile(): Promise<Customer | null> {
    const started = generation;
    const data = await customerAccountRequest<{ customer: RawAccountCustomer | null }>(PROFILE_QUERY);
    if (started !== generation) return null;
    const customer = data.customer ? toCustomer(data.customer) : null;
    set({ customer });
    return customer;
  }

  function startSignIn(): SignInAttempt {
    const c = customerAccount();
    const random = deps.options()?.random ?? defaultRandom();
    if (!random) throw new ShopifyError('ShopifyProvider: auth.random is required for Shopify sign-in on this engine (e.g. expo-crypto getRandomBytes)');
    const pkce: PkcePair = createPkce(random);
    const u = urls();
    const id = ++latestAttempt;
    let settled = false;
    const params: Record<string, string> = {
      client_id: c.clientId,
      response_type: 'code',
      redirect_uri: u.redirectUri,
      scope: (c.scopes ?? DEFAULT_SCOPES).join(' '),
      state: pkce.state,
      nonce: pkce.nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    };
    if (c.locale) params.ui_locales = c.locale;
    const isCallback = (url: string) =>
      url === u.redirectUri || url.startsWith(`${u.redirectUri}?`) || url.startsWith(`${u.redirectUri}#`);
    return {
      url: `${u.authorize}?${form(params)}`,
      redirectUri: u.redirectUri,
      isCallback,
      cancel: () => {
        settled = true;
      },
      finish: async (callbackUrl) => {
        // A second callback for the same attempt, or one for an attempt a newer sign-in replaced.
        if (settled || id !== latestAttempt || !isCallback(callbackUrl)) return false;
        settled = true;
        return busy(() => completeSignIn(callbackUrl, pkce));
      },
    };
  }

  async function completeSignIn(callbackUrl: string, pkce: PkcePair): Promise<boolean> {
    const q = callbackParams(callbackUrl);
    if (q.error) {
      // The shopper declined: their choice, like closing the page, not a failure to toast.
      if (q.error === 'access_denied') return false;
      deps.emit('auth:loginFailed', new ShopifyError(`Shopify sign-in failed: ${q.error}${q.error_description ? ` (${q.error_description})` : ''}`));
      return false;
    }
    if (q.state !== pkce.state || !q.code) {
      // Not the redirect this app asked for: never exchange a code it didn't start.
      deps.emit('auth:loginFailed', new ShopifyError('Shopify sign-in returned an unexpected redirect (state mismatch)'));
      return false;
    }
    let tokens: ShopifyTokens;
    try {
      tokens = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: customerAccount().clientId,
        redirect_uri: urls().redirectUri,
        code: q.code,
        code_verifier: pkce.verifier,
      });
    } catch (error) {
      if (!(error instanceof TokenRejected)) throw error;
      deps.emit('auth:loginFailed', error);
      return false;
    }
    // The id token comes straight from Shopify's token endpoint over TLS, so its signature needn't be
    // checked here (OpenID Connect Core 3.1.3.7); the nonce still ties it to this sign-in.
    if (tokens.idToken && jwtClaims(tokens.idToken)?.nonce !== pkce.nonce) {
      deps.emit('auth:loginFailed', new ShopifyError('Shopify sign-in returned an id token for another sign-in (nonce mismatch)'));
      return false;
    }
    await endSession('replaced');
    await saveShopifyTokens(tokens);
    set({ kind: 'shopify', accessToken: tokens.accessToken, customer: null });
    try {
      await loadShopifyProfile();
    } catch (error) {
      // Signed in; the profile loads on the next `refresh()`.
      console.warn('[sdk-shopify] signed in, but the profile did not load', error);
    }
    deps.emit('auth:loginSuccess');
    return true;
  }

  async function signIn(): Promise<boolean> {
    const open = deps.options()?.openAuthSession;
    if (!open) {
      throw new ShopifyError('ShopifyProvider: auth.openAuthSession is required for signIn(); an in-app web view uses startSignIn()');
    }
    const attempt = startSignIn();
    const result = await open(attempt.url, attempt.redirectUri);
    if (result.type !== 'success' || !result.url) {
      attempt.cancel();
      return false;
    }
    return attempt.finish(result.url);
  }

  // ── Password (classic customer accounts) ──────────────────────────────────

  async function startPasswordSession(token: CustomerAccessToken, customer: Customer | null) {
    await endSession('replaced');
    await savePasswordToken(token);
    set({ kind: 'password', accessToken: token.accessToken, customer });
  }

  async function login(email: string, password: string): Promise<boolean> {
    return busy(async () => {
      let token: CustomerAccessToken;
      try {
        token = await shopify.customer.login({ email, password });
      } catch (error) {
        // Only a credential problem is the shopper's mistake; the store being unreachable throws.
        if (classifyAuthFailure(error) === 'unknown') throw error;
        deps.emit('auth:loginFailed', error);
        return false;
      }
      const customer = await shopify.customer.profile(token.accessToken);
      await startPasswordSession(token, customer);
      deps.emit('auth:loginSuccess');
      return true;
    });
  }

  async function signup(input: SignupInput): Promise<boolean> {
    return busy(async () => {
      let created: { customer: Customer; accessToken: CustomerAccessToken };
      try {
        created = await shopify.customer.signup(input);
      } catch (error) {
        if (classifyAuthFailure(error) === 'unknown') throw error;
        deps.emit('auth:loginFailed', error);
        return false;
      }
      await startPasswordSession(created.accessToken, created.customer);
      // Signup signs the shopper in, so both fire: a host that only toasts on loginSuccess still says the right thing.
      deps.emit('auth:signup');
      deps.emit('auth:loginSuccess');
      return true;
    });
  }

  async function recoverPassword(email: string): Promise<void> {
    await busy(async () => {
      await shopify.customer.recoverPassword(email);
      deps.emit('auth:recoverSent');
    });
  }

  // ── Both ──────────────────────────────────────────────────────────────────

  /** Re-reads the profile. Null when signed out or the session ended; throws when offline. */
  async function refresh(): Promise<Customer | null> {
    if (state.kind === 'shopify') return loadShopifyProfile();
    if (state.kind === 'password') {
      const started = generation;
      const token = await getAccessToken();
      if (!token) return null;
      const customer = await shopify.customer.profile(token);
      if (started !== generation) return null;
      if (!customer) {
        await endSession('expired');
        return null;
      }
      set({ customer });
      return customer;
    }
    return null;
  }

  /**
   * Password session: one Storefront `customerUpdate`. It returns the updated customer, which becomes
   * `customer`, so no second request is needed.
   */
  async function updatePasswordProfile(changed: ProfileChanges): Promise<void> {
    const started = generation;
    const token = await getAccessToken();
    if (!token) throw new ShopifyError('The customer session has ended');
    const updated = await shopify.customer.updateProfile(token, changed);
    if (started === generation) set({ customer: updated });
  }

  /**
   * Shopify session: `customerUpdate` for the names, then the consent mutation, stopping at the first
   * refusal. Whatever Shopify accepted is re-read even when a later change was refused, so `customer`
   * never shows a value Shopify doesn't hold.
   */
  async function updateShopifyProfile(changed: ProfileChanges): Promise<void> {
    const { acceptsMarketing: subscribe, ...names } = changed;
    const accepted: ProfileChanges = {};
    try {
      if (Object.keys(names).length > 0) {
        const data = await customerAccountRequest<{ customerUpdate: UserErrorsPayload }>(NAME_UPDATE_MUTATION, { input: names });
        assertNoUserErrors('customerUpdate', data.customerUpdate?.userErrors);
        Object.assign(accepted, names);
      }
      if (subscribe !== undefined) {
        const data = await customerAccountRequest<{
          customerEmailMarketingSubscribe?: UserErrorsPayload;
          customerEmailMarketingUnsubscribe?: UserErrorsPayload;
        }>(subscribe ? MARKETING_SUBSCRIBE_MUTATION : MARKETING_UNSUBSCRIBE_MUTATION);
        const payload = subscribe ? data.customerEmailMarketingSubscribe : data.customerEmailMarketingUnsubscribe;
        // "Already subscribed" is the state the shopper asked for, not a failure. It happens when the
        // loaded profile was out of date (subscribed on another device since).
        const errors = (payload?.userErrors ?? []).filter((e) => !(subscribe && e.code === 'CUSTOMER_ALREADY_SUBSCRIBED'));
        assertNoUserErrors(subscribe ? 'customerEmailMarketingSubscribe' : 'customerEmailMarketingUnsubscribe', errors);
        accepted.acceptsMarketing = subscribe;
      }
    } finally {
      if (Object.keys(accepted).length > 0) await reloadAfterUpdate(accepted);
    }
  }

  /**
   * Re-reads the profile after a write Shopify accepted. If that read fails (offline the moment after
   * saving), the accepted values are shown instead, so the screen doesn't fall back to the old ones.
   * Never throws.
   */
  async function reloadAfterUpdate(accepted: ProfileChanges): Promise<void> {
    const started = generation;
    try {
      await loadShopifyProfile();
    } catch (error) {
      console.warn('[sdk-shopify] profile saved, but did not reload', error);
      const current = state.customer;
      if (started === generation && current) set({ customer: { ...current, ...accepted } });
    }
  }

  /**
   * Changes the shopper's name and email marketing consent, for either kind of session. Sends only
   * the fields that differ from `customer` (nothing to send resolves `true` at once). `true` once
   * Shopify accepted every change, with `customer` showing the new values. `false` when signed out, or
   * when Shopify refused a value or couldn't be reached; the reason goes to `console.warn`. Never
   * throws, so a form only has to check the answer.
   */
  async function updateProfile(changes: ProfileChanges): Promise<boolean> {
    try {
      return await busy(async () => {
        const kind = state.kind;
        if (!kind) throw new ShopifyError('Not signed in');
        const changed = changedProfileFields(state.customer, changes);
        if (Object.keys(changed).length === 0) return true;
        if (kind === 'password') await updatePasswordProfile(changed);
        else await updateShopifyProfile(changed);
        return true;
      });
    } catch (error) {
      console.warn('[sdk-shopify] profile update failed', error);
      return false;
    }
  }

  /**
   * Local first, so nothing between the tap and being signed out can fail; then Shopify is told, and
   * its answer doesn't matter. Always resolves.
   */
  async function logout(): Promise<void> {
    await busy(async () => {
      const kind = state.kind;
      const idToken = shopifyTokens?.idToken ?? null;
      const classicToken = passwordToken?.accessToken ?? null;
      let logoutUrl: string | null = null;
      try {
        if (kind === 'shopify' && idToken) logoutUrl = `${urls().logout}?id_token_hint=${encodeURIComponent(idToken)}`;
      } catch {
        logoutUrl = null;
      }
      await endSession('signed-out');
      if (logoutUrl) {
        // Ends Shopify's session server-side. No `post_logout_redirect_uri`: Shopify would answer
        // with a redirect to the app's scheme, which fetch can't follow. `manual`: only arriving matters.
        void fetch(logoutUrl, { method: 'GET', redirect: 'manual' }).catch(() => undefined);
      }
      if (classicToken) {
        try {
          await shopify.customer.logout(classicToken);
        } catch (error) {
          console.warn('[sdk-shopify] token delete failed; signed out locally', error);
        }
      }
      deps.emit('auth:logout');
    });
  }

  /**
   * Reads a stored session on app open. A session Shopify no longer accepts is dropped silently: an
   * expired login isn't a failed one, and a toast at a shopper who did nothing is noise. Offline
   * keeps the session; the profile loads on the next `refresh()`.
   */
  async function restore(): Promise<void> {
    const started = generation;
    try {
      const stored = await readShopifyTokens();
      if (started !== generation) return;
      if (stored) {
        shopifyTokens = stored;
        set({ kind: 'shopify', accessToken: stored.accessToken });
        const expired = stored.expiresAt !== null && stored.expiresAt - EXPIRY_SKEW_MS <= now();
        if (expired) {
          // Null when Shopify refused it (the session is gone); offline keeps the session as is.
          const token = await refreshShopify().catch((error) => {
            console.warn('[sdk-shopify] session refresh failed on app open; kept', error);
            return null;
          });
          if (!token) return;
        }
        await loadShopifyProfile().catch((error) => console.warn('[sdk-shopify] profile did not load on app open', error));
        return;
      }

      const classic = await readPasswordToken();
      if (started !== generation || !classic) return;
      if (classic.expiresAt !== null && classic.expiresAt - EXPIRY_SKEW_MS <= now()) {
        await endSession('expired');
        return;
      }
      passwordToken = classic;
      set({ kind: 'password', accessToken: classic.accessToken });
      if (classic.expiresAt !== null && classic.expiresAt - now() < RENEW_WITHIN_MS) {
        try {
          const renewed = await shopify.customer.renew(classic.accessToken);
          if (started === generation) {
            await savePasswordToken(renewed);
            set({ accessToken: renewed.accessToken });
          }
        } catch (error) {
          // Still valid for now; it's tried again on the next app open.
          console.warn('[sdk-shopify] token renew failed; kept', error);
        }
      }
      let customer: Customer | null;
      try {
        customer = await shopify.customer.profile(passwordToken?.accessToken ?? classic.accessToken);
      } catch (error) {
        console.warn('[sdk-shopify] profile did not load on app open; session kept', error);
        return;
      }
      if (started !== generation) return;
      if (!customer) await endSession('expired');
      else set({ customer });
    } catch (error) {
      console.warn('[sdk-shopify] session restore failed', error);
    } finally {
      set({ restoring: false });
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    restore,
    login,
    signup,
    recoverPassword,
    startSignIn,
    signIn,
    getAccessToken,
    renewAccessToken,
    customerAccountRequest,
    refresh,
    updateProfile,
    logout,
  };
}
