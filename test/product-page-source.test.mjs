// SDK move 6 on top of 0.9.1's attribution:
// `AddToCartInput.source` through `useAddToCart` (what `useProductPage().cart.add` is), and
// `useCheckout().prepare` landing the attribution and the provider's `cartAttributes`. Real
// ShopifyProvider in jsdom, the Storefront API stubbed at `fetch` with an in-memory cart.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = { amount: '10.00', currencyCode: 'USD' };
const carts = new Map();
let nextCartId = 1;
const calls = [];
const sameLine = (a, b) => a.merchandiseId === b.merchandiseId && JSON.stringify(a.attributes ?? []) === JSON.stringify(b.attributes ?? []);
const payload = (id) => {
  const c = carts.get(id);
  return {
    id, checkoutUrl: 'https://shop/checkout', totalQuantity: c.lines.reduce((n, l) => n + l.quantity, 0), attributes: c.attributes,
    buyerIdentity: { countryCode: 'US', email: null, phone: null },
    lines: { nodes: c.lines.map((l, i) => ({ id: `${id}/line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
      merchandise: { id: l.merchandiseId }, cost: { totalAmount: money, amountPerQuantity: money } })) },
    cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};

global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = op?.[1] || op?.[2] || 'unknown';
  calls.push({ name, variables });
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  await new Promise((r) => setTimeout(r, 3));
  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') {
    const id = `gid://shopify/Cart/${nextCartId++}`;
    carts.set(id, { attributes: variables.input?.attributes ?? [], lines: [] });
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });
  if (name === 'CartLinesAdd') {
    const c = carts.get(variables.cartId);
    for (const l of variables.lines) {
      const existing = c.lines.find((x) => sameLine(x, l));
      if (existing) existing.quantity += l.quantity;
      else c.lines.push({ ...l });
    }
    return reply({ cartLinesAdd: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartAttributesUpdate') {
    carts.get(variables.cartId).attributes = variables.attributes;
    return reply({ cartAttributesUpdate: { cart: payload(variables.cartId), userErrors: [] } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useAddToCart, useCart, useCheckout, parseAttribution, ATTRIBUTION_ATTRIBUTE_KEY } = await import('../dist/index.js');

const t = harness('product page: where an add came from, and checkout landing it (SDK move 6, on 0.9.1 attribution)');

const VARIANT = { id: 'gid://shopify/ProductVariant/41', availableForSale: true, quantityAvailable: 10 };
const live = { type: 'live', showId: 's-1' };
const replay = { type: 'replay', showId: 's-2' };
const cartAttributes = [{ key: 'source_name', value: 'apptile-mobile-app-builder' }];

let page = null;
let cartApi = null;
let checkout = null;
function Probe({ source }) {
  page = useAddToCart(VARIANT, source ? { source } : {});
  cartApi = useCart();
  checkout = useCheckout();
  return null;
}
let root = null;
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 60)); });
async function mount(props, extra = { attribution: { enabled: true } }) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  calls.length = 0;
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, cartAttributes, ...extra },
      React.createElement(Probe, props),
    ));
  });
  await settle();
}
const serverCart = () => carts.get(cartApi.cart.id);
const serverValue = () => parseAttribution(serverCart().attributes.find((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY)?.value);
const strip = (a) => JSON.parse(JSON.stringify(a, (k, v) => (k === 't' ? undefined : v)));
const named = (n) => calls.filter((c) => c.name === n);

t.section('AddToCartInput.source');
await mount({ source: live });
await t.check('the page\'s source (useProductPage / useAddToCart options) goes with every add', async () => {
  await runAct(async () => { await page.add(); });
  await settle();
  await runAct(async () => { await page.add({ quantity: 2 }); });
  await settle();
  assert.deepEqual(strip(serverValue()), { v: 1, live: { 's-1': { items: { 41: { n: 3 } } } } });
});
await t.check('it never reaches Shopify', () => {
  const sentLines = named('CartLinesAdd').flatMap((c) => c.variables.lines);
  assert.equal(sentLines.length, 2);
  assert.ok(sentLines.every((line) => !('source' in line)));
});
await t.check('one add can name its own source', async () => {
  await runAct(async () => { await page.add({ source: replay }); });
  await settle();
  assert.deepEqual(strip(serverValue()).replay, { 's-2': { items: { 41: { n: 1 } } } });
});
await t.check('a page given none adds as the app\'s own', async () => {
  await mount({});
  await runAct(async () => { await page.add(); });
  await settle();
  assert.deepEqual(strip(serverValue()), { v: 1, app: { 41: { n: 1 } } });
});

t.section('useCheckout().prepare with attribution');
await t.check('the cart\'s attribution and its cartAttributes are on the cart before the start is reported; nothing written when both are', async () => {
  calls.length = 0;
  let result;
  await runAct(async () => { result = await checkout.prepare(); });
  assert.equal(result, 'ready');
  assert.deepEqual(named('CartAttributesUpdate'), [], 'both already there: no write');
});
await t.check('cartAttributes gone from the cart (another device changed it) are put back, keeping the attribution', async () => {
  const kept = serverCart().attributes.filter((a) => a.key === ATTRIBUTION_ATTRIBUTE_KEY);
  serverCart().attributes = kept;
  await runAct(async () => { await cartApi.refresh(); });
  calls.length = 0;
  let result;
  await runAct(async () => { result = await checkout.prepare(); });
  assert.equal(result, 'ready');
  const writes = named('CartAttributesUpdate');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].variables.attributes.map((a) => a.key).sort(), [ATTRIBUTION_ATTRIBUTE_KEY, 'source_name']);
  assert.deepEqual(strip(serverValue()), { v: 1, app: { 41: { n: 1 } } });
});

await runAct(async () => { root.unmount(); });
t.done();
