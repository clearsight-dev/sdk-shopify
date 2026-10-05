// Base cases of the "old" login: email and password (classic customer accounts, Storefront
// `customerAccessToken`), against the session module with the Storefront API stubbed at `fetch`.
import assert from 'node:assert/strict';
import { SECURE_STORE_KEY, harness, keychain, memoryStorage, networkDown, response } from './auth-helpers.mjs';

const { createCustomerSession, PASSWORD_SESSION_KEYS: P, SHOPIFY_SESSION_KEYS, LEGACY_PASSWORD_TOKEN_KEY } = await import('../dist/index.js');
const { setConfig } = await import('../dist/client.js');
setConfig({ storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' });

const DAY = 24 * 3600_000;
const clock = { now: Date.parse('2026-10-02T10:00:00Z') };
const iso = (ms) => new Date(ms).toISOString();

// ── Fake Storefront API ─────────────────────────────────────────────────────
const accounts = new Map([['amber@example.com', 'right-password']]);
const liveTokens = new Set(['tok_stored']);
let minted = 0;
const calls = [];
const PROFILE = { id: 'gid://shopify/Customer/1', email: 'amber@example.com', firstName: 'Amber', lastName: 'Marie', phone: null, defaultAddress: null, acceptsMarketing: false };
const userError = (code, message) => ({ field: null, code, message });

const handlers = {
  CustomerAccessTokenCreate({ input }) {
    if (accounts.get(input.email) !== input.password) {
      return { customerAccessTokenCreate: { customerAccessToken: null, customerUserErrors: [userError('UNIDENTIFIED_CUSTOMER', 'Unidentified customer')] } };
    }
    minted += 1;
    liveTokens.add(`tok_${minted}`);
    return { customerAccessTokenCreate: { customerAccessToken: { accessToken: `tok_${minted}`, expiresAt: iso(clock.now + 60 * DAY) }, customerUserErrors: [] } };
  },
  CustomerAccessTokenRenew({ customerAccessToken }) {
    if (!liveTokens.has(customerAccessToken)) return { customerAccessTokenRenew: { customerAccessToken: null, userErrors: [{ field: null, message: 'Access denied' }] } };
    return { customerAccessTokenRenew: { customerAccessToken: { accessToken: customerAccessToken, expiresAt: iso(clock.now + 60 * DAY) }, userErrors: [] } };
  },
  CustomerAccessTokenDelete({ customerAccessToken }) {
    liveTokens.delete(customerAccessToken);
    return { customerAccessTokenDelete: { deletedAccessToken: customerAccessToken, userErrors: [] } };
  },
  CustomerCreate({ input }) {
    if (accounts.has(input.email)) {
      return { customerCreate: { customer: null, customerUserErrors: [userError('TAKEN', 'Email has already been taken')] } };
    }
    accounts.set(input.email, input.password);
    return { customerCreate: { customer: { ...PROFILE, email: input.email, firstName: input.firstName ?? null }, customerUserErrors: [] } };
  },
  CustomerRecover: () => ({ customerRecover: { customerUserErrors: [] } }),
  Customer: ({ accessToken }) => ({ customer: liveTokens.has(accessToken) ? PROFILE : null }),
};
const server = { down: false };

global.fetch = async (url, init) => {
  if (server.down) networkDown();
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:mutation|query) (\w+)/.exec(query)?.[1];
  calls.push(name);
  if (!handlers[name]) throw new Error(`unexpected operation ${name}`);
  return response(200, { data: handlers[name](variables) });
};

async function makeSession({ storage = keychain(), legacy = null, restore = true } = {}) {
  const events = [];
  const session = createCustomerSession({
    storage: () => storage,
    legacyStorage: legacy ? () => legacy : undefined,
    options: () => ({ method: 'password' }),
    emit: (type, error) => events.push({ type, error }),
    now: () => clock.now,
  });
  if (restore) await session.restore();
  return { session, storage, events, state: () => session.getState(), types: () => events.map((e) => e.type) };
}

const stored = (token, expiresAt) =>
  keychain({ [P.accessToken]: token, ...(expiresAt === undefined ? {} : { [P.expiresAt]: String(expiresAt) }) });

const t = harness('auth: email and password (classic customer accounts)');

t.section('storage keys');
await t.check('every session key is one expo-secure-store accepts', () => {
  for (const key of [...Object.values(P), ...Object.values(SHOPIFY_SESSION_KEYS)]) assert.match(key, SECURE_STORE_KEY, key);
});

t.section('sign in');
{
  const s = await makeSession();
  const ok = await s.session.login('amber@example.com', 'right-password');
  await t.check('success: signed in with the profile, token and expiry stored, loginSuccess', () => {
    assert.equal(ok, true);
    assert.equal(s.state().kind, 'password');
    assert.equal(s.state().customer.firstName, 'Amber');
    assert.equal(s.storage.dump()[P.accessToken], s.state().accessToken);
    assert.equal(s.storage.dump()[P.expiresAt], String(clock.now + 60 * DAY));
    assert.deepEqual(s.types(), ['auth:loginSuccess']);
  });
}
{
  const s = await makeSession();
  let threw = null;
  let ok;
  try { ok = await s.session.login('amber@example.com', 'wrong'); } catch (e) { threw = e; }
  await t.check('wrong password: false, loginFailed, no throw, nothing stored', () => {
    assert.equal(threw, null);
    assert.equal(ok, false);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.types(), ['auth:loginFailed']);
    assert.deepEqual(s.storage.dump(), {});
  });
}
{
  const s = await makeSession();
  server.down = true;
  let threw = null;
  try { await s.session.login('amber@example.com', 'right-password'); } catch (e) { threw = e; }
  server.down = false;
  await t.check('offline: throws, no loginFailed (not the shopper\'s mistake), not loading', () => {
    assert.ok(threw);
    assert.deepEqual(s.types(), []);
    assert.equal(s.state().loading, false);
    assert.deepEqual(s.storage.dump(), {});
  });
}
{
  const storage = keychain({ [SHOPIFY_SESSION_KEYS.accessToken]: 'at_x', [SHOPIFY_SESSION_KEYS.refreshToken]: 'rt_x' });
  const s = await makeSession({ storage, restore: false });
  await s.session.login('amber@example.com', 'right-password');
  await t.check('a password sign-in ends a Shopify session on the device', () => {
    assert.equal(storage.map.has(SHOPIFY_SESSION_KEYS.accessToken), false);
    assert.equal(storage.map.has(SHOPIFY_SESSION_KEYS.refreshToken), false);
    assert.equal(s.state().kind, 'password');
  });
}

t.section('sign up and password reset');
{
  const s = await makeSession();
  const ok = await s.session.signup({ email: 'new@example.com', password: 'pw123456', firstName: 'New' });
  await t.check('sign up: signed in, signup then loginSuccess', () => {
    assert.equal(ok, true);
    assert.equal(s.state().kind, 'password');
    assert.equal(s.state().customer.email, 'new@example.com');
    assert.deepEqual(s.types(), ['auth:signup', 'auth:loginSuccess']);
  });
}
{
  const s = await makeSession();
  const ok = await s.session.signup({ email: 'amber@example.com', password: 'pw123456' });
  await t.check('email already taken: false, loginFailed carrying the TAKEN code', () => {
    assert.equal(ok, false);
    assert.deepEqual(s.types(), ['auth:loginFailed']);
    assert.equal(s.events[0].error.errors[0].code, 'TAKEN');
  });
}
{
  const s = await makeSession();
  await s.session.recoverPassword('amber@example.com');
  await t.check('forgot password: recoverSent', () => {
    assert.deepEqual(s.types(), ['auth:recoverSent']);
  });
}

t.section('restore on app open');
{
  calls.length = 0;
  const s = await makeSession({ storage: stored('tok_stored', clock.now + 30 * DAY) });
  await t.check('a valid token: signed in, no renew, no event', () => {
    assert.equal(s.state().kind, 'password');
    assert.equal(s.state().customer.email, 'amber@example.com');
    assert.equal(s.state().restoring, false);
    assert.deepEqual(calls, ['Customer']);
    assert.deepEqual(s.types(), []);
  });
}
{
  calls.length = 0;
  const storage = stored('tok_stored', clock.now + 2 * DAY);
  const s = await makeSession({ storage });
  await t.check('under 7 days left: renewed, and the new expiry stored', () => {
    assert.deepEqual(calls, ['CustomerAccessTokenRenew', 'Customer']);
    assert.equal(storage.dump()[P.expiresAt], String(clock.now + 60 * DAY));
    assert.equal(s.state().kind, 'password');
  });
}
{
  calls.length = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => (init.body.includes('CustomerAccessTokenRenew') ? networkDown() : realFetch(url, init));
  const storage = stored('tok_stored', clock.now + 2 * DAY);
  const s = await makeSession({ storage });
  global.fetch = realFetch;
  await t.check('renew fails offline: the still-valid token is kept', () => {
    assert.equal(s.state().kind, 'password');
    assert.equal(storage.dump()[P.expiresAt], String(clock.now + 2 * DAY));
  });
}
{
  calls.length = 0;
  const storage = stored('tok_stored', clock.now - DAY);
  const s = await makeSession({ storage });
  await t.check('expired: dropped silently without asking Shopify', () => {
    assert.equal(s.state().kind, null);
    assert.deepEqual(calls, []);
    assert.deepEqual(storage.dump(), {});
    assert.deepEqual(s.types(), []);
  });
}
{
  const storage = stored('tok_revoked', clock.now + 30 * DAY);
  const s = await makeSession({ storage });
  await t.check('revoked (no profile for it): dropped silently', () => {
    assert.equal(s.state().kind, null);
    assert.deepEqual(storage.dump(), {});
    assert.deepEqual(s.types(), []);
  });
}
{
  server.down = true;
  const s = await makeSession({ storage: stored('tok_stored', clock.now + 30 * DAY) });
  server.down = false;
  await t.check('offline: still signed in, profile still to load', () => {
    assert.equal(s.state().kind, 'password');
    assert.equal(s.state().customer, null);
    assert.equal(s.state().restoring, false);
  });
}
{
  const legacy = memoryStorage({ [LEGACY_PASSWORD_TOKEN_KEY]: 'tok_stored' });
  const secure = keychain();
  const s = await makeSession({ storage: secure, legacy });
  await t.check('a token SDK 0.8 kept in plain storage, under a key the keychain refuses, moves to the keychain', () => {
    assert.equal(s.state().kind, 'password');
    assert.equal(secure.dump()[P.accessToken], 'tok_stored');
    assert.equal(legacy.map.has(LEGACY_PASSWORD_TOKEN_KEY), false);
  });
}
{
  // The web preview: no keychain, so both are the same plain storage.
  const plain = memoryStorage({ [LEGACY_PASSWORD_TOKEN_KEY]: 'tok_stored' });
  const s = await makeSession({ storage: plain, legacy: plain });
  await t.check('without a keychain the token moves to its new key in the same storage', () => {
    assert.equal(s.state().kind, 'password');
    assert.deepEqual(Object.keys(plain.dump()), [P.accessToken]);
  });
}

t.section('in use');
{
  const s = await makeSession({ storage: stored('tok_stored', clock.now + 30 * DAY) });
  const fresh = await s.session.getAccessToken();
  clock.now += 31 * DAY;
  const later = await s.session.getAccessToken();
  clock.now -= 31 * DAY;
  await t.check('getAccessToken: the token while valid; once expired null and sessionExpired', () => {
    assert.equal(fresh, 'tok_stored');
    assert.equal(later, null);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.types(), ['auth:sessionExpired']);
  });
}
{
  liveTokens.add('tok_stored');
  const s = await makeSession({ storage: stored('tok_stored', clock.now + 30 * DAY) });
  liveTokens.delete('tok_stored');
  const customer = await s.session.refresh();
  await t.check('refresh() after Shopify revoked the token: signed out, sessionExpired', () => {
    assert.equal(customer, null);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.types(), ['auth:sessionExpired']);
  });
  liveTokens.add('tok_stored');
}

t.section('sign out');
{
  const s = await makeSession();
  await s.session.login('amber@example.com', 'right-password');
  const token = s.state().accessToken;
  calls.length = 0;
  await s.session.logout();
  await t.check('signed out, storage cleared, token deleted at Shopify, logout fires', () => {
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.storage.dump(), {});
    assert.deepEqual(calls, ['CustomerAccessTokenDelete']);
    assert.equal(liveTokens.has(token), false);
    assert.deepEqual(s.types().slice(-1), ['auth:logout']);
  });
}
{
  const s = await makeSession({ storage: stored('tok_stored', clock.now + 30 * DAY) });
  server.down = true;
  await s.session.logout();
  server.down = false;
  await t.check('offline sign-out still signs out', () => {
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.storage.dump(), {});
    assert.deepEqual(s.types(), ['auth:logout']);
  });
}

t.done();
