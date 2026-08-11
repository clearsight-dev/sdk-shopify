// Renders the real ShopifyProvider in jsdom with the Storefront API stubbed at
// `fetch`, and asserts the events a host would toast on.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';


const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── Storefront API stub ─────────────────────────────────────────────────────
// One handler per operation the provider touches. `scenario` flips behaviour so
// one render can exercise success and refusal paths.
const scenario = { addFails: null, loginFails: null };
let cartLines = [];

const money = { amount: '10.00', currencyCode: 'USD' };
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1',
  checkoutUrl: 'https://shop/checkout',
  totalQuantity: cartLines.reduce((n, l) => n + l.quantity, 0),
  lines: { nodes: cartLines.map((l, i) => ({
    id: `gid://line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
    merchandise: { id: l.merchandiseId }, cost: { totalAmount: money, amountPerQuantity: money },
  })) },
  cost: { subtotalAmount: money, totalAmount: money },
  discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
});

const calls = [];
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = (op?.[1] || op?.[2] || 'unknown');
  calls.push(name);
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } },
                   localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate')  { cartLines = []; return reply({ cartCreate: { cart: cartPayload(), userErrors: [] } }); }
  if (name === 'CartGet' || query.includes('cart(id:')) return reply({ cart: cartPayload() });
  if (name === 'CartLinesAdd') {
    if (scenario.addFails) {
      return reply({ cartLinesAdd: { cart: null, userErrors: [scenario.addFails] } });
    }
    // Merge like Shopify does — same merchandise AND same attributes is one line,
    // otherwise the line count drifts from what the real API would report.
    for (const l of variables.lines) {
      const key = (x) => `${x.merchandiseId}|${JSON.stringify(x.attributes ?? [])}`;
      const existing = cartLines.find((x) => key(x) === key(l));
      if (existing) existing.quantity += l.quantity;
      else cartLines.push({ ...l });
    }
    return reply({ cartLinesAdd: { cart: cartPayload(), userErrors: [] } });
  }
  if (name === 'CartLinesRemove') {
    cartLines = cartLines.filter((_l, i) => !variables.lineIds.includes(`gid://line/${i}`));
    return reply({ cartLinesRemove: { cart: cartPayload(), userErrors: [] } });
  }
  if (name === 'CustomerAccessTokenCreate') {
    if (scenario.loginFails) {
      return reply({ customerAccessTokenCreate: { customerAccessToken: null, customerUserErrors: [scenario.loginFails] } });
    }
    return reply({ customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_1', expiresAt: '2030-01-01' }, customerUserErrors: [] } });
  }
  if (name === 'CustomerAccessTokenDelete') {
    return reply({ customerAccessTokenDelete: { deletedAccessToken: 'tok_1', userErrors: [] } });
  }
  if (name === 'CustomerRecover') return reply({ customerRecover: { customerUserErrors: [] } });
  if (name === 'Customer' || query.includes('customer(customerAccessToken')) {
    return reply({ customer: { id: 'gid://customer/1', email: 'a@b.c', firstName: 'A', lastName: 'B',
                               phone: null, defaultAddress: null, acceptsMarketing: false } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
// `act` moved to the react package in 18.3; fall back for older peers.
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;

const { ShopifyProvider, useShopify } = await import('../dist/index.js');

const events = [];
let api = null;
function Probe() {
  api = useShopify();
  return null;
}

const root = createRoot(document.getElementById('root'));
await runAct(async () => {
  root.render(React.createElement(
    ShopifyProvider,
    {
      config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' },
      cartPolicy: { maxLineItems: 2 },
      messages: { 'cart.added': 'Added to bag' },
      onEvent: (e) => events.push(e),
    },
    React.createElement(Probe),
  ));
});
await runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };
const take = () => { const out = events.splice(0, events.length); return out; };

console.log('provider');
check('mounts ready with a cart', () => {
  assert.equal(api.ready, true);
  assert.equal(api.error, null);
  assert.equal(api.cart.maxLineItems, 2);
});

console.log('cart alerts');
let result;
await runAct(async () => { result = await api.cart.addLine({ merchandiseId: 'v1', quantity: 1 }); });
check('add emits cart:add with the OVERRIDDEN copy and ok:true', () => {
  assert.equal(result.ok, true);
  const [e, ...rest] = take();
  assert.equal(rest.length, 0);
  assert.equal(e.type, 'cart:add');
  assert.equal(e.severity, 'success');
  assert.equal(e.messageKey, 'cart.added');
  assert.equal(e.message, 'Added to bag');
});

await runAct(async () => { result = await api.cart.addLine({ merchandiseId: 'v2', quantity: 1 }); });
check('second distinct line still fits a limit of 2', () => {
  assert.equal(result.ok, true);
  assert.equal(take().length, 1);
  assert.equal(api.cart.lineCount, 2);
});

await runAct(async () => { result = await api.cart.addLine({ merchandiseId: 'v3', quantity: 1 }); });
check('third line is refused BEFORE any request, with the limit message', () => {
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'limit');
  assert.equal(result.message, 'You can not add more than 2 items on cart');
  const [e] = take();
  assert.equal(e.type, 'cart:limitExceeded');
  assert.equal(e.severity, 'error');
  const addsBefore = calls.filter((c) => c === 'CartLinesAdd').length;
  assert.equal(addsBefore, 2, 'no third CartLinesAdd was sent');
});

await runAct(async () => { result = await api.cart.addLine({ merchandiseId: 'v1', quantity: 5 }); });
check('topping up an existing line is allowed at the limit', () => {
  assert.equal(result.ok, true);
  assert.equal(take()[0].type, 'cart:add');
});

await runAct(async () => { await api.cart.removeLine('gid://line/0'); });
check('remove emits cart:remove — previously fired nothing', () => {
  const [e] = take();
  assert.equal(e.type, 'cart:remove');
  assert.equal(e.messageKey, 'cart.removed');
  assert.equal(e.message, 'Product removed from the Cart');
});

scenario.addFails = { field: null, message: 'The merchandise is out of stock', code: 'MERCHANDISE_OUT_OF_STOCK' };
let threw = null;
await runAct(async () => {
  try { await api.cart.addLine({ merchandiseId: 'v9', quantity: 1 }); }
  catch (e) { threw = e; }
});
check('an unsellable line emits cart:outOfStock AND still throws', () => {
  assert.ok(threw, 'error propagated to the caller');
  const [e] = take();
  assert.equal(e.type, 'cart:outOfStock');
  assert.equal(e.severity, 'error');
  assert.equal(e.message, 'Sorry, this item is out of stock');
  assert.ok(e.error, 'error attached for logging');
});
scenario.addFails = null;

console.log('wishlist alerts');
await runAct(async () => { await api.wishlist.add('gid://product/1'); });
check('wishlist add emits', () => { assert.equal(take()[0].type, 'wishlist:add'); });
await runAct(async () => { await api.wishlist.remove('gid://product/1'); });
check('wishlist remove emits — the hole this fixes', () => {
  const [e] = take();
  assert.equal(e.type, 'wishlist:remove');
  assert.equal(e.message, 'Removed from wishlist');
});
await runAct(async () => { await api.wishlist.remove('gid://product/nope'); });
check('removing something absent emits nothing', () => { assert.equal(take().length, 0); });

console.log('login alerts');
await runAct(async () => { result = await api.customer.login('a@b.c', 'pw'); });
check('login success sets the session and emits', () => {
  assert.equal(result, true);
  assert.equal(api.customer.loggedIn, true);
  assert.equal(api.customer.customer.email, 'a@b.c');
  assert.equal(api.customer.accessToken, 'tok_1');
  assert.equal(localStorage.getItem('shopify:customer-token:v1'), 'tok_1');
  const [e] = take();
  assert.equal(e.type, 'auth:loginSuccess');
  assert.equal(e.message, 'Welcome back!');
});

await runAct(async () => { await api.customer.logout(); });
check('logout clears the session, storage, and emits', () => {
  assert.equal(api.customer.loggedIn, false);
  assert.equal(localStorage.getItem('shopify:customer-token:v1'), null);
  assert.equal(take()[0].type, 'auth:logout');
});

scenario.loginFails = { field: ['password'], message: 'Unidentified customer', code: 'UNIDENTIFIED_CUSTOMER' };
threw = null;
await runAct(async () => {
  try { result = await api.customer.login('a@b.c', 'wrong'); } catch (e) { threw = e; }
});
check('bad credentials resolve false and emit auth:loginFailed, no throw', () => {
  assert.equal(threw, null, 'a wrong password is an answer, not an exception');
  assert.equal(result, false);
  assert.equal(api.customer.loggedIn, false);
  const [e] = take();
  assert.equal(e.type, 'auth:loginFailed');
  assert.equal(e.severity, 'error');
  assert.equal(e.message, 'Incorrect email or password');
});
scenario.loginFails = null;

await runAct(async () => { await api.customer.recoverPassword('a@b.c'); });
check('recover emits auth:recoverSent', () => {
  assert.equal(take()[0].message, 'Check your email for a reset link');
});

console.log('checkout alerts');
await runAct(async () => { await api.checkout.reportOrderPlaced({ orderNumber: 1001 }); });
check('order placed emits and resets the cart', () => {
  const [e] = take();
  assert.equal(e.type, 'checkout:orderPlaced');
  assert.equal(e.message, 'Your order has been placed 🎉');
  assert.deepEqual(e.error, { orderNumber: 1001 });
  assert.equal(api.cart.lineCount, 0);
});
await runAct(async () => { api.checkout.reportPaymentFailed(new Error('declined')); });
check('payment failed emits as an error', () => {
  const [e] = take();
  assert.equal(e.type, 'checkout:paymentFailed');
  assert.equal(e.severity, 'error');
  assert.equal(e.message, 'Payment could not be processed');
});

console.log('non-toast copy');
check('wishlist.empty is readable for a placeholder', () => {
  assert.equal(api.message('wishlist.empty'), 'Your wishlist is empty');
});

console.log('session restore');
// The first tree has to go: `Probe` writes into one shared `api`, so a stray
// re-render of the old provider would clobber the new one's context.
await runAct(async () => { root.unmount(); });

// A fresh provider over the same storage — what a cold app start looks like.
let liveRoot = null;
const remount = async (onEvent) => {
  // Retire the previous tree first, for the same reason as above.
  if (liveRoot) await runAct(async () => { liveRoot.unmount(); });
  const r = createRoot(document.createElement('div'));
  liveRoot = r;
  await runAct(async () => {
    r.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, onEvent },
      React.createElement(Probe),
    ));
  });
  await runAct(async () => { await new Promise((res) => setTimeout(res, 40)); });
  return r;
};

localStorage.setItem('shopify:customer-token:v1', 'tok_1');
take();
await remount((e) => events.push(e));
check('a stored token is exchanged for a profile on mount', () => {
  assert.equal(api.customer.loggedIn, true);
  assert.equal(api.customer.accessToken, 'tok_1');
  assert.equal(api.customer.restoring, false);
  // Restoring is not logging in — no toast at a shopper who just opened the app.
  assert.equal(events.filter((e) => e.type.startsWith('auth:')).length, 0);
});

// Now the token no longer resolves, which is an expiry, not a failed login.
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const { query } = JSON.parse(init.body);
  if (query.includes('customer(customerAccessToken')) {
    return { ok: true, status: 200, json: async () => ({ data: { customer: null } }) };
  }
  return realFetch(url, init);
};
localStorage.setItem('shopify:customer-token:v1', 'tok_expired');
take();
await remount((e) => events.push(e));
check('an expired token is dropped silently, storage cleared, no auth event', () => {
  assert.equal(api.customer.loggedIn, false);
  assert.equal(api.customer.restoring, false);
  assert.equal(localStorage.getItem('shopify:customer-token:v1'), null);
  assert.equal(events.filter((e) => e.type.startsWith('auth:')).length, 0);
});
global.fetch = realFetch;

console.log('resilience');
const before = events.length;
await remount(() => { throw new Error('host listener blew up'); });
let survived = false;
await runAct(async () => {
  const r = await api.cart.addLine({ merchandiseId: 'vX', quantity: 1 });
  survived = r.ok;
});
check('a throwing onEvent does not fail the write', () => {
  assert.equal(survived, true);
  assert.equal(events.length, before);
});

console.log(`\n${pass} checks passed`);
