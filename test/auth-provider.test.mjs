// The auth options on ShopifyProvider, rendered in jsdom: the login method switched while the app
// runs (password for App Store review, Shopify for shoppers), the events a host toasts on, and
// store credit from the source each app picks (`useStoreCredit`).
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { counterRandom, harness, jwt, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const SHOP_ID = '68843864220';
const REDIRECT = `shop.${SHOP_ID}.app://callback`;
const money = { amount: '10.00', currencyCode: 'USD' };
const cart = { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '' };

const calls = [];
let authorize = null;
const tileCalls = [];
// The Shopify shopper's first name, so a profile write shows on the next read.
let accountFirstName = 'Amber';
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/oauth/token')) {
    calls.push('token');
    return response(200, { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, id_token: jwt({ nonce: authorize.nonce }) });
  }
  if (url.includes('/account/customer/api/')) {
    const { query, variables } = JSON.parse(init.body);
    const name = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    calls.push(name);
    if (name === 'CustomerNameUpdate') {
      accountFirstName = variables.input.firstName ?? accountFirstName;
      return response(200, { data: { customerUpdate: { userErrors: [] } } });
    }
    if (name === 'StoreCredit') {
      return response(200, { data: { customer: { storeCreditAccounts: { nodes: [
        { id: 's1', balance: { amount: '12.50', currencyCode: 'USD' } },
        { id: 's2', balance: { amount: '7.25', currencyCode: 'USD' } },
      ] } } } });
    }
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/7', firstName: accountFirstName, lastName: 'Marie',
      emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } } });
  }
  if (url.startsWith('https://tile-credit.test/')) {
    tileCalls.push({ url, auth: init.headers.Authorization });
    return response(200, { ok: true, appId: 'a', customer: {}, balanceCents: 4200, lifetimeEarnedCents: 0, lifetimeRedeemedCents: 0, expiringCents: 0 });
  }
  if (url.includes('/logout?')) return response(302, '');
  // Storefront API.
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  calls.push(name);
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart, userErrors: [] } } });
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart } });
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_review', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'CustomerAccessTokenDelete') return response(200, { data: { customerAccessTokenDelete: { deletedAccessToken: 'tok_review', userErrors: [] } } });
  if (name === 'Customer') {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'review@example.com', firstName: 'App', lastName: 'Review', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, useStoreCredit } = await import('../dist/index.js');

const t = harness('auth: ShopifyProvider options');
const events = [];
const take = () => events.splice(0, events.length);
let api = null;
let credit = null;
function Probe() {
  api = useShopify();
  credit = useStoreCredit();
  return null;
}

const secure = keychain();
const openAuthSession = async (url, redirectUri) => {
  authorize = Object.fromEntries(new URL(url).searchParams);
  return { type: 'success', url: `${redirectUri}?code=c&state=${authorize.state}` };
};
const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
async function render({ auth, storeCredit } = {}) {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      {
        config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' },
        onEvent: (e) => events.push(e),
        auth,
        storeCredit,
      },
      React.createElement(Probe),
    ));
  });
  await settle();
}
const authFor = (method) => ({ method, secureStorage: secure, openAuthSession, random: counterRandom(), customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } });

t.section('defaults');
await render();
await t.check('no auth option: password sign-in, as before; no store credit', () => {
  assert.equal(api.customer.method, 'password');
  assert.equal(api.customer.sessionKind, null);
  assert.equal(api.customer.loggedIn, false);
  assert.equal(api.customer.restoring, false);
  assert.equal(credit.source, null);
  assert.equal(credit.available, false);
});

t.section('App Store review: password mode');
await render({ auth: authFor('password'), storeCredit: { source: 'shopify' } });
await runAct(async () => { await api.customer.login('review@example.com', 'review-password'); });
await settle();
await t.check('the reviewer signs in with email and password', () => {
  assert.equal(api.customer.sessionKind, 'password');
  assert.equal(api.customer.customer.email, 'review@example.com');
  assert.equal(secure.dump()['auth.storefrontToken'], 'tok_review');
  const [e] = take();
  assert.equal(e.type, 'auth:loginSuccess');
  assert.equal(e.messageKey, 'auth.loginSuccess');
});
await t.check('Shopify store credit is unavailable to a password session, and not requested', () => {
  assert.equal(credit.source, 'shopify');
  assert.equal(credit.available, false);
  assert.equal(credit.balance, null);
  assert.equal(calls.includes('StoreCredit'), false);
});

await render({ auth: authFor('password'), storeCredit: { source: 'tile', tileCreditBaseUrl: 'https://tile-credit.test' } });
await t.check('Tile Credit works with a password session', () => {
  assert.equal(credit.available, true);
  assert.deepEqual(credit.balance, { amount: '42.00', currencyCode: 'USD' });
  assert.equal(tileCalls.at(-1).url, 'https://tile-credit.test/public/me');
  assert.equal(tileCalls.at(-1).auth, 'Customer tok_review');
});

t.section('review over: switched to Shopify sign-in while running');
await render({ auth: authFor('shopify'), storeCredit: { source: 'shopify' } });
await t.check('the method changes at once; the signed-in reviewer stays signed in', () => {
  assert.equal(api.customer.method, 'shopify');
  assert.equal(api.customer.sessionKind, 'password');
  assert.equal(api.customer.loggedIn, true);
});

await runAct(async () => { await api.customer.logout(); });
take();
let ok;
await runAct(async () => { ok = await api.customer.signIn(); });
await settle();
await t.check('a shopper signs in with Shopify through the provider', () => {
  assert.equal(ok, true);
  assert.equal(api.customer.sessionKind, 'shopify');
  assert.equal(api.customer.customer.email, 'amber@example.com');
  assert.equal(secure.dump()['auth.token'], 'at_1');
  assert.equal(authorize.redirect_uri, REDIRECT);
  assert.deepEqual(take().map((e) => e.type), ['auth:loginSuccess']);
});
await t.check('Shopify store credit: the accounts summed', () => {
  assert.equal(credit.available, true);
  assert.deepEqual(credit.balance, { amount: '19.75', currencyCode: 'USD' });
});
let token;
await runAct(async () => { token = await api.customer.getAccessToken(); });
await t.check('getAccessToken hands other SDKs a usable token', () => {
  assert.equal(token, 'at_1');
});
let saved;
await runAct(async () => { saved = await api.customer.updateProfile({ firstName: 'Amberly', lastName: 'Marie' }); });
await settle();
await t.check('updateProfile through the provider: the changed name sent, and the context shows it', () => {
  assert.equal(saved, true);
  assert.equal(api.customer.customer.firstName, 'Amberly');
  assert.equal(calls.filter((name) => name === 'CustomerNameUpdate').length, 1);
  assert.equal(api.customer.loading, false);
});
accountFirstName = 'Amber';

await runAct(async () => { await api.customer.logout(); });
await settle();
await t.check('signed out: no session, no balance, logout toast', () => {
  assert.equal(api.customer.loggedIn, false);
  assert.equal(credit.available, false);
  assert.equal(credit.balance, null);
  const [e] = take();
  assert.equal(e.type, 'auth:logout');
  assert.equal(e.messageKey, 'auth.loggedOut');
});

t.section('app open');
await runAct(async () => { root.unmount(); });
const reopened = createRoot(document.getElementById('root'));
secure.map.set('auth.token', 'at_1');
secure.map.set('auth.refreshToken', 'rt_1');
secure.map.set('auth.expiresAt', String(Date.now() + 3_600_000));
await runAct(async () => {
  reopened.render(React.createElement(
    ShopifyProvider,
    { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, onEvent: (e) => events.push(e), auth: authFor('shopify') },
    React.createElement(Probe),
  ));
});
await settle();
await t.check('a stored Shopify session is restored on mount, with no toast', () => {
  assert.equal(api.customer.sessionKind, 'shopify');
  assert.equal(api.customer.restoring, false);
  assert.equal(api.customer.customer.firstName, 'Amber');
  assert.equal(events.filter((e) => e.type.startsWith('auth:')).length, 0);
});
await runAct(async () => { reopened.unmount(); });

t.done();
