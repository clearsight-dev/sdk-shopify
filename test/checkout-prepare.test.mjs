// Getting the cart ready for checkout (SDK move 6): `prepareCheckout` with every step handed in, then
// `useCheckout().prepare` / `preparing` through the real ShopifyProvider in jsdom, with the Storefront
// API stubbed at `fetch`.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { deferred, harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div><div id="second"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const { prepareCheckout, CHECKOUT_LABEL_STEP_TIMEOUT_MS } = await import('../dist/checkout.js');

const t = harness('checkout: getting the cart ready (prepareCheckout, useCheckout().prepare)');

// ── prepareCheckout, every step handed in ───────────────────────────────────

const LINE = { id: 'gid://line/1', quantity: 1, attributes: [], merchandise: { id: 'gid://shopify/ProductVariant/1' } };
const cartWith = (lines, countryCode = 'US') => ({ id: 'gid://shopify/Cart/1', lines, buyerIdentity: { countryCode, email: null, phone: null } });

/** Steps that record what they were asked, in order. `over` replaces any of them. */
function stepsFor(over = {}) {
  const log = [];
  const steps = {
    readCartAgain: async () => { log.push('read'); return cartWith([LINE]); },
    cartAlreadyLoaded: () => { log.push('loaded'); return cartWith([LINE]); },
    signedIn: false,
    email: null,
    getAccessToken: async () => { log.push('token'); return 'tok'; },
    setBuyerIdentity: async (shopper) => { log.push(['buyer', shopper]); return true; },
    reportCheckoutStarted: async () => { log.push('started'); },
    ...over,
  };
  return { steps, log };
}

t.section('prepareCheckout: the cart');
await t.check('no cart is empty, and nothing else happens', async () => {
  const { steps, log } = stepsFor({ readCartAgain: async () => { log.push('read'); return null; }, signedIn: true });
  assert.equal(await prepareCheckout(steps), 'empty');
  assert.deepEqual(log, ['read']);
});
await t.check('a cart with no lines is empty (a reservation that ran out took them)', async () => {
  const { steps, log } = stepsFor({ readCartAgain: async () => cartWith([]), signedIn: true });
  assert.equal(await prepareCheckout(steps), 'empty');
  assert.deepEqual(log, []);
});
await t.check('a read that fails carries on with the cart already loaded ("Carry on"): its country, ready', async () => {
  const { steps, log } = stepsFor({
    readCartAgain: async () => { throw new TypeError('Network request failed'); },
    cartAlreadyLoaded: () => { log.push('loaded'); return cartWith([LINE], 'CA'); },
    signedIn: true,
  });
  assert.equal(await prepareCheckout(steps), 'ready');
  assert.deepEqual(log, ['loaded', 'token', ['buyer', { customerAccessToken: 'tok', countryCode: 'CA' }], 'started']);
});
await t.check('a read that fails with no lines loaded either is empty: nothing to pay for', async () => {
  const none = stepsFor({ readCartAgain: async () => { throw new TypeError('offline'); }, cartAlreadyLoaded: () => null });
  assert.equal(await prepareCheckout(none.steps), 'empty');
  assert.deepEqual(none.log, []);
  const noLines = stepsFor({ readCartAgain: async () => { throw new TypeError('offline'); }, cartAlreadyLoaded: () => cartWith([]) });
  assert.equal(await prepareCheckout(noLines.steps), 'empty');
});
await t.check('a read that answers (even with no cart) is believed over the cart already loaded', async () => {
  const { steps, log } = stepsFor({ readCartAgain: async () => null });
  assert.equal(await prepareCheckout(steps), 'empty');
  assert.ok(!log.includes('loaded'));
});
await t.check('a read that fails, then a lapsed hold among the lines already loaded, is still lapsedHold', async () => {
  const { steps } = stepsFor({ readCartAgain: async () => { throw new TypeError('offline'); } });
  assert.equal(await prepareCheckout(steps, { hasLapsedHold: () => true }), 'lapsedHold');
});

t.section('prepareCheckout: a reservation that ran out');
await t.check('hasLapsedHold is asked about the lines just read; true is lapsedHold, and nothing is attached, labelled or reported', async () => {
  const fresh = [LINE, { ...LINE, id: 'gid://line/2' }];
  let asked = null;
  const { steps, log } = stepsFor({
    readCartAgain: async () => cartWith(fresh), signedIn: true,
    flushAttribution: async () => { log.push('flush'); return true; },
  });
  const result = await prepareCheckout(steps, { hasLapsedHold: (lines) => { asked = lines; return true; } });
  assert.equal(result, 'lapsedHold');
  assert.equal(asked, fresh);
  assert.deepEqual(log, []);
});
await t.check('hasLapsedHold false, or left out, goes on to ready', async () => {
  assert.equal(await prepareCheckout(stepsFor().steps, { hasLapsedHold: () => false }), 'ready');
  assert.equal(await prepareCheckout(stepsFor().steps), 'ready');
});

t.section('prepareCheckout: the shopper');
await t.check('signed out: no token asked for, no buyer identity, the start reported, ready', async () => {
  const { steps, log } = stepsFor();
  assert.equal(await prepareCheckout(steps), 'ready');
  assert.deepEqual(log, ['read', 'started']);
});
await t.check('signed in: the token, the email and the country of the cart just read, before the start is reported', async () => {
  const { steps, log } = stepsFor({ signedIn: true, email: 'amber@example.com', readCartAgain: async () => cartWith([LINE], 'CA') });
  assert.equal(await prepareCheckout(steps), 'ready');
  assert.deepEqual(log, ['token', ['buyer', { customerAccessToken: 'tok', email: 'amber@example.com', countryCode: 'CA' }], 'started']);
});
await t.check('an email not loaded yet, or a cart with no country, is left out rather than sent empty', async () => {
  const { steps, log } = stepsFor({ signedIn: true, email: null, readCartAgain: async () => cartWith([LINE], null) });
  await prepareCheckout(steps);
  assert.deepEqual(log[1], ['buyer', { customerAccessToken: 'tok' }]);
});
await t.check('no token (the session ended): no buyer identity, still ready', async () => {
  const { steps, log } = stepsFor({ signedIn: true, getAccessToken: async () => null });
  assert.equal(await prepareCheckout(steps), 'ready');
  assert.deepEqual(log, ['read', 'started']);
});
await t.check('a token or buyer-identity failure leaves a guest checkout: still ready, start reported', async () => {
  const tokenFails = stepsFor({ signedIn: true, getAccessToken: async () => { throw new Error('offline'); } });
  assert.equal(await prepareCheckout(tokenFails.steps), 'ready');
  assert.deepEqual(tokenFails.log, ['read', 'started']);
  const writeFails = stepsFor({ signedIn: true, setBuyerIdentity: async () => { throw new Error('offline'); } });
  assert.equal(await prepareCheckout(writeFails.steps), 'ready');
  assert.deepEqual(writeFails.log, ['read', 'token', 'started']);
});

t.section('prepareCheckout: labelling the cart (Freckled Poppy\'s labelCartForCheckout)');
await t.check('the attribution lands first, then the cart attributes, both before the start is reported', async () => {
  const { steps, log } = stepsFor({
    flushAttribution: async () => { log.push('flush'); return true; },
    ensureCartAttributes: async () => { log.push('ensure'); return true; },
  });
  assert.equal(await prepareCheckout(steps), 'ready');
  assert.deepEqual(log, ['read', 'flush', 'ensure', 'started']);
});
await t.check('either step left out is skipped (a build without attribution)', async () => {
  const { steps, log } = stepsFor({ ensureCartAttributes: async () => { log.push('ensure'); return true; } });
  await prepareCheckout(steps);
  assert.deepEqual(log, ['read', 'ensure', 'started']);
});
await t.check('a step that answers false or rejects is warned about, the next one still runs, and checkout goes on', async () => {
  const warnings = t.warnings.length;
  const { steps, log } = stepsFor({
    flushAttribution: async () => { log.push('flush'); throw new Error('write failed'); },
    ensureCartAttributes: async () => { log.push('ensure'); return false; },
  });
  assert.equal(await prepareCheckout(steps), 'ready');
  assert.deepEqual(log, ['read', 'flush', 'ensure', 'started']);
  assert.deepEqual(t.warnings.slice(warnings).map((w) => w.replace(/;.*/, '')), [
    '[sdk-shopify] checkout: flushAttribution failed',
    '[sdk-shopify] checkout: ensureCartAttributes failed',
  ]);
});
await t.check('a step that runs past its time is left behind, warned about, and checkout goes on', async () => {
  const warnings = t.warnings.length;
  const never = deferred();
  const { steps, log } = stepsFor({
    labelStepTimeoutMs: 20,
    flushAttribution: () => { log.push('flush'); return never.promise; },
    ensureCartAttributes: async () => { log.push('ensure'); return true; },
  });
  const started = Date.now();
  assert.equal(await prepareCheckout(steps), 'ready');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(log, ['read', 'flush', 'ensure', 'started']);
  assert.match(t.warnings[warnings], /flushAttribution timed out/);
  assert.equal(CHECKOUT_LABEL_STEP_TIMEOUT_MS, 3000, "each step's default time is Freckled Poppy's 3 seconds");
});
await t.check('attaching the shopper and labelling run together: labelling doesn\'t wait for the token', async () => {
  const token = deferred();
  const { steps, log } = stepsFor({
    signedIn: true,
    getAccessToken: () => { log.push('token asked'); return token.promise; },
    flushAttribution: async () => { log.push('flush'); return true; },
  });
  const running = prepareCheckout(steps);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ['read', 'token asked', 'flush']);
  token.resolve('tok');
  assert.equal(await running, 'ready');
  assert.equal(log.at(-1), 'started');
});

t.section('prepareCheckout: never rejects');
await t.check('reporting the start fails: warned, still ready', async () => {
  const { steps } = stepsFor({ reportCheckoutStarted: async () => { throw new Error('storage full'); } });
  assert.equal(await prepareCheckout(steps), 'ready');
});
await t.check('anything else that throws (here the app\'s own hasLapsedHold) is failed', async () => {
  const { steps } = stepsFor();
  assert.equal(await prepareCheckout(steps, { hasLapsedHold: () => { throw new Error('bug'); } }), 'failed');
});

// ── useCheckout().prepare through the provider ──────────────────────────────

const money = (amount) => ({ amount, currencyCode: 'USD' });
const server = { lines: [], buyerIdentity: { countryCode: 'US', email: null, phone: null } };
const sent = [];
let holdRead = null;
let failRead = false;
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [],
  totalQuantity: server.lines.reduce((n, l) => n + l.quantity, 0),
  buyerIdentity: server.buyerIdentity,
  lines: { nodes: server.lines.map((l) => ({ id: l.id, quantity: l.quantity, attributes: [], sellingPlanAllocation: null,
    merchandise: { id: l.merchandiseId, title: 'S', price: money('50.00') }, cost: { totalAmount: money('50.00'), amountPerQuantity: money('50.00') } })) },
  cost: { subtotalAmount: money('50.00'), totalAmount: money('50.00') }, discountCodes: [],
  appliedGiftCards: [], createdAt: '', updatedAt: '',
});

global.fetch = async (url, init = {}) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  sent.push({ name, variables });
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart: cartPayload(), userErrors: [] } } });
  if (name === 'CartGet') {
    if (failRead) throw new TypeError('Network request failed');
    if (holdRead) await holdRead.promise;
    return response(200, { data: { cart: cartPayload() } });
  }
  if (name === 'CartLinesAdd') {
    for (const l of variables.lines) server.lines.push({ id: `gid://line/${server.lines.length}`, ...l });
    return response(200, { data: { cartLinesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartBuyerIdentityUpdate') {
    const bi = variables.buyerIdentity;
    server.buyerIdentity = { countryCode: bi.countryCode ?? null, email: bi.email ?? null, phone: null };
    return response(200, { data: { cartBuyerIdentityUpdate: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_pw', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'Customer') {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'buyer@example.com', firstName: 'B', lastName: 'Y', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useCart, useCheckout, useCustomer } = await import('../dist/index.js');

/** Two buttons' worth of checkout: each Probe has its own `useCheckout()`. */
const probes = { first: null, second: null };
let cartApi = null;
let customerApi = null;
function Probe({ name }) {
  probes[name] = useCheckout();
  if (name === 'first') {
    cartApi = useCart();
    customerApi = useCustomer();
  }
  return null;
}
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
const root = createRoot(document.getElementById('root'));
await runAct(async () => {
  root.render(React.createElement(
    ShopifyProvider,
    { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' },
      auth: { method: 'password', secureStorage: keychain() } },
    React.createElement(Probe, { name: 'first' }),
    React.createElement(Probe, { name: 'second' }),
  ));
});
await settle();
const names = () => sent.map((s) => s.name);
const STARTED_KEY = 'shopify:checkout-started-cart-id:v1';

t.section('useCheckout().prepare through the provider');
await t.check('a cart with no lines yet: read again, empty, and nothing is written', async () => {
  sent.length = 0;
  localStorage.removeItem(STARTED_KEY);
  let result;
  await runAct(async () => { result = await probes.first.prepare(); });
  assert.equal(result, 'empty');
  assert.deepEqual(names(), ['CartGet']);
  assert.equal(localStorage.getItem(STARTED_KEY), null);
});
await runAct(async () => { await cartApi.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1 }); });
await settle();
await t.check('signed out: the cart is read again, no buyer identity is written, the start is marked, ready', async () => {
  sent.length = 0;
  localStorage.removeItem(STARTED_KEY);
  let result;
  await runAct(async () => { result = await probes.first.prepare(); });
  assert.equal(result, 'ready');
  assert.deepEqual(names(), ['CartGet']);
  assert.equal(localStorage.getItem(STARTED_KEY), 'gid://shopify/Cart/1');
});
await t.check('hasLapsedHold gets the lines just read; true answers lapsedHold and marks nothing', async () => {
  localStorage.removeItem(STARTED_KEY);
  let asked = null;
  let result;
  await runAct(async () => { result = await probes.first.prepare({ hasLapsedHold: (lines) => { asked = lines; return true; } }); });
  assert.equal(result, 'lapsedHold');
  assert.deepEqual(asked.map((line) => line.merchandise.id), ['gid://shopify/ProductVariant/1']);
  assert.equal(localStorage.getItem(STARTED_KEY), null);
});
await t.check('preparing is true while this hook\'s prepare runs, and only for this hook', async () => {
  holdRead = deferred();
  let running;
  await runAct(async () => { running = probes.first.prepare(); await new Promise((r) => setTimeout(r, 10)); });
  assert.equal(probes.first.preparing, true);
  assert.equal(probes.second.preparing, false, "another screen's button shows no spinner");
  await runAct(async () => { holdRead.resolve(); holdRead = null; await running; });
  assert.equal(probes.first.preparing, false);
});
await t.check('offline: the read fails, and checkout goes on with the cart already loaded ("Carry on")', async () => {
  localStorage.removeItem(STARTED_KEY);
  failRead = true;
  let result;
  await runAct(async () => { result = await probes.first.prepare(); });
  failRead = false;
  assert.equal(result, 'ready');
  assert.equal(localStorage.getItem(STARTED_KEY), 'gid://shopify/Cart/1');
  assert.equal(cartApi.cart.lines.length, 1, 'the cart on screen is kept');
});
await t.check('prepare keeps one identity while the cart changes', async () => {
  const before = probes.first.prepare;
  await runAct(async () => { await cartApi.addLine({ merchandiseId: 'gid://shopify/ProductVariant/2', quantity: 1 }); });
  await settle();
  assert.equal(probes.first.prepare, before);
});
await t.check('signed in: the buyer identity carries the token, the profile\'s email and the cart\'s country', async () => {
  await runAct(async () => { await customerApi.login('buyer@example.com', 'pw'); });
  await settle();
  server.buyerIdentity = { countryCode: 'CA', email: null, phone: null };
  sent.length = 0;
  let result;
  await runAct(async () => { result = await probes.first.prepare(); });
  assert.equal(result, 'ready');
  assert.deepEqual(names(), ['CartGet', 'CartBuyerIdentityUpdate']);
  assert.deepEqual(sent[1].variables.buyerIdentity, { customerAccessToken: 'tok_pw', email: 'buyer@example.com', countryCode: 'CA' });
  assert.equal(server.buyerIdentity.countryCode, 'CA', 'the write keeps the country, so a gift card can stay');
});
await t.check('the other report functions are still there', () => {
  assert.equal(typeof probes.first.reportCheckoutStarted, 'function');
  assert.equal(typeof probes.first.reportOrderPlaced, 'function');
  assert.equal(typeof probes.first.reportPaymentFailed, 'function');
});

await runAct(async () => { root.unmount(); });
t.done();
