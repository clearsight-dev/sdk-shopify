// Variant metafields (0.23.0): `variantMetafields` adds a metafields selection to every product read's
// variants and reads it back as `variant.metafields`; unset, the query and the variants are what they were.
// Per-size data a product's own metafields can't hold.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const variant = (n, metafields) => ({
  id: `gid://shopify/ProductVariant/${n}`, title: `Size ${n}`, sku: null, availableForSale: true, quantityAvailable: 3,
  price: money('10.00'), compareAtPrice: null, selectedOptions: [{ name: 'Size', value: `${n}` }], image: null,
  sellingPlanAllocations: { nodes: [] },
  ...(metafields === undefined ? {} : { metafields }),
});
let variantsAnswer = [];
const productNode = () => ({
  __typename: 'Product',
  id: 'gid://shopify/Product/1', handle: 'p-1', title: 'Product 1',
  description: '', descriptionHtml: '', vendor: 'V', productType: 'T', tags: [], totalInventory: 5, availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('10.00') },
  compareAtPriceRange: { minVariantPrice: money('0.00'), maxVariantPrice: money('0.00') },
  options: [], variants: { nodes: variantsAnswer }, images: { nodes: [] }, featuredImage: null, onlineStoreUrl: null,
  media: { nodes: [] }, updatedAt: '', createdAt: '', ratingMetafields: [null, null],
});
const sent = [];
global.fetch = async (_url, init) => {
  const { query } = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(query) || [])[1] || 'anon';
  sent.push({ name, query });
  const data = name === 'ProductByHandle' ? { product: productNode() } : {};
  return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
};
const lastQuery = (name) => [...sent].reverse().find((call) => call.name === name)?.query ?? '';
const variantsSelection = (query) => query.slice(query.indexOf('variants(first: 100)'), query.indexOf('images(first: 20)'));

const { shopify, clearRequestCache, getVariantMetafields, productMetafield } = await import('../dist/index.js');

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };
console.log('variant metafields');

await shopify.init({ storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' });
variantsAnswer = [variant(1)];
await check('unset: the variants ask for no metafields and carry no record (the SDK names none of its own)', async () => {
  const product = await shopify.products.byHandle('p-1');
  assert.doesNotMatch(variantsSelection(lastQuery('ProductByHandle')), /metafields/);
  assert.deepEqual(getVariantMetafields(), []);
  assert.equal('metafields' in product.variants[0], false);
  assert.equal('variantMetafieldsRead' in product, false);
});

await shopify.init({
  storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't',
  variantMetafields: [{ namespace: 'auction', key: 'winners' }, { namespace: 'auction', key: 'allowedQty' }, { namespace: 'auction', key: 'winners' }],
});
clearRequestCache();
await check('configured: each listed once, inside each variant of every product read', () => {
  assert.deepEqual(getVariantMetafields(), [{ namespace: 'auction', key: 'winners' }, { namespace: 'auction', key: 'allowedQty' }]);
});

variantsAnswer = [
  variant(1, [{ namespace: 'auction', key: 'winners', value: '["a@example.com"]', type: 'json' }, { namespace: 'auction', key: 'allowedQty', value: ' 2 ', type: 'number_integer' }]),
  variant(2, [null, null]),
];
await check('each variant reads its own back, keyed namespace.key; a size with none has none', async () => {
  const product = await shopify.products.byHandle('p-1');
  const selection = variantsSelection(lastQuery('ProductByHandle'));
  assert.match(selection, /metafields\(identifiers: \[\{namespace:"auction",key:"winners"\},\{namespace:"auction",key:"allowedQty"\}\]\)/);
  assert.deepEqual(product.variants[0].metafields, { 'auction.winners': '["a@example.com"]', 'auction.allowedQty': ' 2 ' });
  assert.equal(productMetafield(product.variants[0], 'auction.allowedQty'), '2');
  assert.deepEqual(product.variants[1].metafields, {});
  assert.equal(productMetafield(product.variants[1], 'auction.winners'), null);
  assert.equal('sellingPlanAllocations' in product.variants[0], false, 'the variant keeps its usual shape');
  assert.deepEqual(product.variantMetafieldsRead, ['auction.winners', 'auction.allowedQty'], 'what the read asked for');
});

await check('a cart line’s merchandise is untouched (VariantFields is shared with the cart)', async () => {
  const queries = await import('../dist/queries.js');
  assert.doesNotMatch(queries.VARIANT_FRAGMENT, /metafields/);
});

await check('an unsafe identifier is refused', async () => {
  await assert.rejects(async () => shopify.init({ storeDomain: 's', storefrontAccessToken: 't', variantMetafields: [{ namespace: 'a"b', key: 'c' }] }), /invalid metafield namespace/);
});

console.log(`\n${pass} checks passed`);
