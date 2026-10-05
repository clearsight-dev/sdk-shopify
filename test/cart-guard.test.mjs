// The cart guard lifecycle (`cartGuard`, which Cart Hold plugs into): every unit a guard approves
// either lands or is handed back, a release carries its receipt, attributes survive a guard's
// answer, a quiet batch tells the guard and raises no out-of-stock alert, and a quantity the guard
// lowers is the one added. Renders the real ShopifyProvider in jsdom with the Storefront API stubbed
// at `fetch`.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = { amount: '10.00', currencyCode: 'USD' };
let lines = [];
let nextLine = 0;
const sent = [];
/** `outOfStock`: variants Shopify refuses as out of stock, failing any batch that carries one. */
const server = { createFails: false, addFails: false, outOfStock: new Set() };
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout',
  totalQuantity: lines.reduce((n, l) => n + l.quantity, 0),
  lines: { nodes: lines.map((l) => ({ id: l.id, quantity: l.quantity, attributes: l.attributes ?? [], sellingPlanAllocation: null,
    merchandise: { id: l.merchandiseId, title: 'S', price: money }, cost: { totalAmount: money, amountPerQuantity: money } })) },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], attributes: [], createdAt: '', updatedAt: '',
});

global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:mutation|query) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') {
    if (server.createFails) return response(503, 'down');
    return response(200, { data: { cartCreate: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart: cartPayload() } });
  if (name === 'CartLinesAdd') {
    sent.push({ name, lines: variables.lines });
    if (server.addFails) return response(200, { data: { cartLinesAdd: { cart: null, userErrors: [{ field: null, code: 'INVALID', message: 'no' }] } } });
    if (variables.lines.some((l) => server.outOfStock.has(l.merchandiseId))) {
      return response(200, { data: { cartLinesAdd: { cart: null, userErrors: [{ field: ['lines'], code: 'MERCHANDISE_OUT_OF_STOCK', message: 'The product is out of stock.' }] } } });
    }
    for (const l of variables.lines) lines.push({ id: `gid://line/${nextLine++}`, ...l });
    return response(200, { data: { cartLinesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartLinesUpdate') {
    sent.push({ name, lines: variables.lines });
    for (const u of variables.lines) {
      const line = lines.find((l) => l.id === u.id);
      line.quantity = u.quantity;
      if (u.attributes) line.attributes = u.attributes;
    }
    return response(200, { data: { cartLinesUpdate: { cart: cartPayload(), userErrors: [] } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify } = await import('../dist/index.js');

// A guard like Cart Hold: stamps what it reserves, and records what it is told. `cutTo` set: it
// approves at most that many units, as Cart Hold does when only some are still free.
const released = [];
const landed = [];
const addOptions = [];
let cutTo = null;
const guard = {
  beforeAdd: (input, options) => {
    addOptions.push(options);
    const quantity = cutTo === null ? input.quantity : Math.min(cutTo, input.quantity);
    return { ...input, quantity, attributes: [...(input.attributes ?? []), { key: '_hold', value: 'stamp' }] };
  },
  beforeIncrease: (line, quantity) => ({ id: line.id, quantity }),
  onLanded: (event) => landed.push(event),
  onReleased: (event) => released.push(event),
};
/** Event types the provider emitted, in order. */
const events = [];

let api = null;
function Probe() {
  api = useShopify();
  return null;
}
const root = createRoot(document.getElementById('root'));
async function render(cartPolicy) {
  await runAct(async () => {
    root.render(React.createElement(ShopifyProvider, {
      config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, cartGuard: guard, cartPolicy,
      onEvent: (event) => events.push(event.type),
    }, React.createElement(Probe)));
  });
  await runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
}
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 10)); });

const t = harness('cart guard lifecycle');
await render({ maxLineItems: 1 });

t.section('adds that do not land hand their units back');
await runAct(async () => { await api.cart.addLine({ merchandiseId: 'v1', quantity: 1 }); });
released.length = 0;
let result;
await runAct(async () => { result = await api.cart.addLine({ merchandiseId: 'v2', quantity: 2 }); });
await settle();
await t.check('refused by the line limit after the guard approved it: released, with its receipt', () => {
  assert.equal(result.reason, 'limit');
  assert.equal(released.length, 1);
  assert.equal(released[0].reason, 'rejected');
  assert.equal(released[0].variantId, 'v2');
  assert.equal(released[0].quantity, 2);
  assert.deepEqual(released[0].input.attributes, [{ key: '_hold', value: 'stamp' }]);
  assert.equal(released[0].line, null);
});

released.length = 0;
server.addFails = true;
await render({});
await runAct(async () => { try { await api.cart.addLine({ merchandiseId: 'v3', quantity: 1 }); } catch {} });
server.addFails = false;
await settle();
await t.check('refused by Shopify: released, with its receipt', () => {
  assert.equal(released.length, 1);
  assert.equal(released[0].variantId, 'v3');
  assert.ok(released[0].input);
});

t.section('attributes survive');
lines = [{ id: 'gid://line/held', merchandiseId: 'v9', quantity: 1, attributes: [{ key: '_hold', value: 'stamp' }, { key: 'note', value: 'gift' }] }];
await runAct(async () => { await api.cart.refresh(); });
sent.length = 0;
await runAct(async () => { await api.cart.updateLine('gid://line/held', 2, [{ key: 'note', value: 'wrapped' }]); });
await t.check('a guard approving an increase without attributes keeps the caller\'s, and the private stamp', () => {
  const update = sent.find((s) => s.name === 'CartLinesUpdate').lines[0];
  assert.equal(update.quantity, 2);
  assert.deepEqual(update.attributes, [{ key: 'note', value: 'wrapped' }, { key: '_hold', value: 'stamp' }]);
});
sent.length = 0;
await runAct(async () => { await api.cart.updateLine('gid://line/held', 2, [{ key: 'note', value: 'plain' }]); });
await t.check('an attribute-only update keeps the line\'s `_` attributes it didn\'t mention', () => {
  const update = sent.find((s) => s.name === 'CartLinesUpdate').lines[0];
  assert.deepEqual(update.attributes, [{ key: 'note', value: 'plain' }, { key: '_hold', value: 'stamp' }]);
});

t.section('a quiet batch (Buy again): the caller reports the outcome');
const ok = { merchandiseId: 'v-ok', quantity: 1 };
const sold = { merchandiseId: 'v-sold', quantity: 1 };
server.outOfStock.add('v-sold');
addOptions.length = 0;
released.length = 0;
events.length = 0;
await runAct(async () => { await api.cart.addLines([ok, sold], { quiet: true }); });
await settle();
await t.check('every beforeAdd is passed { quiet: true }', () => {
  assert.deepEqual(addOptions, [{ quiet: true }, { quiet: true }]);
});
await t.check('the line Shopify refused in the line-by-line retry raises no cart:outOfStock; the rest lands, with cart:add', () => {
  assert.deepEqual(events, ['cart:add']);
  assert.ok(lines.some((l) => l.merchandiseId === 'v-ok'));
  assert.deepEqual(released.map((r) => r.variantId), ['v-sold']);
});
addOptions.length = 0;
events.length = 0;
await runAct(async () => { await api.cart.addLines([ok, sold]); });
await settle();
server.outOfStock.clear();
await t.check('not quiet: the guard is passed no options, and the retry raises its one cart:outOfStock', () => {
  assert.deepEqual(addOptions, [undefined, undefined]);
  assert.deepEqual(events, ['cart:outOfStock', 'cart:add']);
});
addOptions.length = 0;
await runAct(async () => { await api.cart.addLine(ok); });
await t.check('addLine passes the guard no options', () => assert.deepEqual(addOptions, [undefined]));

t.section('a guard that lowers the quantity (Cart Hold taking only the units still free)');
cutTo = 2;
sent.length = 0;
landed.length = 0;
await runAct(async () => { await api.cart.addLines([{ merchandiseId: 'v-few', quantity: 3 }], { quiet: true }); });
await settle();
cutTo = null;
await t.check('the quantity the guard returned is the one sent, and the one it hears landed', () => {
  assert.equal(sent.find((s) => s.name === 'CartLinesAdd').lines[0].quantity, 2);
  assert.deepEqual(landed.map((e) => [e.variantId, e.quantity]), [['v-few', 2]]);
});

t.section('a cart that cannot be created');
await runAct(async () => { root.unmount(); });
localStorage.clear();
lines = [];
released.length = 0;
server.createFails = true;
const root2 = createRoot(document.getElementById('root'));
await runAct(async () => {
  root2.render(React.createElement(ShopifyProvider, { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, cartGuard: guard }, React.createElement(Probe)));
});
await runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
let threw = null;
await runAct(async () => { try { await api.cart.addLine({ merchandiseId: 'v5', quantity: 1 }); } catch (e) { threw = e; } });
await settle();
server.createFails = false;
await t.check('the add throws, and its units are released', () => {
  assert.ok(threw);
  assert.equal(released.length, 1);
  assert.equal(released[0].variantId, 'v5');
});
await runAct(async () => { root2.unmount(); });

t.done();
