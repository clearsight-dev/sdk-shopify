// Answers saved on this device (0.22.0): `useProductCustomisation().save()` with no cart line keeps the
// answers and their line attributes per variant, and `useSavedCustomisations()` reads them back, for items
// bought on a cart made later (an auction's wins). Every reader hears a save.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const QUESTIONS = JSON.stringify({ questions: [
  { id: 'q1', key: 'Wrist size', type: 'choice', options: [{ id: 's', label: 'Small' }, { id: 'm', label: 'Medium' }] },
  { id: 'q2', key: 'Engraving', type: 'text_input' },
] });
const productNode = () => ({
  __typename: 'Product', id: 'gid://shopify/Product/1', handle: 'band', title: 'Band', description: '', descriptionHtml: '',
  vendor: 'V', productType: 'T', tags: [], totalInventory: 5, availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('10.00') },
  compareAtPriceRange: { minVariantPrice: money('0.00'), maxVariantPrice: money('0.00') },
  options: [], images: { nodes: [] }, featuredImage: null, onlineStoreUrl: null, media: { nodes: [] }, updatedAt: '', createdAt: '',
  ratingMetafields: [null, null],
  metafields: [{ namespace: 'custom', key: 'customisations_config', value: QUESTIONS, type: 'json' }],
  variants: { nodes: [{ id: 'gid://shopify/ProductVariant/77', title: 'One', sku: null, availableForSale: true, quantityAvailable: 3,
    price: money('10.00'), compareAtPrice: null, selectedOptions: [], image: null, sellingPlanAllocations: { nodes: [] } }] },
});
const cart = { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money('0'), totalAmount: money('0') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '' };
global.fetch = async (_url, init) => {
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1];
  const data = name === 'ProductByHandle' ? { product: productNode() }
    : name === 'CartCreate' ? { cartCreate: { cart, userErrors: [] } } : query.includes('cart(id:') ? { cart } : {};
  return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
};

const data = {};
const storage = { getItem: async (k) => (k in data ? data[k] : null), setItem: async (k, v) => { data[k] = String(v); }, removeItem: async (k) => { delete data[k]; } };

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useProduct, useProductCustomisation, useSavedCustomisations, useItemsCustomisation, CUSTOMISATION_STORAGE_KEY } = await import('../dist/index.js');

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };
console.log('saved customisations');

let page = null;
let saved = null;
let items = null;
function Screen() {
  page = useProductCustomisation({ productHandle: 'band', variantId: 'gid://shopify/ProductVariant/77' });
  saved = useSavedCustomisations();
  const band = useProduct('band').product;
  items = useItemsCustomisation(React.useMemo(() => [
    { id: 'win-1', product: band, variantId: 'gid://shopify/ProductVariant/77' },
    { id: 'win-2', product: null, variantId: 'gid://shopify/ProductVariant/88' },
  ], [band]));
  return null;
}
const config = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', productMetafields: [{ namespace: 'custom', key: 'customisations_config' }], customisation: { product: 'custom.customisations_config' } };
const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
await runAct(async () => root.render(React.createElement(ShopifyProvider, { config, storage }, React.createElement(Screen))));
await settle();

await check('nothing saved: read, and empty; a won item whose product asks is unanswered', () => {
  assert.equal(saved.loaded, true);
  assert.deepEqual(items.customisableIds, ['win-1']);
  assert.deepEqual(items.unansweredIds, ['win-1']);
  assert.equal(items.known, true);
  assert.deepEqual(saved.attributesFor('gid://shopify/ProductVariant/77'), []);
  assert.equal(page.questions.length, 2);
});

await runAct(async () => { page.setAnswer('q1', 'm'); page.setAnswer('q2', 'AM'); });
let ok = null;
await runAct(async () => { ok = await page.save(); });
await settle();
await check('a save with no line keeps the answers and their attributes, and every reader hears it', () => {
  assert.equal(ok, true);
  assert.deepEqual(saved.answersFor('77'), { q1: 'm', q2: 'AM' });
  assert.deepEqual(saved.attributesFor('gid://shopify/ProductVariant/77'), [{ key: 'Wrist size', value: 'Medium' }, { key: 'Engraving', value: 'AM' }]);
  assert.deepEqual(items.unansweredIds, [], 'the won item has its answers now');
  assert.deepEqual(items.attributesById['win-1'], [{ key: 'Wrist size', value: 'Medium' }, { key: 'Engraving', value: 'AM' }]);
  assert.deepEqual(JSON.parse(data[CUSTOMISATION_STORAGE_KEY])['77'].attributes, [{ key: 'Wrist size', value: 'Medium' }, { key: 'Engraving', value: 'AM' }]);
});
await runAct(async () => root.unmount());

// A record from before (bare answers by variant) still reads, on a new launch with a new storage.
const oldData = { [CUSTOMISATION_STORAGE_KEY]: JSON.stringify({ 77: { q1: 's' } }) };
const oldStorage = { getItem: async (k) => oldData[k] ?? null, setItem: async (k, v) => { oldData[k] = String(v); }, removeItem: async () => {} };
const root2 = createRoot(document.getElementById('root'));
await runAct(async () => root2.render(React.createElement(ShopifyProvider, { config, storage: oldStorage }, React.createElement(Screen))));
await settle();
await check('an earlier record of bare answers still prefills; it has no attributes', () => {
  assert.deepEqual(saved.answersFor('77'), { q1: 's' });
  assert.deepEqual(saved.attributesFor('77'), []);
  assert.deepEqual(page.answers, { q1: 's' });
});
await runAct(async () => root2.unmount());
console.log(`\n${pass} checks passed`);
