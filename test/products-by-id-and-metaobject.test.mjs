// `useProductsById` and `useMetaobject` (0.17.0) rendered in jsdom with the real ShopifyProvider and the
// Storefront API stubbed at `fetch`: products by id in the order given, read once per session, missing
// ones left out; a metaobject's fields with their picture and collection, read once, read again on refresh.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
/** The store's products by id; anything else answers null, as Shopify's `nodes(ids:)` does. */
const STORE = {
  'gid://shopify/Product/1': 'ring',
  'gid://shopify/Product/2': 'band',
  'gid://shopify/Product/3': 'charm',
};
const productNode = (id) => ({
  __typename: 'Product', id, handle: STORE[id], title: STORE[id].toUpperCase(), availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('10.00') },
  compareAtPriceRange: { minVariantPrice: money('0.00'), maxVariantPrice: money('0.00') },
  featuredImage: { url: `https://cdn.shopify.com/${STORE[id]}.jpg`, altText: null, width: 1, height: 1 },
  images: { nodes: [] }, media: { nodes: [] }, variants: { nodes: [] }, options: [], tags: [],
});
const METAOBJECT = {
  id: 'gid://shopify/Metaobject/9', type: 'home_hero',
  fields: [
    { key: 'title', value: 'New & RARE Luxury Drop', reference: null },
    { key: 'image', value: 'gid://shopify/MediaImage/5', reference: { image: { url: 'https://cdn.shopify.com/hero.jpg' } } },
    { key: 'collection', value: 'gid://shopify/Collection/7', reference: { handle: 'new-drops' } },
    { key: 'show_button', value: 'true', reference: null },
  ],
};

const sent = [];
const fail = { nodes: false };
global.fetch = async (_url, init = {}) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  sent.push({ name, variables });
  if (name === 'WishlistNodes') {
    if (fail.nodes) return response(500, 'boom');
    return response(200, { data: { nodes: variables.ids.map((id) => (STORE[id] ? productNode(id) : null)) } });
  }
  // The provider makes a cart when it starts; an empty one does.
  if (name === 'CartCreate' || name === 'CartGet') {
    const cart = {
      id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [], totalQuantity: 0,
      buyerIdentity: { countryCode: 'US', email: null, phone: null }, lines: { nodes: [] },
      cost: { subtotalAmount: money('0.00'), totalAmount: money('0.00') },
      discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
    };
    return response(200, { data: name === 'CartCreate' ? { cartCreate: { cart, userErrors: [] } } : { cart } });
  }
  if (name === 'MetaobjectById') {
    return response(200, { data: { metaobject: variables.id === METAOBJECT.id ? METAOBJECT : null } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useProductsById, useMetaobject, clearProductsById, clearMetaobjects, clearRequestCache } = await import('../dist/index.js');

const t = harness('products by id, and a metaobject');
const count = (name) => sent.filter((call) => call.name === name).length;
const settle = (ms = 30) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });

/** Mounts a probe under the provider; `read()` is the hook's latest answer. */
async function mount(useHook) {
  let latest = null;
  function Probe() {
    latest = useHook();
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth: { method: 'password', secureStorage: keychain() } },
      React.createElement(Probe),
    ));
  });
  await settle();
  return { read: () => latest, unmount: () => runAct(async () => root.unmount()) };
}

t.section('useProductsById');
await t.check('the products in the order asked, read in one batch; one the store no longer has is left out', async () => {
  const before = count('WishlistNodes');
  const probe = await mount(() => useProductsById(['gid://shopify/Product/3', 'gid://shopify/Product/404', 'gid://shopify/Product/1']));
  const state = probe.read();
  assert.equal(count('WishlistNodes') - before, 1);
  assert.deepEqual(state.products.map((product) => product.handle), ['charm', 'ring']);
  assert.equal(state.byId['gid://shopify/Product/1'].handle, 'ring');
  assert.equal(state.loading, false);
  assert.equal(state.error, false);
  await probe.unmount();
});

await t.check('a second list naming the same products reads nothing again; a new id is read alone', async () => {
  const before = sent.length;
  const probe = await mount(() => useProductsById(['gid://shopify/Product/1', 'gid://shopify/Product/2']));
  const calls = sent.slice(before).filter((call) => call.name === 'WishlistNodes');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].variables.ids, ['gid://shopify/Product/2']);
  assert.deepEqual(probe.read().products.map((product) => product.handle), ['ring', 'band']);
  await probe.unmount();
});

await t.check('no ids: nothing read, nothing shown', async () => {
  const before = count('WishlistNodes');
  const probe = await mount(() => useProductsById([]));
  assert.equal(count('WishlistNodes'), before);
  assert.deepEqual(probe.read().products, []);
  await probe.unmount();
});

await t.check('a failed read says so', async () => {
  // Both caches emptied: this session's products, and the SDK's recent answers.
  clearProductsById();
  clearRequestCache();
  fail.nodes = true;
  const probe = await mount(() => useProductsById(['gid://shopify/Product/2']));
  assert.equal(probe.read().error, true);
  assert.deepEqual(probe.read().products, []);
  fail.nodes = false;
  await probe.unmount();
});

t.section('useMetaobject');
await t.check("each field's value, with the picture's URL and the collection's handle", async () => {
  const probe = await mount(() => useMetaobject('gid://shopify/Metaobject/9'));
  const { fields, metaobject, loading } = probe.read();
  assert.equal(loading, false);
  assert.equal(metaobject.type, 'home_hero');
  assert.deepEqual(fields.title, { value: 'New & RARE Luxury Drop', imageUrl: null, collectionHandle: null });
  assert.equal(fields.image.imageUrl, 'https://cdn.shopify.com/hero.jpg');
  assert.equal(fields.collection.collectionHandle, 'new-drops');
  assert.equal(fields.show_button.value, 'true');
  await probe.unmount();
});

await t.check('read once a session; refresh reads it again', async () => {
  const before = count('MetaobjectById');
  const probe = await mount(() => useMetaobject('gid://shopify/Metaobject/9'));
  assert.equal(count('MetaobjectById'), before);
  assert.equal(probe.read().fields.title.value, 'New & RARE Luxury Drop');
  await runAct(async () => probe.read().refresh());
  await settle();
  assert.equal(count('MetaobjectById'), before + 1);
  await probe.unmount();
});

await t.check('no such entry: no fields; no id: nothing read', async () => {
  clearMetaobjects();
  clearRequestCache();
  const missing = await mount(() => useMetaobject('gid://shopify/Metaobject/404'));
  assert.equal(missing.read().metaobject, null);
  assert.deepEqual(missing.read().fields, {});
  await missing.unmount();
  const before = count('MetaobjectById');
  const none = await mount(() => useMetaobject(null));
  assert.equal(count('MetaobjectById'), before);
  await none.unmount();
});

t.done();
