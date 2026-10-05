// Base cases of the "new" login: Shopify's web sign-in (new customer accounts, OAuth 2 + PKCE),
// against the session module with Shopify stubbed at `fetch` and the browser sheet stubbed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { counterRandom, deferred, harness, jwt, keychain, networkDown, parseForm, response } from './auth-helpers.mjs';

const { createCustomerSession, codeChallenge, SHOPIFY_SESSION_KEYS: K, PASSWORD_SESSION_KEYS } = await import('../dist/index.js');
const { sha256, base64url } = await import('../dist/auth/pkce.js');

const SHOP_ID = '68843864220';
const CLIENT_ID = 'client-1';
const REDIRECT = `shop.${SHOP_ID}.app://callback`;
const AUTHORIZE_URL = `https://shopify.com/authentication/${SHOP_ID}/oauth/authorize`;
const TOKEN_URL = `https://shopify.com/authentication/${SHOP_ID}/oauth/token`;
const LOGOUT_URL = `https://shopify.com/authentication/${SHOP_ID}/logout`;
const GRAPHQL_URL = `https://shopify.com/${SHOP_ID}/account/customer/api/2026-07/graphql`;
const HOUR = 3600_000;

// ── Fake Shopify ────────────────────────────────────────────────────────────
const clock = { now: Date.parse('2026-10-02T10:00:00Z') };
const liveAccess = new Set();
const liveRefresh = new Set();
let issued = 0;
const requests = [];
const byGrant = (grant) => requests.filter((r) => r.url === TOKEN_URL && parseForm(r.body).grant_type === grant);

/** The sign-in sheet. `mode` is what the shopper does in it. */
const browser = {
  mode: 'approve',
  params: null,
  async open(url, redirectUri) {
    assert.ok(url.startsWith(`${AUTHORIZE_URL}?`));
    browser.params = Object.fromEntries(new URL(url).searchParams);
    const state = browser.params.state;
    switch (browser.mode) {
      case 'approve': return { type: 'success', url: `${redirectUri}?code=code_1&state=${state}` };
      case 'cancel': return { type: 'cancel' };
      case 'dismiss': return { type: 'dismiss' };
      case 'denied': return { type: 'success', url: `${redirectUri}?error=access_denied&state=${state}` };
      case 'server-error': return { type: 'success', url: `${redirectUri}?error=server_error&error_description=Try+later&state=${state}` };
      case 'forged': return { type: 'success', url: `${redirectUri}?code=code_1&state=someone-elses` };
      default: throw new Error(browser.mode);
    }
  },
};

function issue({ idToken = true } = {}) {
  issued += 1;
  const access = `at_${issued}`;
  const refresh = `rt_${issued}`;
  liveAccess.add(access);
  liveRefresh.add(refresh);
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: 3600,
    token_type: 'Bearer',
    ...(idToken ? { id_token: jwt({ sub: '7', nonce: browser.params?.nonce }) } : {}),
  };
}

const server = {
  token(form) {
    if (form.grant_type === 'authorization_code') {
      // PKCE: the verifier must hash to the challenge the sheet was opened with.
      if (form.code !== 'code_1' || codeChallenge(form.code_verifier) !== browser.params.code_challenge) {
        return response(400, { error: 'invalid_grant' });
      }
      return response(200, issue());
    }
    if (form.grant_type === 'refresh_token') {
      // Refresh tokens rotate: each one works once.
      if (!liveRefresh.delete(form.refresh_token)) return response(400, { error: 'invalid_grant' });
      return response(200, issue({ idToken: false }));
    }
    return response(400, { error: 'unsupported_grant_type' });
  },
  graphql(body, headers) {
    if (!liveAccess.has(headers.Authorization)) return response(401, { errors: [{ message: 'Unauthorized' }] });
    return response(200, {
      data: {
        customer: {
          id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
          emailAddress: { emailAddress: 'amber@example.com', marketingState: 'SUBSCRIBED' },
          phoneNumber: { phoneNumber: '+15550100' },
          defaultAddress: { id: 'a1', firstName: 'Amber', lastName: 'Marie', address1: '1 Main', address2: null, city: 'Austin', province: 'TX', country: 'United States', zip: '78701', phoneNumber: null },
        },
      },
    });
  },
  logout: () => response(302, ''),
};
const defaults = { ...server };

global.fetch = async (url, init = {}) => {
  const req = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
  requests.push(req);
  if (req.url === TOKEN_URL) return server.token(parseForm(req.body), req);
  if (req.url === GRAPHQL_URL) return server.graphql(JSON.parse(req.body), req.headers);
  if (req.url.startsWith(`${LOGOUT_URL}?`)) return server.logout(req);
  throw new Error(`unexpected fetch ${req.url}`);
};

function reset() {
  Object.assign(server, defaults);
  browser.mode = 'approve';
  browser.params = null;
  requests.length = 0;
}

/** A session as the provider makes one. `restore()` runs first, as on app open. */
async function makeSession({ storage = keychain(), options = {}, restore = true } = {}) {
  const events = [];
  const session = createCustomerSession({
    storage: () => storage,
    options: () => ({
      method: 'shopify',
      customerAccount: { shopId: SHOP_ID, clientId: CLIENT_ID },
      openAuthSession: browser.open,
      random: counterRandom(),
      ...options,
    }),
    apiVersion: () => '2026-07',
    emit: (type, error) => events.push({ type, error }),
    now: () => clock.now,
  });
  if (restore) await session.restore();
  return { session, storage, events, state: () => session.getState(), types: () => events.map((e) => e.type) };
}

/** A stored session, as a previous app run left it. */
function storedSession({ expiresIn = HOUR, idToken = 'id_old' } = {}) {
  liveAccess.add('at_stored');
  liveRefresh.add('rt_stored');
  return keychain({
    [K.accessToken]: 'at_stored',
    [K.refreshToken]: 'rt_stored',
    [K.expiresAt]: String(clock.now + expiresIn),
    [K.idToken]: idToken,
  });
}

const t = harness('auth: Shopify web sign-in (new customer accounts)');

// ── PKCE ────────────────────────────────────────────────────────────────────
t.section('PKCE');
await t.check('SHA-256 matches node:crypto, one block and several', () => {
  for (const text of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(200), 'é漢🙂']) {
    const ours = Buffer.from(sha256(new TextEncoder().encode(text))).toString('hex');
    assert.equal(ours, createHash('sha256').update(text, 'utf8').digest('hex'), JSON.stringify(text));
  }
});
await t.check('S256 challenge matches RFC 7636 appendix B', () => {
  assert.equal(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
await t.check('base64url has no padding and matches Buffer', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 53 + 7) & 0xff);
    assert.equal(base64url(bytes), Buffer.from(bytes).toString('base64url'));
  }
});

// ── Sign in ─────────────────────────────────────────────────────────────────
t.section('sign in (system sheet)');
{
  reset();
  const s = await makeSession();
  const ok = await s.session.signIn();
  await t.check('success: signed in, profile loaded, loginSuccess', () => {
    assert.equal(ok, true);
    assert.equal(s.state().kind, 'shopify');
    assert.equal(s.state().accessToken, 'at_1');
    assert.equal(s.state().customer.email, 'amber@example.com');
    assert.equal(s.state().customer.acceptsMarketing, true);
    assert.equal(s.state().customer.defaultAddress.city, 'Austin');
    assert.deepEqual(s.types(), ['auth:loginSuccess']);
  });
  await t.check('the authorize URL asks for a PKCE code with state and nonce', () => {
    const p = browser.params;
    assert.equal(p.client_id, CLIENT_ID);
    assert.equal(p.response_type, 'code');
    assert.equal(p.redirect_uri, REDIRECT);
    assert.equal(p.scope, 'openid email customer-account-api:full');
    assert.equal(p.code_challenge_method, 'S256');
    assert.match(p.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(p.state && p.nonce && p.state !== p.nonce);
  });
  await t.check('the code exchange sends the verifier, and no secret', () => {
    const [exchange] = byGrant('authorization_code');
    const form = parseForm(exchange.body);
    assert.equal(form.client_id, CLIENT_ID);
    assert.equal(form.redirect_uri, REDIRECT);
    assert.equal(codeChallenge(form.code_verifier), browser.params.code_challenge);
    assert.equal(form.client_secret, undefined);
  });
  await t.check('tokens are stored under production Amber\'s keychain keys', () => {
    const stored = s.storage.dump();
    assert.equal(stored[K.accessToken], 'at_1');
    assert.equal(stored[K.refreshToken], 'rt_1');
    assert.equal(stored[K.expiresAt], String(clock.now + HOUR));
    assert.ok(stored[K.idToken].split('.').length === 3);
  });
  await t.check('the Customer Account API gets the token bare, no "Bearer"', () => {
    const call = requests.find((r) => r.url === GRAPHQL_URL);
    assert.equal(call.headers.Authorization, 'at_1');
  });
}

for (const mode of ['cancel', 'dismiss']) {
  reset();
  browser.mode = mode;
  const s = await makeSession();
  const ok = await s.session.signIn();
  await t.check(`backing out (${mode}): false, no event, nothing stored, no token request`, () => {
    assert.equal(ok, false);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.types(), []);
    assert.deepEqual(s.storage.dump(), {});
    assert.equal(byGrant('authorization_code').length, 0);
  });
}

{
  reset();
  browser.mode = 'denied';
  const s = await makeSession();
  const ok = await s.session.signIn();
  await t.check('the shopper declines (access_denied): false, no toast', () => {
    assert.equal(ok, false);
    assert.deepEqual(s.types(), []);
    assert.equal(byGrant('authorization_code').length, 0);
  });
}

{
  reset();
  browser.mode = 'server-error';
  const s = await makeSession();
  const ok = await s.session.signIn();
  await t.check('Shopify reports an error: false, loginFailed with the reason', () => {
    assert.equal(ok, false);
    assert.deepEqual(s.types(), ['auth:loginFailed']);
    assert.match(s.events[0].error.message, /server_error \(Try later\)/);
  });
}

{
  reset();
  browser.mode = 'forged';
  const s = await makeSession();
  const ok = await s.session.signIn();
  await t.check('a redirect with the wrong state is refused, and its code never exchanged', () => {
    assert.equal(ok, false);
    assert.deepEqual(s.types(), ['auth:loginFailed']);
    assert.match(s.events[0].error.message, /state mismatch/);
    assert.equal(byGrant('authorization_code').length, 0);
    assert.equal(s.state().kind, null);
  });
}

{
  reset();
  server.token = () => response(400, { error: 'invalid_grant', error_description: 'code expired' });
  const s = await makeSession();
  const ok = await s.session.signIn();
  await t.check('the code exchange is refused (invalid_grant): false, loginFailed, nothing stored', () => {
    assert.equal(ok, false);
    assert.deepEqual(s.types(), ['auth:loginFailed']);
    assert.deepEqual(s.storage.dump(), {});
  });
}

{
  reset();
  server.token = (form) => {
    const body = issue();
    body.id_token = jwt({ sub: '7', nonce: 'another-sign-in' });
    return response(200, body);
  };
  const s = await makeSession();
  const ok = await s.session.signIn();
  await t.check('an id token for another sign-in (nonce mismatch) is refused', () => {
    assert.equal(ok, false);
    assert.deepEqual(s.types(), ['auth:loginFailed']);
    assert.match(s.events[0].error.message, /nonce mismatch/);
    assert.deepEqual(s.storage.dump(), {});
  });
}

for (const [label, handler] of [['offline', networkDown], ['Shopify down (503)', () => response(503, '<html>')]]) {
  reset();
  server.token = handler;
  const s = await makeSession();
  let threw = null;
  try { await s.session.signIn(); } catch (e) { threw = e; }
  await t.check(`${label} during the exchange: throws, no loginFailed, nothing stored`, () => {
    assert.equal(threw?.name, 'ShopifyError');
    assert.deepEqual(s.types(), []);
    assert.deepEqual(s.storage.dump(), {});
    assert.equal(s.state().loading, false);
  });
}

{
  reset();
  const storage = keychain({ [PASSWORD_SESSION_KEYS.accessToken]: 'classic', [PASSWORD_SESSION_KEYS.expiresAt]: String(clock.now + 30 * 24 * HOUR) });
  const s = await makeSession({ storage, restore: false });
  await s.session.signIn();
  await t.check('signing in with Shopify ends a password session on the device', () => {
    assert.equal(storage.map.has(PASSWORD_SESSION_KEYS.accessToken), false);
    assert.equal(s.state().kind, 'shopify');
  });
}

t.section('sign in (in-app web view)');
{
  reset();
  const s = await makeSession();
  const attempt = s.session.startSignIn();
  browser.params = Object.fromEntries(new URL(attempt.url).searchParams);
  await t.check('isCallback picks out the redirect, not Shopify\'s own pages', () => {
    assert.equal(attempt.redirectUri, REDIRECT);
    assert.equal(attempt.isCallback(`${REDIRECT}?code=x&state=y`), true);
    assert.equal(attempt.isCallback('https://shopify.com/authentication/68843864220/login'), false);
    assert.equal(attempt.isCallback(`${REDIRECT}-evil?code=x`), false);
  });
  const ok = await attempt.finish(`${REDIRECT}?code=code_1&state=${browser.params.state}`);
  const again = await attempt.finish(`${REDIRECT}?code=code_1&state=${browser.params.state}`);
  await t.check('finish signs in once; the same callback again is ignored', () => {
    assert.equal(ok, true);
    assert.equal(again, false);
    assert.equal(byGrant('authorization_code').length, 1);
    assert.deepEqual(s.types(), ['auth:loginSuccess']);
  });
}
{
  reset();
  const s = await makeSession();
  const first = s.session.startSignIn();
  const firstState = new URL(first.url).searchParams.get('state');
  const second = s.session.startSignIn();
  browser.params = Object.fromEntries(new URL(second.url).searchParams);
  const stale = await first.finish(`${REDIRECT}?code=code_1&state=${firstState}`);
  const cancelled = s.session.startSignIn();
  cancelled.cancel();
  const afterCancel = await cancelled.finish(`${REDIRECT}?code=code_1&state=x`);
  await t.check('a replaced attempt and a cancelled one can\'t sign in', () => {
    assert.equal(stale, false);
    assert.equal(afterCancel, false);
    assert.equal(byGrant('authorization_code').length, 0);
    assert.deepEqual(s.types(), []);
  });
}

// ── App open ────────────────────────────────────────────────────────────────
t.section('restore on app open');
{
  reset();
  const s = await makeSession({ storage: storedSession() });
  await t.check('a fresh token: signed in at once, no refresh, no event', () => {
    assert.equal(s.state().kind, 'shopify');
    assert.equal(s.state().restoring, false);
    assert.equal(s.state().customer.firstName, 'Amber');
    assert.equal(byGrant('refresh_token').length, 0);
    assert.deepEqual(s.types(), []);
  });
}
{
  reset();
  const storage = storedSession({ expiresIn: -HOUR });
  const s = await makeSession({ storage });
  await t.check('an expired token is refreshed; the rotated refresh token is stored, the id token kept', () => {
    assert.equal(byGrant('refresh_token').length, 1);
    assert.equal(s.state().kind, 'shopify');
    const stored = storage.dump();
    assert.notEqual(stored[K.accessToken], 'at_stored');
    assert.notEqual(stored[K.refreshToken], 'rt_stored');
    assert.equal(stored[K.idToken], 'id_old');
    assert.deepEqual(s.types(), []);
  });
}
{
  reset();
  const storage = storedSession({ expiresIn: 30_000 });
  await makeSession({ storage });
  await t.check('a token inside the 60 s margin counts as expired', () => {
    assert.equal(byGrant('refresh_token').length, 1);
  });
}
{
  reset();
  const storage = storedSession({ expiresIn: -HOUR });
  liveRefresh.delete('rt_stored');
  const s = await makeSession({ storage });
  await t.check('a refused refresh signs out silently: storage cleared, no event', () => {
    assert.equal(s.state().kind, null);
    assert.equal(s.state().restoring, false);
    assert.deepEqual(storage.dump(), {});
    assert.deepEqual(s.types(), []);
  });
}
{
  reset();
  server.token = networkDown;
  const storage = storedSession({ expiresIn: -HOUR });
  const s = await makeSession({ storage });
  await t.check('offline with an expired token: the session is kept for later', () => {
    assert.equal(s.state().kind, 'shopify');
    assert.equal(s.state().restoring, false);
    assert.equal(storage.dump()[K.refreshToken], 'rt_stored');
    assert.deepEqual(s.types(), []);
  });
}
{
  reset();
  server.graphql = networkDown;
  const s = await makeSession({ storage: storedSession() });
  await t.check('offline with a fresh token: signed in, profile still to load', () => {
    assert.equal(s.state().kind, 'shopify');
    assert.equal(s.state().customer, null);
    assert.equal(s.state().restoring, false);
  });
  server.graphql = defaults.graphql;
  await s.session.refresh();
  await t.check('refresh() loads the profile once back online', () => {
    assert.equal(s.state().customer.lastName, 'Marie');
  });
}

// ── In use ──────────────────────────────────────────────────────────────────
t.section('tokens in use');
{
  reset();
  const s = await makeSession({ storage: storedSession() });
  clock.now += 2 * HOUR;
  const tokens = await Promise.all([s.session.getAccessToken(), s.session.getAccessToken(), s.session.getAccessToken()]);
  await t.check('three callers at once share one refresh (refresh tokens rotate)', () => {
    assert.equal(byGrant('refresh_token').length, 1);
    assert.equal(new Set(tokens).size, 1);
    assert.ok(tokens[0].startsWith('at_'));
    assert.deepEqual(s.types(), []);
  });
}
{
  reset();
  const s = await makeSession({ storage: storedSession() });
  liveRefresh.delete('rt_stored');
  clock.now += 2 * HOUR;
  const token = await s.session.getAccessToken();
  await t.check('a refused refresh while in use: signed out, auth:sessionExpired', () => {
    assert.equal(token, null);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.types(), ['auth:sessionExpired']);
    assert.deepEqual(s.storage.dump(), {});
  });
}
{
  reset();
  const s = await makeSession({ storage: storedSession() });
  server.token = networkDown;
  clock.now += 2 * HOUR;
  let threw = null;
  try { await s.session.getAccessToken(); } catch (e) { threw = e; }
  await t.check('offline while in use: throws, still signed in', () => {
    assert.equal(threw?.name, 'ShopifyError');
    assert.equal(s.state().kind, 'shopify');
    assert.deepEqual(s.types(), []);
  });
}
{
  reset();
  const s = await makeSession({ storage: storedSession() });
  liveAccess.delete('at_stored');
  const data = await s.session.customerAccountRequest('query { customer { id } }');
  await t.check('a revoked token (401) is refreshed once and the call retried', () => {
    assert.equal(data.customer.id, 'gid://shopify/Customer/7');
    assert.equal(byGrant('refresh_token').length, 1);
    assert.equal(s.state().kind, 'shopify');
  });
}
{
  reset();
  const s = await makeSession({ storage: storedSession() });
  server.graphql = () => response(401, {});
  let threw = null;
  try { await s.session.customerAccountRequest('query { customer { id } }'); } catch (e) { threw = e; }
  await t.check('401 again after the refresh: the session ends, sessionExpired', () => {
    assert.match(threw?.message, /session has ended/);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.types(), ['auth:sessionExpired']);
  });
}

// ── Sign out ────────────────────────────────────────────────────────────────
t.section('sign out');
{
  reset();
  const s = await makeSession();
  await s.session.signIn();
  const idToken = s.storage.dump()[K.idToken];
  let storageAtLogout = null;
  server.logout = () => { storageAtLogout = s.storage.dump(); return response(302, ''); };
  await s.session.logout();
  await new Promise((r) => setTimeout(r, 0));
  await t.check('local first: storage is already empty when Shopify is told', () => {
    assert.deepEqual(storageAtLogout, {});
    assert.equal(s.state().kind, null);
    assert.equal(s.state().customer, null);
  });
  await t.check('Shopify\'s session is ended with id_token_hint; logout fires', () => {
    const call = requests.find((r) => r.url.startsWith(LOGOUT_URL));
    assert.equal(new URL(call.url).searchParams.get('id_token_hint'), idToken);
    assert.equal(s.types().at(-1), 'auth:logout');
  });
}
{
  reset();
  server.logout = networkDown;
  const s = await makeSession({ storage: storedSession() });
  await s.session.logout();
  await t.check('offline sign-out still signs out', () => {
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.storage.dump(), {});
    assert.deepEqual(s.types(), ['auth:logout']);
  });
}
{
  reset();
  const gate = deferred();
  server.token = async (form) => { await gate.promise; return defaults.token(form); };
  const s = await makeSession({ storage: storedSession() });
  clock.now += 2 * HOUR;
  const pending = s.session.getAccessToken();
  await s.session.logout();
  gate.resolve();
  const token = await pending;
  await t.check('a refresh that lands after sign-out doesn\'t sign the shopper back in', () => {
    assert.equal(token, null);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.storage.dump(), {});
  });
}

// ── Setup errors ────────────────────────────────────────────────────────────
t.section('setup');
{
  const s = await makeSession({ options: { customerAccount: undefined } });
  await t.check('no customerAccount config: a clear error', () => {
    assert.throws(() => s.session.startSignIn(), /auth\.customerAccount/);
  });
}
{
  const s = await makeSession({ options: { openAuthSession: undefined } });
  let threw = null;
  try { await s.session.signIn(); } catch (e) { threw = e; }
  await t.check('no openAuthSession: signIn() says to pass it or use startSignIn()', () => {
    assert.match(threw?.message, /openAuthSession/);
  });
}

t.done();
