// Profile editing (`updateProfile`) for both kinds of session, against the session module with
// Shopify stubbed at `fetch`: the Storefront `customerUpdate` for a password session, and the Customer
// Account API's `customerUpdate` and email-marketing mutations for a Shopify sign-in session.
import assert from 'node:assert/strict';
import { harness, keychain, networkDown, response } from './auth-helpers.mjs';

const { createCustomerSession, SHOPIFY_SESSION_KEYS: K, PASSWORD_SESSION_KEYS: P } = await import('../dist/index.js');
const { setConfig } = await import('../dist/client.js');
setConfig({ storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' });

const SHOP_ID = '68843864220';
const ACCOUNT_URL = `https://shopify.com/${SHOP_ID}/account/customer/api/2026-07/graphql`;
const DAY = 24 * 3600_000;
const clock = { now: Date.parse('2026-10-02T10:00:00Z') };
const userError = (code, message, field = null) => ({ field, code, message });

// ── Fake Shopify ────────────────────────────────────────────────────────────
// One shopper, as each API shows them. Writes change it, so a re-read shows what landed.
let storefrontCustomer;
let accountCustomer;
function resetShopper() {
  storefrontCustomer = { id: 'gid://shopify/Customer/1', email: 'amber@example.com', firstName: 'Amber', lastName: 'Marie', phone: null, defaultAddress: null, acceptsMarketing: false };
  accountCustomer = {
    id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
    emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' },
    phoneNumber: null, defaultAddress: null,
  };
}

/** Every request, as `{ api, name, variables }`, in order. */
const calls = [];
const names = () => calls.map((c) => c.name);
/** Per-operation overrides: return a `data` object, or throw to fail the request. */
const refuse = {};
let offline = false;
let profileReadsFail = false;

const storefront = {
  Customer: ({ accessToken }) => ({ customer: accessToken === 'tok_live' ? storefrontCustomer : null }),
  CustomerUpdate({ accessToken, customer }) {
    if (accessToken !== 'tok_live') return { customerUpdate: { customer: null, customerUserErrors: [userError('TOKEN_INVALID', 'Customer access token is invalid')] } };
    storefrontCustomer = { ...storefrontCustomer, ...customer };
    return { customerUpdate: { customer: storefrontCustomer, customerUserErrors: [] } };
  },
};

const account = {
  CustomerProfile() {
    if (profileReadsFail) networkDown();
    return { customer: accountCustomer };
  },
  CustomerNameUpdate({ input }) {
    accountCustomer = { ...accountCustomer, ...input };
    return { customerUpdate: { userErrors: [] } };
  },
  CustomerEmailMarketingSubscribe() {
    accountCustomer.emailAddress = { ...accountCustomer.emailAddress, marketingState: 'SUBSCRIBED' };
    return { customerEmailMarketingSubscribe: { emailAddress: { marketingState: 'SUBSCRIBED' }, userErrors: [] } };
  },
  CustomerEmailMarketingUnsubscribe() {
    accountCustomer.emailAddress = { ...accountCustomer.emailAddress, marketingState: 'UNSUBSCRIBED' };
    return { customerEmailMarketingUnsubscribe: { emailAddress: { marketingState: 'UNSUBSCRIBED' }, userErrors: [] } };
  },
};

global.fetch = async (url, init) => {
  if (offline) networkDown();
  const api = String(url) === ACCOUNT_URL ? 'account' : 'storefront';
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:mutation|query) (\w+)/.exec(query)?.[1];
  calls.push({ api, name, variables });
  if (api === 'account' && init.headers.Authorization !== 'at_live') return response(401, {});
  const handler = refuse[name] ?? (api === 'account' ? account : storefront)[name];
  if (!handler) throw new Error(`unexpected ${api} operation ${name}`);
  return response(200, { data: handler(variables ?? {}) });
};

function reset() {
  resetShopper();
  calls.length = 0;
  for (const key of Object.keys(refuse)) delete refuse[key];
  offline = false;
  profileReadsFail = false;
}

/** A session restored on app open, as a previous run left it: `password`, `shopify`, or signed out. */
async function makeSession(kind) {
  const storage =
    kind === 'password' ? keychain({ [P.accessToken]: 'tok_live', [P.expiresAt]: String(clock.now + 30 * DAY) })
    : kind === 'shopify' ? keychain({ [K.accessToken]: 'at_live', [K.refreshToken]: 'rt_live', [K.expiresAt]: String(clock.now + 3600_000) })
    : keychain();
  const events = [];
  const session = createCustomerSession({
    storage: () => storage,
    options: () => ({ method: kind ?? 'password', customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } }),
    apiVersion: () => '2026-07',
    emit: (type, error) => events.push({ type, error }),
    now: () => clock.now,
  });
  await session.restore();
  calls.length = 0;
  return { session, events, state: () => session.getState(), types: () => events.map((e) => e.type) };
}

const t = harness('auth: updateProfile (name and email marketing consent)');

// ── Password session: Storefront customerUpdate ─────────────────────────────
t.section('password session (Storefront customerUpdate)');
{
  reset();
  const s = await makeSession('password');
  const ok = await s.session.updateProfile({ firstName: 'Amberly', lastName: 'Marie' });
  await t.check('names only: one customerUpdate carrying only the name that changed', () => {
    assert.equal(ok, true);
    assert.deepEqual(names(), ['CustomerUpdate']);
    assert.deepEqual(calls[0].variables.customer, { firstName: 'Amberly' });
    assert.equal(calls[0].variables.accessToken, 'tok_live');
  });
  await t.check('the customer customerUpdate returns becomes `customer`, with no second read', () => {
    assert.equal(s.state().customer.firstName, 'Amberly');
    assert.equal(s.state().customer.lastName, 'Marie');
    assert.equal(s.state().loading, false);
  });
}
{
  reset();
  const s = await makeSession('password');
  const ok = await s.session.updateProfile({ acceptsMarketing: true });
  await t.check('consent only: customerUpdate with acceptsMarketing alone', () => {
    assert.equal(ok, true);
    assert.deepEqual(calls.map((c) => c.variables.customer), [{ acceptsMarketing: true }]);
    assert.equal(s.state().customer.acceptsMarketing, true);
  });
}
{
  reset();
  const s = await makeSession('password');
  const ok = await s.session.updateProfile({ firstName: 'Ann', lastName: 'Lee', acceptsMarketing: true });
  await t.check('names and consent: one customerUpdate with all three', () => {
    assert.equal(ok, true);
    assert.deepEqual(calls.map((c) => c.variables.customer), [{ firstName: 'Ann', lastName: 'Lee', acceptsMarketing: true }]);
    assert.equal(s.state().customer.lastName, 'Lee');
    assert.equal(s.state().customer.acceptsMarketing, true);
  });
}
{
  reset();
  const s = await makeSession('password');
  const ok = await s.session.updateProfile({ firstName: 'Amber', lastName: 'Marie', acceptsMarketing: false });
  await t.check('nothing changed: true, and nothing sent', () => {
    assert.equal(ok, true);
    assert.deepEqual(calls, []);
  });
}
{
  reset();
  refuse.CustomerUpdate = () => ({ customerUpdate: { customer: null, customerUserErrors: [userError('TOO_LONG', 'First name is too long', ['firstName'])] } });
  const s = await makeSession('password');
  const before = s.state().customer;
  let threw = null;
  let ok;
  try { ok = await s.session.updateProfile({ firstName: 'x'.repeat(300) }); } catch (e) { threw = e; }
  await t.check('Shopify refuses a value: false, no throw, `customer` unchanged, reason logged', () => {
    assert.equal(threw, null);
    assert.equal(ok, false);
    assert.equal(s.state().customer, before);
    assert.equal(s.state().loading, false);
    assert.match(t.warnings.at(-1), /profile update failed.*First name is too long/);
  });
}
{
  reset();
  const s = await makeSession('password');
  offline = true;
  const ok = await s.session.updateProfile({ lastName: 'Lee' });
  await t.check('offline: false, still signed in, nothing changed', () => {
    assert.equal(ok, false);
    assert.equal(s.state().kind, 'password');
    assert.equal(s.state().customer.lastName, 'Marie');
  });
}

// ── Shopify session: Customer Account API ───────────────────────────────────
t.section('Shopify session (Customer Account API)');
{
  reset();
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ firstName: 'Amber', lastName: 'Lee' });
  await t.check('names only: customerUpdate(input) with only the changed name, then the profile re-read', () => {
    assert.equal(ok, true);
    assert.deepEqual(names(), ['CustomerNameUpdate', 'CustomerProfile']);
    assert.deepEqual(calls[0].variables, { input: { lastName: 'Lee' } });
    assert.ok(calls.every((c) => c.api === 'account'));
  });
  await t.check('refreshed after success: `customer` shows the new name', () => {
    assert.equal(s.state().customer.lastName, 'Lee');
    assert.equal(s.state().loading, false);
  });
}
{
  reset();
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ acceptsMarketing: true });
  await t.check('consent on: customerEmailMarketingSubscribe, no customerUpdate, then the re-read', () => {
    assert.equal(ok, true);
    assert.deepEqual(names(), ['CustomerEmailMarketingSubscribe', 'CustomerProfile']);
    assert.equal(s.state().customer.acceptsMarketing, true);
  });
}
{
  reset();
  accountCustomer.emailAddress.marketingState = 'SUBSCRIBED';
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ firstName: 'Amber', acceptsMarketing: false });
  await t.check('consent off: customerEmailMarketingUnsubscribe; the unchanged name is not sent', () => {
    assert.equal(ok, true);
    assert.deepEqual(names(), ['CustomerEmailMarketingUnsubscribe', 'CustomerProfile']);
    assert.equal(s.state().customer.acceptsMarketing, false);
  });
}
{
  reset();
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ firstName: 'Ann', lastName: 'Lee', acceptsMarketing: true });
  await t.check('names and consent: names first, then consent, then one re-read', () => {
    assert.equal(ok, true);
    assert.deepEqual(names(), ['CustomerNameUpdate', 'CustomerEmailMarketingSubscribe', 'CustomerProfile']);
    assert.deepEqual(calls[0].variables, { input: { firstName: 'Ann', lastName: 'Lee' } });
    assert.equal(s.state().customer.firstName, 'Ann');
    assert.equal(s.state().customer.acceptsMarketing, true);
  });
}
{
  reset();
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ firstName: 'Amber', acceptsMarketing: false });
  await t.check('nothing changed: true, and nothing sent', () => {
    assert.equal(ok, true);
    assert.deepEqual(calls, []);
  });
}
{
  reset();
  refuse.CustomerNameUpdate = () => ({ customerUpdate: { userErrors: [userError('INVALID', 'First name is invalid', ['input', 'firstName'])] } });
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ firstName: '<a>', acceptsMarketing: true });
  await t.check('names refused: false, consent never sent, nothing re-read, reason logged', () => {
    assert.equal(ok, false);
    assert.deepEqual(names(), ['CustomerNameUpdate']);
    assert.equal(s.state().customer.firstName, 'Amber');
    assert.equal(s.state().customer.acceptsMarketing, false);
    assert.match(t.warnings.at(-1), /profile update failed.*First name is invalid/);
  });
}
{
  reset();
  refuse.CustomerEmailMarketingSubscribe = () => ({ customerEmailMarketingSubscribe: { emailAddress: null, userErrors: [userError('FAILED_TO_SUBSCRIBE', 'Subscription failed.')] } });
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ lastName: 'Lee', acceptsMarketing: true });
  await t.check('consent refused after the names landed: false, and the names that landed still show', () => {
    assert.equal(ok, false);
    assert.deepEqual(names(), ['CustomerNameUpdate', 'CustomerEmailMarketingSubscribe', 'CustomerProfile']);
    assert.equal(s.state().customer.lastName, 'Lee');
    assert.equal(s.state().customer.acceptsMarketing, false);
  });
}
{
  reset();
  refuse.CustomerEmailMarketingUnsubscribe = () => ({ customerEmailMarketingUnsubscribe: { emailAddress: null, userErrors: [userError('FAILED_TO_UNSUBSCRIBE', 'Unsubscription failed.')] } });
  accountCustomer.emailAddress.marketingState = 'SUBSCRIBED';
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ acceptsMarketing: false });
  await t.check('unsubscribe refused: false, still shown as subscribed', () => {
    assert.equal(ok, false);
    assert.equal(s.state().customer.acceptsMarketing, true);
  });
}
{
  reset();
  // Subscribed on another device since this profile was read.
  refuse.CustomerEmailMarketingSubscribe = () => {
    accountCustomer.emailAddress.marketingState = 'SUBSCRIBED';
    return { customerEmailMarketingSubscribe: { emailAddress: null, userErrors: [userError('CUSTOMER_ALREADY_SUBSCRIBED', 'The customer is already subscribed.')] } };
  };
  const s = await makeSession('shopify');
  const ok = await s.session.updateProfile({ acceptsMarketing: true });
  await t.check('"already subscribed" is the state asked for: true, and re-read', () => {
    assert.equal(ok, true);
    assert.equal(s.state().customer.acceptsMarketing, true);
  });
}
{
  reset();
  const s = await makeSession('shopify');
  profileReadsFail = true;
  const ok = await s.session.updateProfile({ firstName: 'Ann', acceptsMarketing: true });
  await t.check('saved, but the re-read fails: true, and `customer` shows what Shopify accepted', () => {
    assert.equal(ok, true);
    assert.equal(s.state().customer.firstName, 'Ann');
    assert.equal(s.state().customer.acceptsMarketing, true);
    assert.equal(s.state().customer.lastName, 'Marie');
    assert.match(t.warnings.at(-1), /profile saved, but did not reload/);
  });
}
{
  reset();
  const s = await makeSession('shopify');
  offline = true;
  let threw = null;
  let ok;
  try { ok = await s.session.updateProfile({ firstName: 'Ann' }); } catch (e) { threw = e; }
  await t.check('offline: false, no throw, still signed in', () => {
    assert.equal(threw, null);
    assert.equal(ok, false);
    assert.equal(s.state().kind, 'shopify');
    assert.equal(s.state().customer.firstName, 'Amber');
    assert.equal(s.state().loading, false);
  });
}
{
  reset();
  const s = await makeSession('shopify');
  // Shopify revokes the token and refuses the refresh: the session ends mid-save.
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) return response(400, { error: 'invalid_grant' });
    if (String(url) === ACCOUNT_URL) return response(401, {});
    return realFetch(url, init);
  };
  const ok = await s.session.updateProfile({ firstName: 'Ann' });
  global.fetch = realFetch;
  await t.check('the session ends mid-save: false, signed out, auth:sessionExpired', () => {
    assert.equal(ok, false);
    assert.equal(s.state().kind, null);
    assert.deepEqual(s.types(), ['auth:sessionExpired']);
  });
}

// ── Signed out ──────────────────────────────────────────────────────────────
t.section('signed out');
{
  reset();
  const s = await makeSession(null);
  let threw = null;
  let ok;
  try { ok = await s.session.updateProfile({ firstName: 'Ann', acceptsMarketing: true }); } catch (e) { threw = e; }
  await t.check('signed out: false, no throw, nothing sent, reason logged', () => {
    assert.equal(threw, null);
    assert.equal(ok, false);
    assert.deepEqual(calls, []);
    assert.equal(s.state().loading, false);
    assert.match(t.warnings.at(-1), /profile update failed.*Not signed in/);
  });
}

t.done();
