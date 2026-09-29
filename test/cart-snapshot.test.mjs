// The device-side line snapshot, and restoring an expired cart from it. Real ShopifyProvider in
// jsdom, Storefront API stubbed at `fetch` with a tiny in-memory cart store.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
// defineProperty, not assignment: Node 21+ ships `navigator` as a getter-only global.
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = { amount: '10.00', currencyCode: 'USD' };
const carts = new Map();
let nextCartId = 1;
// Merchandise Shopify refuses: no longer for sale.
const refused = new Set();
// CartLinesAdd calls allowed before the network drops; null = never.
let addsBeforeOutage = null;
const calls = [];

const refusal = (id) => ({ field: ['lines'], message: `The merchandise ${id} is no longer available.`, code: 'MERCHANDISE_NOT_FOUND' });

const payload = (id) => {
  const c = carts.get(id);
  return {
    id,
    checkoutUrl: 'https://shop/checkout',
    totalQuantity: c.lines.reduce((n, l) => n + l.quantity, 0),
    attributes: c.attributes,
    lines: { nodes: c.lines.map((l, i) => ({
      id: `${id}/line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
      sellingPlanAllocation: l.sellingPlanId ? { sellingPlan: { id: l.sellingPlanId } } : null,
      merchandise: { id: l.merchandiseId }, cost: { totalAmount: money, amountPerQuantity: money },
    })) },
    cost: { subtotalAmount: money, totalAmount: money },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};

global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = op?.[1] || op?.[2] || 'unknown';
  calls.push({ name, variables });
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (name === 'CartLinesAdd' && addsBeforeOutage !== null && addsBeforeOutage-- <= 0) {
    throw new TypeError('Network request failed');
  }

  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } },
                   localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') {
    const lines = variables.input?.lines ?? [];
    const bad = lines.find((l) => refused.has(l.merchandiseId));
    if (bad) return reply({ cartCreate: { cart: null, userErrors: [refusal(bad.merchandiseId)] } });
    const id = `gid://shopify/Cart/${nextCartId++}`;
    carts.set(id, { attributes: variables.input?.attributes ?? [], lines: lines.map((l) => ({ ...l })) });
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) {
    return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });
  }
  if (name === 'CartLinesAdd') {
    const bad = variables.lines.find((l) => refused.has(l.merchandiseId));
    if (bad) return reply({ cartLinesAdd: { cart: null, userErrors: [refusal(bad.merchandiseId)] } });
    carts.get(variables.cartId).lines.push(...variables.lines.map((l) => ({ ...l })));
    return reply({ cartLinesAdd: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartLinesUpdate') {
    const c = carts.get(variables.cartId);
    for (const u of variables.lines) c.lines[Number(u.id.split('/line/')[1])].quantity = u.quantity;
    return reply({ cartLinesUpdate: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartLinesRemove') {
    const c = carts.get(variables.cartId);
    c.lines = c.lines.filter((_l, i) => !variables.lineIds.includes(`${variables.cartId}/line/${i}`));
    return reply({ cartLinesRemove: { cart: payload(variables.cartId), userErrors: [] } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, toLineSnapshot } = await import('../dist/index.js');

const CART_KEY = 'shopify:cart-id:v1';
const LINES_KEY = 'shopify:cart-lines:v1';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
  };
}

const cartAttributes = [{ key: '_app', value: 'fp' }];
let api = null;
let root = null;
function Probe() { api = useShopify(); return null; }

async function mount(storage) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  calls.length = 0;
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, storage, cartAttributes },
      React.createElement(Probe),
    ));
  });
  await runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

const snapshotOf = (storage) => JSON.parse(storage.map.get(LINES_KEY));
const creates = () => calls.filter((c) => c.name === 'CartCreate');

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

const tagged = { merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 2,
  attributes: [{ key: '_stream_id', value: 's-42' }, { key: '_cart_hold_expires', value: '2026-09-29T10:00:00Z' }] };
const planned = { merchandiseId: 'gid://shopify/ProductVariant/2', quantity: 1, sellingPlanId: 'gid://shopify/SellingPlan/9',
  attributes: [{ key: '_replay_id', value: 'r-7' }] };
const plain = { merchandiseId: 'gid://shopify/ProductVariant/3', quantity: 3 };

console.log('snapshot on change');
const s1 = memoryStorage();
await mount(s1);
check('a fresh cart writes an empty snapshot', () => {
  assert.equal(api.ready, true);
  assert.deepEqual(snapshotOf(s1), []);
});

await runAct(async () => { await api.cart.addLines([tagged, planned, plain]); });
check('an add writes every line: quantity, selling plan, attributes verbatim', () => {
  assert.deepEqual(snapshotOf(s1), [
    { merchandiseId: tagged.merchandiseId, quantity: 2, sellingPlanId: null, attributes: tagged.attributes },
    { merchandiseId: planned.merchandiseId, quantity: 1, sellingPlanId: planned.sellingPlanId, attributes: planned.attributes },
    { merchandiseId: plain.merchandiseId, quantity: 3, sellingPlanId: null, attributes: [] },
  ]);
});
check('CartLine carries sellingPlanId, and toLineSnapshot is exported from the root', () => {
  assert.equal(api.cart.cart.lines[1].sellingPlanId, planned.sellingPlanId);
  assert.equal(api.cart.cart.lines[0].sellingPlanId, null);
  assert.deepEqual(toLineSnapshot(api.cart.cart), snapshotOf(s1));
});

const plainLineId = api.cart.cart.lines[2].id;
await runAct(async () => { await api.cart.removeLine(plainLineId); });
check('a remove rewrites the snapshot', () => {
  assert.deepEqual(snapshotOf(s1).map((l) => l.merchandiseId), [tagged.merchandiseId, planned.merchandiseId]);
});

console.log('expired cart restore');
const saved = JSON.stringify([...snapshotOf(s1), { merchandiseId: plain.merchandiseId, quantity: 3, sellingPlanId: null, attributes: [] }]);
const s2 = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/expired', [LINES_KEY]: saved });
await mount(s2);
check('one cartCreate carries every line and the cart attributes', () => {
  const made = creates();
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].variables.input.attributes, cartAttributes);
  assert.deepEqual(made[0].variables.input.lines, [
    { merchandiseId: tagged.merchandiseId, quantity: 2, attributes: tagged.attributes },
    { merchandiseId: planned.merchandiseId, quantity: 1, attributes: planned.attributes, sellingPlanId: planned.sellingPlanId },
    { merchandiseId: plain.merchandiseId, quantity: 3, attributes: [] },
  ]);
});
check('the restored cart is stored, with its lines intact', () => {
  const c = api.cart.cart;
  assert.equal(s2.map.get(CART_KEY), c.id);
  assert.notEqual(c.id, 'gid://shopify/Cart/expired');
  assert.deepEqual(toLineSnapshot(c), JSON.parse(saved));
  assert.deepEqual(snapshotOf(s2), JSON.parse(saved));
});

refused.add(planned.merchandiseId);
const s3 = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/expired', [LINES_KEY]: saved });
await mount(s3);
check('a refused line is skipped and the others restore', () => {
  assert.equal(api.error, null);
  assert.deepEqual(toLineSnapshot(api.cart.cart).map((l) => l.merchandiseId), [tagged.merchandiseId, plain.merchandiseId]);
  assert.deepEqual(api.cart.cart.lines[0].attributes, tagged.attributes);
  assert.deepEqual(api.cart.cart.attributes, cartAttributes);
  assert.equal(snapshotOf(s3).length, 2);
});
check('the fallback is an empty create plus one add per line', () => {
  const made = creates();
  assert.equal(made.length, 2);
  assert.equal(made[1].variables.input.lines, undefined);
  assert.equal(calls.filter((c) => c.name === 'CartLinesAdd').length, 3);
});
refused.clear();

addsBeforeOutage = 2;
const s4 = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/expired', [LINES_KEY]: saved });
refused.add(tagged.merchandiseId);
await mount(s4);
check('a network failure mid-fallback keeps the partial cart instead of failing startup', () => {
  assert.equal(api.error, null);
  assert.deepEqual(toLineSnapshot(api.cart.cart).map((l) => l.merchandiseId), [planned.merchandiseId]);
  assert.equal(s4.map.get(CART_KEY), api.cart.cart.id);
  assert.deepEqual(snapshotOf(s4), toLineSnapshot(api.cart.cart));
});
addsBeforeOutage = null;
refused.clear();

const s5 = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/expired' });
await mount(s5);
check('no snapshot: an empty cart, created as before', () => {
  const made = creates();
  assert.equal(made.length, 1);
  assert.equal(made[0].variables.input.lines, undefined);
  assert.equal(api.cart.cart.lines.length, 0);
  assert.deepEqual(snapshotOf(s5), []);
});

const s6 = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/expired', [LINES_KEY]: 'not json' });
await mount(s6);
check('a malformed snapshot counts as empty', () => {
  assert.equal(api.error, null);
  assert.equal(api.cart.cart.lines.length, 0);
});

console.log('checkout started');
const CHECKOUT_KEY = 'shopify:checkout-started-cart-id:v1';
const s8 = memoryStorage();
await mount(s8);
await runAct(async () => { await api.cart.addLines([tagged, planned]); });
const checkedOutId = api.cart.cart.id;
await runAct(async () => { await api.checkout.reportCheckoutStarted(); });
check('reportCheckoutStarted marks the current cart id', () => {
  assert.equal(s8.map.get(CHECKOUT_KEY), checkedOutId);
});
// A completed checkout reads back null, the same as an expiry.
carts.delete(checkedOutId);
await mount(s8);
check('checkout started + stored cart null: an empty cart, nothing restored', () => {
  const made = creates();
  assert.equal(made.length, 1);
  assert.equal(made[0].variables.input.lines, undefined);
  assert.deepEqual(made[0].variables.input.attributes, cartAttributes);
  assert.equal(api.cart.cart.lines.length, 0);
  assert.deepEqual(snapshotOf(s8), []);
});

const s9 = memoryStorage();
await mount(s9);
await runAct(async () => { await api.cart.addLines([tagged]); });
await runAct(async () => { await api.checkout.reportCheckoutStarted(); });
await runAct(async () => { await api.cart.addLine(plain); });
check('an add after checkout started clears the mark', () => {
  assert.equal(s9.map.has(CHECKOUT_KEY), false);
});
await runAct(async () => { await api.checkout.reportCheckoutStarted(); });
await runAct(async () => { await api.cart.updateLine(api.cart.cart.lines[1].id, 5); });
check('an update after checkout started clears the mark', () => {
  assert.equal(s9.map.has(CHECKOUT_KEY), false);
});
await runAct(async () => { await api.checkout.reportCheckoutStarted(); });
await runAct(async () => { await api.cart.removeLine(api.cart.cart.lines[1].id); });
check('a remove after checkout started clears the mark', () => {
  assert.equal(s9.map.has(CHECKOUT_KEY), false);
});
carts.delete(api.cart.cart.id);
await mount(s9);
check('so the shopper who came back gets the cart restored', () => {
  assert.deepEqual(toLineSnapshot(api.cart.cart).map((l) => l.merchandiseId), [tagged.merchandiseId]);
});

console.log('reset');
const s7 = memoryStorage();
await mount(s7);
await runAct(async () => { await api.cart.addLines([tagged]); });
const departing = api.cart.cart.id;
calls.length = 0;
await runAct(async () => { await api.cart.reset(); });
check('reset clears the snapshot and writes nothing to the departing cart', () => {
  assert.deepEqual(snapshotOf(s7), []);
  assert.deepEqual(calls.map((c) => c.name), ['CartCreate']);
  assert.equal(carts.get(departing).lines.length, 1);
});

await runAct(async () => { await api.cart.addLines([plain]); });
await runAct(async () => { await api.checkout.reportOrderPlaced(); });
check('checkout complete clears the snapshot', () => {
  assert.deepEqual(snapshotOf(s7), []);
});

await runAct(async () => root.unmount());
console.log(`\n${pass} checks passed`);
