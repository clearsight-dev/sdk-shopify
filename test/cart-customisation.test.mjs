// The checkout gates for customisation (0.23.0), in ShopifyProvider (jsdom): `useCartCustomisation` holds
// checkout until every line's product has been read (a failed read, or a line just added, is not known),
// a line with no answers at all is never done, `save()` onto a cart line keeps the line's `_` attributes and
// refuses a line the cart doesn't have, and `useItemsCustomisation` waits for products not read yet.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
// Product 1 asks a size and an engraving; product 2 asks nothing; product 3 asks only a conditional question.
const QUESTIONS = {
  1: { questions: [
    { id: 'q1', key: 'Wrist size', type: 'choice', options: [{ id: 's', label: 'Small' }, { id: 'm', label: 'Medium' }] },
    { id: 'q2', key: 'Engraving', type: 'text_input' },
  ] },
  3: { questions: [
    { id: 'c1', type: 'choice', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] },
    { id: 'c2', key: 'Charm', type: 'choice', condition: [{ question_id: 'c1', answer: ['y'] }], options: [{ id: 'h', label: 'Heart' }] },
  ] },
};
const VARIANT = { 1: 'gid://shopify/ProductVariant/77', 2: 'gid://shopify/ProductVariant/88', 3: 'gid://shopify/ProductVariant/99' };
const productNode = (n) => ({
  __typename: 'Product', id: `gid://shopify/Product/${n}`, handle: n === 1 ? 'band' : `p${n}`, title: `P${n}`, description: '', descriptionHtml: '',
  vendor: 'V', productType: 'T', tags: [], totalInventory: 5, availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('10.00') },
  compareAtPriceRange: { minVariantPrice: money('0.00'), maxVariantPrice: money('0.00') },
  options: [], images: { nodes: [] }, featuredImage: null, onlineStoreUrl: null, media: { nodes: [] }, updatedAt: '', createdAt: '',
  ratingMetafields: [null, null],
  metafields: QUESTIONS[n] ? [{ namespace: 'custom', key: 'customisations_config', value: JSON.stringify(QUESTIONS[n]), type: 'json' }] : [],
  variants: { nodes: [{ id: VARIANT[n], title: 'One', sku: null, availableForSale: true, quantityAvailable: 3,
    price: money('10.00'), compareAtPrice: null, selectedOptions: [], image: null, sellingPlanAllocations: { nodes: [] } }] },
});

/** The store's cart, oldest first: a won lot (only the app's `_lotNumber`) and a product that asks nothing. */
const server = { lines: [
  { id: 'gid://line/1', product: 1, attributes: [{ key: '_lotNumber', value: '12' }] },
  { id: 'gid://line/2', product: 2, attributes: [] },
] };
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [],
  totalQuantity: server.lines.length,
  buyerIdentity: { countryCode: 'US', email: null, phone: null },
  lines: { nodes: [...server.lines].reverse().map((l) => ({ id: l.id, quantity: 1, attributes: l.attributes, sellingPlanAllocation: null,
    merchandise: { id: VARIANT[l.product], title: 'One', price: money('10.00'), availableForSale: true, quantityAvailable: 5,
      product: { id: `gid://shopify/Product/${l.product}`, title: `P${l.product}`, handle: `p${l.product}` } },
    cost: { totalAmount: money('10.00'), amountPerQuantity: money('10.00') } })) },
  cost: { subtotalAmount: money('10.00'), totalAmount: money('10.00') },
  discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
});

let productsFail = true;
let holdProducts = null;
const lineUpdates = [];
global.fetch = async (_url, init = {}) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart: cartPayload(), userErrors: [] } } });
  if (name === 'CartGet') return response(200, { data: { cart: cartPayload() } });
  if (name === 'CartLinesAdd') {
    for (const l of variables.lines) {
      const product = Number(Object.entries(VARIANT).find(([, id]) => id === l.merchandiseId)[0]);
      server.lines.push({ id: `gid://line/${server.lines.length + 1}`, product, attributes: l.attributes ?? [] });
    }
    return response(200, { data: { cartLinesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartLinesUpdate') {
    lineUpdates.push(variables.lines);
    for (const u of variables.lines) {
      const line = server.lines.find((l) => l.id === u.id);
      if (u.attributes) line.attributes = u.attributes;
    }
    return response(200, { data: { cartLinesUpdate: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'WishlistNodes') {
    if (holdProducts) await holdProducts;
    if (productsFail) return response(503, 'unavailable');
    return response(200, { data: { nodes: variables.ids.map((id) => productNode(Number(id.split('/').pop()))) } });
  }
  if (name === 'ProductByHandle') return response(200, { data: { product: productNode(1) } });
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useCart, useProductCustomisation, useCartCustomisation, useItemsCustomisation, CUSTOMISATION_STORAGE_KEY } = await import('../dist/index.js');

const t = harness('cart customisation: the checkout gates and save() onto a cart line');
let cartApi = null;
let gate = null;
let onLine = null;
let onMissingLine = null;
let wins = null;
let winProducts = { band: undefined, charm: undefined };
function Probe() {
  cartApi = useCart();
  gate = useCartCustomisation();
  onLine = useProductCustomisation({ productHandle: 'band', variantId: VARIANT[1], cartLineId: 'gid://line/1' });
  onMissingLine = useProductCustomisation({ productHandle: 'band', variantId: VARIANT[1], cartLineId: 'gid://line/404' });
  const list = React.useMemo(() => [
    { id: 'win-band', product: winProducts.band, variantId: VARIANT[1] },
    { id: 'win-charm', product: winProducts.charm, variantId: VARIANT[3] },
  ], [winProducts]);
  wins = useItemsCustomisation(list);
  return null;
}
const data = {};
const storage = { getItem: async (k) => (k in data ? data[k] : null), setItem: async (k, v) => { data[k] = String(v); }, removeItem: async (k) => { delete data[k]; } };
const config = {
  storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07',
  productMetafields: [{ namespace: 'custom', key: 'customisations_config' }],
  customisation: { product: 'custom.customisations_config' },
};
const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
const render = () => runAct(async () => root.render(React.createElement(ShopifyProvider, { config, storage }, React.createElement(Probe))));
await render();
await settle();

t.section('useCartCustomisation');
await t.check('the lines’ products could not be read: not known, so checkout waits (never "known" after a failed read)', () => {
  assert.equal(cartApi.cart.lines.length, 2);
  assert.equal(gate.known, false);
});

productsFail = false;
let releaseProducts = null;
holdProducts = new Promise((r) => { releaseProducts = r; });
await runAct(async () => { await cartApi.addLine({ merchandiseId: VARIANT[3], quantity: 1 }); });
await t.check('a line just added: not known until its product’s read lands', () => {
  assert.equal(cartApi.cart.lines.length, 3);
  assert.equal(gate.known, false);
});
holdProducts = null;
releaseProducts();
await settle();
await t.check('read: the won lot (only `_lotNumber`) and the conditional-only product with no answers both still need answers', () => {
  assert.equal(gate.known, true);
  assert.deepEqual(gate.customisableLineIds.sort(), ['gid://line/1', 'gid://line/3']);
  assert.deepEqual(gate.unansweredLineIds.sort(), ['gid://line/1', 'gid://line/3']);
});

t.section('save() onto a cart line');
let saved = null;
await runAct(async () => { onMissingLine.setAnswer('q1', 'm'); });
await runAct(async () => { saved = await onMissingLine.save(); });
await t.check('a line the cart doesn’t have: false, and nothing written anywhere', () => {
  assert.equal(saved, false);
  assert.equal(lineUpdates.length, 0);
  assert.equal(data[CUSTOMISATION_STORAGE_KEY], undefined);
});

await runAct(async () => { onLine.setAnswer('q1', 'm'); onLine.setAnswer('q2', 'AM'); });
await runAct(async () => { saved = await onLine.save(); });
await settle();
await t.check('the line gets the answers, its own `_` attributes kept; the gate opens for it', () => {
  assert.equal(saved, true);
  assert.equal(lineUpdates.length, 1);
  assert.deepEqual(lineUpdates[0][0].attributes, [
    { key: '_lotNumber', value: '12' },
    { key: 'Wrist size', value: 'Medium' },
    { key: 'Engraving', value: 'AM' },
  ]);
  assert.deepEqual(gate.unansweredLineIds, ['gid://line/3']);
});

t.section('useItemsCustomisation');
await t.check('a won item whose product isn’t read yet: not known', () => {
  assert.equal(wins.known, false);
});
winProducts = { band: { ...productNode(1), metafields: { 'custom.customisations_config': JSON.stringify(QUESTIONS[1]) }, variants: [{ id: VARIANT[1] }] },
  charm: { metafields: { 'custom.customisations_config': JSON.stringify(QUESTIONS[3]) }, variants: [{ id: VARIANT[3] }] } };
await render();
await settle();
await t.check('read: answers saved on this phone count; the conditional-only win with none is unanswered', () => {
  assert.equal(wins.known, true);
  assert.deepEqual(wins.customisableIds, ['win-band', 'win-charm']);
  assert.deepEqual(wins.unansweredIds, ['win-charm']);
  assert.deepEqual(wins.attributesById['win-band'], [{ key: 'Wrist size', value: 'Medium' }, { key: 'Engraving', value: 'AM' }]);
});
winProducts = { band: null, charm: winProducts.charm };
await render();
await settle();
await t.check('a product the store no longer has (null) is skipped, not waited for', () => {
  assert.equal(wins.known, true);
  assert.deepEqual(wins.customisableIds, ['win-charm']);
});

await runAct(async () => root.unmount());
t.done();
