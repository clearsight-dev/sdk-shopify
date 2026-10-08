// The provider's `linkTags` (0.11.0): a link's `ref` and `utm…` tags saved on the phone and put on the
// cart. Real ShopifyProvider in jsdom, Storefront API stubbed at `fetch` with an in-memory cart store.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = { amount: '10.00', currencyCode: 'USD' };
const carts = new Map();
let nextCartId = 1;
// Attribute writes left to fail before they start landing again.
let attrFailures = 0;
const calls = [];

const payload = (id) => {
  const c = carts.get(id);
  return {
    id,
    checkoutUrl: 'https://shop/checkout',
    // One line on every cart: checkout's preparation stops at an empty cart, before the labels.
    totalQuantity: 1,
    attributes: c.attributes,
    lines: { nodes: [{
      id: `${id}/line/0`, quantity: 1, attributes: [],
      merchandise: { id: 'gid://shopify/ProductVariant/1' }, cost: { totalAmount: money, amountPerQuantity: money },
    }] },
    cost: { subtotalAmount: money, totalAmount: money },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};

global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = op?.[1] || op?.[2] || 'unknown';
  calls.push({ name, variables });
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  await new Promise((r) => setTimeout(r, 3));

  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } },
                   localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') {
    const id = `gid://shopify/Cart/${nextCartId++}`;
    carts.set(id, { attributes: variables.input?.attributes ?? [] });
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) {
    return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });
  }
  if (name === 'CartAttributesUpdate') {
    if (attrFailures > 0) { attrFailures -= 1; throw new TypeError('Network request failed'); }
    carts.get(variables.cartId).attributes = variables.attributes;
    return reply({ cartAttributesUpdate: { cart: payload(variables.cartId), userErrors: [] } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, LINK_TAGS_STORAGE_KEY } = await import('../dist/index.js');

const CART_KEY = 'shopify:cart-id:v1';
const DAY = 24 * 60 * 60 * 1000;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
  };
}

/** A stand-in for React Native's `Linking`: the opening link, and links sent to the running app. */
function links(opening = null) {
  const listeners = new Set();
  return {
    getInitialUrl: async () => opening,
    subscribe: (onLink) => { listeners.add(onLink); return () => listeners.delete(onLink); },
    send: (url) => { for (const onLink of listeners) onLink(url); },
    get listening() { return listeners.size; },
  };
}

const cartAttributes = [{ key: 'source_name', value: 'amore-app' }];
let api = null;
let root = null;
function Probe() { api = useShopify(); return null; }

async function mount(storage, extra = {}) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  calls.length = 0;
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, storage, cartAttributes, ...extra },
      React.createElement(Probe),
    ));
  });
  await settle();
}
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 60)); });
const act = async (fn) => { await runAct(fn); await settle(); };

// What Shopify holds, not what the provider thinks.
const serverAttributes = () => carts.get(api.cart.cart.id).attributes;
const named = (n) => calls.filter((c) => c.name === n);
const savedRecord = (s) => JSON.parse(s.map.get(LINK_TAGS_STORAGE_KEY));

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

const INFLUENCER = 'https://sparklbands.com/collections/new-drops?ref=brandi10&utm_source=instagram&utm_medium=influencer&utm_campaign=fall_drop';
const INFLUENCER_TAGS = [
  { key: 'ref', value: 'brandi10' },
  { key: 'utm_source', value: 'instagram' },
  { key: 'utm_medium', value: 'influencer' },
  { key: 'utm_campaign', value: 'fall_drop' },
];

console.log('off unless asked for');
{
  const s = memoryStorage();
  await mount(s);
  let saved;
  await act(async () => { saved = await api.cart.saveLinkTags(INFLUENCER); });
  check('no linkTags: nothing saved, no cart write, the cart as before', () => {
    assert.equal(saved, false);
    assert.equal(s.map.has(LINK_TAGS_STORAGE_KEY), false);
    assert.equal(named('CartAttributesUpdate').length, 0);
    assert.deepEqual(serverAttributes(), cartAttributes);
  });
  const source = links(INFLUENCER);
  await mount(memoryStorage(), { linkTags: { keepDays: 0, ...source } });
  await act(async () => { source.send(INFLUENCER); });
  check('keepDays 0: the opening link and later ones are not saved or put on the cart', () => {
    assert.equal(named('CartAttributesUpdate').length, 0);
    assert.deepEqual(serverAttributes(), cartAttributes);
  });
}

console.log('the link that opened the app');
{
  const s = memoryStorage();
  const source = links(INFLUENCER);
  await mount(s, { linkTags: { keepDays: 7, ...source } });
  check('its tags are on the cart, after the provider\'s own attributes', () => {
    assert.deepEqual(serverAttributes(), [...cartAttributes, ...INFLUENCER_TAGS]);
  });
  check('and saved on the phone with the time', () => {
    const record = savedRecord(s);
    assert.deepEqual(record.tags, { ref: 'brandi10', utm_source: 'instagram', utm_medium: 'influencer', utm_campaign: 'fall_drop' });
    assert.ok(Math.abs(record.savedAt - Date.now()) < 5_000);
  });
  check('the app is listening for later links', () => assert.equal(source.listening, 1));

  calls.length = 0;
  await act(async () => { source.send('https://sparklbands.com/products/band?variant=1'); });
  check('a link with no tags changes nothing', () => {
    assert.equal(named('CartAttributesUpdate').length, 0);
    assert.deepEqual(serverAttributes(), [...cartAttributes, ...INFLUENCER_TAGS]);
  });

  await act(async () => { source.send('amorefashion://collections/tops?utm_source=tiktok&utm_campaign=winter'); });
  check('the last link wins: its tags replace every older one on the cart (ref and utm_medium go)', () => {
    assert.deepEqual(serverAttributes(), [
      ...cartAttributes,
      { key: 'utm_source', value: 'tiktok' },
      { key: 'utm_campaign', value: 'winter' },
    ]);
    assert.deepEqual(savedRecord(s).tags, { utm_source: 'tiktok', utm_campaign: 'winter' });
  });

  calls.length = 0;
  await mount(s, { linkTags: { keepDays: 7, ...links() } });
  check('opened again with no link: the saved tags are already on the stored cart, no write', () => {
    assert.equal(named('CartAttributesUpdate').length, 0);
    assert.equal(named('CartCreate').length, 0);
  });
  await act(async () => { await api.cart.reset(); });
  check('a new cart starts with the saved tags', () => {
    assert.deepEqual(named('CartCreate').slice(-1)[0].variables.input.attributes, [
      ...cartAttributes,
      { key: 'utm_source', value: 'tiktok' },
      { key: 'utm_campaign', value: 'winter' },
    ]);
  });
  if (root) await runAct(async () => root.unmount());
  root = null;
  check('unmounting stops listening', () => assert.equal(source.listening, 0));
}

console.log('a stored cart from before the link');
{
  const cartId = 'gid://shopify/Cart/stored-1';
  carts.set(cartId, { attributes: [...cartAttributes, { key: 'utm_content', value: 'older-post' }] });
  const s = memoryStorage({
    [CART_KEY]: cartId,
    [LINK_TAGS_STORAGE_KEY]: JSON.stringify({ savedAt: Date.now() - DAY, tags: { ref: 'brandi10' } }),
  });
  await mount(s, { linkTags: { keepDays: 7, ...links() } });
  check('gets the saved tags once it loads, its older tag replaced', () => {
    assert.equal(api.cart.cart.id, cartId);
    assert.deepEqual(serverAttributes(), [...cartAttributes, { key: 'ref', value: 'brandi10' }]);
  });
}

console.log('after keepDays');
{
  const s = memoryStorage({
    [LINK_TAGS_STORAGE_KEY]: JSON.stringify({ savedAt: Date.now() - 8 * DAY, tags: { ref: 'brandi10' } }),
  });
  await mount(s, { linkTags: { keepDays: 7, ...links() } });
  check('a new cart gets no tags', () => assert.deepEqual(serverAttributes(), cartAttributes));

  const cartId = 'gid://shopify/Cart/stored-2';
  carts.set(cartId, { attributes: [...cartAttributes, { key: 'ref', value: 'brandi10' }] });
  const kept = memoryStorage({
    [CART_KEY]: cartId,
    [LINK_TAGS_STORAGE_KEY]: JSON.stringify({ savedAt: Date.now() - 8 * DAY, tags: { ref: 'brandi10' } }),
  });
  await mount(kept, { linkTags: { keepDays: 7, ...links() } });
  let prepared;
  await act(async () => { prepared = await api.checkout.prepare(); });
  check('a cart that already has them keeps them, through checkout ("Leave them on")', () => {
    assert.equal(prepared, 'ready');
    assert.deepEqual(serverAttributes(), [...cartAttributes, { key: 'ref', value: 'brandi10' }]);
  });
  await mount(kept, { linkTags: { keepDays: 10, ...links() } });
  await act(async () => { await api.cart.reset(); });
  check('a longer setting counts from the same save: 8 days in, 10 kept, a new cart gets them again', () => {
    assert.deepEqual(serverAttributes(), [...cartAttributes, { key: 'ref', value: 'brandi10' }]);
  });
}

console.log('a cart write that fails');
{
  const s = memoryStorage();
  const source = links();
  await mount(s, { linkTags: { keepDays: 7, ...source } });
  attrFailures = 1;
  let saved;
  await act(async () => { saved = await api.cart.saveLinkTags(INFLUENCER); });
  check('the tags are still saved, and the call says so', () => {
    assert.equal(saved, true);
    assert.deepEqual(serverAttributes(), cartAttributes);
    assert.equal(savedRecord(s).tags.ref, 'brandi10');
  });
  let prepared;
  await act(async () => { prepared = await api.checkout.prepare(); });
  check('checkout puts them on', () => {
    assert.equal(prepared, 'ready');
    assert.deepEqual(serverAttributes(), [...cartAttributes, ...INFLUENCER_TAGS]);
  });
}

if (root) await runAct(async () => root.unmount());
console.log(`\n${pass} checks passed`);
