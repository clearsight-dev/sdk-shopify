// The metafields an app asks for (0.23.0): the SDK names none of its own; `cartMetafields` and
// `customerMetafields` come back on every cart and profile read (both ways of signing in); a product page's
// own `metafields` / `variantMetafields` are read on that page's read only, recorded in `metafieldsRead`, and
// never kept in the product store, so a card or the device never carries them and the page reads them fresh.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { counterRandom, harness, jwt, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const SHOP_ID = '68843864220';
const money = (amount) => ({ amount, currencyCode: 'USD' });
const mf = (namespace, key, value) => ({ namespace, key, value, type: 'single_line_text_field' });
const asked = (query, list) => list.filter((m) => query.includes(`{namespace:"${m.namespace}",key:"${m.key}"}`));
const productNode = (query) => ({
  __typename: 'Product', id: 'gid://shopify/Product/1', handle: 'lot', title: 'Lot', description: '', descriptionHtml: '',
  vendor: 'V', productType: 'T', tags: [], totalInventory: 5, availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('10.00') },
  compareAtPriceRange: { minVariantPrice: money('0.00'), maxVariantPrice: money('0.00') },
  options: [], images: { nodes: [] }, featuredImage: null, onlineStoreUrl: null, media: { nodes: [] }, updatedAt: '', createdAt: '',
  ratingMetafields: [null, null],
  // Like Shopify: only what the query asked for.
  metafields: asked(query, [mf('custom', 'badge', 'New'), mf('custom', 'size_chart', '["a@example.com"]')]),
  variants: { nodes: [{ id: 'gid://shopify/ProductVariant/7', title: 'S', sku: null, availableForSale: true, quantityAvailable: 3,
    price: money('10.00'), compareAtPrice: null, selectedOptions: [], image: null, sellingPlanAllocations: { nodes: [] },
    metafields: asked(query, [mf('custom', 'fit_note', '0')]) }] },
});
const cart = () => ({ id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, note: '', attributes: [],
  buyerIdentity: { countryCode: 'US', email: null, phone: null }, lines: { nodes: [] },
  cost: { subtotalAmount: money('0'), totalAmount: money('0') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  metafields: [mf('custom', 'gift_wrap', 'yes')] });

let authorize = null;
let holdPageRead = null;
const sent = [];
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/oauth/token')) {
    return response(200, { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, id_token: jwt({ nonce: authorize.nonce }) });
  }
  if (url.includes('/logout?')) return response(302, '');
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  sent.push({ name, query, api: url.includes('/account/customer/api/') ? 'account' : 'storefront' });
  if (url.includes('/account/customer/api/')) {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/7', firstName: 'A', lastName: 'B', metafields: [mf('custom', 'size', '6')],
      emailAddress: { emailAddress: 'a@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } } });
  }
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'ProductByHandle') {
    if (holdPageRead && query.includes('"custom",key:"size_chart"')) await holdPageRead;
    return response(200, { data: { product: productNode(query) } });
  }
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart: cart(), userErrors: [] } } });
  if (name === 'CartGet') return response(200, { data: { cart: cart() } });
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'Customer') {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'p@example.com', firstName: 'P', lastName: 'W', phone: null,
      defaultAddress: null, acceptsMarketing: false, metafields: [mf('custom', 'size', '7'), null] } } });
  }
  return response(200, { data: {} });
};
const last = (name) => [...sent].reverse().find((call) => call.name === name)?.query ?? '';

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const sdk = await import('../dist/index.js');
const { ShopifyProvider, useShopify, useProduct, peekProduct, clearProductStore, clearRequestCache, shopify } = sdk;
const queries = await import('../dist/queries.js');

const t = harness('metafield interfaces: app-level lists, and a product page’s own');
const BASE = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' };

t.section('nothing configured');
await shopify.init(BASE);
await t.check('the SDK names no metafield of its own: no selection anywhere, no records', async () => {
  for (const name of ['STANDARD_PRODUCT_METAFIELDS', 'STANDARD_VARIANT_METAFIELDS', 'EARLY_ACCESS_METAFIELDS', 'useEarlyAccess', 'withoutLots']) {
    assert.equal(name in sdk, false, name);
  }
  const product = await shopify.products.byHandle('lot');
  assert.doesNotMatch(last('ProductByHandle'), /^\s*metafields\(identifiers/m, 'only the star ratings’ own selection');
  assert.deepEqual(product.metafields, {});
  assert.equal('metafieldsRead' in product, false);
  assert.equal(queries.withCartMetafields(queries.CART_GET_QUERY), queries.CART_GET_QUERY, 'the cart query is the same text');
  assert.equal(queries.withCustomerMetafields(queries.CUSTOMER_QUERY), queries.CUSTOMER_QUERY);
  const read = await shopify.cart.get('gid://shopify/Cart/1');
  assert.equal('metafields' in read, false);
});

t.section('app-level lists');
await shopify.init({ ...BASE,
  productMetafields: [{ namespace: 'custom', key: 'badge' }],
  cartMetafields: [{ namespace: 'custom', key: 'gift_wrap' }],
  customerMetafields: [{ namespace: 'custom', key: 'size' }] });
clearRequestCache();
await t.check('cartMetafields: on every cart read, as cart.metafields', async () => {
  const read = await shopify.cart.get('gid://shopify/Cart/1');
  assert.match(last('CartGet'), /fragment CartFields on Cart \{\s*metafields\(identifiers: \[\{namespace:"custom",key:"gift_wrap"\}\]\)/);
  assert.deepEqual(read.metafields, { 'custom.gift_wrap': 'yes' });
});
await t.check('customerMetafields, password session: on the Storefront profile, as customer.metafields', async () => {
  const profile = await shopify.customer.profile('tok');
  assert.match(last('Customer'), /fragment CustomerFields on Customer \{\s*metafields\(identifiers: \[\{namespace:"custom",key:"size"\}\]\)/);
  assert.deepEqual(profile.metafields, { 'custom.size': '7' });
});
await t.check('productMetafields: every product read, recorded as read', async () => {
  const product = await shopify.products.byHandle('lot');
  assert.deepEqual(product.metafields, { 'custom.badge': 'New' });
  assert.deepEqual(product.metafieldsRead, ['custom.badge']);
});

t.section('a product page’s own');
clearProductStore();
clearRequestCache();
const PAGE_OWN = { metafields: [{ namespace: 'custom', key: 'size_chart' }], variantMetafields: [{ namespace: 'custom', key: 'fit_note' }] };
let page = null;
let plain = null;
let openPage = true;
function Screen() {
  page = useProduct(openPage ? 'lot' : null, PAGE_OWN);
  plain = useProduct('lot');
  return null;
}
let api = null;
function Account() {
  api = useShopify();
  return null;
}
const openAuthSession = async (authUrl, redirectUri) => {
  authorize = Object.fromEntries(new URL(authUrl).searchParams);
  return { type: 'success', url: `${redirectUri}?code=c&state=${authorize.state}` };
};
const config = { ...BASE, productMetafields: [{ namespace: 'custom', key: 'badge' }], customerMetafields: [{ namespace: 'custom', key: 'size' }] };
const auth = { method: 'shopify', secureStorage: keychain(), openAuthSession, random: counterRandom(), customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } };
const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
const render = () => runAct(async () => root.render(React.createElement(ShopifyProvider, { config, auth }, React.createElement(Account), React.createElement(Screen))));
await render();
await settle();
await t.check('the page’s read asks for its own on top of the configured ones; its product has them, recorded as read', () => {
  const pageReads = sent.filter((call) => call.name === 'ProductByHandle' && call.query.includes('"custom",key:"size_chart"'));
  assert.ok(pageReads.length >= 1);
  assert.match(pageReads[0].query, /metafields\(identifiers: \[\{namespace:"custom",key:"badge"\},\{namespace:"custom",key:"size_chart"\}\]\)/);
  assert.deepEqual(page.product.metafields, { 'custom.badge': 'New', 'custom.size_chart': '["a@example.com"]' });
  assert.deepEqual(page.product.metafieldsRead, ['custom.badge', 'custom.size_chart']);
  assert.deepEqual(page.product.variants[0].metafields, { 'custom.fit_note': '0' });
  assert.deepEqual(page.product.variantMetafieldsRead, ['custom.fit_note']);
});
await t.check('the shared copy (product store, device, other screens) never carries them', () => {
  const kept = peekProduct('lot').full;
  assert.deepEqual(kept.metafields, { 'custom.badge': 'New' });
  assert.deepEqual(kept.metafieldsRead, ['custom.badge']);
  assert.equal('metafields' in kept.variants[0], false);
  assert.equal(plain.product.metafields['custom.size_chart'], undefined);
});

openPage = false;
await render();
await settle();
const readsBefore = sent.filter((call) => call.name === 'ProductByHandle').length;
clearRequestCache(); // later: the request cache's short window has passed
let releasePageRead = null;
holdPageRead = new Promise((r) => { releasePageRead = r; });
openPage = true;
await render();
await t.check('opened again: a copy read without its own is only a preview until the page’s read lands', () => {
  assert.equal(page.product, null);
  assert.equal(page.preview?.title, 'Lot');
});
holdPageRead = null;
releasePageRead();
await settle();
await t.check('…then the page’s own read lands, with them', () => {
  assert.ok(sent.filter((call) => call.name === 'ProductByHandle').length > readsBefore);
  assert.equal(page.product.metafields['custom.size_chart'], '["a@example.com"]');
});

t.section('customer metafields, Shopify sign-in');
await runAct(async () => { await api.customer.signIn(); });
await settle();
await t.check('the Customer Account API profile carries them too', () => {
  const profileQuery = [...sent].reverse().find((call) => call.api === 'account' && call.name === 'CustomerProfile')?.query ?? '';
  assert.match(profileQuery, /customer \{\s*metafields\(identifiers: \[\{namespace:"custom",key:"size"\}\]\)/);
  assert.deepEqual(api.customer.customer.metafields, { 'custom.size': '6' });
});

await runAct(async () => root.unmount());
t.done();
