// Whether an add really landed (0.13.1). Shopify doesn't refuse an add past the stock: it answers ok and
// adds only what is left, or nothing. Real ShopifyProvider in jsdom, Storefront API stubbed at `fetch`
// with per-variant stock that clamps the same way, and gone carts that answer as Shopify does.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = { amount: '10.00', currencyCode: 'USD' };
const carts = new Map();
let nextCartId = 1;
// Units of a variant a cart may hold; absent = unlimited.
const stock = new Map();
const calls = [];

const missing = { field: ['cartId'], message: 'The specified cart does not exist.', code: 'INVALID' };
const sameAttributes = (a = [], b = []) => JSON.stringify(a) === JSON.stringify(b);
const unitsIn = (c, id) => c.lines.reduce((n, l) => (l.merchandiseId === id ? n + l.quantity : n), 0);

// What Shopify does with an add: merge into a line with the same variant and attributes, and clamp
// silently to the stock left.
function addTo(c, line) {
  const left = stock.has(line.merchandiseId) ? Math.max(0, stock.get(line.merchandiseId) - unitsIn(c, line.merchandiseId)) : Infinity;
  const quantity = Math.min(line.quantity, left);
  if (quantity <= 0) return;
  const same = c.lines.find((l) => l.merchandiseId === line.merchandiseId && sameAttributes(l.attributes, line.attributes));
  if (same) same.quantity += quantity;
  else c.lines.push({ ...line, quantity });
}

const payload = (id) => {
  const c = carts.get(id);
  return {
    id,
    checkoutUrl: 'https://shop/checkout',
    totalQuantity: c.lines.reduce((n, l) => n + l.quantity, 0),
    attributes: c.attributes,
    buyerIdentity: { countryCode: 'US', email: null, phone: null },
    lines: { nodes: c.lines.map((l, i) => ({
      id: `${id}/line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
      sellingPlanAllocation: null,
      merchandise: { id: l.merchandiseId }, cost: { totalAmount: money, amountPerQuantity: money },
    })) },
    cost: { subtotalAmount: money, totalAmount: money },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};

function mint(lines = [], attributes = []) {
  const id = `gid://shopify/Cart/${nextCartId++}`;
  const c = { attributes, lines: [] };
  carts.set(id, c);
  lines.forEach((line) => addTo(c, line));
  return id;
}

global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /mutation (\w+)|query (\w+)/.exec(query)?.slice(1).find(Boolean) ?? 'unknown';
  calls.push({ name, variables });
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } },
                   localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') {
    const id = mint(variables.input?.lines ?? [], variables.input?.attributes ?? []);
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet') return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });

  const field = name[0].toLowerCase() + name.slice(1);
  if (variables.cartId && !carts.has(variables.cartId)) {
    const phantom = mint(name === 'CartLinesAdd' ? variables.lines : []);
    return reply({ [field]: { cart: payload(phantom), userErrors: [missing] } });
  }
  const c = carts.get(variables.cartId);
  if (name === 'CartLinesAdd') variables.lines.forEach((line) => addTo(c, line));
  if (name === 'CartAttributesUpdate') c.attributes = variables.attributes;
  return reply({ [field]: { cart: payload(variables.cartId), userErrors: [] } });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, parseAttribution, ATTRIBUTION_ATTRIBUTE_KEY } = await import('../dist/index.js');

const ACTIVITY_KEY = 'shopify:cart-activity:v1';
const ELEVEN_DAYS = 11 * 24 * 60 * 60 * 1000;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
  };
}

let api = null;
let root = null;
let events = [];
let guardCalls = [];
function Probe() { api = useShopify(); return null; }

// Records what the guard hears; vetoes any input carrying the `_veto` attribute.
const cartGuard = {
  beforeAdd: (input) => (input.attributes?.some((a) => a.key === '_veto') ? null : input),
  onLanded: (e) => guardCalls.push(['landed', e.variantId, e.quantity]),
  onReleased: (e) => guardCalls.push(['released', e.variantId, e.quantity, e.reason]),
};

async function mount(storage = memoryStorage(), extra = {}) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      {
        config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' },
        storage, cartGuard, onEvent: (e) => events.push(e), ...extra,
      },
      React.createElement(Probe),
    ));
  });
  await runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
  events = [];
  guardCalls = [];
  calls.length = 0;
  return storage;
}

const of = (type) => events.filter((e) => e.type === type);
const units = (id) => (api.cart.cart?.lines ?? []).reduce((n, l) => (l.merchandise.id === id ? n + l.quantity : n), 0);

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

const V = (n) => `gid://shopify/ProductVariant/${n}`;

console.log('a normal add');
stock.clear();
await mount();
let r;
await runAct(async () => { r = await api.cart.addLine({ merchandiseId: V(1), quantity: 2 }); });
check('ok, every unit landed, cart:add says 2, no clamp', () => {
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined);
  assert.equal(r.landedQuantity, 2);
  assert.equal(of('cart:add').length, 1);
  assert.equal(of('cart:add')[0].changedLines[0].quantityChange, 2);
  assert.equal(of('cart:stockLimit').length, 0);
  assert.deepEqual(guardCalls, [['landed', V(1), 2]]);
});

console.log('an add Shopify clamps to nothing');
stock.set(V(2), 1);
await runAct(async () => { await api.cart.addLine({ merchandiseId: V(2), quantity: 1 }); });
events = []; guardCalls = [];
await runAct(async () => { r = await api.cart.addLine({ merchandiseId: V(2), quantity: 1 }); });
check('ok false, clamped, the noMoreStock copy, and the cart as Shopify returned it', () => {
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'clamped');
  assert.equal(r.message, 'No more stock available');
  assert.equal(r.landedQuantity, 0);
  assert.equal(r.cart.id, api.cart.cart.id);
  assert.equal(units(V(2)), 1);
});
check('no cart:add; cart:stockLimit with what was cut', () => {
  assert.equal(of('cart:add').length, 0);
  const [e] = of('cart:stockLimit');
  assert.equal(e.severity, 'error');
  assert.equal(e.message, 'No more stock available');
  assert.deepEqual(e.clamped, [{ merchandiseId: V(2), requestedQuantity: 1, landedQuantity: 0 }]);
});
check('the guard gets its unit back and hears of no landing', () => {
  assert.deepEqual(guardCalls, [['released', V(2), 1, 'rejected']]);
});

console.log('an add Shopify cuts short');
stock.set(V(3), 3);
events = []; guardCalls = [];
await runAct(async () => { r = await api.cart.addLine({ merchandiseId: V(3), quantity: 5 }); });
check('ok, with the 3 that landed', () => {
  assert.equal(r.ok, true);
  assert.equal(r.landedQuantity, 3);
  assert.equal(units(V(3)), 3);
});
check('cart:add says 3, cart:stockLimit says 5 asked, 3 landed', () => {
  assert.equal(of('cart:add')[0].changedLines[0].quantityChange, 3);
  assert.deepEqual(of('cart:stockLimit')[0].clamped, [{ merchandiseId: V(3), requestedQuantity: 5, landedQuantity: 3 }]);
});
check('the guard hears 3 landed and 2 released', () => {
  assert.deepEqual(guardCalls, [['landed', V(3), 3], ['released', V(3), 2, 'rejected']]);
});

console.log('units on lines split by attributes all count');
stock.set(V(4), 3);
await runAct(async () => {
  await api.cart.addLine({ merchandiseId: V(4), quantity: 1, attributes: [{ key: '_stream_id', value: 'a' }] });
  await api.cart.addLine({ merchandiseId: V(4), quantity: 1, attributes: [{ key: '_stream_id', value: 'b' }] });
});
await runAct(async () => { r = await api.cart.addLine({ merchandiseId: V(4), quantity: 2, attributes: [{ key: '_stream_id', value: 'c' }] }); });
check('two lines hold 2 of 3: a third line gets 1, a partial clamp', () => {
  assert.equal(r.ok, true);
  assert.equal(r.landedQuantity, 1);
  assert.equal(api.cart.cart.lines.filter((l) => l.merchandise.id === V(4)).length, 3);
});
await runAct(async () => { r = await api.cart.addLine({ merchandiseId: V(4), quantity: 1, attributes: [{ key: '_stream_id', value: 'a' }] }); });
check('and then nothing more lands', () => {
  assert.equal(r.reason, 'clamped');
});

console.log('a clamp on a cart rebuilt after it was gone');
stock.clear();
stock.set(V(5), 2);
const s5 = memoryStorage();
await mount(s5);
await runAct(async () => { await api.cart.addLine({ merchandiseId: V(5), quantity: 2 }); });
const dead = api.cart.cart.id;
s5.map.set(ACTIVITY_KEY, JSON.stringify({ cartId: dead, at: Date.now() - ELEVEN_DAYS }));
carts.delete(dead);
events = []; guardCalls = [];
await runAct(async () => { r = await api.cart.addLine({ merchandiseId: V(5), quantity: 1 }); });
check('measured against the rebuilt cart (2 already in it), not 0: clamped', () => {
  assert.equal(of('cart:recovered')[0].recovery.reason, 'expired');
  assert.notEqual(api.cart.cart.id, dead);
  assert.equal(units(V(5)), 2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'clamped');
  assert.equal(r.landedQuantity, 0);
  assert.equal(r.cart.id, api.cart.cart.id);
});
stock.set(V(5), 4);
const rebuilt = api.cart.cart.id;
s5.map.set(ACTIVITY_KEY, JSON.stringify({ cartId: rebuilt, at: Date.now() - ELEVEN_DAYS }));
carts.delete(rebuilt);
await runAct(async () => { r = await api.cart.addLine({ merchandiseId: V(5), quantity: 3 }); });
check('with room for 2 more: 2 landed of the 3, not 4 counted from 0', () => {
  assert.equal(r.ok, true);
  assert.equal(r.landedQuantity, 2);
  assert.equal(units(V(5)), 4);
});

console.log('addLines with mixed results');
stock.clear();
await mount();
stock.set(V(7), 1);
stock.set(V(8), 0);
await runAct(async () => {
  r = await api.cart.addLinesDetailed([
    { merchandiseId: V(6), quantity: 2 },
    { merchandiseId: V(7), quantity: 3 },
    { merchandiseId: V(8), quantity: 1 },
    { merchandiseId: V(9), quantity: 1, attributes: [{ key: '_veto', value: '1' }] },
  ]);
});
check('one entry per input: all, part, none, vetoed; ok with the 3 that landed', () => {
  assert.equal(r.ok, true);
  assert.equal(r.landedQuantity, 3);
  assert.deepEqual(r.lines, [
    { merchandiseId: V(6), requestedQuantity: 2, landedQuantity: 2 },
    { merchandiseId: V(7), requestedQuantity: 3, landedQuantity: 1 },
    { merchandiseId: V(8), requestedQuantity: 1, landedQuantity: 0 },
    { merchandiseId: V(9), requestedQuantity: 1, landedQuantity: 0 },
  ]);
});
check('cart:add lists only what landed; one cart:stockLimit lists both cuts', () => {
  assert.deepEqual(of('cart:add')[0].changedLines.map((c) => [c.line.merchandise.id, c.quantityChange]), [[V(6), 2], [V(7), 1]]);
  assert.equal(of('cart:stockLimit').length, 1);
  assert.deepEqual(of('cart:stockLimit')[0].clamped, [
    { merchandiseId: V(7), requestedQuantity: 3, landedQuantity: 1 },
    { merchandiseId: V(8), requestedQuantity: 1, landedQuantity: 0 },
  ]);
});
check('the guard hears what landed and gets the rest back', () => {
  assert.deepEqual(guardCalls, [
    ['released', V(7), 2, 'rejected'],
    ['released', V(8), 1, 'rejected'],
    ['landed', V(6), 2],
    ['landed', V(7), 1],
  ]);
});
events = [];
let plain;
await runAct(async () => { plain = await api.cart.addLines([{ merchandiseId: V(7), quantity: 1 }, { merchandiseId: V(8), quantity: 1 }]); });
check('addLines when nothing landed: null', () => {
  assert.equal(plain, null);
  assert.equal(of('cart:add').length, 0);
});
events = [];
await runAct(async () => { r = await api.cart.addLinesDetailed([{ merchandiseId: V(8), quantity: 2 }], { quiet: true }); });
check('addLinesDetailed when nothing landed: clamped, the copy, the cart; quiet raises no cart:stockLimit', () => {
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'clamped');
  assert.equal(r.message, 'No more stock available');
  assert.equal(r.cart.id, api.cart.cart.id);
  assert.equal(of('cart:stockLimit').length, 0);
});
await runAct(async () => { plain = await api.cart.addLines([{ merchandiseId: V(6), quantity: 1 }]); });
check('addLines that landed: the cart, as before', () => {
  assert.equal(plain.id, api.cart.cart.id);
});
// 3 of V(6) in the cart; room for 3 more.
stock.set(V(6), 6);
await runAct(async () => {
  r = await api.cart.addLinesDetailed([
    { merchandiseId: V(6), quantity: 2 },
    { merchandiseId: V(6), quantity: 2, attributes: [{ key: '_stream_id', value: 'x' }] },
  ]);
});
check('two inputs of one variant share what landed in input order: 2, then 1 of 2', () => {
  assert.deepEqual(r.lines.map((l) => l.landedQuantity), [2, 1]);
});

console.log('attribution counts only what landed');
stock.clear();
stock.set(V(10), 1);
await mount(memoryStorage(), { attribution: { enabled: true } });
const live = { type: 'live', showId: 'show-1' };
await runAct(async () => { await api.cart.addLine({ merchandiseId: V(10), quantity: 3, source: live }); });
await runAct(async () => { await api.cart.flushAttribution(); });
check('3 asked, 1 landed: the show is credited 1', () => {
  const value = parseAttribution(carts.get(api.cart.cart.id).attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY).value);
  const credited = Object.values(value.live['show-1'].items).reduce((n, item) => n + item.n, 0);
  assert.equal(credited, 1);
});

await runAct(async () => root.unmount());
console.log(`\n${pass} checks passed`);
