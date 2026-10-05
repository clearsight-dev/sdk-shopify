// The provider recording `_apptile_attribution` after line writes. Real ShopifyProvider in jsdom,
// Storefront API stubbed at `fetch` with an in-memory cart store that merges lines like Shopify.
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
const refused = new Set();
// Attribute writes left to fail before they start landing again.
let attrFailures = 0;
const calls = [];

const refusal = (id) => ({ field: ['lines'], message: `The merchandise ${id} is no longer available.`, code: 'MERCHANDISE_NOT_FOUND' });
const sameLine = (a, b) => a.merchandiseId === b.merchandiseId && JSON.stringify(a.attributes ?? []) === JSON.stringify(b.attributes ?? []);

const payload = (id) => {
  const c = carts.get(id);
  return {
    id,
    checkoutUrl: 'https://shop/checkout',
    totalQuantity: c.lines.reduce((n, l) => n + l.quantity, 0),
    attributes: c.attributes,
    lines: { nodes: c.lines.map((l, i) => ({
      id: `${id}/line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
      merchandise: { id: l.merchandiseId }, cost: { totalAmount: money, amountPerQuantity: money },
    })) },
    cost: { subtotalAmount: money, totalAmount: money },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};

function addInto(c, lines) {
  for (const l of lines) {
    const existing = c.lines.find((x) => sameLine(x, l));
    if (existing) existing.quantity += l.quantity;
    else c.lines.push({ ...l });
  }
}

global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = op?.[1] || op?.[2] || 'unknown';
  calls.push({ name, variables });
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  // Real latency, so two fast writes genuinely overlap.
  await new Promise((r) => setTimeout(r, 3));

  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } },
                   localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') {
    const lines = variables.input?.lines ?? [];
    const bad = lines.find((l) => refused.has(l.merchandiseId));
    if (bad) return reply({ cartCreate: { cart: null, userErrors: [refusal(bad.merchandiseId)] } });
    const id = `gid://shopify/Cart/${nextCartId++}`;
    carts.set(id, { attributes: variables.input?.attributes ?? [], lines: [] });
    addInto(carts.get(id), lines);
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) {
    return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });
  }
  if (name === 'CartLinesAdd') {
    const bad = variables.lines.find((l) => refused.has(l.merchandiseId));
    if (bad) return reply({ cartLinesAdd: { cart: null, userErrors: [refusal(bad.merchandiseId)] } });
    addInto(carts.get(variables.cartId), variables.lines);
    return reply({ cartLinesAdd: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartLinesUpdate') {
    const c = carts.get(variables.cartId);
    for (const u of variables.lines) c.lines[Number(u.id.split('/line/')[1])].quantity = u.quantity;
    c.lines = c.lines.filter((l) => l.quantity > 0);
    return reply({ cartLinesUpdate: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartLinesRemove') {
    const c = carts.get(variables.cartId);
    c.lines = c.lines.filter((_l, i) => !variables.lineIds.includes(`${variables.cartId}/line/${i}`));
    return reply({ cartLinesRemove: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartAttributesUpdate') {
    if (attrFailures > 0) { attrFailures -= 1; throw new TypeError('Network request failed'); }
    carts.get(variables.cartId).attributes = variables.attributes;
    return reply({ cartAttributesUpdate: { cart: payload(variables.cartId), userErrors: [] } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, parseAttribution, ATTRIBUTION_ATTRIBUTE_KEY } = await import('../dist/index.js');

const CART_KEY = 'shopify:cart-id:v1';
const LINES_KEY = 'shopify:cart-lines:v1';
const ATTR_KEY = 'shopify:cart-attribution:v1';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
  };
}

const cartAttributes = [{ key: 'source_name', value: 'fp-app' }];
let api = null;
let root = null;
function Probe() { api = useShopify(); return null; }

async function mount(storage, extra = {}) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  calls.length = 0;
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, storage, cartAttributes, ...extra },
      React.createElement(Probe),
    ));
  });
  await settle();
}
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 60)); });
const act = async (fn) => { await runAct(fn); await settle(); };

// What Shopify holds, not what the provider thinks.
const serverCart = () => carts.get(api.cart.cart.id);
const serverValue = () => parseAttribution(serverCart().attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY)?.value);
const strip = (a) => JSON.parse(JSON.stringify(a, (k, v) => (k === 't' ? undefined : v)));
const named = (n) => calls.filter((c) => c.name === n);

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

const V1 = 'gid://shopify/ProductVariant/1';
const V2 = 'gid://shopify/ProductVariant/2';
const V3 = 'gid://shopify/ProductVariant/3';
const live = { type: 'live', showId: 'show-1' };
const replay = { type: 'replay', showId: 'show-1' };

console.log('off by default');
{
  const s = memoryStorage();
  await mount(s);
  calls.length = 0;
  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 1, source: live }); });
  await act(async () => { await api.cart.addLines([{ merchandiseId: V2, quantity: 2 }]); });
  await act(async () => { await api.cart.updateLine(api.cart.cart.lines[0].id, 3, undefined, { source: live }); });
  await act(async () => { await api.cart.updateLine(api.cart.cart.lines[0].id, 2); });
  await act(async () => { await api.cart.removeLine(api.cart.cart.lines[1].id); });
  check('no attribute write, no attribute, no extra storage key', () => {
    assert.equal(named('CartAttributesUpdate').length, 0);
    assert.deepEqual(serverCart().attributes, cartAttributes);
    assert.equal(s.map.has(ATTR_KEY), false);
  });
  check('same call sequence as before the feature', () => {
    assert.deepEqual(calls.map((c) => c.name), [
      'CartLinesAdd', 'CartLinesAdd', 'CartLinesUpdate', 'CartLinesUpdate', 'CartLinesRemove',
    ]);
  });
  check('`source` never reaches Shopify', () => {
    assert.deepEqual(named('CartLinesAdd')[0].variables.lines, [{ merchandiseId: V1, quantity: 1 }]);
  });
  await mount(s, { attribution: { enabled: false } });
  await act(async () => { await api.cart.addLine({ merchandiseId: V3, quantity: 1 }); });
  check('enabled: false is the same as off', () => {
    assert.equal(named('CartAttributesUpdate').length, 0);
    assert.equal(s.map.has(ATTR_KEY), false);
  });
}

const on = { attribution: { enabled: true } };

console.log('recording');
{
  const s = memoryStorage();
  await mount(s, on);
  const before = Math.floor(Date.now() / 1000);
  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 2, source: live }); });
  check('addLine with a live source records it, with t in epoch seconds', () => {
    const v = serverValue();
    assert.deepEqual(strip(v), { v: 1, live: { 'show-1': { items: { 1: { n: 2 } } } } });
    assert.ok(v.live['show-1'].t >= before && v.live['show-1'].t <= Math.floor(Date.now() / 1000));
  });
  check('`source` never reaches Shopify', () => {
    assert.deepEqual(named('CartLinesAdd')[0].variables.lines, [{ merchandiseId: V1, quantity: 2 }]);
  });
  check('every other cart attribute is kept', () => {
    assert.deepEqual(serverCart().attributes[0], cartAttributes[0]);
    assert.equal(serverCart().attributes.length, 2);
  });
  check('the provider cart and the restore snapshot carry the value', () => {
    assert.deepEqual(parseAttribution(api.cart.cart.attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY).value), serverValue());
    assert.deepEqual(parseAttribution(s.map.get(ATTR_KEY)), serverValue());
  });

  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 1 }); });
  check('an add Shopify merges into an existing line records the added quantity, not the line total', () => {
    assert.equal(serverCart().lines.length, 1);
    assert.equal(serverCart().lines[0].quantity, 3);
    assert.deepEqual(strip(serverValue()), { v: 1, live: { 'show-1': { items: { 1: { n: 2 } } } }, app: { 1: { n: 1 } } });
  });

  const lineId = api.cart.cart.lines[0].id;
  await act(async () => { await api.cart.updateLine(lineId, 5, undefined, { source: replay }); });
  check('updateLine increase records the delta under opts.source', () => {
    assert.deepEqual(strip(serverValue()).replay, { 'show-1': { items: { 1: { n: 2 } } } });
  });
  await act(async () => { await api.cart.updateLine(lineId, 4); });
  await act(async () => { await api.cart.updateLine(lineId, 6); });
  check('updateLine decrease removes app first; an increase with no source is app', () => {
    assert.deepEqual(strip(serverValue()), {
      v: 1,
      live: { 'show-1': { items: { 1: { n: 2 } } } },
      replay: { 'show-1': { items: { 1: { n: 2 } } } },
      app: { 1: { n: 2 } },
    });
  });
  await act(async () => { await api.cart.updateLine(lineId, 1); });
  check('a bigger decrease goes app → replay → live', () => {
    assert.deepEqual(strip(serverValue()), { v: 1, live: { 'show-1': { items: { 1: { n: 1 } } } } });
  });

  await act(async () => {
    await api.cart.addLine({ merchandiseId: V2, quantity: 2, source: live, attributes: [{ key: '_preauthorized', value: 'true' }] });
  });
  await act(async () => {
    await api.cart.addLine({ merchandiseId: V3, quantity: 1, source: live, attributes: [{ key: '_preauthorized', value: '' }] });
  });
  await act(async () => {
    await api.cart.addLine({ merchandiseId: V3, quantity: 1, source: live, attributes: [{ key: '_preauthorized', value: 'false' }] });
  });
  check("pre-auth lines are 'p' (blank included); 'false' is 'n'; line attributes untouched", () => {
    const items = serverValue().live['show-1'].items;
    assert.deepEqual(items[2], { p: 2 });
    assert.deepEqual(items[3], { n: 1, p: 1 });
    assert.deepEqual(serverCart().lines[1].attributes, [{ key: '_preauthorized', value: 'true' }]);
  });

  const v2Line = api.cart.cart.lines.find((l) => l.merchandise.id === V2).id;
  await act(async () => { await api.cart.removeLine(v2Line); });
  check("removeLine takes the line's whole quantity off its line type", () => {
    assert.equal(serverValue().live['show-1'].items[2], undefined);
    assert.deepEqual(serverValue().live['show-1'].items[3], { n: 1, p: 1 });
  });
}

console.log('addLines');
{
  const s = memoryStorage();
  await mount(s, on);
  await act(async () => {
    await api.cart.addLines([{ merchandiseId: V1, quantity: 1, source: live }, { merchandiseId: V2, quantity: 2, source: replay }]);
  });
  check('a batch records each input under its own source', () => {
    assert.deepEqual(strip(serverValue()), {
      v: 1, live: { 'show-1': { items: { 1: { n: 1 } } } }, replay: { 'show-1': { items: { 2: { n: 2 } } } },
    });
  });
  refused.add(V2);
  await act(async () => {
    await api.cart.addLines([{ merchandiseId: V2, quantity: 1, source: live }, { merchandiseId: V3, quantity: 4, source: live }]);
  });
  refused.clear();
  check('the line-by-line fallback records only the lines that landed', () => {
    assert.deepEqual(strip(serverValue()).live, { 'show-1': { items: { 1: { n: 1 }, 3: { n: 4 } } } });
  });
}

console.log('serialised writes');
{
  const s = memoryStorage();
  await mount(s, on);
  await act(async () => {
    await Promise.all([
      api.cart.addLine({ merchandiseId: V1, quantity: 1, source: live }),
      api.cart.addLine({ merchandiseId: V2, quantity: 1, source: live }),
    ]);
  });
  check('two fast adds: both counted', () => {
    assert.deepEqual(strip(serverValue()).live, { 'show-1': { items: { 1: { n: 1 }, 2: { n: 1 } } } });
  });

  attrFailures = 1;
  let result = null;
  await act(async () => { result = await api.cart.addLine({ merchandiseId: V3, quantity: 2, source: live }); });
  check('a failed attribute write does not fail the add', () => {
    assert.equal(result.ok, true);
    assert.equal(serverValue().live['show-1'].items[3], undefined);
  });
  await act(async () => { await api.cart.addLine({ merchandiseId: V3, quantity: 1, source: replay }); });
  check('the next write carries the counts the failed one lost', () => {
    assert.deepEqual(strip(serverValue()), {
      v: 1,
      live: { 'show-1': { items: { 1: { n: 1 }, 2: { n: 1 }, 3: { n: 2 } } } },
      replay: { 'show-1': { items: { 3: { n: 1 } } } },
    });
  });
}

console.log('flushAttribution');
{
  const s = memoryStorage();
  await mount(s, on);
  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 1, source: live }); });
  calls.length = 0;
  let flushed = null;
  await act(async () => { flushed = await api.cart.flushAttribution(); });
  check('nothing pending: true, without a request', () => {
    assert.equal(flushed, true);
    assert.equal(calls.length, 0);
  });

  attrFailures = 1;
  await act(async () => { await api.cart.addLine({ merchandiseId: V2, quantity: 2, source: live }); });
  check('a failed write leaves the value unsent', () => {
    assert.equal(serverValue().live['show-1'].items[2], undefined);
  });
  calls.length = 0;
  await act(async () => { flushed = await api.cart.flushAttribution(); });
  check('flush writes the pending value once and resolves true', () => {
    assert.equal(flushed, true);
    assert.equal(named('CartAttributesUpdate').length, 1);
    assert.deepEqual(strip(serverValue()).live, { 'show-1': { items: { 1: { n: 1 }, 2: { n: 2 } } } });
  });

  attrFailures = 2;
  await act(async () => { await api.cart.addLine({ merchandiseId: V3, quantity: 1, source: live }); });
  calls.length = 0;
  await act(async () => { flushed = await api.cart.flushAttribution(); });
  check('flush whose retry fails resolves false, without throwing', () => {
    assert.equal(flushed, false);
    assert.equal(named('CartAttributesUpdate').length, 1);
    assert.equal(serverValue().live['show-1'].items[3], undefined);
  });
  await act(async () => { flushed = await api.cart.flushAttribution(); });
  check('a later flush that lands resolves true', () => {
    assert.equal(flushed, true);
    assert.deepEqual(serverValue().live['show-1'].items[3], { n: 1 });
  });

  await mount(memoryStorage());
  calls.length = 0;
  await act(async () => { flushed = await api.cart.flushAttribution(); });
  check('attribution off: true, without a request', () => {
    assert.equal(flushed, true);
    assert.equal(calls.length, 0);
  });
}

console.log('ensureCartAttributes');
{
  const s = memoryStorage();
  await mount(s, on);
  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 1, source: live }); });
  calls.length = 0;
  let ok = null;
  await act(async () => { ok = await api.cart.ensureCartAttributes([{ key: 'source_name', value: 'fp-app' }]); });
  check('every pair already there: true, without a request', () => {
    assert.equal(ok, true);
    assert.equal(calls.length, 0);
  });

  const before = serverCart().attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY);
  await act(async () => {
    ok = await api.cart.ensureCartAttributes([{ key: 'source_name', value: 'checkout' }, { key: 'extra', value: '1' }]);
  });
  check('a different value is overwritten; every other attribute, _apptile_attribution included, is kept', () => {
    assert.equal(ok, true);
    assert.equal(named('CartAttributesUpdate').length, 1);
    assert.deepEqual(serverCart().attributes, [before, { key: 'source_name', value: 'checkout' }, { key: 'extra', value: '1' }]);
    assert.deepEqual(api.cart.cart.attributes, serverCart().attributes);
  });

  calls.length = 0;
  await act(async () => {
    await api.cart.addLine({ merchandiseId: V2, quantity: 1, source: live });
    ok = await api.cart.ensureCartAttributes([{ key: 'source_name', value: 'fp-app' }]);
  });
  check('queued behind a pending attribution write, which lands first and is kept', () => {
    assert.equal(ok, true);
    const writes = named('CartAttributesUpdate');
    assert.equal(writes.length, 2);
    assert.match(writes[0].variables.attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY).value, /"2":\{"n":1\}/);
    assert.deepEqual(writes[1].variables.attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY),
      writes[0].variables.attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY));
    assert.deepEqual(strip(serverValue()).live, { 'show-1': { items: { 1: { n: 1 }, 2: { n: 1 } } } });
    assert.equal(serverCart().attributes.find((a) => a.key === 'source_name').value, 'fp-app');
  });

  await act(async () => { await api.cart.addLine({ merchandiseId: V3, quantity: 1, source: live }); });
  check('the next attribution write builds on the cart it returned', () => {
    assert.equal(serverCart().attributes.find((a) => a.key === 'extra').value, '1');
    assert.equal(serverCart().attributes.find((a) => a.key === 'source_name').value, 'fp-app');
    assert.deepEqual(serverValue().live['show-1'].items[3], { n: 1 });
  });

  attrFailures = 1;
  await act(async () => { ok = await api.cart.ensureCartAttributes([{ key: 'extra', value: '2' }]); });
  check('a failed write resolves false, without throwing', () => {
    assert.equal(ok, false);
    assert.equal(serverCart().attributes.find((a) => a.key === 'extra').value, '1');
  });

  await mount(memoryStorage());
  await act(async () => { ok = await api.cart.ensureCartAttributes([{ key: 'extra', value: '3' }]); });
  check('works with attribution off', () => {
    assert.equal(ok, true);
    assert.deepEqual(serverCart().attributes, [...cartAttributes, { key: 'extra', value: '3' }]);
  });
}

console.log('a guard that rebuilds the input');
{
  const guard = { beforeAdd: (input) => ({ merchandiseId: input.merchandiseId, quantity: input.quantity, attributes: input.attributes }) };
  await mount(memoryStorage(), { ...on, cartGuard: guard });
  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 1, source: live }); });
  await act(async () => { await api.cart.addLines([{ merchandiseId: V2, quantity: 2, source: replay }]); });
  check("keeps the request's source on addLine and addLines", () => {
    assert.deepEqual(strip(serverValue()), {
      v: 1, live: { 'show-1': { items: { 1: { n: 1 } } } }, replay: { 'show-1': { items: { 2: { n: 2 } } } },
    });
  });
}

console.log('other attribute writers');
{
  const existing = '{"v":1,"live":{"old-show":{"t":100,"items":{"1":{"n":1}}}}}';
  carts.set('gid://shopify/Cart/stored', {
    attributes: [{ key: ATTRIBUTION_ATTRIBUTE_KEY, value: existing }, { key: 'other', value: 'x' }],
    lines: [{ merchandiseId: V1, quantity: 1, attributes: [] }],
  });
  const s = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/stored' });
  await mount(s, on);
  check('the cartAttributes backfill keeps _apptile_attribution and every other attribute', () => {
    assert.deepEqual(serverCart().attributes, [
      { key: ATTRIBUTION_ATTRIBUTE_KEY, value: existing }, { key: 'other', value: 'x' }, cartAttributes[0],
    ]);
  });
  await act(async () => { await api.cart.addLine({ merchandiseId: V2, quantity: 1, source: live }); });
  check("the stored cart's value is the base", () => {
    assert.deepEqual(strip(serverValue()).live, { 'old-show': { items: { 1: { n: 1 } } }, 'show-1': { items: { 2: { n: 1 } } } });
    assert.equal(serverValue().live['old-show'].t, 100);
  });

  carts.set('gid://shopify/Cart/other-device', {
    attributes: [{ key: ATTRIBUTION_ATTRIBUTE_KEY, value: '{"v":1,"app":{"9":{"n":3}}}' }],
    lines: [{ merchandiseId: 'gid://shopify/ProductVariant/9', quantity: 3, attributes: [] }],
  });
  await act(async () => { await api.cart.adopt('gid://shopify/Cart/other-device'); });
  check("adopt takes the adopted cart's value as the base (no merge)", () => {
    assert.equal(api.cart.cart.id, 'gid://shopify/Cart/other-device');
    assert.deepEqual(parseAttribution(s.map.get(ATTR_KEY)), { v: 1, app: { 9: { n: 3 } } });
  });
  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 1, source: live }); });
  check('the next change builds on the adopted value', () => {
    assert.deepEqual(strip(serverValue()), { v: 1, live: { 'show-1': { items: { 1: { n: 1 } } } }, app: { 9: { n: 3 } } });
  });
}

console.log('expired cart restore');
{
  const saved = '{"v":1,"live":{"show-1":{"t":500,"items":{"1":{"n":2}}}}}';
  const lines = JSON.stringify([{ merchandiseId: V1, quantity: 2, sellingPlanId: null, attributes: [] }]);
  const s = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/expired', [LINES_KEY]: lines, [ATTR_KEY]: saved });
  await mount(s, on);
  check('the new cart is created with the saved value and the configured attributes', () => {
    const made = named('CartCreate');
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].variables.input.attributes, [...cartAttributes, { key: ATTRIBUTION_ATTRIBUTE_KEY, value: saved }]);
    assert.equal(serverValue().live['show-1'].items[1].n, 2);
  });

  const s2 = memoryStorage({ [CART_KEY]: 'gid://shopify/Cart/expired', [LINES_KEY]: lines, [ATTR_KEY]: saved });
  await mount(s2);
  check('with attribution off, the restore is unchanged', () => {
    assert.deepEqual(named('CartCreate')[0].variables.input.attributes, cartAttributes);
  });

  const s3 = memoryStorage({
    [CART_KEY]: 'gid://shopify/Cart/expired', [LINES_KEY]: lines, [ATTR_KEY]: saved,
    'shopify:checkout-started-cart-id:v1': 'gid://shopify/Cart/expired',
  });
  await mount(s3, on);
  check('a checked-out cart starts fresh: nothing carried', () => {
    assert.deepEqual(named('CartCreate')[0].variables.input.attributes, cartAttributes);
    assert.deepEqual(parseAttribution(s3.map.get(ATTR_KEY)), { v: 1 });
  });

  await act(async () => { await api.cart.addLine({ merchandiseId: V1, quantity: 1, source: live }); });
  await act(async () => { await api.cart.reset(); });
  check('reset starts the new cart from {"v":1}', () => {
    assert.deepEqual(parseAttribution(s3.map.get(ATTR_KEY)), { v: 1 });
    assert.equal(serverValue(), null);
  });
}

await runAct(async () => root.unmount());
console.log(`\n${pass} checks passed`);
