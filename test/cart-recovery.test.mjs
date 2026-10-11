// A stored cart Shopify no longer has (ordered, or expired), found while the app runs. Real
// ShopifyProvider in jsdom, Storefront API stubbed at `fetch`. A write to a gone cart answers as
// Shopify does (2026-07): HTTP 200, a `cartId` INVALID userError, and a brand-new cart that must not
// be used; reading it answers `{cart: null}`.
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
// Carts Shopify handed back on a write to a gone cart. None may ever become the app's cart.
const phantoms = new Set();
// Carts whose writes are refused for their id while a read still finds them.
const refusedButReadable = new Set();
// CartCreate calls that fail at the transport before Shopify answers.
let createOutages = 0;
// When set, the next CartCreate waits for it.
let createGate = null;
// Variants Shopify refuses to add (no longer for sale).
const refusedVariants = new Set();
// A cart that vanishes right after its next add lands (the reply still shows the add).
let vanishAfterNextAdd = null;
const calls = [];

const missing = { field: ['cartId'], message: 'The specified cart does not exist.', code: 'INVALID' };

const payload = (id) => {
  const c = carts.get(id);
  return {
    id,
    checkoutUrl: 'https://shop/checkout',
    totalQuantity: c.lines.reduce((n, l) => n + l.quantity, 0),
    attributes: c.attributes,
    buyerIdentity: c.buyerIdentity ?? { countryCode: 'US', email: null, phone: null },
    lines: { nodes: c.lines.map((l, i) => ({
      id: `${id}/line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
      sellingPlanAllocation: null,
      merchandise: { id: l.merchandiseId }, cost: { totalAmount: money, amountPerQuantity: money },
    })) },
    cost: { subtotalAmount: money, totalAmount: money },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};

const mint = (lines = [], attributes = []) => {
  const id = `gid://shopify/Cart/${nextCartId++}`;
  carts.set(id, { attributes, lines: lines.map((l) => ({ ...l })) });
  return id;
};

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
    if (createGate) { const gate = createGate; createGate = null; await gate; }
    if (createOutages > 0) { createOutages -= 1; throw new TypeError('Network request failed'); }
    const id = mint(variables.input?.lines ?? [], variables.input?.attributes ?? []);
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet') return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });

  const field = name[0].toLowerCase() + name.slice(1);
  if (variables.cartId && (!carts.has(variables.cartId) || refusedButReadable.has(variables.cartId))) {
    const phantom = mint(name === 'CartLinesAdd' ? variables.lines : []);
    phantoms.add(phantom);
    return reply({ [field]: { cart: payload(phantom), userErrors: [missing] } });
  }
  const c = carts.get(variables.cartId);
  if (name === 'CartLinesAdd') {
    const bad = variables.lines.find((l) => refusedVariants.has(l.merchandiseId));
    if (bad) {
      return reply({ cartLinesAdd: { cart: null, userErrors: [{ field: ['lines'], message: 'No longer available.', code: 'MERCHANDISE_NOT_FOUND' }] } });
    }
    c.lines.push(...variables.lines.map((l) => ({ ...l })));
    if (vanishAfterNextAdd === variables.cartId) {
      vanishAfterNextAdd = null;
      const landed = payload(variables.cartId);
      carts.delete(variables.cartId);
      return reply({ cartLinesAdd: { cart: landed, userErrors: [] } });
    }
  }
  if (name === 'CartLinesUpdate') {
    for (const u of variables.lines) c.lines[Number(u.id.split('/line/')[1])].quantity = u.quantity;
  }
  if (name === 'CartLinesRemove') {
    c.lines = c.lines.filter((_l, i) => !variables.lineIds.includes(`${variables.cartId}/line/${i}`));
  }
  if (name === 'CartAttributesUpdate') c.attributes = variables.attributes;
  if (name === 'CartBuyerIdentityUpdate') c.buyerIdentity = { countryCode: 'US', email: variables.buyerIdentity.email ?? null, phone: null };
  return reply({ [field]: { cart: payload(variables.cartId), userErrors: [] } });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, isMissingCartError, toLineSnapshot, parseAttribution, ATTRIBUTION_ATTRIBUTE_KEY } =
  await import('../dist/index.js');
const T = await import('../dist/types.js');

const CART_KEY = 'shopify:cart-id:v1';
const CHECKOUT_KEY = 'shopify:checkout-started-cart-id:v1';
const ACTIVITY_KEY = 'shopify:cart-activity:v1';
const ATTR_KEY = 'shopify:cart-attribution:v1';
const ELEVEN_DAYS = 11 * 24 * 60 * 60 * 1000;

// Logs every write so a test can see what was stored in what order.
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const log = [];
  return {
    map, log,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => { log.push(['set', k, v]); map.set(k, v); },
    removeItem: async (k) => { log.push(['remove', k]); map.delete(k); },
  };
}

const cartAttributes = [{ key: '_app', value: 'fp' }];
let api = null;
let root = null;
let events = [];
function Probe() { api = useShopify(); return null; }

async function mount(storage, extra = {}) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  events = [];
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      {
        config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', country: 'US' },
        storage, cartAttributes, onEvent: (e) => events.push(e), ...extra,
      },
      React.createElement(Probe),
    ));
  });
  await runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
  calls.length = 0;
}

const named = (name) => calls.filter((c) => c.name === name);
const recovered = () => events.filter((e) => e.type === 'cart:recovered');
const variantsOf = (cart) => toLineSnapshot(cart).map((l) => l.merchandiseId);
const writesTo = (id) => calls.filter((c) => c.variables?.cartId === id);

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

const shirt = { merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 2, attributes: [{ key: '_stream_id', value: 's-42' }] };
const hat = { merchandiseId: 'gid://shopify/ProductVariant/2', quantity: 1 };
const sock = { merchandiseId: 'gid://shopify/ProductVariant/3', quantity: 3 };

/**
 * A mounted cart holding `lines`, then made to vanish in Shopify. `idle`: its last use is put past the
 * ten-day expiry, so it is rebuilt; otherwise it was used just now and comes back empty.
 */
async function deadCart(storage, lines, { markCheckout = false, idle = false, extra } = {}) {
  await mount(storage, extra);
  if (lines.length) await runAct(async () => { await api.cart.addLines(lines); });
  if (markCheckout) await runAct(async () => { await api.checkout.reportCheckoutStarted(); });
  const id = api.cart.cart.id;
  if (idle) storage.map.set(ACTIVITY_KEY, JSON.stringify({ cartId: id, at: Date.now() - ELEVEN_DAYS }));
  carts.delete(id);
  calls.length = 0;
  storage.log.length = 0;
  events = [];
  return id;
}

console.log('isMissingCartError');
const err = (...errors) => new T.ShopifyError('cartLinesAdd failed', errors);
check('a cartId INVALID userError, in any language', () => {
  assert.equal(isMissingCartError(err(missing)), true);
  assert.equal(isMissingCartError(err({ field: ['cartId'], message: "Le panier spécifié n'existe pas.", code: 'INVALID' })), true);
});
check('false for out of stock, INVALID on another field, another code, no field, transport, plain, nothing', () => {
  assert.equal(isMissingCartError(err({ field: ['lines', '0', 'quantity'], message: 'The product is out of stock.', code: 'MERCHANDISE_OUT_OF_STOCK' })), false);
  assert.equal(isMissingCartError(err({ field: ['lines', '0', 'merchandiseId'], message: 'The merchandise does not exist.', code: 'INVALID' })), false);
  assert.equal(isMissingCartError(err({ field: ['cartId'], message: 'The specified cart does not exist.' })), false);
  assert.equal(isMissingCartError(err({ field: null, message: 'The specified cart does not exist.', code: 'INVALID' })), false);
  assert.equal(isMissingCartError(new TypeError('Network request failed')), false);
  assert.equal(isMissingCartError(new Error('The specified cart does not exist.')), false);
  assert.equal(isMissingCartError(null), false);
});

console.log('add on a gone cart used recently');
const s1 = memoryStorage();
const dead1 = await deadCart(s1, [shirt, hat]);
let result1;
await runAct(async () => { result1 = await api.cart.addLine(sock); });
check('one read confirms it is gone, then an EMPTY cart is made and the add lands on it', () => {
  assert.equal(result1.ok, true);
  assert.deepEqual(calls.map((c) => c.name), ['CartLinesAdd', 'CartGet', 'CartCreate', 'CartLinesAdd']);
  assert.equal(named('CartGet')[0].variables.id, dead1);
  assert.equal(named('CartCreate')[0].variables.input.lines, undefined);
  assert.deepEqual(named('CartCreate')[0].variables.input.attributes, cartAttributes);
  assert.deepEqual(variantsOf(api.cart.cart), [sock.merchandiseId]);
});
check('the new cart is stored, and the cart Shopify sent with the error is not used', () => {
  assert.equal(s1.map.get(CART_KEY), api.cart.cart.id);
  assert.notEqual(api.cart.cart.id, dead1);
  assert.equal(phantoms.has(api.cart.cart.id), false);
});
check('cart:recovered: which cart died, which replaced it, reason missing', () => {
  const [e] = recovered();
  assert.equal(recovered().length, 1);
  assert.equal(e.severity, 'info');
  assert.equal(e.message, undefined);
  assert.deepEqual(e.recovery, { deadCartId: dead1, newCartId: api.cart.cart.id, reason: 'missing' });
  assert.equal(e.cart.id, api.cart.cart.id);
  assert.deepEqual(events.map((x) => x.type), ['cart:recovered', 'cart:add']);
});

console.log('add on a gone cart idle past the ten-day expiry');
const s2 = memoryStorage();
const dead2 = await deadCart(s2, [shirt, hat], { idle: true });
await runAct(async () => { await api.cart.addLine(sock); });
check('it is rebuilt from the snapshot, then the add lands; reason expired', () => {
  assert.deepEqual(variantsOf(api.cart.cart), [shirt.merchandiseId, hat.merchandiseId, sock.merchandiseId]);
  assert.deepEqual(api.cart.cart.lines[0].attributes, shirt.attributes);
  assert.deepEqual(recovered()[0].recovery, { deadCartId: dead2, newCartId: api.cart.cart.id, reason: 'expired' });
});

console.log('add on a gone cart marked as gone to checkout');
const s3 = memoryStorage();
const dead3 = await deadCart(s3, [shirt, hat], { markCheckout: true, idle: true });
let added3;
await runAct(async () => { added3 = await api.cart.addLines([sock]); });
check('the mark wins over the expiry: empty, nothing bought comes back, the add lands', () => {
  assert.equal(named('CartCreate')[0].variables.input.lines, undefined);
  assert.deepEqual(variantsOf(added3), [sock.merchandiseId]);
  assert.equal(phantoms.has(api.cart.cart.id), false);
  assert.deepEqual(recovered()[0].recovery, { deadCartId: dead3, newCartId: api.cart.cart.id, reason: 'ordered' });
  assert.equal(events.some((e) => e.type === 'checkout:orderPlaced'), false);
});
check('the mark is cleared only after the new cart is stored', () => {
  const stored = s3.log.findIndex(([op, k]) => op === 'set' && k === CART_KEY);
  const cleared = s3.log.findIndex(([op, k]) => op === 'remove' && k === CHECKOUT_KEY);
  assert.ok(stored >= 0 && cleared > stored);
  assert.equal(s3.map.has(CHECKOUT_KEY), false);
});

console.log('two adds at once');
const s4 = memoryStorage();
await deadCart(s4, [shirt]);
await runAct(async () => { await Promise.all([api.cart.addLine(hat), api.cart.addLine(sock)]); });
check('one replacement, and both adds land on it', () => {
  assert.equal(named('CartCreate').length, 1);
  assert.equal(recovered().length, 1);
  assert.deepEqual(new Set(variantsOf(api.cart.cart)), new Set([hat.merchandiseId, sock.merchandiseId]));
  assert.equal(events.filter((e) => e.type === 'cart:add').length, 2);
});

console.log('a callback made before the replacement');
const s5 = memoryStorage();
const dead5 = await deadCart(s5, [shirt], { idle: true });
const staleSetBuyer = api.cart.setBuyerIdentity;
const staleDiscounts = api.cart.applyDiscountCodes;
let refreshed5;
await runAct(async () => { refreshed5 = await api.cart.refresh(); });
calls.length = 0;
await runAct(async () => { await staleSetBuyer({ email: 'a@b.co', countryCode: 'US' }); });
await runAct(async () => { await staleDiscounts(['TEN']); });
check('setBuyerIdentity and a discount from before refresh() replaced the cart land on the new cart', () => {
  assert.notEqual(refreshed5.id, dead5);
  assert.deepEqual(named('CartBuyerIdentityUpdate').map((c) => c.variables.cartId), [refreshed5.id]);
  assert.deepEqual(named('CartDiscountCodesUpdate').map((c) => c.variables.cartId), [refreshed5.id]);
  assert.equal(writesTo(dead5).length, 0);
});

console.log('the cart changes while a replacement is being made');
for (const [label, change] of [
  ['reset', async () => { await api.cart.reset(); }],
  ['adopt', async (adoptId) => { await api.cart.adopt(adoptId); }],
]) {
  const s = memoryStorage();
  await deadCart(s, [shirt]);
  const adoptId = mint([hat]);
  let release;
  createGate = new Promise((r) => { release = r; });
  let adding;
  await runAct(async () => {
    adding = api.cart.addLine(sock);
    await new Promise((r) => setTimeout(r, 10));
  });
  await runAct(async () => { await change(adoptId); });
  const changedTo = api.cart.cart.id;
  await runAct(async () => { release(); await adding; });
  check(`${label} meanwhile: the replacement is dropped, no event, and the add lands on the cart after the ${label}`, () => {
    assert.equal(api.cart.cart.id, changedTo);
    assert.equal(s.map.get(CART_KEY), changedTo);
    assert.equal(recovered().length, 0);
    assert.ok(variantsOf(api.cart.cart).includes(sock.merchandiseId));
  });
}

console.log('the checkout steps an app runs on a gone cart');
// 0.9 has no prepare(): an app reads the cart again, attaches the shopper, labels the cart and reports
// the start itself, with callbacks from the render before the read.
const s6 = memoryStorage();
await deadCart(s6, [shirt, hat], { idle: true });
const { setBuyerIdentity, ensureCartAttributes } = api.cart;
const { reportCheckoutStarted } = api.checkout;
let read6;
await runAct(async () => {
  read6 = await api.cart.refresh();
  await setBuyerIdentity({ email: 'a@b.co', customerAccessToken: 'token' });
  await ensureCartAttributes([{ key: '_checkout', value: '1' }]);
  await reportCheckoutStarted();
});
check('idle past the expiry: rebuilt, then every step lands on the new cart and checkout is marked for it', () => {
  assert.deepEqual(variantsOf(read6), [shirt.merchandiseId, hat.merchandiseId]);
  assert.equal(api.cart.cart.id, read6.id);
  assert.deepEqual(named('CartBuyerIdentityUpdate').map((c) => c.variables.cartId), [read6.id]);
  assert.deepEqual(named('CartAttributesUpdate').map((c) => c.variables.cartId), [read6.id]);
  assert.equal(s6.map.get(CHECKOUT_KEY), read6.id);
});
const s7 = memoryStorage();
await deadCart(s7, [shirt]);
let read7;
await runAct(async () => { read7 = await api.cart.refresh(); });
check('used recently: the read comes back as an empty cart, nothing to check out', () => {
  assert.equal(read7.lines.length, 0);
  assert.equal(api.cart.cart.lines.length, 0);
});

console.log('addLines when the replacement cannot be made');
const s8 = memoryStorage();
const dead8 = await deadCart(s8, []);
createOutages = 1;
let addError8;
await runAct(async () => { await api.cart.addLines([hat, sock]).catch((e) => { addError8 = e; }); });
check('the original error, and no line-by-line retry', () => {
  assert.equal(isMissingCartError(addError8), true);
  assert.equal(named('CartLinesAdd').length, 1);
  assert.equal(named('CartCreate').length, 1);
  assert.equal(s8.map.get(CART_KEY), dead8);
});
await runAct(async () => { await new Promise((r) => setTimeout(r, 20)); });
check('nothing goes on retrying by itself', () => {
  assert.equal(named('CartCreate').length, 1);
  assert.equal(named('CartLinesAdd').length, 1);
});
await runAct(async () => { await api.cart.addLine(sock); });
check('the next add tries again and lands', () => {
  assert.equal(named('CartCreate').length, 2);
  assert.deepEqual(variantsOf(api.cart.cart), [sock.merchandiseId]);
});

console.log('addLines: the cart vanishes during the line-by-line retry');
const s8b = memoryStorage();
await mount(s8b);
const dying = api.cart.cart.id;
const gone = { merchandiseId: 'gid://shopify/ProductVariant/9', quantity: 1 };
refusedVariants.add(gone.merchandiseId);
vanishAfterNextAdd = dying;
let addError8b;
await runAct(async () => { await api.cart.addLines([hat, sock, gone]).catch((e) => { addError8b = e; }); });
refusedVariants.clear();
check('the gone-cart error stops the retry: the dead cart is never stored back over its replacement', () => {
  assert.equal(isMissingCartError(addError8b), true);
  assert.equal(recovered().length, 1);
  assert.notEqual(api.cart.cart.id, dying);
  assert.equal(api.cart.cart.id, recovered()[0].recovery.newCartId);
  assert.equal(s8b.map.get(CART_KEY), api.cart.cart.id);
  assert.equal(named('CartLinesAdd').length, 3);
  assert.equal(events.some((e) => e.type === 'cart:add'), false);
});

console.log('a refusal for the cart id while a read still finds the cart');
const s9 = memoryStorage();
await mount(s9);
const alive = api.cart.cart.id;
refusedButReadable.add(alive);
let addError9;
await runAct(async () => { await api.cart.addLine(sock).catch((e) => { addError9 = e; }); });
refusedButReadable.delete(alive);
check('nothing is replaced and the error is thrown', () => {
  assert.equal(isMissingCartError(addError9), true);
  assert.equal(named('CartGet').length, 1);
  assert.equal(named('CartCreate').length, 0);
  assert.equal(api.cart.cart.id, alive);
  assert.equal(recovered().length, 0);
});

console.log('rate limit');
const s10 = memoryStorage();
await mount(s10);
const outcomes = [];
for (let i = 0; i < 4; i += 1) {
  carts.delete(api.cart.cart.id);
  await runAct(async () => {
    outcomes.push(await api.cart.addLine(sock).then(() => 'landed', (e) => (isMissingCartError(e) ? 'gone' : 'other')));
  });
}
check('three replacements a minute; the fourth write gets its own error', () => {
  assert.deepEqual(outcomes, ['landed', 'landed', 'landed', 'gone']);
  assert.equal(named('CartCreate').length, 3);
  assert.equal(recovered().length, 3);
});

console.log('refresh');
const s11 = memoryStorage();
const dead11 = await deadCart(s11, [shirt, hat], { idle: true });
let refreshed11;
await runAct(async () => { refreshed11 = await api.cart.refresh(); });
check('a null read replaces the cart (no second read), stores it and returns it', () => {
  assert.equal(named('CartGet').length, 1);
  assert.deepEqual(variantsOf(refreshed11), [shirt.merchandiseId, hat.merchandiseId]);
  assert.equal(s11.map.get(CART_KEY), refreshed11.id);
  assert.deepEqual(recovered()[0].recovery, { deadCartId: dead11, newCartId: refreshed11.id, reason: 'expired' });
});
const s12 = memoryStorage();
const dead12 = await deadCart(s12, [shirt]);
createOutages = 1;
let refreshed12 = 'unset';
await runAct(async () => { refreshed12 = await api.cart.refresh(); });
check('a replacement that fails leaves refresh answering null, as before', () => {
  assert.equal(refreshed12, null);
  assert.equal(s12.map.get(CART_KEY), dead12);
});

console.log('remove on a gone cart');
const s13 = memoryStorage();
const dead13 = await deadCart(s13, [shirt, hat], { idle: true });
let removeError13;
await runAct(async () => { await api.cart.removeLine(api.cart.cart.lines[1].id).catch((e) => { removeError13 = e; }); });
check('replaced, then the original error, not retried', () => {
  assert.equal(isMissingCartError(removeError13), true);
  assert.deepEqual(named('CartLinesRemove').map((c) => c.variables.cartId), [dead13]);
  assert.equal(named('CartCreate').length, 1);
  assert.equal(events.some((e) => e.type === 'cart:remove'), false);
});
check('idle past the expiry, the removed line comes back with the rebuild (a second tap removes it)', () => {
  assert.deepEqual(variantsOf(api.cart.cart), [shirt.merchandiseId, hat.merchandiseId]);
});
await runAct(async () => { await api.cart.removeLine(api.cart.cart.lines[1].id); });
check('and that second remove lands on the new cart', () => {
  assert.deepEqual(variantsOf(api.cart.cart), [shirt.merchandiseId]);
});

console.log('the other writes: replaced, original error, not retried');
for (const [label, mutation, write] of [
  ['buyer identity', 'CartBuyerIdentityUpdate', () => api.cart.setBuyerIdentity({ email: 'a@b.co' })],
  ['discount codes', 'CartDiscountCodesUpdate', () => api.cart.applyDiscountCodes(['TEN'])],
  ['note', 'CartNoteUpdate', () => api.cart.updateNote('gift wrap')],
]) {
  const s = memoryStorage();
  const dead = await deadCart(s, [shirt]);
  let failure;
  await runAct(async () => { await write().catch((e) => { failure = e; }); });
  check(label, () => {
    assert.equal(isMissingCartError(failure), true);
    assert.deepEqual(named(mutation).map((c) => c.variables.cartId), [dead]);
    assert.equal(recovered().length, 1);
    assert.equal(s.map.get(CART_KEY), api.cart.cart.id);
  });
}
const s14 = memoryStorage();
await deadCart(s14, [shirt]);
let ensured;
await runAct(async () => { ensured = await api.cart.ensureCartAttributes([{ key: 'x', value: '1' }]); });
check('ensureCartAttributes: replaced, false, no throw', () => {
  assert.equal(ensured, false);
  assert.equal(recovered().length, 1);
});

console.log('attribution on');
const live = { type: 'live', showId: 'show-1' };
const s15 = memoryStorage();
const dead15 = await deadCart(s15, [{ ...hat, source: live }], { idle: true, extra: { attribution: { enabled: true } } });
const savedAttribution = s15.map.get(ATTR_KEY);
await runAct(async () => { await api.cart.addLine({ ...sock, source: live }); });
await runAct(async () => { await api.cart.flushAttribution(); });
check('the rebuilt cart starts from the saved value, and the retried add is recorded on it', () => {
  assert.ok(savedAttribution);
  const create = named('CartCreate')[0].variables.input.attributes;
  assert.deepEqual(create.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY).value, savedAttribution);
  const value = parseAttribution(carts.get(api.cart.cart.id).attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY).value);
  const items = Object.values(value.live['show-1'].items);
  assert.equal(items.reduce((n, item) => n + item.n, 0), hat.quantity + sock.quantity);
  assert.equal(writesTo(dead15).filter((c) => c.name === 'CartAttributesUpdate').length, 0);
});
const s16 = memoryStorage();
await deadCart(s16, [{ ...hat, source: live }], { extra: { attribution: { enabled: true } } });
await runAct(async () => { await api.cart.addLine({ ...sock, source: live }); });
await runAct(async () => { await api.cart.flushAttribution(); });
check('an empty replacement carries no old attribution: only the new add', () => {
  const value = parseAttribution(carts.get(api.cart.cart.id).attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY).value);
  const items = Object.values(value.live['show-1'].items);
  assert.equal(items.reduce((n, item) => n + item.n, 0), sock.quantity);
});

await runAct(async () => root.unmount());
console.log(`\n${pass} checks passed`);
