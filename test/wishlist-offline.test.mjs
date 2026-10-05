// The wishlist works offline: what it stores, what it reads (its own shape, sdk-shopify's older one
// and Apptile's engine's), the one-time merge of an earlier app's key, the guards that never lose a
// list, and the provider loading it when the cart can't load.
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
const net = { online: true, descriptionSize: 20 };
const productNode = (id) => {
  const n = id.split('/').pop();
  return {
    __typename: 'Product',
    id, handle: `p-${n}`, title: `Product ${n}`,
    description: 'd'.repeat(net.descriptionSize), descriptionHtml: '<p>d</p>',
    vendor: 'V', productType: 'T', tags: ['SEARCH-BLOCKED'], totalInventory: 5, availableForSale: true,
    priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('12.00') },
    compareAtPriceRange: { minVariantPrice: money('15.00'), maxVariantPrice: money('15.00') },
    options: [{ id: 'o1', name: 'Size', values: ['S', 'M'] }],
    variants: { nodes: [
      { id: `gid://shopify/ProductVariant/${n}1`, title: 'S', availableForSale: true, price: money('10.00') },
      { id: `gid://shopify/ProductVariant/${n}2`, title: 'M', availableForSale: false, price: money('12.00') },
    ] },
    images: { nodes: [1, 2, 3].map((k) => ({ url: `https://cdn.test/${n}-${k}.jpg`, altText: null })) },
    featuredImage: { url: `https://cdn.test/${n}-1.jpg`, altText: null, width: 800, height: 800 },
    onlineStoreUrl: null,
    media: { nodes: [{ mediaContentType: 'VIDEO' }, { mediaContentType: 'IMAGE' }] },
    updatedAt: '', createdAt: '',
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
  if (name === 'WishlistNodes') return reply({ nodes: variables.ids.map((id) => (id.endsWith('/404') ? null : productNode(id))) });
  return reply({});
};

const sdk = await import('../dist/index.js');
const { shopify, clearRequestCache, peekProduct } = sdk;
const store = await import('../dist/productStore.js');
const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', country: 'US' };
await shopify.init(CONFIG);

/** An AsyncStorage-like adapter over a plain object, so a test can read and seed what's stored. */
function memory(seed = {}) {
  const data = { ...seed };
  const writes = [];
  return {
    data,
    writes,
    getItem: async (k) => (k in data ? data[k] : null),
    setItem: async (k, v) => { writes.push(k); data[k] = String(v); },
    removeItem: async (k) => { delete data[k]; },
  };
}
const APPTILE_KEY = '6f314dd7-2bf7-4451-9d2f-4e4affb0c1a0_WishlistProducts';
const SDK_KEY = 'tile:shopify:wishlist:v1';
const stored = (s, key = APPTILE_KEY) => JSON.parse(s.data[key]);
/** sdk-shopify ≤0.8's own check: an older bundle (an OTA rollback) keeps only entries passing it. */
const oldSdkAccepts = (v) =>
  v && typeof v === 'object' && typeof v.productId === 'string' && typeof v.addedAt === 'number' && v.basic && typeof v.basic === 'object';
const settle = () => new Promise((r) => setTimeout(r, 20));

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };

console.log("Apptile's key, read and written");
const s1 = memory({ [APPTILE_KEY]: JSON.stringify([{ id: '8680645656811', handle: 'tigers-sequin-tee' }]) });
await shopify.wishlist.init({ storage: s1, storageKey: APPTILE_KEY, hydrateOnInit: false });
await check("an Apptile entry {id, handle} becomes the product's GID, with its handle", () => {
  const [item] = shopify.wishlist.list();
  assert.equal(item.productId, 'gid://shopify/Product/8680645656811');
  assert.equal(item.basic.handle, 'tigers-sequin-tee');
  assert.equal(item.product, undefined);
});
await shopify.wishlist.refresh();
await check('a refresh stores the product with the entry, trimmed: one image, no media list, hasVideo kept', () => {
  const [entry] = stored(s1);
  assert.equal(entry.product.title, 'Product 8680645656811');
  assert.equal(entry.product.images.length, 1);
  assert.deepEqual(entry.product.media, []);
  assert.deepEqual(entry.product.mediaContentTypes, []);
  assert.equal(entry.product.hasVideo, true);
  assert.equal(entry.product.variants.length, 2);
});
await check("each entry keeps Apptile's fields (numeric id, handle) and passes an older SDK's check", () => {
  const [entry] = stored(s1);
  assert.equal(entry.id, '8680645656811');
  // The handle as the store has it now (the stub renames it), kept at the top level as Apptile's was.
  assert.equal(entry.handle, 'p-8680645656811');
  assert.equal(entry.productId, 'gid://shopify/Product/8680645656811');
  assert.equal(oldSdkAccepts(entry), true);
});

console.log('offline');
net.online = false;
store.clearProductStore();
store.resetProductStoreMemory();
clearRequestCache();
await shopify.wishlist.init({ storage: s1, storageKey: APPTILE_KEY });
await settle();
await check('a launch with no network draws every saved product from the device', () => {
  const [item] = shopify.wishlist.list();
  assert.equal(item.product?.title, 'Product 8680645656811');
  assert.equal(item.product?.priceRange.min.amount, '10.00');
});
await check("the launch's failed background refresh keeps the stored products", () => {
  assert.equal(stored(s1)[0].product.title, 'Product 8680645656811');
  assert.equal(shopify.wishlist.list()[0].product?.title, 'Product 8680645656811');
});
await check('a refresh that fails rejects and changes nothing', async () => {
  const before = s1.data[APPTILE_KEY];
  await assert.rejects(shopify.wishlist.refresh());
  assert.equal(s1.data[APPTILE_KEY], before);
  assert.equal(shopify.wishlist.list()[0].product?.title, 'Product 8680645656811');
});
await check("a saved product seeds the product store, so its product page has an instant view offline", () => {
  const cached = peekProduct('gid://shopify/Product/8680645656811');
  assert.equal(cached?.base.title, 'Product 8680645656811');
  assert.equal(cached?.base.variants.length, 2);
});
await check('un-starring deletes its stored details with the entry', async () => {
  await shopify.wishlist.remove('gid://shopify/Product/8680645656811');
  assert.deepEqual(stored(s1), []);
});
net.online = true;

console.log('merging an earlier key, once');
const s2 = memory({
  [APPTILE_KEY]: JSON.stringify([{ id: '1', handle: 'p-1' }, { id: '3', handle: 'p-3' }]),
  [SDK_KEY]: JSON.stringify([
    { productId: 'gid://shopify/Product/2', basic: { handle: 'p-2', title: 'Two' }, addedAt: 2000 },
    { productId: 'gid://shopify/Product/1', basic: { handle: 'p-1' }, addedAt: 1000 },
  ]),
});
const sdkKeyBefore = s2.data[SDK_KEY];
await shopify.wishlist.init({ storage: s2, storageKey: APPTILE_KEY, migrateFrom: [SDK_KEY], hydrateOnInit: false });
await check('both lists merge without duplicates, dated entries first, newest first', () => {
  assert.deepEqual(shopify.wishlist.list().map((i) => i.productId), [
    'gid://shopify/Product/2', 'gid://shopify/Product/1', 'gid://shopify/Product/3',
  ]);
  assert.equal(stored(s2).length, 3);
});
await check('the earlier key is left exactly as it was, and the merge is recorded', () => {
  assert.equal(s2.data[SDK_KEY], sdkKeyBefore);
  assert.deepEqual(JSON.parse(s2.data[`${APPTILE_KEY}:merged`]), [SDK_KEY]);
});
await shopify.wishlist.remove('gid://shopify/Product/2');
await shopify.wishlist.init({ storage: s2, storageKey: APPTILE_KEY, migrateFrom: [SDK_KEY], hydrateOnInit: false });
await check('a product un-starred after the merge does not come back from the earlier key', () => {
  assert.equal(shopify.wishlist.has('gid://shopify/Product/2'), false);
  assert.equal(shopify.wishlist.count(), 2);
});

console.log('never losing a list');
const s3 = memory({ [APPTILE_KEY]: 'not a list{' });
await shopify.wishlist.init({ storage: s3, storageKey: APPTILE_KEY, hydrateOnInit: false });
await shopify.wishlist.add('gid://shopify/Product/7', { handle: 'p-7' });
await check('a value that is not a list is copied aside before the first write replaces it', () => {
  assert.equal(s3.data[`${APPTILE_KEY}:unreadable`], 'not a list{');
  assert.equal(stored(s3)[0].productId, 'gid://shopify/Product/7');
});
const s4 = memory({ [APPTILE_KEY]: JSON.stringify([{ id: '9', handle: 'p-9' }]) });
const failingRead = { ...s4, getItem: async (k) => { if (k === APPTILE_KEY) throw new Error('Row too big'); return s4.getItem(k); } };
await shopify.wishlist.init({ storage: failingRead, storageKey: APPTILE_KEY, hydrateOnInit: false });
await shopify.wishlist.add('gid://shopify/Product/8', { handle: 'p-8' });
await shopify.wishlist.clear();
await check('a list that could not be read is never written over, nor cleared, that session', () => {
  assert.deepEqual(JSON.parse(s4.data[APPTILE_KEY]), [{ id: '9', handle: 'p-9' }]);
  assert.equal(s4.writes.includes(APPTILE_KEY), false);
});

console.log('size budget');
net.descriptionSize = 60_000;
clearRequestCache();
const s5 = memory({ [APPTILE_KEY]: JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: String(100 + i), handle: `p-${100 + i}` }))) });
await shopify.wishlist.init({ storage: s5, storageKey: APPTILE_KEY, hydrateOnInit: false });
await shopify.wishlist.refresh();
net.descriptionSize = 20;
await check('the stored value stays under about 1 MB of details however many products are saved', () => {
  assert.ok(s5.data[APPTILE_KEY].length < 1_100_000, `stored ${s5.data[APPTILE_KEY].length} chars`);
});
await check('details are kept for the newest entries; older ones keep their id and handle, and load online', () => {
  const entries = stored(s5);
  assert.equal(entries.length, 40);
  assert.ok(entries[0].product, 'the newest keeps its details');
  assert.equal(entries.at(-1).product, undefined);
  assert.equal(entries.at(-1).id, '139');
  assert.equal(entries.at(-1).handle, 'p-139');
});

console.log('provider, offline');
// Saved online first, so the entry is exactly what this SDK writes.
const saved = memory({ [APPTILE_KEY]: JSON.stringify([{ id: '5', handle: 'p-5' }]) });
await shopify.wishlist.init({ storage: saved, storageKey: APPTILE_KEY, hydrateOnInit: false });
await shopify.wishlist.refresh();
net.online = false;
store.clearProductStore();
store.resetProductStoreMemory();
clearRequestCache();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
let api = null;
function Probe() { api = sdk.useShopify(); return null; }
const root = createRoot(document.getElementById('root'));
const quiet = console.error;
console.error = () => {};
await runAct(async () => {
  root.render(React.createElement(sdk.ShopifyProvider, { config: CONFIG, storage: saved, wishlistStorageKey: APPTILE_KEY, wishlistKeepDeleted: true },
    React.createElement(Probe)));
});
await runAct(async () => { await settle(); await settle(); });
console.error = quiet;
await check("with no network the cart can't load, yet the wishlist is there, products and all", () => {
  assert.equal(api.ready, true);
  assert.ok(api.error, 'the cart failure is still reported');
  assert.equal(api.wishlist.items.length, 1);
  assert.equal(api.wishlist.items[0].product?.title, 'Product 5');
});
await runAct(async () => root.unmount());

console.log(`\n${pass} checks passed`);
