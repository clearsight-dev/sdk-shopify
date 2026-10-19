// Holds that run out, through the real ShopifyProvider (0.19.0, ENG-695): rendered in jsdom with a
// stand-in for Cart Hold in `cartExtensions` and the Storefront API stubbed at `fetch`, on real timers with
// holds a fraction of a second long. The rules themselves are test/hold-end-watch's, on a fake clock; this
// checks the wiring: the alert through `onEvent` with its words, the switch, the reads after a hold on any
// screen (and not twice with the Cart page open), a remove, a swapped cart, and a launch after a hold ran out.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, keychain, memoryStorage, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
/** The store's carts by id: each line a variant and its attributes. */
const carts = new Map();
let nextCart = 1;
let nextLine = 1;
const sent = [];
const payload = (id) => {
  const lines = carts.get(id) ?? [];
  return {
    id, checkoutUrl: 'https://shop/checkout', note: '', attributes: [],
    totalQuantity: lines.length,
    buyerIdentity: { countryCode: 'US', email: null, phone: null },
    lines: { nodes: lines.map((l) => ({ id: l.id, quantity: 1, attributes: l.attributes, sellingPlanAllocation: null,
      merchandise: { id: l.variant, title: 'S', price: money('20.00'), availableForSale: true, quantityAvailable: 5 },
      cost: { totalAmount: money('20.00'), amountPerQuantity: money('20.00') } })) },
    cost: { subtotalAmount: money('0.00'), totalAmount: money('0.00') },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};
const newCart = (lines = []) => {
  const id = `gid://shopify/Cart/${nextCart++}`;
  carts.set(id, lines.map((l) => ({ id: `gid://line/${nextLine++}`, ...l })));
  return id;
};

global.fetch = async (_url, init = {}) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  sent.push({ name, variables });
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart: payload(newCart()), userErrors: [] } } });
  if (name === 'CartGet') return response(200, { data: { cart: carts.has(variables.id) ? payload(variables.id) : null } });
  if (name === 'CartLinesAdd') {
    for (const l of variables.lines) carts.get(variables.cartId).push({ id: `gid://line/${nextLine++}`, variant: l.merchandiseId, attributes: l.attributes ?? [] });
    return response(200, { data: { cartLinesAdd: { cart: payload(variables.cartId), userErrors: [] } } });
  }
  if (name === 'CartLinesRemove') {
    carts.set(variables.cartId, carts.get(variables.cartId).filter((l) => !variables.lineIds.includes(l.id)));
    return response(200, { data: { cartLinesRemove: { cart: payload(variables.cartId), userErrors: [] } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useCart, useCartPage } = await import('../dist/index.js');

const t = harness('holds that run out: through ShopifyProvider');

/** Stands in for Cart Hold: a line's `_hold` stamp, and reads 30 and 300 ms after the next hold ends. */
const holdOf = (line) => Number(line.attributes.find((a) => a.key === '_hold')?.value) || null;
const READS_AFTER_MS = [30, 300];
const holdExtension = {
  name: 'test-hold',
  lineFacts: (line) => ({ holdExpiresAt: holdOf(line) }),
  refreshDelays: (cart, now) => {
    const next = cart.lines.map(holdOf).filter((at) => at !== null && at > now).sort((a, b) => a - b)[0];
    return next === undefined ? [] : READS_AFTER_MS.map((ms) => next - now + ms).filter((delay) => delay > 0);
  },
};
const EXTENSIONS = [holdExtension];
const HOLD_MS = 250;
const CART_ID_KEY = 'shopify:cart-id:v1';

const wait = (ms) => runAct(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const held = () => [{ key: '_hold', value: String(Date.now() + HOLD_MS) }];
const reads = () => sent.filter((s) => s.name === 'CartGet').length;

/** A provider of its own (its own storage, so its own cart), with what it raised. */
async function mount({ withCartPage = false, alert, messages, storage = memoryStorage() } = {}) {
  const events = [];
  const api = {};
  function Probe() {
    api.cart = useCart();
    return null;
  }
  function CartPage() {
    api.page = useCartPage();
    return null;
  }
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  const props = (extra) => ({
    config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' },
    auth: { method: 'password', secureStorage: keychain() },
    storage,
    cartExtensions: EXTENSIONS,
    onEvent: (event) => events.push(event),
    ...(alert ? { reservationExpiredAlert: alert } : {}),
    ...(messages ? { messages } : {}),
    ...extra,
  });
  const draw = (extra = {}) => root.render(React.createElement(
    ShopifyProvider,
    props(extra),
    React.createElement(Probe),
    withCartPage ? React.createElement(CartPage) : null,
  ));
  await runAct(async () => { draw(); });
  await wait(40);
  const expired = () => events.filter((e) => e.type === 'cart:reservationExpired');
  return { api, events, expired, rerender: (extra) => runAct(async () => { draw(extra); }), unmount: () => runAct(async () => root.unmount()) };
}

t.section('the alert');
await t.check('one cart:reservationExpired when the hold runs out, with its words, as info, and the cart', async () => {
  const app = await mount();
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  await wait(HOLD_MS - 80);
  assert.equal(app.expired().length, 0, 'not before');
  await wait(140);
  assert.equal(app.expired().length, 1);
  const [event] = app.expired();
  assert.equal(event.message, 'Your reservation expired and the item was released.');
  assert.equal(event.messageKey, 'cart.reservationExpired');
  assert.equal(event.severity, 'info');
  assert.equal(event.cart.lines.length, 1);
  await app.unmount();
});
await t.check('no second one when the sweep takes the line', async () => {
  const app = await mount();
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  await wait(HOLD_MS + 60);
  // Cart Hold's sweep: the line leaves the store's cart, and the read 300 ms after the end sees it.
  const id = app.api.cart.cart.id;
  carts.set(id, []);
  await wait(350);
  assert.equal(app.api.cart.cart.lines.length, 0, 'the swept line has gone, with no Cart page open');
  assert.equal(app.expired().length, 1);
  await app.unmount();
});
await t.check("the panel's words (`messages`) win", async () => {
  const app = await mount({ messages: { 'cart.reservationExpired': 'Your hold ran out' } });
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  await wait(HOLD_MS + 60);
  assert.equal(app.expired()[0]?.message, 'Your hold ran out');
  await app.unmount();
});

t.section('the switch');
await t.check('reservationExpiredAlert { enabled: false }: no alert; the cart is still read after the hold', async () => {
  const app = await mount({ alert: { enabled: false } });
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  const before = reads();
  await wait(HOLD_MS + 350);
  assert.equal(app.expired().length, 0);
  assert.equal(reads() - before, 2);
  await app.unmount();
});
await t.check('turned off by a new prop while the hold runs (a Live Layer publish): none', async () => {
  const app = await mount();
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  await app.rerender({ reservationExpiredAlert: { enabled: false } });
  await wait(HOLD_MS + 60);
  assert.equal(app.expired().length, 0);
  await app.unmount();
});

t.section('the reads after a hold, on any screen');
await t.check('read at each time the extension asks for, with no Cart page open', async () => {
  const app = await mount();
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  const before = reads();
  await wait(HOLD_MS + 350);
  assert.equal(reads() - before, 2);
  await app.unmount();
});
await t.check('the same reads with the Cart page open: not twice', async () => {
  const app = await mount({ withCartPage: true });
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  const before = reads();
  await wait(HOLD_MS + 350);
  assert.equal(reads() - before, 2);
  assert.equal(app.expired().length, 1, 'and one alert');
  await app.unmount();
});

t.section('no alert');
await t.check('for a line the shopper removed before the hold ran out', async () => {
  const app = await mount();
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  const lineId = app.api.cart.cart.lines[0].id;
  await runAct(async () => { await app.api.cart.removeLine(lineId); });
  await wait(HOLD_MS + 350);
  assert.equal(app.expired().length, 0);
  await app.unmount();
});
await t.check("for the old cart's hold when another cart is adopted (Cart Assist)", async () => {
  const app = await mount();
  await runAct(async () => { await app.api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, attributes: held() }); });
  const accountCart = newCart([{ variant: 'gid://shopify/ProductVariant/2', attributes: [] }]);
  await runAct(async () => { await app.api.cart.adopt(accountCart); });
  await wait(HOLD_MS + 350);
  assert.equal(app.api.cart.cart.id, accountCart);
  assert.equal(app.expired().length, 0);
  await app.unmount();
});
await t.check('at launch, for a hold that ran out while the app was closed; its read still comes, quietly', async () => {
  // The phone's stored cart: one line whose hold ran out 40 ms ago, so its 300 ms read is still to come.
  const storedCart = newCart([{ variant: 'gid://shopify/ProductVariant/1', attributes: [{ key: '_hold', value: String(Date.now() - 40) }] }]);
  const storage = memoryStorage({ [CART_ID_KEY]: storedCart });
  const launchReads = reads();
  const app = await mount({ storage });
  assert.equal(app.api.cart.cart?.id, storedCart);
  const afterLaunch = reads();
  assert.equal(afterLaunch - launchReads >= 1, true, 'the launch read');
  carts.set(storedCart, []);
  await wait(350);
  assert.equal(reads() - afterLaunch, 1, 'one more read, the one still to come');
  assert.equal(app.api.cart.cart.lines.length, 0, 'the swept line has gone');
  assert.equal(app.expired().length, 0);
  await app.unmount();
});

t.done();
