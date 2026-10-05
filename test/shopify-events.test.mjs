// SDK move 7: events that say what changed (`cart`, `changedLines`, `productId`, the signed-in
// `customer`), `useShopifyEvents`, and `showsInCart`. Real ShopifyProvider in jsdom, the Storefront API
// stubbed at `fetch` with an in-memory cart that merges lines like Shopify.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const carts = new Map();
let nextCartId = 1;
const sameLine = (a, b) => a.merchandiseId === b.merchandiseId && JSON.stringify(a.attributes ?? []) === JSON.stringify(b.attributes ?? []);
const payload = (id) => {
  const c = carts.get(id);
  return {
    id, checkoutUrl: 'https://shop/checkout',
    totalQuantity: c.lines.reduce((n, l) => n + l.quantity, 0),
    attributes: c.attributes,
    lines: { nodes: c.lines.map((l, i) => ({
      id: `${id}/line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
      merchandise: { id: l.merchandiseId, title: `Variant ${l.merchandiseId}`, price: money('10.00'), product: { id: `P-${l.merchandiseId}`, title: 'Tee', handle: 'tee' } },
      cost: { totalAmount: money('10.00'), amountPerQuantity: money('10.00') },
    })) },
    cost: { subtotalAmount: money('10.00'), totalAmount: money('10.00') },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};
const addInto = (c, lines) => {
  for (const l of lines) {
    const existing = c.lines.find((x) => sameLine(x, l));
    if (existing) existing.quantity += l.quantity;
    else c.lines.push({ merchandiseId: l.merchandiseId, quantity: l.quantity, attributes: l.attributes ?? [] });
  }
};
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = op?.[1] || op?.[2] || 'unknown';
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  await new Promise((r) => setTimeout(r, 2));
  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') {
    const id = `gid://shopify/Cart/${nextCartId++}`;
    carts.set(id, { attributes: variables.input?.attributes ?? [], lines: [] });
    addInto(carts.get(id), variables.input?.lines ?? []);
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });
  if (name === 'CartLinesAdd') { addInto(carts.get(variables.cartId), variables.lines); return reply({ cartLinesAdd: { cart: payload(variables.cartId), userErrors: [] } }); }
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
  if (name === 'CartAttributesUpdate') { carts.get(variables.cartId).attributes = variables.attributes; return reply({ cartAttributesUpdate: { cart: payload(variables.cartId), userErrors: [] } }); }
  if (name === 'CustomerAccessTokenCreate') return reply({ customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_1', expiresAt: '2030-01-01' }, customerUserErrors: [] } });
  if (name === 'CustomerAccessTokenDelete') return reply({ customerAccessTokenDelete: { deletedAccessToken: 'tok_1', userErrors: [] } });
  if (name === 'CustomerCreate') return reply({ customerCreate: { customer: { id: 'gid://shopify/Customer/8', email: 'new@b.c', firstName: 'New', lastName: null, phone: null, defaultAddress: null, acceptsMarketing: false }, customerUserErrors: [] } });
  if (name === 'Customer' || query.includes('customer(customerAccessToken')) {
    return reply({ customer: { id: 'gid://shopify/Customer/7', email: 'a@b.c', firstName: 'Ann', lastName: 'Bee', phone: null, defaultAddress: null, acceptsMarketing: true } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, useShopifyEvents, showsInCart, ATTRIBUTION_ATTRIBUTE_KEY } = await import('../dist/index.js');

const memoryStorage = () => {
  const map = new Map();
  return { getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => { map.set(k, v); }, removeItem: async (k) => { map.delete(k); } };
};

let api = null;
const fromOnEvent = [];
const fromHook = [];
const order = [];
let hookRenders = 0;
/** Subscribes with a new function every render, as an app's inline listener would. */
function Listener() {
  hookRenders += 1;
  const render = hookRenders;
  useShopifyEvents((event) => { fromHook.push({ ...event, render }); order.push(`hook:${event.type}`); });
  return null;
}
let throwingMounted = true;
function ThrowingListener() {
  useShopifyEvents(() => { throw new Error('listener blew up'); });
  return null;
}
function Probe() { api = useShopify(); return null; }
function Tree({ showListener }) {
  return React.createElement(
    ShopifyProvider,
    {
      config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' },
      storage: memoryStorage(),
      attribution: { enabled: true },
      onEvent: (event) => { fromOnEvent.push(event); order.push(`onEvent:${event.type}`); },
    },
    React.createElement(Probe),
    throwingMounted ? React.createElement(ThrowingListener) : null,
    showListener ? React.createElement(Listener) : null,
  );
}

const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
const act = async (fn) => { await runAct(async () => { await fn(); }); await settle(); };
await runAct(async () => root.render(React.createElement(Tree, { showListener: true })));
await settle();

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };
const take = (list) => list.splice(0, list.length);
const lineOf = (variantId) => api.cart.cart.lines.find((line) => line.merchandise.id === variantId);
take(fromOnEvent); take(fromHook); take(order);

console.log('cart events say what changed');
let landed;
await act(async () => { landed = await api.cart.addLine({ merchandiseId: 'v1', quantity: 1 }); });
check('cart:add carries the cart the write returned and the new line, +1', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.type, 'cart:add');
  assert.equal(event.cart.id, landed.cart.id);
  assert.deepStrictEqual(event.cart.lines.map((line) => line.quantity), [1]);
  assert.equal(event.changedLines.length, 1);
  assert.equal(event.changedLines[0].line.merchandise.id, 'v1');
  assert.equal(event.changedLines[0].line.quantity, 1);
  assert.equal(event.changedLines[0].quantityChange, 1);
});
await act(() => api.cart.addLine({ merchandiseId: 'v1', quantity: 2 }));
check('an add onto a line already in the cart: the line as it is now (3), +2', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.changedLines[0].line.quantity, 3);
  assert.equal(event.changedLines[0].quantityChange, 2);
});
await act(() => api.cart.addLine({ merchandiseId: 'v1', quantity: 1, attributes: [{ key: '_stream_id', value: 'S1' }] }));
check('an add with its own attributes is its own line, and that is the line reported', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.changedLines[0].line.quantity, 1);
  assert.deepStrictEqual(event.changedLines[0].line.attributes, [{ key: '_stream_id', value: 'S1' }]);
});
await act(() => api.cart.addLines([{ merchandiseId: 'v2', quantity: 1 }, { merchandiseId: 'v3', quantity: 2 }, { merchandiseId: 'v2', quantity: 1 }]));
check('addLines: each line once, two inputs that landed on one line counted together', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.type, 'cart:add');
  assert.deepStrictEqual(event.changedLines.map((change) => [change.line.merchandise.id, change.line.quantity, change.quantityChange]), [['v2', 2, 2], ['v3', 2, 2]]);
});
await act(() => api.cart.updateLine(lineOf('v3').id, 5));
check('cart:update: the line as it is now, with the signed change', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.type, 'cart:update');
  assert.equal(event.changedLines[0].line.quantity, 5);
  assert.equal(event.changedLines[0].quantityChange, 3);
});
await act(() => api.cart.updateLine(lineOf('v3').id, 0));
check('cart:update to 0: the line as it was, and minus all of it', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.changedLines[0].line.merchandise.id, 'v3');
  assert.equal(event.changedLines[0].line.quantity, 5);
  assert.equal(event.changedLines[0].quantityChange, -5);
  assert.equal(event.cart.lines.some((line) => line.merchandise.id === 'v3'), false);
});
const v2Line = lineOf('v2');
await act(() => api.cart.removeLine(v2Line.id));
check('cart:remove: the line as it was, minus its whole quantity, and the cart without it', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.type, 'cart:remove');
  assert.equal(event.changedLines[0].line.id, v2Line.id);
  assert.equal(event.changedLines[0].quantityChange, -2);
  assert.equal(event.cart.lines.some((line) => line.id === v2Line.id), false);
});
await act(() => api.cart.addLine({ merchandiseId: 'v9', quantity: 5, maxQuantity: 1 }));
check('an alert carries no cart and no lines: only the three cart writes do', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.type, 'cart:stockLimit');
  assert.equal('cart' in event, false);
  assert.equal('changedLines' in event, false);
});

console.log('wishlist events say which product');
await act(() => api.wishlist.add('gid://shopify/Product/P9'));
await act(() => api.wishlist.toggle('gid://shopify/Product/P9'));
await act(() => api.wishlist.toggle({ id: 'gid://shopify/Product/P10', title: 'Hat', handle: 'hat', featuredImage: null, priceRange: { min: money('1'), max: money('1') }, variants: [], images: [] }));
await act(() => api.wishlist.remove('gid://shopify/Product/P10'));
await act(() => api.wishlist.remove('gid://shopify/Product/not-saved'));
check('add, toggle off, toggle on (a product object), remove; nothing for a product not saved', () => {
  assert.deepStrictEqual(take(fromOnEvent).map((event) => [event.type, event.productId]), [
    ['wishlist:add', 'gid://shopify/Product/P9'],
    ['wishlist:remove', 'gid://shopify/Product/P9'],
    ['wishlist:add', 'gid://shopify/Product/P10'],
    ['wishlist:remove', 'gid://shopify/Product/P10'],
  ]);
});

console.log('a sign-in says who');
await act(() => api.customer.login('a@b.c', 'pw'));
check('auth:loginSuccess carries the customer and how they signed in', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.type, 'auth:loginSuccess');
  assert.equal(event.customer.id, 'gid://shopify/Customer/7');
  assert.equal(event.customer.email, 'a@b.c');
  assert.equal(event.sessionKind, 'password');
});
await act(() => api.customer.logout());
check('auth:logout carries no customer', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.type, 'auth:logout');
  assert.equal('customer' in event, false);
});
await act(() => api.customer.signup({ email: 'new@b.c', password: 'pw', firstName: 'New' }));
check('a signup announces the sign-in with the new customer', () => {
  const events = take(fromOnEvent);
  assert.deepStrictEqual(events.map((event) => event.type), ['auth:signup', 'auth:loginSuccess']);
  assert.equal(events[1].customer.id, 'gid://shopify/Customer/8');
});

console.log('failures keep their error where it was');
await act(() => api.checkout.reportOrderPlaced({ orderNumber: 1001 }));
check('checkout:orderPlaced still carries its details as `error`', () => {
  const [event] = take(fromOnEvent).filter((e) => e.type === 'checkout:orderPlaced');
  assert.deepStrictEqual(event.error, { orderNumber: 1001 });
});
await act(async () => { api.checkout.reportPaymentFailed(new Error('declined')); });
check('checkout:paymentFailed carries the error', () => {
  const [event] = take(fromOnEvent);
  assert.equal(event.error.message, 'declined');
});

console.log('useShopifyEvents');
check('the hook heard the same events as onEvent, each right after it', () => {
  const pairs = order.filter((entry) => entry.startsWith('onEvent:') || entry.startsWith('hook:'));
  for (let i = 0; i < pairs.length; i += 2) {
    assert.equal(pairs[i].replace('onEvent:', ''), pairs[i + 1].replace('hook:', ''));
    assert.ok(pairs[i].startsWith('onEvent:') && pairs[i + 1].startsWith('hook:'));
  }
  assert.ok(pairs.length >= 30);
});
check('a listener that throws costs nothing: every write landed and the next listener still heard', () => {
  assert.ok(fromHook.some((event) => event.type === 'cart:remove'));
});
check('the listener read is the latest render\'s', () => {
  const renders = fromHook.map((event) => event.render);
  assert.equal(renders[renders.length - 1], hookRenders);
});
take(fromHook);
throwingMounted = false;
await runAct(async () => root.render(React.createElement(Tree, { showListener: false })));
await settle();
await act(() => api.cart.addLine({ merchandiseId: 'v4', quantity: 1 }));
check('an unmounted listener hears nothing more; onEvent still does', () => {
  assert.equal(fromHook.length, 0);
  assert.equal(take(fromOnEvent).filter((event) => event.type === 'cart:add').length, 1);
});
await runAct(async () => root.unmount());

console.log('without onEvent');
const heard = [];
function OnlyHook() { useShopifyEvents((event) => heard.push(event.type)); api = useShopify(); return null; }
const root2 = createRoot(document.createElement('div'));
await runAct(async () => root2.render(React.createElement(ShopifyProvider, { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, storage: memoryStorage() }, React.createElement(OnlyHook))));
await settle();
await act(() => api.cart.addLine({ merchandiseId: 'v5', quantity: 1 }));
check('a provider with no onEvent still tells useShopifyEvents', () => assert.deepStrictEqual(heard, ['cart:add']));
await runAct(async () => root2.unmount());

console.log('showsInCart');
const cartWith = (value) => ({ attributes: [{ key: 'source_name', value: 'app' }, { key: ATTRIBUTION_ATTRIBUTE_KEY, value }] });
check('the live and replay shows, by streaming id', () => {
  const value = JSON.stringify({ v: 1, live: { A: { t: 1, items: { 11: { n: 1 } } } }, replay: { B: { t: 2, items: { 12: { p: 1 } } }, C: { t: 3, items: { 13: { n: 2 } } } }, app: { 14: { n: 1 } } });
  assert.deepStrictEqual(showsInCart(cartWith(value)), { live: ['A'], replay: ['B', 'C'] });
});
check('a show whose units all left the cart is not listed', () => {
  const value = JSON.stringify({ v: 1, live: { A: { t: 1, items: {} }, D: { t: 1, items: { 11: { n: 0 } } } } });
  assert.deepStrictEqual(showsInCart(cartWith(value)), { live: [], replay: [] });
});
check('no attribution, an unreadable one, or no cart: no shows', () => {
  assert.deepStrictEqual(showsInCart({ attributes: [] }), { live: [], replay: [] });
  assert.deepStrictEqual(showsInCart(cartWith('not json')), { live: [], replay: [] });
  assert.deepStrictEqual(showsInCart(cartWith(JSON.stringify({ v: 2, live: { A: { t: 1, items: { 1: { n: 1 } } } } }))), { live: [], replay: [] });
  assert.deepStrictEqual(showsInCart(null), { live: [], replay: [] });
  assert.deepStrictEqual(showsInCart(undefined), { live: [], replay: [] });
});

console.log(`\n${pass} checks passed`);
process.exit(0);
