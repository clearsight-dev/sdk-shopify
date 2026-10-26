// ShopifyProvider starts a fresh cart when a signed-in shopper becomes signed out (`resetCartOnSignOut`),
// and `useCart().ensureCartId` creates at most one cart however often it is called at once.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, keychain, memoryStorage, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const CART_KEY = 'shopify:cart-id:v1';
const money = { amount: '10.00', currencyCode: 'USD' };
const cartWith = (id) => ({ id, checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], attributes: [],
  createdAt: '', updatedAt: '' });

let created = 0;
let failCreates = 0;
let profileGone = false;
global.fetch = async (url, init = {}) => {
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') {
    if (failCreates > 0) {
      failCreates -= 1;
      throw new TypeError('Network request failed');
    }
    created += 1;
    // A beat of latency, so two calls really overlap.
    await new Promise((r) => setTimeout(r, 5));
    return response(200, { data: { cartCreate: { cart: cartWith(`gid://shopify/Cart/${created}`), userErrors: [] } } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) {
    const { variables } = JSON.parse(init.body);
    return response(200, { data: { cart: cartWith(variables.id) } });
  }
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_1', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'CustomerAccessTokenDelete') return response(200, { data: { customerAccessTokenDelete: { deletedAccessToken: 'tok_1', userErrors: [] } } });
  if (name === 'Customer') {
    if (profileGone) return response(200, { data: { customer: null } });
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'a@example.com', firstName: 'A', lastName: 'B', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify } = await import('../dist/index.js');

const t = harness('ShopifyProvider: cart reset on sign-out, ensureCartId');
let api = null;
function Probe() {
  api = useShopify();
  return null;
}

let root = null;
let storage = null;
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
/** A fresh provider, as on app open. `stored`: what the keychain holds. */
async function launch({ stored = {}, props = {} } = {}) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  storage = memoryStorage();
  created = 0;
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      {
        config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' },
        storage,
        auth: { method: 'password', secureStorage: keychain(stored) },
        ...props,
      },
      React.createElement(Probe),
    ));
  });
  await settle();
}
const act = async (work) => {
  await runAct(async () => { await work(); });
  await settle();
};

t.section('sign-out');
await launch();
await t.check('a launch that starts signed out creates only the launch cart', () => {
  assert.equal(api.customer.restoring, false);
  assert.equal(api.customer.loggedIn, false);
  assert.equal(created, 1);
  assert.equal(api.cart.cart.id, 'gid://shopify/Cart/1');
});
await act(() => api.customer.login('a@example.com', 'pw'));
await t.check('signing in does not reset the cart', () => {
  assert.equal(api.customer.loggedIn, true);
  assert.equal(created, 1);
  assert.equal(api.cart.cart.id, 'gid://shopify/Cart/1');
});
await act(() => api.customer.logout());
await t.check('signing out starts one fresh cart, kept as the stored cart', () => {
  assert.equal(api.customer.loggedIn, false);
  assert.equal(created, 2);
  assert.equal(api.cart.cart.id, 'gid://shopify/Cart/2');
  assert.equal(storage.dump()[CART_KEY], 'gid://shopify/Cart/2');
});

await launch({ stored: { 'auth.storefrontToken': 'tok_1', 'auth.storefrontExpiresAt': String(Date.UTC(2030, 0, 1)) } });
await t.check('a session restored at launch counts as signed in', () => {
  assert.equal(api.customer.loggedIn, true);
  assert.equal(created, 1);
});
profileGone = true;
await act(() => api.customer.refresh());
profileGone = false;
await t.check('a session that expires starts one fresh cart', () => {
  assert.equal(api.customer.loggedIn, false);
  assert.equal(created, 2);
  assert.equal(api.cart.cart.id, 'gid://shopify/Cart/2');
});

t.section('not a sign-out');
await launch({ stored: { 'auth.storefrontToken': 'tok_old', 'auth.storefrontExpiresAt': '1000' } });
await t.check('a stored session dropped while restoring does not reset the cart', () => {
  assert.equal(api.customer.restoring, false);
  assert.equal(api.customer.loggedIn, false);
  assert.equal(created, 1);
  assert.equal(api.cart.cart.id, 'gid://shopify/Cart/1');
});

await launch({ props: { resetCartOnSignOut: false } });
await act(() => api.customer.login('a@example.com', 'pw'));
await act(() => api.customer.logout());
await t.check('resetCartOnSignOut: false keeps the cart on sign-out', () => {
  assert.equal(api.customer.loggedIn, false);
  assert.equal(created, 1);
  assert.equal(api.cart.cart.id, 'gid://shopify/Cart/1');
});

t.section('ensureCartId');
await launch();
await t.check('with a cart, returns its id and creates nothing', async () => {
  let id = null;
  await act(async () => { id = await api.cart.ensureCartId(); });
  assert.equal(id, 'gid://shopify/Cart/1');
  assert.equal(created, 1);
});

failCreates = 1;
// The failed launch is logged on purpose; kept quiet here.
const logError = console.error;
console.error = () => {};
await launch();
console.error = logError;
await t.check('the launch cart failed, so there is no cart', () => {
  assert.equal(api.cart.cart, null);
  assert.equal(created, 0);
});
await t.check('two calls at once create one cart and both get its id', async () => {
  let ids = [];
  await act(async () => { ids = await Promise.all([api.cart.ensureCartId(), api.cart.ensureCartId()]); });
  assert.equal(created, 1);
  assert.deepEqual(ids, ['gid://shopify/Cart/1', 'gid://shopify/Cart/1']);
  assert.equal(api.cart.cart.id, 'gid://shopify/Cart/1');
  assert.equal(storage.dump()[CART_KEY], 'gid://shopify/Cart/1');
});

await runAct(async () => root.unmount());
t.done();
process.exit(0);
