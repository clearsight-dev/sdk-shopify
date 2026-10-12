// `useCartPage` (0.14.0) rendered in jsdom with the real ShopifyProvider, its `cartExtensions` and the
// Storefront API stubbed at `fetch`: facts on the lines, + adding a line where an extension says so,
// re-reads an extension asks for, the cart page's two events, and checkout waiting on a lapsed hold.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
/** The store's cart: each line a variant and its attributes, oldest first (Shopify answers newest first). */
const server = { lines: [] };
const sent = [];
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [],
  totalQuantity: server.lines.length,
  buyerIdentity: { countryCode: 'US', email: null, phone: null },
  lines: { nodes: [...server.lines].reverse().map((l) => ({ id: l.id, quantity: 1, attributes: l.attributes, sellingPlanAllocation: null,
    merchandise: { id: l.variant, title: 'S', price: money('20.00'), availableForSale: true, quantityAvailable: 5 },
    cost: { totalAmount: money('20.00'), amountPerQuantity: money('20.00') } })) },
  cost: { subtotalAmount: money(`${20 * server.lines.length}.00`), totalAmount: money(`${20 * server.lines.length}.00`) },
  discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
});

global.fetch = async (url, init = {}) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  sent.push({ name, variables });
  if (name === 'CartCreate') {
    server.lines = [];
    return response(200, { data: { cartCreate: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartGet') return response(200, { data: { cart: cartPayload() } });
  if (name === 'CartLinesAdd') {
    for (const l of variables.lines) server.lines.push({ id: `gid://line/${server.lines.length + 1}`, variant: l.merchandiseId, attributes: l.attributes ?? [] });
    return response(200, { data: { cartLinesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useCartPage, useCart, useCheckout } = await import('../dist/index.js');

const t = harness('cart page: useCartPage with cart extensions');

/** Stands in for Cart Hold: a line stamped `_held` is reserved until its value, and lapsed when `lapsed`. */
const holds = { lapsed: false, reads: [] };
const holdExtension = {
  name: 'test-hold',
  lineFacts: (line) => ({ holdExpiresAt: Number(line.attributes.find((a) => a.key === '_held')?.value) || null }),
  increaseAddsLine: (line) => line.attributes.some((a) => a.key === '_held'),
  refreshDelays: () => holds.reads,
  hasLapsedHold: () => holds.lapsed,
};
const EXTENSIONS = [holdExtension];

let page = null;
let cartApi = null;
let checkoutApi = null;
const events = [];
function Probe() {
  page = useCartPage({ lineOrder: 'oldestFirst' });
  cartApi = useCart();
  checkoutApi = useCheckout();
  return null;
}
const settle = (ms = 30) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });
const root = createRoot(document.getElementById('root'));
await runAct(async () => {
  root.render(React.createElement(
    ShopifyProvider,
    {
      config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' },
      auth: { method: 'password', secureStorage: keychain() },
      cartExtensions: EXTENSIONS,
      onEvent: (event) => events.push(event),
    },
    React.createElement(Probe),
  ));
});
await settle();

t.section('before anything is in the cart');
await t.check('empty: no lines, and a cart that already exists comes to $0.00', () => {
  assert.equal(page.status, 'empty');
  assert.deepEqual(page.lines, []);
  assert.equal(page.amounts.totalNow?.amount ?? '0.00', '0.00');
});

await runAct(async () => { await cartApi.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: [{ key: '_held', value: '4102444800000' }] }); });
await runAct(async () => { await cartApi.addLine({ merchandiseId: 'gid://shopify/ProductVariant/2', quantity: 1 }); });
await settle();

t.section('the lines');
await t.check('oldest first, each with what the extension knows', () => {
  assert.equal(page.status, 'ready');
  assert.deepEqual(page.lines.map((l) => l.line.merchandise.id), ['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2']);
  assert.equal(page.lines[0].holdExpiresAt, 4102444800000);
  assert.equal(page.lines[1].holdExpiresAt, null);
  assert.equal(page.lines[0].unitPrice.amount, '20.00');
  assert.equal(page.lines[0].canIncrease, true);
  assert.equal(page.lines[0].preOrder, null);
  assert.equal(page.amounts.totalNow.amount, '40.00');
});
await t.check('+ on a held line adds a new line, and names it once the add lands', async () => {
  sent.length = 0;
  await runAct(async () => { page.increase(page.lines[0].id); });
  await settle();
  assert.deepEqual(sent.filter((s) => s.name.startsWith('CartLines')).map((s) => s.name), ['CartLinesAdd']);
  assert.equal(page.lines.length, 3);
  assert.equal(page.justAddedLineId, page.lines[2].id, 'the new line, at the bottom');
});

t.section('re-reads an extension asks for');
await t.check('the cart is read again after each delay', async () => {
  sent.length = 0;
  holds.reads = [10, 20];
  await runAct(async () => { await cartApi.refresh(); });
  sent.length = 0;
  await settle(60);
  assert.equal(sent.filter((s) => s.name === 'CartGet').length >= 2, true);
  holds.reads = [];
});

t.section('events');
await t.check('viewed() reports cart:viewed with the cart', () => {
  events.length = 0;
  page.viewed();
  const viewed = events.filter((e) => e.type === 'cart:viewed');
  assert.equal(viewed.length, 1);
  assert.equal(viewed[0].cart.id, 'gid://shopify/Cart/1');
});

t.section('checkout');
await t.check('start() reports checkout:started with the shows, then stops on a lapsed hold', async () => {
  events.length = 0;
  holds.lapsed = true;
  let result = null;
  await runAct(async () => { result = await page.checkout.start(); });
  assert.equal(result, 'lapsedHold');
  const started = events.filter((e) => e.type === 'checkout:started');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].shows, { live: [], replay: [] });
});
await t.check("any checkout entry gets the extensions' answer when it doesn't pass its own", async () => {
  let result = null;
  await runAct(async () => { result = await checkoutApi.prepare(); });
  assert.equal(result, 'lapsedHold');
  await runAct(async () => { result = await checkoutApi.prepare({ hasLapsedHold: () => false }); });
  assert.notEqual(result, 'lapsedHold', "the caller's own answer wins");
  holds.lapsed = false;
  await runAct(async () => { result = await page.checkout.start(); });
  assert.notEqual(result, 'lapsedHold');
});

await runAct(async () => root.unmount());
t.done();
