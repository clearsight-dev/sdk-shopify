// The waitlist: sizes a shopper waits on, kept on the device like the wishlist (the shared rules are
// tested in wishlist-offline.test.mjs). Here: the shapes it reads (Apptile's `{ id, handle }`, an
// app's `{ variantId, productId, addedAt }`), what it stores, offline, and the provider's events.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── Storefront stub ─────────────────────────────────────────────────────────
const money = (amount) => ({ amount, currencyCode: 'USD' });
const net = { online: true };
const variantNode = (id) => {
  const n = id.split('/').pop();
  return {
    __typename: 'ProductVariant',
    id, title: `Size ${n}`, sku: null, availableForSale: true, quantityAvailable: 0,
    price: money('20.00'), compareAtPrice: null, selectedOptions: [{ name: 'Size', value: 'S' }], image: null,
    sellingPlanAllocations: { nodes: n.endsWith('7')
      ? [{ sellingPlan: { id: 'gid://shopify/SellingPlan/1', name: 'Pre-order' }, remainingBalanceChargeAmount: money('10.00') }]
      : [] },
    product: {
      id: `gid://shopify/Product/9${n}`, title: `Product ${n}`, handle: `prod-${n}`,
      featuredImage: { url: `https://cdn.test/${n}.jpg`, altText: null },
      media: { nodes: [{ mediaContentType: 'VIDEO' }] },
    },
  };
};
const emptyCart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money('0'), totalAmount: money('0') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
};
global.fetch = async (_url, init) => {
  if (!net.online) throw new TypeError('Network request failed');
  const { query, variables } = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(query) || [])[1] || 'anon';
  const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) });
  if (name === 'ShopInfo') return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } });
  if (name === 'CartCreate') return reply({ cartCreate: { cart: emptyCart, userErrors: [] } });
  if (name === 'CartGet') return reply({ cart: emptyCart });
  if (name === 'VariantNodes') return reply({ nodes: variables.ids.map((id) => (id.endsWith('/404') ? null : variantNode(id))) });
  return reply({});
};

const sdk = await import('../dist/index.js');
const { shopify, clearRequestCache } = sdk;
const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', country: 'US' };
await shopify.init(CONFIG);

function memory(seed = {}) {
  const data = { ...seed };
  return {
    data,
    getItem: async (k) => (k in data ? data[k] : null),
    setItem: async (k, v) => { data[k] = String(v); },
    removeItem: async (k) => { delete data[k]; },
  };
}
const KEY = '6f314dd7-2bf7-4451-9d2f-4e4affb0c1a0_WaitlistProducts';
const APP_KEY = 'waitlist.entries';
const stored = (s) => JSON.parse(s.data[KEY]);
const V = (n) => `gid://shopify/ProductVariant/${n}`;
const settle = () => new Promise((r) => setTimeout(r, 20));

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };

console.log("Apptile's key");
const s1 = memory({ [KEY]: JSON.stringify([{ id: '4457', handle: 'tigers-sequin-tee' }]) });
await shopify.waitlist.init({ storage: s1, storageKey: KEY, hydrateOnInit: false });
await check("an Apptile entry {id, handle} is the variant's GID and the product's handle", () => {
  const [item] = shopify.waitlist.list();
  assert.equal(item.variantId, V(4457));
  assert.equal(item.productHandle, 'tigers-sequin-tee');
  assert.equal(item.productId, undefined);
  assert.equal(item.variant, undefined);
});
await shopify.waitlist.refresh();
await check('a refresh stores the variant with its product and pre-order plan, and learns the product id', () => {
  const [entry] = stored(s1);
  assert.equal(entry.variant.title, 'Size 4457');
  assert.equal(entry.variant.product.title, 'Product 4457');
  assert.equal(entry.variant.product.hasVideo, true);
  assert.equal(entry.variant.sellingPlan.name, 'Pre-order');
  assert.equal(entry.productId, 'gid://shopify/Product/94457');
});
await check("each entry keeps Apptile's fields: the numeric variant id, and the product's handle", () => {
  const [entry] = stored(s1);
  assert.equal(entry.id, '4457');
  assert.equal(entry.handle, 'prod-4457');
  assert.equal(entry.variantId, V(4457));
});

console.log('offline');
net.online = false;
clearRequestCache();
await shopify.waitlist.init({ storage: s1, storageKey: KEY });
await settle();
await check('a launch with no network draws every entry from the device', () => {
  const [item] = shopify.waitlist.list();
  assert.equal(item.variant?.product.title, 'Product 4457');
  assert.equal(item.variant?.sellingPlan?.name, 'Pre-order');
});
await check('a refresh that fails rejects and changes nothing', async () => {
  const before = s1.data[KEY];
  await assert.rejects(shopify.waitlist.refresh());
  assert.equal(s1.data[KEY], before);
});
net.online = true;

console.log('merging an app key, once');
const s2 = memory({
  [KEY]: JSON.stringify([{ id: '11', handle: 'p-11' }]),
  [APP_KEY]: JSON.stringify([
    { variantId: V(22), productId: 'gid://shopify/Product/922', addedAt: '2026-07-27T10:00:00.000Z' },
    { variantId: V(11), productId: 'gid://shopify/Product/911', addedAt: '2026-07-26T10:00:00.000Z' },
  ]),
});
const appKeyBefore = s2.data[APP_KEY];
await shopify.waitlist.init({ storage: s2, storageKey: KEY, migrateFrom: [APP_KEY], hydrateOnInit: false });
await check('both lists merge without duplicates; an ISO date is read; dated entries first', () => {
  const items = shopify.waitlist.list();
  assert.deepEqual(items.map((i) => i.variantId), [V(22), V(11)]);
  assert.equal(items[0].addedAt, Date.parse('2026-07-27T10:00:00.000Z'));
  assert.equal(items[0].productId, 'gid://shopify/Product/922');
});
await check('the app key is left as it was; un-joining later does not bring an entry back', async () => {
  assert.equal(s2.data[APP_KEY], appKeyBefore);
  await shopify.waitlist.remove(V(22));
  await shopify.waitlist.init({ storage: s2, storageKey: KEY, migrateFrom: [APP_KEY], hydrateOnInit: false });
  assert.equal(shopify.waitlist.has(V(22)), false);
});

console.log('joining, leaving, gone');
const s3 = memory();
await shopify.waitlist.init({ storage: s3, storageKey: KEY, hydrateOnInit: false });
await shopify.waitlist.add({ variantId: V(1), productHandle: 'p-1' });
await shopify.waitlist.add({ variantId: V(2), productHandle: 'p-2' });
await new Promise((r) => setTimeout(r, 5));
await shopify.waitlist.add({ variantId: V(1), productHandle: 'p-1' });
await check('joining again moves the entry to the front, dated now, not listed twice', () => {
  const items = shopify.waitlist.list();
  assert.deepEqual(items.map((i) => i.variantId), [V(1), V(2)]);
  assert.ok(items[0].addedAt >= items[1].addedAt);
});
await shopify.waitlist.add({ variantId: V(404), productHandle: 'gone' });
await shopify.waitlist.refresh();
await check('a variant the store no longer has is kept as null, for the screen to leave out', () => {
  const gone = shopify.waitlist.list().find((i) => i.variantId === V(404));
  assert.equal(gone.variant, null);
  assert.equal(stored(s3).find((e) => e.variantId === V(404)).variant, null);
});
await check('leaving deletes the entry and its stored details', async () => {
  await shopify.waitlist.remove(V(1));
  assert.equal(stored(s3).some((e) => e.variantId === V(1)), false);
});

console.log('provider');
const saved = memory({ [KEY]: JSON.stringify([{ id: '5', handle: 'p-5' }]) });
await shopify.waitlist.init({ storage: saved, storageKey: KEY, hydrateOnInit: false });
await shopify.waitlist.refresh();
net.online = false;
clearRequestCache();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const events = [];
let api = null;
function Probe() { api = sdk.useShopify(); return null; }
const root = createRoot(document.getElementById('root'));
const quiet = console.error;
console.error = () => {};
await runAct(async () => {
  root.render(React.createElement(sdk.ShopifyProvider, { config: CONFIG, storage: saved, waitlistStorageKey: KEY, onEvent: (e) => events.push(e) },
    React.createElement(Probe)));
});
await runAct(async () => { await settle(); await settle(); });
console.error = quiet;
await check("with no network the cart can't load, yet the waitlist is there, details and all", () => {
  assert.equal(api.ready, true);
  assert.deepEqual(api.waitlist.ids, [V(5)]);
  assert.equal(api.waitlist.items[0].variant?.product.title, 'Product 5');
  assert.equal(api.waitlist.has(V(5)), true);
});
await runAct(async () => { await api.waitlist.add({ variantId: V(6), productHandle: 'p-6' }); });
await check('joining emits waitlist:add with "Added to waitlist"', () => {
  const e = events.find((x) => x.type === 'waitlist:add');
  assert.equal(e?.message, 'Added to waitlist');
  assert.equal(e?.severity, 'success');
  assert.deepEqual(api.waitlist.ids, [V(6), V(5)]);
});
await runAct(async () => { await api.waitlist.remove(V(6)); });
await check('leaving emits waitlist:remove with no message, so no toast', () => {
  const e = events.find((x) => x.type === 'waitlist:remove');
  assert.ok(e);
  assert.equal(e.message, undefined);
});
await runAct(async () => root.unmount());

console.log(`\n${pass} checks passed`);
