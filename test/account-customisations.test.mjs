// Customisations on the customer's account (0.23.0; `customisation.accountMetafield`), inside ShopifyProvider
// (jsdom): a Shopify sign-in prefills the customisation page from the account, Save writes the whole value
// back with the variant's answers and the last choices, `useOptionPreferences` gives the remembered option
// values, writes go one at a time, and a value that can't be read is never overwritten.
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
const QUESTIONS = JSON.stringify({ questions: [
  { id: 'q1', key: 'Wrist size', type: 'choice', options: [{ id: 's', label: 'Small' }, { id: 'm', label: 'Medium' }] },
  { id: 'q2', key: 'Engraving', type: 'text_input' },
  { id: 'q3', key: 'Charms', type: 'multi_select', options: [{ id: 'h', label: 'Heart' }, { id: 't', label: 'Star' }] },
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

// What the customer's metafield holds: another variant's answers, and the last choices (a size, a charm).
let accountValue = JSON.stringify({ 'gid://shopify/ProductVariant/55': { 'Wrist size': 'Small' }, Size: '6"', 'Wrist size': 'Medium', Charms: ['Star'] });
let accountReadFails = false;
let accountOwner = 'gid://shopify/Customer/7';
let holdRead = null;
let holdProfile = null;
const accountReads = [];
const accountWrites = [];
let holdWrite = null;
let authorize = null;
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/oauth/token')) {
    return response(200, { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, id_token: jwt({ nonce: authorize.nonce }) });
  }
  if (url.includes('/account/customer/api/')) {
    const { query, variables } = JSON.parse(init.body);
    const name = /(?:query|mutation) (\w+)/.exec(query)?.[1];
    if (name === 'CustomerCustomisations') {
      accountReads.push(variables);
      if (holdRead) await holdRead;
      if (accountReadFails) return response(200, { data: { customer: { id: accountOwner, metafield: { value: 'not json' } } } });
      return response(200, { data: { customer: { id: accountOwner, metafield: { value: accountValue } } } });
    }
    if (name === 'SetCustomerCustomisations') {
      if (holdWrite) await holdWrite;
      const [metafield] = variables.metafields;
      accountWrites.push(metafield);
      accountValue = metafield.value;
      return response(200, { data: { metafieldsSet: { userErrors: [] } } });
    }
    if (name === 'CustomerTags') return response(200, { data: { customer: { tags: [] } } });
    if (holdProfile) await holdProfile;
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
      emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } } });
  }
  if (url.includes('/logout?')) return response(302, '');
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'ProductByHandle') return response(200, { data: { product: productNode() } });
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart, userErrors: [] } } });
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart } });
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, useProductCustomisation, useOptionPreferences, CUSTOMISATION_STORAGE_KEY } = await import('../dist/index.js');

const t = harness('customisations on the account: useProductCustomisation and useOptionPreferences in ShopifyProvider');
let api = null;
let page = null;
let options = null;
function Account() {
  api = useShopify();
  options = useOptionPreferences();
  return null;
}
function Page() {
  page = useProductCustomisation({ productHandle: 'band', variantId: 'gid://shopify/ProductVariant/77' });
  return null;
}

const openAuthSession = async (authUrl, redirectUri) => {
  authorize = Object.fromEntries(new URL(authUrl).searchParams);
  return { type: 'success', url: `${redirectUri}?code=c&state=${authorize.state}` };
};
const data = {};
const storage = { getItem: async (k) => (k in data ? data[k] : null), setItem: async (k, v) => { data[k] = String(v); }, removeItem: async (k) => { delete data[k]; } };
const config = {
  storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07',
  productMetafields: [{ namespace: 'custom', key: 'customisations_config' }],
  customisation: { product: 'custom.customisations_config', accountMetafield: 'apptile.customizations' },
};
const auth = { method: 'shopify', secureStorage: keychain(), openAuthSession, random: counterRandom(), customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } };
let root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
async function render(withPage, on = storage) {
  await runAct(async () => {
    root.render(React.createElement(ShopifyProvider, { config, auth, storage: on }, React.createElement(Account), withPage ? React.createElement(Page) : null));
  });
  await settle();
}

await render(false);
await t.check('signed out: nothing read, nothing remembered, and remember() saves nothing', async () => {
  assert.equal(accountReads.length, 0);
  assert.equal(options.loaded, true);
  assert.deepEqual(options.preferences, {});
  assert.equal(await options.remember({ Size: '7"' }), false);
  assert.equal(accountWrites.length, 0);
});

await runAct(async () => { await api.customer.signIn(); });
await settle();
await t.check('a Shopify sign-in reads the account’s metafield once: the remembered choices, never a variant’s answers', () => {
  assert.equal(accountReads.length, 1);
  assert.deepEqual(accountReads[0], { namespace: 'apptile', key: 'customizations' });
  assert.equal(options.loaded, true);
  assert.deepEqual(options.preferences, { Size: '6"', 'Wrist size': 'Medium', Charms: ['Star'] });
  assert.equal(options.preferredValue('Size', ['6"', '7"']), '6"');
  assert.equal(options.preferredValue('Size', ['7"']), null, 'a value the product doesn’t offer');
  assert.equal(options.preferredValue('Charms', ['Star']), null, 'a list is a question’s, not an option’s');
});

await render(true);
await t.check('a variant with nothing saved opens on the last choices anywhere (labels to option ids), with no second read', () => {
  assert.deepEqual(page.answers, { q1: 'm', q3: ['t'] });
  assert.equal(accountReads.length, 1);
});

await runAct(async () => { page.setAnswer('q1', 's'); page.setAnswer('q2', 'AM'); page.setAnswer('q3', ['h', 't']); });
let ok = null;
await runAct(async () => { ok = await page.save(); });
await settle();
await t.check('Save writes the whole value back: the variant’s answers under its id, the last choices on top, the rest kept', () => {
  assert.equal(ok, true);
  assert.equal(accountWrites.length, 1);
  const [write] = accountWrites;
  assert.equal(write.ownerId, 'gid://shopify/Customer/7');
  assert.equal(write.namespace, 'apptile');
  assert.equal(write.key, 'customizations');
  assert.equal(write.type, 'json');
  assert.deepEqual(JSON.parse(write.value), {
    'gid://shopify/ProductVariant/55': { 'Wrist size': 'Small' },
    'gid://shopify/ProductVariant/77': { 'Wrist size': 'Small', Engraving: 'AM', Charms: ['Heart', 'Star'] },
    Size: '6"', 'Wrist size': 'Small', Charms: ['Heart', 'Star'],
  });
  assert.equal('Engraving' in JSON.parse(write.value), false, 'free text stays with its variant, never a last choice');
  assert.deepEqual(options.preferences.Charms, ['Heart', 'Star'], 'every reader hears the save');
});

// Two writes at once: the second waits for the first, and keeps its entry.
let release;
holdWrite = new Promise((r) => { release = r; });
let first = null;
let second = null;
await runAct(async () => {
  first = options.remember({ Size: '7"' });
  second = options.remember({ Color: 'Rose', Title: null });
  await new Promise((r) => setTimeout(r, 20));
  holdWrite = null;
  release();
  await Promise.all([first, second]);
});
await settle();
await t.check('writes go one at a time, each from a fresh read, so neither drops the other’s entry', async () => {
  assert.equal(await first, true);
  assert.equal(await second, true);
  const value = JSON.parse(accountValue);
  assert.equal(value.Size, '7"');
  assert.equal(value.Color, 'Rose');
  assert.equal('Title' in value, false, 'an empty choice isn’t saved');
  assert.deepEqual(value['gid://shopify/ProductVariant/77'].Charms, ['Heart', 'Star']);
});

accountReadFails = true;
const writesBefore = accountWrites.length;
let refused = null;
await runAct(async () => { refused = await options.remember({ Size: '8"' }); });
await t.check('a value that can’t be read is left alone: the write is dropped, never replacing it', () => {
  assert.equal(refused, false);
  assert.equal(accountWrites.length, writesBefore);
});
accountReadFails = false;

accountOwner = 'gid://shopify/Customer/8';
const writesBeforeSwap = accountWrites.length;
let wrongOwner = null;
await runAct(async () => { wrongOwner = await options.remember({ Size: '9"' }); });
await t.check('a write whose read answers for another customer than the one it was for is dropped', () => {
  assert.equal(wrongOwner, false);
  assert.equal(accountWrites.length, writesBeforeSwap);
});
accountOwner = 'gid://shopify/Customer/7';
await runAct(async () => root.unmount());

// ── Whose answers: Alice (customer 99) used this phone before; customer 7's session restores ──
const phone = {
  [CUSTOMISATION_STORAGE_KEY]: JSON.stringify({ _customer: '99', 77: { answers: { q2: 'FOR ALICE' }, attributes: [{ key: 'Engraving', value: 'FOR ALICE' }] } }),
};
const phoneStorage = { getItem: async (k) => phone[k] ?? null, setItem: async (k, v) => { phone[k] = String(v); }, removeItem: async (k) => { delete phone[k]; } };
let releaseRead = null;
holdRead = new Promise((r) => { releaseRead = r; });
root = createRoot(document.getElementById('root'));
await render(true, phoneStorage);
await t.check('another customer’s answers on the phone are never shown, and are cleared once read', () => {
  assert.equal(api.customer.customer?.id, 'gid://shopify/Customer/7');
  assert.equal(page.answers.q2, undefined);
  assert.equal(page.loading, true, 'the account’s answers are still on their way');
  assert.equal(phone[CUSTOMISATION_STORAGE_KEY].includes('FOR ALICE'), false);
  assert.equal(JSON.parse(phone[CUSTOMISATION_STORAGE_KEY])._customer, '7');
});
await runAct(async () => { page.setAnswer('q2', 'FOR BOB'); });
holdRead = null;
releaseRead();
await settle();
await t.check('the account’s answers land under what the shopper typed meanwhile: typing is never lost', () => {
  assert.deepEqual(page.answers, { q1: 's', q2: 'FOR BOB', q3: ['h', 't'] });
  assert.equal(page.loading, false);
});
await runAct(async () => { ok = await page.save(); });
await settle();
await t.check('Save: this customer’s answers on the account and the phone, nothing of the other customer’s', () => {
  assert.equal(ok, true);
  assert.equal(accountValue.includes('FOR ALICE'), false);
  assert.equal(JSON.parse(accountValue)['gid://shopify/ProductVariant/77'].Engraving, 'FOR BOB');
  const onPhone = JSON.parse(phone[CUSTOMISATION_STORAGE_KEY]);
  assert.equal(onPhone._customer, '7');
  assert.equal(onPhone['77'].answers.q2, 'FOR BOB');
});

// ── A sign-in whose profile is still loading, then a read that fails ──
await runAct(async () => { await api.customer.logout(); });
await settle();
let releaseProfile = null;
holdProfile = new Promise((r) => { releaseProfile = r; });
accountReadFails = true;
await runAct(async () => { void api.customer.signIn(); await new Promise((r) => setTimeout(r, 30)); });
await t.check('signed in, profile still loading: the preferences aren’t loaded yet (never "loaded, nothing saved")', () => {
  assert.equal(api.customer.loggedIn, true);
  assert.equal(api.customer.customer, null);
  assert.equal(options.loaded, false);
});
holdProfile = null;
releaseProfile();
await settle();
await t.check('the account’s read fails: loaded, with nothing remembered, so a page doesn’t wait for ever', () => {
  assert.equal(options.loaded, true);
  assert.deepEqual(options.preferences, {});
});
accountReadFails = false;
const readsBefore = accountReads.length;
Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
await runAct(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
await settle();
await t.check('back in the foreground, a failed read is tried again', () => {
  assert.equal(accountReads.length, readsBefore + 1);
  assert.equal(options.preferences['Wrist size'], 'Small');
});

await runAct(async () => root.unmount());
t.done();
