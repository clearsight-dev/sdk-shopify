// The device store (MMKV on native, localStorage on web), the product store every product read
// feeds, and the cache-first hooks on top: useProduct, useCollectionProducts, useSearch.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);

// ── Storefront stub ─────────────────────────────────────────────────────────
const money = (amount) => ({ amount, currencyCode: 'USD' });
const node = (i) => ({
  id: `gid://shopify/Product/${i}`, handle: `p-${i}`, title: `Product ${i}`,
  description: 'A long description '.repeat(20), descriptionHtml: '<p>long</p>',
  vendor: 'V', productType: 'T', tags: [], totalInventory: 5, availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('12.00') },
  compareAtPriceRange: { minVariantPrice: money('15.00'), maxVariantPrice: money('15.00') },
  options: [], variants: { nodes: [{ id: `gid://shopify/ProductVariant/${i}`, title: 'Default', availableForSale: true, price: money('10.00') }] },
  images: { nodes: [{ url: `https://cdn.test/${i}.jpg`, altText: null }] },
  featuredImage: { url: `https://cdn.test/${i}.jpg`, altText: null, width: 800, height: 1200 },
  onlineStoreUrl: null, media: { nodes: [] }, updatedAt: '', createdAt: '',
});
const pageInfo = (hasNextPage, endCursor) => ({ hasNextPage, hasPreviousPage: false, startCursor: null, endCursor });
const emptyCart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money('0'), totalAmount: money('0') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
};
const calls = {};
const count = (name) => calls[name] ?? 0;
const behave = { productMissing: false, productFails: false };
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(query) || [])[1] || 'anon';
  calls[name] = count(name) + 1;
  await new Promise((r) => setTimeout(r, 5));
  const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) });
  if (name === 'ShopInfo') return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } });
  if (name === 'CartCreate') return reply({ cartCreate: { cart: emptyCart, userErrors: [] } });
  if (name === 'CartGet') return reply({ cart: emptyCart });
  if (name === 'CollectionProducts') {
    return reply({ collection: { handle: variables.handle, title: 'New Arrivals',
      products: { nodes: [1, 2, 3].map(node), filters: [], pageInfo: pageInfo(false, 'c-end') } } });
  }
  if (name === 'SearchProducts') {
    const second = variables.after === 's1';
    return reply({ search: { totalCount: 5, productFilters: [],
      nodes: (second ? [5, 6] : [2, 3, 4]).map(node), pageInfo: pageInfo(!second, second ? 's2' : 's1') } });
  }
  if (name === 'ProductByHandle') {
    if (behave.productFails) return { ok: false, status: 500, statusText: 'err', text: async () => 'boom' };
    if (behave.productMissing) return reply({ product: null });
    const i = Number(String(variables.handle).replace('p-', ''));
    return reply({ product: { ...node(i), variants: { nodes: [
      { id: `gid://shopify/ProductVariant/${i}`, title: 'S', availableForSale: true, price: money('10.00') },
      { id: `gid://shopify/ProductVariant/${i}0`, title: 'M', availableForSale: true, price: money('12.00') },
    ] } } });
  }
  return reply({});
};

const sdk = await import('../dist/index.js');
const { shopify, clearRequestCache, peekProduct, PRODUCT_BASE_KEYS, ShopifyProvider, useProduct, useCollectionProducts, useSearch } = sdk;
const store = await import('../dist/productStore.js');
const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', country: 'US' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** What a cold start looks like: the process forgot everything, the device kept its store. */
const coldStart = () => { store.resetProductStoreMemory(); clearRequestCache(); };
const storedKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('tiledev.sdk-shopify:v3:'));

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };

// ── Device store ────────────────────────────────────────────────────────────
console.log('device store');
await check('web build: localStorage', async () => {
  const web = require('../dist/deviceStore.js');
  web.setDeviceStore(null);
  assert.equal(web.deviceStore().kind, 'localStorage');
});

function nativeStore(mmkv) {
  const file = require.resolve('../dist/deviceStore.native.js');
  delete require.cache[file];
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'react-native-mmkv') {
      if (!mmkv) throw new Error("Cannot find module 'react-native-mmkv'");
      return mmkv;
    }
    return load.call(this, request, ...rest);
  };
  try {
    return require(file).deviceStore();
  } finally {
    Module._load = load;
  }
}
await check('native build: MMKV 3, in its own instance', async () => {
  const data = new Map();
  let id;
  class MMKV {
    constructor(config) { id = config.id; }
    getString(k) { return data.get(k); }
    set(k, v) { data.set(k, v); }
    delete(k) { data.delete(k); }
    getAllKeys() { return [...data.keys()]; }
  }
  const s = nativeStore({ MMKV });
  assert.equal(s.kind, 'mmkv');
  assert.equal(id, 'tiledev.sdk-shopify');
  s.set('a', '1');
  assert.equal(s.get('a'), '1');
  assert.deepEqual(s.keys(), ['a']);
  s.remove('a');
  assert.equal(s.get('a'), undefined);
});
await check('native build without MMKV in the binary: memory, no crash', async () => {
  assert.equal(nativeStore(null).kind, 'memory');
});

// ── Product store ───────────────────────────────────────────────────────────
console.log('product store');
await shopify.init(CONFIG);

await check('a collection read records the base keys of every product, and only those', async () => {
  // Left by earlier SDKs (schema v1, and v2 whose variants had no sellingPlan): cleared by the
  // session's prune, checked further down.
  localStorage.setItem('tiledev.sdk-shopify:v1:abc:b:gid://shopify/Product/1', '{"b":{},"t":1}');
  localStorage.setItem('tiledev.sdk-shopify:v2:abc:b:gid://shopify/Product/1', '{"b":{},"t":1}');
  await shopify.collections.products('new-arrivals', { first: 12 });
  const entry = peekProduct('p-1');
  assert.ok(entry, 'known after a collection read');
  assert.deepEqual(Object.keys(entry.base).sort(), [...PRODUCT_BASE_KEYS].sort());
  assert.equal(entry.base.title, 'Product 1');
  assert.equal(entry.full, null);
  assert.equal(peekProduct('gid://shopify/Product/2')?.handle, 'p-2', 'found by GID as well as handle');
});

await check('a list read keeps what the picker and description need, not only title, image and price', async () => {
  const base = peekProduct('p-1')?.base;
  assert.equal(base?.variants.length, 1);
  assert.equal(base?.variants[0].id, 'gid://shopify/ProductVariant/1');
  assert.deepEqual(base?.options, []);
  assert.equal(typeof base?.description, 'string');
  assert.equal(typeof base?.descriptionHtml, 'string');
  assert.equal(typeof base?.availableForSale, 'boolean');
  assert.ok(Array.isArray(base?.tags));
});

await check('the base keys survive a cold start: read back from the device', async () => {
  assert.ok(storedKeys().some((k) => k.includes(':b:gid://shopify/Product/1')));
  coldStart();
  assert.equal(peekProduct('p-1')?.base.title, 'Product 1');
});

await check('a product read records the full product, which also survives a cold start', async () => {
  await shopify.products.byHandle('p-1');
  assert.equal(peekProduct('p-1')?.full?.variants.length, 2);
  coldStart();
  assert.equal(peekProduct('p-1')?.full?.variants.length, 2);
});

await check('cold start, then a grid read, then the page: the full product from the device still counts', async () => {
  await shopify.products.byHandle('p-1');
  coldStart();
  // The grid loads first after a launch, recording base keys into an empty memory.
  await shopify.collections.products('new-arrivals', { first: 12 });
  assert.equal(peekProduct('p-1')?.full?.variants.length, 2);
});

await check('another market never sees these entries', async () => {
  await shopify.init({ ...CONFIG, country: 'CA' });
  assert.equal(peekProduct('p-1'), null);
  await shopify.init(CONFIG);
  assert.ok(peekProduct('p-1'));
});

await check('an entry older than 7 days is dropped, and removed from the device', async () => {
  const k = storedKeys().find((key) => key.includes(':b:gid://shopify/Product/3'));
  const entry = JSON.parse(localStorage.getItem(k));
  entry.t = Date.now() - 8 * 24 * 60 * 60 * 1000;
  localStorage.setItem(k, JSON.stringify(entry));
  coldStart();
  assert.equal(peekProduct('p-3'), null);
  assert.equal(localStorage.getItem(k), null);
});

await check('cache: false keeps nothing', async () => {
  await shopify.init({ ...CONFIG, cache: false });
  assert.equal(peekProduct('p-1'), null);
  await shopify.init(CONFIG);
});

// ── Hooks ───────────────────────────────────────────────────────────────────
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;

/** Mount `hook(props)` under a fresh provider; `renders[0]` is the very first render. */
async function mount(useHook) {
  const renders = [];
  function Probe() {
    renders.push(useHook());
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await runAct(async () => {
    root.render(React.createElement(ShopifyProvider, { config: CONFIG }, React.createElement(Probe)));
  });
  const settle = async (ms = 80) => { await runAct(async () => { await wait(ms); }); };
  await settle();
  return { renders, last: () => renders[renders.length - 1], settle, unmount: () => runAct(async () => root.unmount()) };
}

console.log('useProduct');
await check('tapped in a grid: the FIRST render already has title, image and price', async () => {
  coldStart();
  await shopify.collections.products('new-arrivals', { first: 12 }); // the grid the shopper tapped in
  const before = count('ProductByHandle');
  const pdp = await mount(() => useProduct('p-2'));
  const first = pdp.renders[0];
  assert.equal(first.preview?.title, 'Product 2');
  assert.equal(first.preview?.featuredImage?.url, 'https://cdn.test/2.jpg');
  assert.equal(first.preview?.priceRange.min.amount, '10.00');
  assert.equal(first.level, 'base');
  assert.equal(first.loading, false);
  assert.equal(first.refreshing, true);
  assert.equal(first.product, null, 'not the full product yet (the gallery media)');
  assert.equal(first.preview?.variants.length, 1, 'but the picker can render: the variants came with the grid');
  const done = pdp.last();
  assert.equal(done.level, 'full');
  assert.equal(done.product?.variants.length, 2);
  assert.equal(done.refreshing, false);
  assert.equal(count('ProductByHandle') - before, 1);
  await pdp.unmount();
});

await check('back on it within a minute: full on the first render, no network', async () => {
  const before = count('ProductByHandle');
  const pdp = await mount(() => useProduct('p-2'));
  assert.equal(pdp.renders[0].level, 'full');
  assert.equal(pdp.renders[0].product?.variants.length, 2);
  assert.equal(count('ProductByHandle') - before, 0);
  await pdp.unmount();
});

await check('after a cold start, the full product still paints on the first render', async () => {
  coldStart();
  const pdp = await mount(() => useProduct('p-2'));
  assert.equal(pdp.renders[0].level, 'full');
  await pdp.unmount();
});

await check('never seen (a deep link): loading, then the full product', async () => {
  const pdp = await mount(() => useProduct('p-9'));
  assert.equal(pdp.renders[0].loading, true);
  assert.equal(pdp.renders[0].preview, null);
  assert.equal(pdp.last().level, 'full');
  await pdp.unmount();
});

await check('keys from earlier schemas (v1, v2) are cleared from the device, off the hot path', async () => {
  await wait(3100); // the session's prune runs 3 s after the first read
  assert.equal(localStorage.getItem('tiledev.sdk-shopify:v1:abc:b:gid://shopify/Product/1'), null);
  assert.equal(localStorage.getItem('tiledev.sdk-shopify:v2:abc:b:gid://shopify/Product/1'), null);
  assert.ok(storedKeys().length > 0, 'the current schema is kept');
});

await check('a product Shopify no longer has: notFound', async () => {
  behave.productMissing = true;
  const pdp = await mount(() => useProduct('p-77'));
  behave.productMissing = false;
  assert.equal(pdp.last().notFound, true);
  await pdp.unmount();
});

await check('a failed read keeps the cached preview on screen', async () => {
  coldStart();
  await shopify.collections.products('new-arrivals', { first: 12 });
  behave.productFails = true;
  const pdp = await mount(() => useProduct('p-3'));
  behave.productFails = false;
  assert.equal(pdp.last().preview?.title, 'Product 3');
  assert.equal(pdp.last().error, true);
  await pdp.unmount();
});

await check('refresh() goes to the network even when the copy is recent', async () => {
  const pdp = await mount(() => useProduct('p-2'));
  const before = count('ProductByHandle');
  await runAct(async () => { pdp.last().refresh(); });
  await pdp.settle();
  assert.equal(count('ProductByHandle') - before, 1);
  await pdp.unmount();
});

console.log('useCollectionProducts, cache first');
await check('cold start: the last first page paints on the first render, then revalidates', async () => {
  const grid = await mount(() => useCollectionProducts({ handle: 'new-arrivals', pageSize: 12 }));
  await grid.unmount();
  // Age the stored page past the revalidation window, then start cold.
  const k = storedKeys().find((key) => key.includes(':l:'));
  const list = JSON.parse(localStorage.getItem(k));
  list.at = Date.now() - 2 * 60 * 1000;
  localStorage.setItem(k, JSON.stringify(list));
  coldStart();
  const before = count('CollectionProducts');
  const again = await mount(() => useCollectionProducts({ handle: 'new-arrivals', pageSize: 12 }));
  const first = again.renders[0];
  assert.equal(first.products.length, 3);
  assert.equal(first.loading, false);
  assert.equal(first.refreshing, true);
  assert.equal(first.products[0].descriptionHtml, '', 'cards are stored without long descriptions');
  assert.equal(again.last().refreshing, false);
  assert.equal(count('CollectionProducts') - before, 1);
  await again.unmount();
});

await check('a first page under a minute old is shown without any network read', async () => {
  coldStart();
  const before = count('CollectionProducts');
  const grid = await mount(() => useCollectionProducts({ handle: 'new-arrivals', pageSize: 12 }));
  assert.equal(grid.renders[0].products.length, 3);
  assert.equal(grid.last().refreshing, false);
  assert.equal(count('CollectionProducts') - before, 0);
  await grid.unmount();
});

console.log('useSearch');
await check('typing is debounced: one request for the settled term', async () => {
  const before = count('SearchProducts');
  let term = 'd';
  let setTerm;
  const search = await mount(() => {
    const [t, set] = React.useState(term);
    setTerm = set;
    return useSearch(t, { debounceMs: 30 });
  });
  const firstCalls = count('SearchProducts') - before;
  await runAct(async () => { setTerm('dr'); });
  await runAct(async () => { setTerm('dress'); });
  // The debounce fires inside act's async scope, which holds the update until the scope ends, so
  // the settled term's request starts as the first settle returns; the second lets it land.
  await search.settle(120);
  await search.settle();
  assert.equal(search.last().query, 'dress');
  assert.equal(count('SearchProducts') - before - firstCalls, 1, 'dr was never searched');
  assert.equal(search.last().products.length, 3);
  assert.equal(search.last().totalCount, 5);
  // Search results feed the product store too: a result opens its product page instantly.
  assert.equal(peekProduct('p-4')?.base.title, 'Product 4');
  // Paging by cursor.
  await runAct(async () => { search.last().loadMore(); });
  await search.settle();
  assert.equal(search.last().products.length, 5);
  assert.equal(search.last().hasMore, false);
  await search.unmount();
});

await check('an empty term reads nothing', async () => {
  const before = count('SearchProducts');
  const search = await mount(() => useSearch('   '));
  assert.equal(search.last().products.length, 0);
  assert.equal(search.last().loading, false);
  assert.equal(count('SearchProducts') - before, 0);
  await search.unmount();
});

console.log(`\n${pass} checks passed`);
