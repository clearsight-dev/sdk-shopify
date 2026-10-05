// The app's own discount code (SDK move 6): `useAppDiscountCode` rendered in jsdom with the real
// ShopifyProvider and the Storefront API stubbed at `fetch`.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const server = { cartNumber: 1, lines: [], codes: [], refuseCodes: false };
const sent = [];
const cartPayload = () => ({
  id: `gid://shopify/Cart/${server.cartNumber}`, checkoutUrl: 'https://shop/checkout', note: '', attributes: [],
  totalQuantity: server.lines.length,
  buyerIdentity: { countryCode: 'US', email: null, phone: null },
  lines: { nodes: server.lines.map((l, i) => ({ id: `gid://line/${i}`, quantity: 1, attributes: [], sellingPlanAllocation: null,
    merchandise: { id: l, title: 'S', price: money('50.00') }, cost: { totalAmount: money('50.00'), amountPerQuantity: money('50.00') } })) },
  cost: { subtotalAmount: money('50.00'), totalAmount: money('50.00') },
  discountCodes: server.codes.map((code) => ({ code, applicable: code.toUpperCase() !== 'NOPE' })),
  appliedGiftCards: [], createdAt: '', updatedAt: '',
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
    server.codes = [];
    return response(200, { data: { cartCreate: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartGet') return response(200, { data: { cart: cartPayload() } });
  if (name === 'CartLinesAdd') {
    for (const l of variables.lines) server.lines.push(l.merchandiseId);
    return response(200, { data: { cartLinesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartDiscountCodesUpdate') {
    if (server.refuseCodes) throw new TypeError('Network request failed');
    server.codes = [...variables.discountCodes];
    return response(200, { data: { cartDiscountCodesUpdate: { cart: cartPayload(), userErrors: [] } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useAppDiscountCode, useCart } = await import('../dist/index.js');

const t = harness('cart: the app\'s own discount code (useAppDiscountCode)');

let cartApi = null;
const errors = [];
function Probe({ code }) {
  cartApi = useCart();
  useAppDiscountCode(code, { onError: (error) => errors.push(error) });
  return null;
}
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
let root = null;
async function render(code) {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth: { method: 'password', secureStorage: keychain() } },
      React.createElement(Probe, { code }),
    ));
  });
  await settle();
}
const discountWrites = () => sent.filter((s) => s.name === 'CartDiscountCodesUpdate');

root = createRoot(document.getElementById('root'));
await render('APPONLY');
await runAct(async () => { await cartApi.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1 }); });
await settle();

t.section('useAppDiscountCode');
await t.check('once there is a cart, the code goes on it, once', async () => {
  assert.deepEqual(discountWrites().map((s) => s.variables.discountCodes), [['APPONLY']]);
  assert.deepEqual(cartApi.cart.discountCodes.map((d) => d.code), ['APPONLY']);
  await runAct(async () => { await cartApi.addLine({ merchandiseId: 'gid://shopify/ProductVariant/2', quantity: 1 }); });
  await settle();
  assert.equal(discountWrites().length, 1, 'a later change to the cart writes nothing');
});
await t.check('the codes already on the cart are kept (the write replaces the whole set)', async () => {
  sent.length = 0;
  server.cartNumber = 2;
  server.codes = ['WELCOME5'];
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  assert.deepEqual(discountWrites().map((s) => s.variables.discountCodes), [['WELCOME5', 'APPONLY']]);
});
await t.check('a code already on the cart, in any letter case, is left alone', async () => {
  sent.length = 0;
  server.cartNumber = 3;
  server.codes = ['apponly'];
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  assert.deepEqual(discountWrites(), []);
});
await t.check('a new cart gets it again; a removed code isn\'t put back on the same cart', async () => {
  sent.length = 0;
  server.cartNumber = 4;
  server.codes = [];
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  assert.equal(discountWrites().length, 1);
  server.codes = [];
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  assert.equal(discountWrites().length, 1, 'tried once for this cart');
});
await t.check('spaces around the code are ignored; an empty code does nothing', async () => {
  sent.length = 0;
  server.cartNumber = 5;
  server.codes = [];
  await render('  SUMMER10 ');
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  assert.deepEqual(discountWrites().map((s) => s.variables.discountCodes), [['SUMMER10']]);
  sent.length = 0;
  server.cartNumber = 6;
  server.codes = [];
  await render('   ');
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  await render(null);
  await settle();
  assert.deepEqual(discountWrites(), []);
});
await t.check('a write that fails goes to onError, and isn\'t tried again on that cart', async () => {
  sent.length = 0;
  server.cartNumber = 7;
  server.codes = [];
  server.refuseCodes = true;
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  await render('APPONLY');
  assert.equal(errors.length, 1);
  assert.equal(discountWrites().length, 1);
  await runAct(async () => { await cartApi.refresh(); });
  await settle();
  assert.equal(discountWrites().length, 1);
  server.refuseCodes = false;
});

await runAct(async () => { root.unmount(); });
t.done();
