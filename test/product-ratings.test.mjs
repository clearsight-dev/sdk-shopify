// Star ratings on products (0.20.0): Shopify's standard review metafields, `reviews.rating` (a rating's
// JSON) and `reviews.rating_count` (an integer), read into `product.rating`; null when missing or
// unreadable, never a throw. Every product read asks for both, beside the app's own metafields.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;

// ── Storefront stub ─────────────────────────────────────────────────────────
const money = (amount) => ({ amount, currencyCode: 'USD' });
const pageInfo = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
/** A `rating` metafield's value as review apps write it: every number a string. */
const ratingJson = (value, scaleMax = '5.0') => JSON.stringify({ scale_min: '1.0', scale_max: scaleMax, value });
/** What Storefront answers for the two identifiers: in their order, null where a product has none. */
const RATINGS = {
  1: [{ key: 'rating', value: ratingJson('4.6') }, { key: 'rating_count', value: '12' }],
  2: [null, null],
};
const productNode = (n) => ({
  __typename: 'Product',
  id: `gid://shopify/Product/${n}`, handle: `p-${n}`, title: `Product ${n}`,
  description: '', descriptionHtml: '', vendor: 'V', productType: 'T', tags: [], totalInventory: 5,
  availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('10.00') },
  compareAtPriceRange: { minVariantPrice: money('0.00'), maxVariantPrice: money('0.00') },
  options: [], variants: { nodes: [] }, images: { nodes: [] }, featuredImage: null, onlineStoreUrl: null,
  media: { nodes: [] }, updatedAt: '', createdAt: '',
  metafields: [{ namespace: 'custom', key: 'badge_text', value: 'Going Fast', type: 'single_line_text_field' }],
  ratingMetafields: RATINGS[n],
});
const emptyCart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money('0'), totalAmount: money('0') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
};
const ANSWERS = {
  ShopInfo: () => ({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } }),
  CartCreate: () => ({ cartCreate: { cart: emptyCart, userErrors: [] } }),
  CartGet: () => ({ cart: emptyCart }),
  Products: () => ({ products: { nodes: [productNode(1), productNode(2)], pageInfo } }),
  ProductByHandle: () => ({ product: productNode(1) }),
  ProductById: () => ({ product: productNode(1) }),
  WishlistNodes: ({ ids }) => ({ nodes: ids.map((id) => productNode(Number(id.split('/').pop()))) }),
  SearchProducts: () => ({ search: { totalCount: 2, nodes: [productNode(1), productNode(2)], pageInfo, productFilters: [] } }),
  Recommended: () => ({ productRecommendations: [productNode(1), productNode(2)] }),
  CollectionProducts: () => ({ collection: { handle: 'h', title: 'H', products: { nodes: [productNode(1), productNode(2)], pageInfo, filters: [] } } }),
};
const sent = [];
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(query) || [])[1] || 'anon';
  sent.push({ name, query });
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: ANSWERS[name]?.(variables) ?? {} }) };
};
const lastQuery = (name) => [...sent].reverse().find((call) => call.name === name)?.query ?? '';

const { productRatingFrom, RATING_METAFIELDS_SELECTION } = await import('../dist/ratings.js');
const queries = await import('../dist/queries.js');
const { shopify, peekProduct, PRODUCT_BASE_KEYS } = await import('../dist/index.js');

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };

// ── Reading a rating ────────────────────────────────────────────────────────
console.log('reading a rating');
const read = (rating, count) => productRatingFrom([
  rating === undefined ? null : { key: 'rating', value: rating },
  count === undefined ? null : { key: 'rating_count', value: count },
]);

await check('a rating and its count, as review apps write them', () => {
  assert.deepEqual(read(ratingJson('4.6'), '12'), { value: 4.6, scaleMax: 5, count: 12 });
  // Numbers rather than strings in the JSON, and the two metafields in either order.
  assert.deepEqual(productRatingFrom([
    { key: 'rating_count', value: '3' },
    { key: 'rating', value: JSON.stringify({ scale_min: 1, scale_max: 5, value: 4 }) },
  ]), { value: 4, scaleMax: 5, count: 3 });
});

await check('a scale other than 5 is kept as it is', () => {
  assert.deepEqual(read(ratingJson('8.5', '10.0'), '40'), { value: 8.5, scaleMax: 10, count: 40 });
  assert.deepEqual(read(ratingJson('3', '3'), '1'), { value: 3, scaleMax: 3, count: 1 });
});

await check('missing: no metafields, nulls where Storefront has none, only a count', () => {
  for (const raw of [undefined, null, [], [null, null], {}, 'rating', 4.6]) {
    assert.equal(productRatingFrom(raw), null, JSON.stringify(raw));
  }
  assert.equal(read(undefined, '12'), null, 'a count without a rating');
  assert.equal(productRatingFrom([{ key: 'other', value: ratingJson('4.6') }]), null);
});

await check('malformed: unreadable JSON, a bare number, no value, no scale, a bad scale', () => {
  const bad = [
    '4.6 stars', '{"value": 4.6', '4.6', 'null', '[]', '"4.6"',
    JSON.stringify({ scale_max: '5.0' }),
    JSON.stringify({ value: '', scale_max: '5.0' }),
    JSON.stringify({ value: 'four', scale_max: '5.0' }),
    JSON.stringify({ value: null, scale_max: '5.0' }),
    JSON.stringify({ value: true, scale_max: '5.0' }),
    JSON.stringify({ value: '4.6' }),
    JSON.stringify({ value: '4.6', scale_max: '0' }),
    JSON.stringify({ value: '4.6', scale_max: '-5' }),
    JSON.stringify({ value: '4.6', scale_max: 'five' }),
  ];
  for (const rating of bad) assert.equal(read(rating, '12'), null, rating);
  assert.equal(productRatingFrom([{ key: 'rating', value: { value: 4.6, scale_max: 5 } }]), null, 'a value that is not text');
  assert.equal(productRatingFrom([{ key: 'rating', value: null }]), null);
});

await check('kept on the scale: above the top is the top, below 0 is 0', () => {
  assert.equal(read(ratingJson('7.2'), '5').value, 5);
  assert.equal(read(ratingJson('-1'), '5').value, 0);
  assert.equal(read(ratingJson('0'), '0').value, 0);
});

await check('count missing or unreadable is 0; a fraction is rounded down; below 0 is 0', () => {
  assert.equal(read(ratingJson('4.6')).count, 0, 'no count metafield');
  assert.equal(read(ratingJson('4.6'), null).count, 0);
  assert.equal(read(ratingJson('4.6'), '').count, 0);
  assert.equal(read(ratingJson('4.6'), 'many').count, 0);
  assert.equal(read(ratingJson('4.6'), '12.7').count, 12);
  assert.equal(read(ratingJson('4.6'), '-3').count, 0);
  assert.deepEqual(read(ratingJson('4.6'), 'many'), { value: 4.6, scaleMax: 5, count: 0 }, 'the rating itself still shows');
});

// ── What every product read asks for ────────────────────────────────────────
console.log('what every product read asks for');
const RATING_ASKED = /ratingMetafields: metafields\(identifiers: \[\{namespace: "reviews", key: "rating"\}, \{namespace: "reviews", key: "rating_count"\}\]\) \{ key value \}/;

await check('the selection names both review metafields, under its own name', () => {
  assert.match(RATING_METAFIELDS_SELECTION, RATING_ASKED);
});

await shopify.init({
  storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', country: 'US',
  productMetafields: [{ namespace: 'custom', key: 'badge_text' }],
});

await check('both product fragments carry it: cards (ProductCardFields) and the product page (ProductFields)', () => {
  const built = Object.entries(queries)
    .map(([name, value]) => [name, typeof value === 'function' ? value() : value])
    .filter(([, text]) => typeof text === 'string' && text.includes('fragment ProductCoreFields'));
  assert.deepEqual(built.map(([name]) => name).sort(), [
    'collectionProductsQuery', 'nodesAsProductsQuery', 'productByHandleQuery', 'productByIdQuery',
    'productCardFragment', 'productFragment', 'productRecommendationsQuery', 'productsListQuery', 'searchProductsQuery',
  ]);
  for (const [name, text] of built) {
    const core = text.slice(text.indexOf('fragment ProductCoreFields'));
    assert.match(core.slice(0, core.indexOf('\n  }\n')), RATING_ASKED, `${name}: inside ProductCoreFields`);
  }
});

/** Each read that returns products, the operation it sends, and the products it gives back. */
const READS = [
  ['collection page', 'CollectionProducts', async () => (await shopify.collections.products('h', { first: 50 })).nodes],
  ['search', 'SearchProducts', async () => (await shopify.products.search('tee')).nodes],
  ['recommendations', 'Recommended', () => shopify.products.recommended('gid://shopify/Product/9')],
  ['products by id (recently viewed, past orders, a PM-picked list)', 'WishlistNodes',
    () => shopify.products.byIds(['gid://shopify/Product/1', 'gid://shopify/Product/2'])],
  ['product page by handle', 'ProductByHandle', async () => [await shopify.products.byHandle('p-1')]],
  ['product page by id', 'ProductById', async () => [await shopify.products.byId('gid://shopify/Product/1')]],
  ['product list', 'Products', async () => (await shopify.products.list({ first: 2 })).nodes],
];
for (const [what, operation, run] of READS) {
  await check(`${what}: ${operation} asks for both, and each product has its rating`, async () => {
    const products = await run();
    const query = lastQuery(operation);
    assert.match(query, RATING_ASKED);
    // The app's own metafields still come under `metafields`, beside the ratings' own name.
    assert.match(query, /\bmetafields\(identifiers: \[\{namespace:"custom",key:"badge_text"\}\]\) \{ namespace key value type \}/);
    assert.deepEqual(products[0].rating, { value: 4.6, scaleMax: 5, count: 12 });
    assert.equal(products[0].metafields['custom.badge_text'], 'Going Fast');
    if (products[1]) assert.equal(products[1].rating, null, 'a product with no reviews');
  });
}

await check('the wishlist refresh asks for both', async () => {
  const storage = { data: {}, getItem: async (k) => storage.data[k] ?? null, setItem: async (k, v) => { storage.data[k] = v; }, removeItem: async (k) => { delete storage.data[k]; } };
  await shopify.wishlist.init({ storage, storageKey: 'w-refresh', hydrateOnInit: false });
  await shopify.wishlist.add('gid://shopify/Product/1');
  await shopify.wishlist.refresh();
  assert.match(lastQuery('WishlistNodes'), RATING_ASKED);
  assert.deepEqual(shopify.wishlist.list()[0].product.rating, { value: 4.6, scaleMax: 5, count: 12 });
});

// ── Kept with the product ───────────────────────────────────────────────────
console.log('kept with the product');

await check('a card read keeps the rating in the base keys, so a product page opens with its stars', () => {
  assert.ok(PRODUCT_BASE_KEYS.includes('rating'));
  assert.deepEqual(peekProduct('p-1').base.rating, { value: 4.6, scaleMax: 5, count: 12 });
  assert.equal(peekProduct('p-2').base.rating, null);
});

await check('a wishlist product saved before ratings reads as none, not undefined, until its refresh', async () => {
  const saved = { ...productNode(1), variants: [], images: [], media: [], priceRange: { min: money('10.00'), max: money('10.00') }, metafields: {} };
  delete saved.ratingMetafields;
  delete saved.__typename;
  const entry = { productId: saved.id, id: '1', handle: 'p-1', basic: { handle: 'p-1' }, addedAt: 1, product: saved };
  const storage = { data: { 'w-old': JSON.stringify([entry]) }, getItem: async (k) => storage.data[k] ?? null, setItem: async (k, v) => { storage.data[k] = v; }, removeItem: async (k) => { delete storage.data[k]; } };
  await shopify.wishlist.init({ storage, storageKey: 'w-old', hydrateOnInit: false });
  const [item] = shopify.wishlist.list();
  assert.equal(item.product.title, 'Product 1');
  assert.equal(item.product.rating, null);
});

console.log(`\n${pass} passed`);
