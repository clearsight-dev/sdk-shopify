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
await t.check('signed out: nothing restricted, known, nothing read', () => {
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

tagsAnswerNoCustomer = true;
await runAct(async () => { await screenA.refresh({ force: true }); });
await settle();
await t.check('no customer in the answer is a failed read: what was known stays', () => {
  assert.equal(tagReads.length, 3);
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

await runAct(async () => root.unmount());
t.done();
