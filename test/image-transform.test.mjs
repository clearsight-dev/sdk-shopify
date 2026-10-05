// imageTransform on every call that returns images: omitted, nothing about the request changes;
// passed, it is sent as $imageTransform, which request() declares on the operation.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const pageInfo = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
const money = { amount: '1.00', currencyCode: 'USD' };
const emptyCart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
};
/** Minimal answers per operation, enough for each call to return cleanly. */
const ANSWERS = {
  ShopInfo: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } },
  Products: { products: { nodes: [], pageInfo } },
  ProductByHandle: { product: null },
  ProductById: { product: null },
  WishlistNodes: { nodes: [] },
  SearchProducts: { search: { nodes: [], pageInfo, productFilters: [], totalCount: 0 } },
  Recommended: { productRecommendations: [] },
  Collections: { collections: { nodes: [], pageInfo } },
  CollectionByHandle: { collection: null },
  CollectionProducts: { collection: { handle: 'h', title: 'H', products: { nodes: [], pageInfo, filters: [] } } },
  VariantNodes: { nodes: [] },
  CartGet: { cart: emptyCart },
  CartCreate: { cartCreate: { cart: emptyCart, userErrors: [] } },
  CartLinesAdd: { cartLinesAdd: { cart: emptyCart, userErrors: [] } },
  CustomerOrders: { customer: null },
  BlogArticles: { blog: null },
  BlogArticleByHandle: { blog: null },
  Customer: { customer: null },
};
const sent = [];
global.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(body.query) || [])[1];
  sent.push({ name, query: body.query, variables: body.variables });
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: ANSWERS[name] ?? {} }) };
};
const last = (name) => [...sent].reverse().find((s) => s.name === name);
const declares = (query) => /\((?:[^()]*,\s*)?\$imageTransform: ImageTransformInput\)/.test(query.match(/(?:query|mutation) \w+\s*\([^)]*\)/)?.[0] ?? '');

const { shopify, useCollectionProducts, ShopifyProvider } = await import('../dist/index.js');
const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', cache: false };
await shopify.init(CONFIG);

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };
const T = { maxWidth: 330, scale: 2, preferredContentType: 'WEBP' };

console.log('imageTransform on every call that returns images');
const CALLS = [
  ['Products', (o) => shopify.products.list({ first: 1, ...o })],
  ['ProductByHandle', (o) => shopify.products.byHandle('h', o)],
  ['ProductById', (o) => shopify.products.byId('gid://shopify/Product/1', o)],
  ['WishlistNodes', (o) => shopify.products.byIds(['gid://shopify/Product/1'], o)],
  ['SearchProducts', (o) => shopify.products.search('q', { first: 1, ...o })],
  ['Recommended', (o) => shopify.products.recommended('gid://shopify/Product/1', o)],
  ['Collections', (o) => shopify.collections.list({ first: 1, ...o })],
  ['CollectionByHandle', (o) => shopify.collections.byHandle('h', o)],
  ['CollectionProducts', (o) => shopify.collections.products('h', { first: 1, ...o })],
  ['VariantNodes', (o) => shopify.variants.byIds(['gid://shopify/ProductVariant/1'], o)],
  ['CartGet', (o) => shopify.cart.get('gid://shopify/Cart/1', o)],
  ['CartLinesAdd', (o) => shopify.cart.addLines('gid://shopify/Cart/1', [{ merchandiseId: 'v', quantity: 1 }], o)],
  ['CustomerOrders', (o) => shopify.customer.orders('tok', { first: 1, ...o })],
  ['BlogArticles', (o) => shopify.blogs.articles('news', { first: 1, ...o })],
  ['BlogArticleByHandle', (o) => shopify.blogs.articleByHandle('news', 'a', o)],
];

await check('omitted: no $imageTransform is sent, so every URL is the original (as before)', async () => {
  for (const [name, call] of CALLS) {
    await call({});
    const req = last(name);
    assert.ok(req, `${name} was sent`);
    assert.equal('imageTransform' in (req.variables ?? {}), false, `${name} sent no transform`);
    assert.ok(declares(req.query), `${name} declares the (null) variable its fragments use`);
  }
});

await check('passed: every call sends it as $imageTransform', async () => {
  for (const [name, call] of CALLS) {
    await call({ imageTransform: T });
    assert.deepEqual(last(name).variables.imageTransform, T, name);
  }
});

await check('the fragments ask for url(transform: $imageTransform), media included', async () => {
  const q = last('ProductByHandle').query;
  assert.match(q, /fragment ImageFields on Image \{[\s\S]*?url\(transform: \$imageTransform\)/);
  assert.match(q, /previewImage \{ url\(transform: \$imageTransform\) width height \}/);
  assert.match(q, /\.\.\. on MediaImage \{ id image \{ url\(transform: \$imageTransform\) altText width height \} \}/);
  assert.equal((q.match(/\$imageTransform: ImageTransformInput/g) || []).length, 1, 'declared exactly once');
});

await check('operations with no images are untouched', async () => {
  await shopify.customer.profile('tok');
  assert.equal(/imageTransform/.test(last('Customer').query), false);
  assert.equal(/imageTransform/.test(sent.find((s) => s.name === 'ShopInfo').query), false);
});

console.log('provider-run reads: imageTransforms in the config');
await check('cart: the config default applies when a call passes none; a call\'s own wins', async () => {
  await shopify.init({ ...CONFIG, imageTransforms: { cart: { maxWidth: 120 } } });
  await shopify.cart.get('gid://shopify/Cart/1');
  assert.deepEqual(last('CartGet').variables.imageTransform, { maxWidth: 120 });
  await shopify.cart.get('gid://shopify/Cart/1', { imageTransform: { maxWidth: 64 } });
  assert.deepEqual(last('CartGet').variables.imageTransform, { maxWidth: 64 });
  await shopify.cart.create({});
  assert.deepEqual(last('CartCreate').variables.imageTransform, { maxWidth: 120 });
  // The default is the cart's only: a product read still gets originals.
  await shopify.products.byHandle('h');
  assert.equal('imageTransform' in last('ProductByHandle').variables, false);
  await shopify.init(CONFIG);
});

console.log('caching');
await check('each transform is its own cache entry; the same one is shared', async () => {
  await shopify.init({ ...CONFIG, cache: undefined });
  const before = sent.filter((s) => s.name === 'CollectionProducts').length;
  await shopify.collections.products('cached', { first: 2, imageTransform: { maxWidth: 100 } });
  await shopify.collections.products('cached', { first: 2, imageTransform: { maxWidth: 100 } });
  await shopify.collections.products('cached', { first: 2, imageTransform: { maxWidth: 200 } });
  await shopify.collections.products('cached', { first: 2 });
  assert.equal(sent.filter((s) => s.name === 'CollectionProducts').length - before, 3);
});

console.log('hooks');
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
await check('useCollectionProducts passes its imageTransform', async () => {
  let feed;
  function Grid() {
    feed = useCollectionProducts({ handle: 'grid-h', pageSize: 6, imageTransform: { maxWidth: 330, scale: 2 } });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await runAct(async () => {
    root.render(React.createElement(ShopifyProvider, { config: { ...CONFIG, cache: undefined } }, React.createElement(Grid)));
  });
  await runAct(async () => { await new Promise((r) => setTimeout(r, 60)); });
  const req = [...sent].reverse().find((s) => s.name === 'CollectionProducts' && s.variables.handle === 'grid-h');
  assert.deepEqual(req.variables.imageTransform, { maxWidth: 330, scale: 2 });
  assert.equal(feed.loading, false);
  await runAct(async () => { root.unmount(); });
});

console.log(`\n${pass} checks passed`);
