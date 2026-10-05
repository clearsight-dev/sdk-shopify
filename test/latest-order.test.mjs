// The order just placed (SDK move 6): `placedSince`, then `useLatestOrderSince` rendered in jsdom with
// the real ShopifyProvider, a Shopify sign-in, and the Customer Account API stubbed at `fetch`.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const SHOP_ID = '68843864220';
const ACCOUNT_URL = `https://shopify.com/${SHOP_ID}/account/customer/api/2026-07/graphql`;
const MINUTE = 60_000;
const usd = (amount) => ({ amount, currencyCode: 'USD' });

const { placedSince, ORDER_CLOCK_LEEWAY_MS } = await import('../dist/orders.js');

const t = harness('orders: the order just placed (useLatestOrderSince)');

t.section('placedSince');
const OPENED = Date.parse('2026-10-06T10:00:00Z');
const at = (iso) => ({ processedAt: iso });
await t.check('an order placed after checkout opened counts', () => {
  assert.equal(placedSince(at('2026-10-06T10:03:00Z'), OPENED), true);
});
await t.check('up to 2 minutes before counts too (the phone\'s clock may run ahead of Shopify\'s); earlier doesn\'t', () => {
  assert.equal(ORDER_CLOCK_LEEWAY_MS, 2 * MINUTE);
  assert.equal(placedSince(at('2026-10-06T09:58:00Z'), OPENED), true);
  assert.equal(placedSince(at('2026-10-06T09:57:59Z'), OPENED), false);
  assert.equal(placedSince(at('2026-10-06T09:59:00Z'), OPENED, 0), false, 'a leeway of 0');
});
await t.check('with no time given, any order counts; a date that can\'t be read never does', () => {
  assert.equal(placedSince(at('2020-01-01T00:00:00Z'), undefined), true);
  assert.equal(placedSince(at('2020-01-01T00:00:00Z'), null), true);
  assert.equal(placedSince(at('not a date'), OPENED), false);
});

// ── Rendered ────────────────────────────────────────────────────────────────

/** The shopper's orders, newest first, as the Customer Account API lists them. */
let accountOrders = [];
const order = (n, processedAt) => ({
  id: `gid://shopify/Order/${n}`, name: `#${1000 + n}`, processedAt, cancelledAt: null, fulfillmentStatus: 'UNFULFILLED',
  statusPageUrl: `https://shop/status/${n}`, totalPrice: usd('10.0'), lineItems: { nodes: [{ quantity: 1 }] },
});
const calls = [];
const historyReads = () => calls.filter((name) => name === 'OrderHistory').length;

global.fetch = async (url, init = {}) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:mutation|query) (\w+)/.exec(query)?.[1] ?? 'anon';
  calls.push(name);
  if (String(url) === ACCOUNT_URL) {
    if (name === 'CustomerProfile') {
      return response(200, { data: { customer: { id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
        emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } } });
    }
    if (name === 'OrderHistory') {
      const nodes = accountOrders.slice(0, variables.first);
      return response(200, { data: { customer: { orders: { nodes, pageInfo: { hasNextPage: accountOrders.length > nodes.length, endCursor: null } } } } });
    }
    throw new Error(`unexpected account operation ${name}`);
  }
  if (name === 'ShopInfo') return response(200, { data: { shop: { name: 'Shop', moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } } });
  if (name === 'CartCreate' || name === 'CartGet') {
    const cart = { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [], totalQuantity: 0,
      buyerIdentity: { countryCode: 'US', email: null, phone: null }, lines: { nodes: [] },
      cost: { subtotalAmount: usd('0.0'), totalAmount: usd('0.0') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '' };
    return response(200, { data: name === 'CartCreate' ? { cartCreate: { cart, userErrors: [] } } : { cart } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useLatestOrderSince, LATEST_ORDER_READ_AGAIN_SECONDS } = await import('../dist/index.js');

let latest = null;
function Probe({ since, options }) {
  latest = useLatestOrderSince(since, options);
  return null;
}
let root = null;
const wait = (ms) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function open({ signedIn = true, since, options }) {
  if (root) await runAct(async () => { root.unmount(); });
  root = createRoot(document.getElementById('root'));
  const secureStorage = signedIn
    ? keychain({ 'auth.token': 'at_live', 'auth.refreshToken': 'rt_live', 'auth.expiresAt': String(Date.now() + 3600_000) })
    : keychain();
  calls.length = 0;
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' },
        auth: { method: 'shopify', secureStorage, customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } } },
      React.createElement(Probe, { since, options }),
    ));
  });
  await wait(30);
}
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const FAST = { readAgainAfterSeconds: [0.05, 0.2] };

t.section('useLatestOrderSince');
await t.check('reads the newest order only (a page of one) and shows it once it was placed after checkout opened', async () => {
  accountOrders = [order(2, iso(now + 5_000)), order(1, iso(now - 3 * 24 * 3600_000))];
  await open({ since: now, options: FAST });
  assert.equal(latest.order?.name, '#1002');
  assert.equal(historyReads(), 1);
  await wait(300);
  assert.equal(historyReads(), 1, 'nothing is read again once it is there');
});
await t.check('the order before stays hidden (no number rather than a wrong one), and the newest is read again after each wait until the new one is listed', async () => {
  accountOrders = [order(1, iso(now - 3 * 24 * 3600_000))];
  await open({ since: now, options: FAST });
  assert.equal(latest.order, null);
  assert.equal(historyReads(), 1);
  await wait(100);
  assert.equal(historyReads(), 2, 'the first read again');
  accountOrders = [order(2, iso(now + 1_000)), ...accountOrders];
  await wait(150);
  assert.equal(historyReads(), 3, 'the second read again');
  assert.equal(latest.order?.name, '#1002');
});
await t.check('Shopify never lists it: two reads again, then it stops, with no order', async () => {
  accountOrders = [order(1, iso(now - 3 * 24 * 3600_000))];
  await open({ since: now, options: FAST });
  await wait(400);
  assert.equal(historyReads(), 3);
  assert.equal(latest.order, null);
});
await t.check('an order placed a minute before checkout opened still counts (the clock leeway)', async () => {
  accountOrders = [order(3, iso(now - MINUTE))];
  await open({ since: now, options: FAST });
  assert.equal(latest.order?.name, '#1003');
});
await t.check('no time given: the newest order, whatever its date', async () => {
  accountOrders = [order(1, iso(now - 3 * 24 * 3600_000))];
  await open({ since: undefined, options: FAST });
  assert.equal(latest.order?.name, '#1001');
});
await t.check('signed out: no order, and nothing is read, not even later', async () => {
  accountOrders = [order(2, iso(now + 5_000))];
  await open({ signedIn: false, since: now, options: FAST });
  await wait(200);
  assert.equal(latest.order, null);
  assert.equal(historyReads(), 0);
});
await t.check('by default it reads again after 3 and 8 seconds', () => {
  assert.deepEqual([...LATEST_ORDER_READ_AGAIN_SECONDS], [3, 8]);
});

await runAct(async () => { root.unmount(); });
t.done();
