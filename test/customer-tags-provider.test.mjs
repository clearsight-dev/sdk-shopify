// `useCustomerTags` inside ShopifyProvider (jsdom): a Shopify sign-in reads `customer { tags }` from the
// Customer Account API with the session's token, callers share the read, and sign-out clears it.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { counterRandom, harness, jwt, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const SHOP_ID = '68843864220';
const money = { amount: '10.00', currencyCode: 'USD' };
const cart = { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '' };

let authorize = null;
let accountTags = ['vip'];
let tagsAnswerNoCustomer = false;
const tagReads = [];
let holdProfile = null;
// The password session's Storefront read; null is the token missing `unauthenticated_read_customer_tags`.
let storefrontTags = ['BIDBLOCKED'];
const storefrontTagReads = [];
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/oauth/token')) {
    return response(200, { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, id_token: jwt({ nonce: authorize.nonce }) });
  }
  if (url.includes('/account/customer/api/')) {
    const { query } = JSON.parse(init.body);
    const name = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    if (name === 'CustomerTags') {
      tagReads.push(init.headers.Authorization);
      return response(200, { data: { customer: tagsAnswerNoCustomer ? null : { tags: accountTags } } });
    }
    if (holdProfile) await holdProfile;
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
      emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } } });
  }
  if (url.includes('/logout?')) return response(302, '');
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart, userErrors: [] } } });
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart } });
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_pw', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'Customer') {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'pw@example.com', firstName: 'Pass', lastName: 'Word', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  if (name === 'CustomerTagsStorefront') {
    storefrontTagReads.push(JSON.parse(init.body).variables);
    if (!storefrontTags) return response(200, { errors: [{ message: 'Access denied for tags field. Required access: `unauthenticated_read_customer_tags` access scope.' }] });
    return response(200, { data: { customer: { tags: storefrontTags } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, useCustomerTags } = await import('../dist/index.js');

const t = harness('customer tags: useCustomerTags in ShopifyProvider');
let api = null;
let screenA = null;
let screenB = null;
function ScreenA() {
  api = useShopify();
  screenA = useCustomerTags();
  return null;
}
function ScreenB({ active }) {
  screenB = useCustomerTags({ active });
  return null;
}

const openAuthSession = async (url, redirectUri) => {
  authorize = Object.fromEntries(new URL(url).searchParams);
  return { type: 'success', url: `${redirectUri}?code=c&state=${authorize.state}` };
};
const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
const auth = { method: 'shopify', secureStorage: keychain(), openAuthSession, random: counterRandom(), customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } };
async function render({ bActive = false } = {}) {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth },
      React.createElement(ScreenA),
      React.createElement(ScreenB, { active: bActive }),
    ));
  });
  await settle();
}

await render();
await t.check('signed out: no tags, known, nothing read', () => {
  assert.equal(screenA.customerId, null);
  assert.equal(screenA.known, true);
  assert.deepEqual(screenA.tags, []);
  assert.equal(tagReads.length, 0);
});

await runAct(async () => { await api.customer.signIn(); });
await settle();
await t.check('a Shopify sign-in reads the tags once from the Customer Account API, for every caller', () => {
  assert.equal(tagReads.length, 1);
  assert.equal(tagReads[0], 'at_1', 'the session the SDK already holds, sent bare');
  assert.equal(screenA.customerId, 'gid://shopify/Customer/7');
  assert.deepEqual(screenA.tags, ['vip']);
  assert.equal(screenA.known, true);
  assert.equal(screenA.hasTag(' VIP '), true);
  assert.deepEqual(screenB.tags, ['vip']);
});

accountTags = ['vip', 'no-bidding'];
await render({ bActive: true });
await t.check('a screen becoming active re-reads at most once per 30 s once the tags are known', () => {
  assert.equal(tagReads.length, 1);
});

await runAct(async () => { await screenB.refresh({ force: true }); });
await settle();
await t.check('a forced re-read picks up a new tag, on every caller', () => {
  assert.equal(tagReads.length, 2);
  assert.equal(screenA.hasTag('no-bidding'), true);
  assert.equal(screenB.hasTag('no-bidding'), true);
});

accountTags = ['vip', 'APPBLOCKED'];
await runAct(async () => { await screenB.refresh({ force: true }); });
await settle();
await t.check('a tag added on the account reaches every caller', () => {
  assert.equal(screenA.hasTag('appblocked'), true);
  assert.equal(screenB.hasTag('APPBLOCKED'), true);
});
accountTags = ['vip', 'no-bidding'];
await runAct(async () => { await screenB.refresh({ force: true }); });
await settle();

tagsAnswerNoCustomer = true;
await runAct(async () => { await screenA.refresh({ force: true }); });
await settle();
await t.check('no customer in the answer is a failed read: what was known stays', () => {
  assert.equal(tagReads.length, 5);
  assert.equal(screenA.known, true);
  assert.equal(screenA.hasTag('no-bidding'), true);
});

await runAct(async () => { await api.customer.logout(); });
await settle();
await t.check('sign-out clears the tags', () => {
  assert.equal(screenA.customerId, null);
  assert.deepEqual(screenA.tags, []);
  assert.equal(screenA.known, true);
});

// Signed in before the profile has loaded (offline at launch): whose tags these are isn't known yet.
tagsAnswerNoCustomer = false;
let releaseProfile = null;
holdProfile = new Promise((r) => { releaseProfile = r; });
await runAct(async () => { void api.customer.signIn(); await new Promise((r) => setTimeout(r, 30)); });
await t.check('signed in with the profile still loading: not known, never "no tags"', () => {
  assert.equal(api.customer.loggedIn, true);
  assert.equal(api.customer.customer, null);
  assert.equal(screenA.known, false);
  assert.equal(screenA.tags, null);
  assert.equal(screenA.hasTag('vip'), false);
});
holdProfile = null;
releaseProfile();
await settle();
await t.check('the profile lands: the tags are read and known', () => {
  assert.equal(screenA.customerId, 'gid://shopify/Customer/7');
  assert.equal(screenA.known, true);
  assert.equal(screenA.hasTag('vip'), true);
});
await runAct(async () => { await api.customer.logout(); });
await settle();
await runAct(async () => root.unmount());

// A password session reads the Storefront API with the customer's token.
const root2 = createRoot(document.getElementById('root'));
async function renderPassword() {
  await runAct(async () => {
    root2.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth: { method: 'password', secureStorage: keychain() } },
      React.createElement(ScreenA),
    ));
  });
  await settle();
}
await renderPassword();
await runAct(async () => { await api.customer.login('pw@example.com', 'secret'); });
await settle();
await t.check('a password session reads the tags from the Storefront API with its token', () => {
  assert.equal(api.customer.sessionKind, 'password');
  assert.deepEqual(storefrontTagReads.at(-1), { customerAccessToken: 'tok_pw' });
  assert.deepEqual(screenA.tags, ['BIDBLOCKED']);
  assert.equal(screenA.known, true);
});
await runAct(async () => { await api.customer.logout(); });
await settle();

storefrontTags = null;
await runAct(async () => { await api.customer.login('pw@example.com', 'secret'); });
await settle();
await t.check('without the tags scope every read fails: the tags stay unknown', () => {
  assert.equal(screenA.known, false);
  assert.equal(screenA.tags, null);
});
await runAct(async () => root2.unmount());
t.done();
