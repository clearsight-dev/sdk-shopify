// `useRecentlyViewed` and `usePastOrderProducts` (0.17.0) rendered in jsdom with the real ShopifyProvider
// and Shopify stubbed at `fetch`. Recently viewed: recorded, newest first, once each, kept to its limits,
// stored on the device and read back, the open product left out, a product the store no longer has
// dropped, and every hook told of a change. Past orders: nothing signed out; signed in with either
// sign-in, each product once from its newest order, kept to `limit`, products the store no longer has
// left out, in one read of the orders and one of the products.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { deferred, harness, keychain, memoryStorage, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const SHOP_ID = '68843864220';
const ACCOUNT_URL = `https://shopify.com/${SHOP_ID}/account/customer/api/2026-07/graphql`;
const DAY = 24 * 3600_000;
const KEY = 'tile:shopify:recentlyViewed:v1';
const money = (amount) => ({ amount, currencyCode: 'USD' });
const P = (n) => `gid://shopify/Product/${n}`;
const V = (n) => `gid://shopify/ProductVariant/${n}`;

// ── Fake Shopify ────────────────────────────────────────────────────────────

/** The store's products by id, with their variants; anything else answers null, as `nodes(ids:)` does. */
const STORE = {
  [P(1)]: { handle: 'ring', variants: [V(11), V(12)] },
  [P(2)]: { handle: 'band', variants: [V(21)] },
  [P(3)]: { handle: 'charm', variants: [V(31)] },
  [P(4)]: { handle: 'chain', variants: [V(41)] },
  [P(5)]: { handle: 'stud', variants: [V(51)] },
};
/** Products 1000 and up exist too, for the long lists. */
const productOf = (id) => STORE[id] ?? (Number(id.split('/').pop()) >= 1000 ? { handle: `p${id.split('/').pop()}`, variants: [] } : null);
const productNode = (id) => ({
  __typename: 'Product', id, handle: productOf(id).handle, title: productOf(id).handle.toUpperCase(), availableForSale: true,
  priceRange: { minVariantPrice: money('10.00'), maxVariantPrice: money('10.00') },
  compareAtPriceRange: { minVariantPrice: money('0.00'), maxVariantPrice: money('0.00') },
  featuredImage: null, images: { nodes: [] }, media: { nodes: [] }, options: [], tags: [],
  variants: { nodes: productOf(id).variants.map((variantId) => ({
    id: variantId, title: 'One', availableForSale: true, quantityAvailable: 3, price: money('10.00'), compareAtPrice: null,
    selectedOptions: [], image: null, sellingPlanAllocations: { nodes: [] },
  })) },
});

/** Email and password's past orders (Storefront field names), newest first. */
let storefrontPastOrders = [];
/** A Shopify sign-in's past orders (Customer Account API field names), newest first. */
let accountPastOrders = [];
const sfLine = (variant, product) => ({ variant: variant ? { id: variant, product: { id: product } } : null });

/** Every request, as `{ api, name, variables }`, in order. */
const calls = [];
const count = (name) => calls.filter((call) => call.name === name).length;
/** Operation names whose next request fails as if offline. */
const failNext = new Set();

const cart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [], totalQuantity: 0,
  buyerIdentity: { countryCode: 'US', email: null, phone: null }, lines: { nodes: [] },
  cost: { subtotalAmount: money('0.00'), totalAmount: money('0.00') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
};
const storefront = {
  Customer: ({ accessToken }) => ({ customer: accessToken === 'tok_live'
    ? { id: 'gid://shopify/Customer/1', email: 'amber@example.com', firstName: 'Amber', lastName: 'Marie', phone: null, defaultAddress: null, acceptsMarketing: false }
    : null }),
  CustomerPastOrderProducts: ({ accessToken, first }) => ({
    customer: accessToken === 'tok_live' ? { orders: { nodes: storefrontPastOrders.slice(0, first) } } : null,
  }),
  WishlistNodes: ({ ids }) => ({ nodes: ids.map((id) => (productOf(id) ? productNode(id) : null)) }),
  CartCreate: () => ({ cartCreate: { cart, userErrors: [] } }),
  CartGet: () => ({ cart }),
};
const account = {
  CustomerProfile: () => ({ customer: { id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
    emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } }),
  PastOrderProducts: ({ first }) => ({ customer: { orders: { nodes: accountPastOrders.slice(0, first) } } }),
};

global.fetch = async (url, init = {}) => {
  const api = String(url) === ACCOUNT_URL ? 'account' : 'storefront';
  const { query, variables = {} } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  calls.push({ api, name, variables });
  if (failNext.delete(name)) throw new TypeError('Network request failed');
  if (api === 'account') {
    if (init.headers.Authorization !== 'at_live') return response(401, {});
    const handler = account[name];
    if (!handler) throw new Error(`unexpected account operation ${name}`);
    return response(200, { data: handler(variables) });
  }
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  const handler = storefront[name];
  return response(200, { data: handler ? handler(variables) : {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const {
  ShopifyProvider, shopify, useRecentlyViewed, usePastOrderProducts, useCustomer, clearProductsById, clearRequestCache,
} = await import('../dist/index.js');

const t = harness('recently viewed, and products from past orders');
const settle = (ms = 30) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });
const handles = (products) => products.map((product) => product.handle);
const stored = (storage, key = KEY) => JSON.parse(storage.map.get(key) ?? 'null');
/** Both caches emptied: this session's products, and the SDK's recent answers. */
const forgetProducts = () => { clearProductsById(); clearRequestCache(); };

const SIGNED_OUT = () => ({ method: 'password', secureStorage: keychain(), customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } });
const PASSWORD = () => ({
  method: 'password', customerAccount: { shopId: SHOP_ID, clientId: 'client-1' },
  secureStorage: keychain({ 'auth.storefrontToken': 'tok_live', 'auth.storefrontExpiresAt': String(Date.now() + 30 * DAY) }),
});
const SHOPIFY = () => ({
  method: 'shopify', customerAccount: { shopId: SHOP_ID, clientId: 'client-1' },
  secureStorage: keychain({ 'auth.token': 'at_live', 'auth.refreshToken': 'rt_live', 'auth.expiresAt': String(Date.now() + 3600_000) }),
});

/**
 * Mounts one provider with a probe per hook; `read(name)` is that hook's latest answer. Each probe is
 * its own component, so one list's change reaching another is the provider's doing, not a shared render.
 */
async function mount(hooks, { storage = memoryStorage(), auth = SIGNED_OUT(), recentlyViewed } = {}) {
  const latest = {};
  const probes = Object.entries(hooks).map(([name, useHook]) => function Probe() {
    latest[name] = useHook();
    return null;
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, storage, auth, recentlyViewed },
      ...probes.map((Probe) => React.createElement(Probe)),
    ));
  });
  await settle();
  return { read: (name) => latest[name], unmount: () => runAct(async () => root.unmount()) };
}
const act = (work) => runAct(async () => { await work(); });

// ── Recently viewed ─────────────────────────────────────────────────────────
t.section('useRecentlyViewed');
const ring = { id: P(1), handle: 'ring' };
const band = { id: P(2), handle: 'band' };
const charm = { id: P(3), handle: 'charm' };
const chain = { id: P(4), handle: 'chain' };

let storage = memoryStorage();
await t.check('a product recorded shows, read as the store has it, and is stored with its handle and when', async () => {
  const before = Date.now();
  const probe = await mount({ list: () => useRecentlyViewed() }, { storage });
  assert.deepEqual(probe.read('list').products, []);
  assert.equal(probe.read('list').loading, false);
  await act(() => probe.read('list').record(ring));
  await settle();
  const state = probe.read('list');
  assert.deepEqual(handles(state.products), ['ring']);
  assert.equal(state.products[0].priceRange.min.amount, '10.00');
  assert.equal(state.loading, false);
  assert.equal(state.error, false);
  const [entry] = stored(storage);
  assert.equal(entry.id, P(1));
  assert.equal(entry.handle, 'ring');
  assert.ok(entry.viewedAt >= before && entry.viewedAt <= Date.now());
  await probe.unmount();
});

await t.check('newest first; a product opened again moves to the front, once', async () => {
  const probe = await mount({ list: () => useRecentlyViewed() }, { storage });
  await act(() => probe.read('list').record(band));
  await act(() => probe.read('list').record(charm));
  await settle();
  assert.deepEqual(handles(probe.read('list').products), ['charm', 'band', 'ring']);
  await act(() => probe.read('list').record(ring));
  await settle();
  assert.deepEqual(handles(probe.read('list').products), ['ring', 'charm', 'band']);
  assert.deepEqual(stored(storage).map((entry) => entry.handle), ['ring', 'charm', 'band']);
  assert.deepEqual(shopify.recentlyViewed.list().map((entry) => entry.id), [P(1), P(3), P(2)]);
  await probe.unmount();
});

await t.check('the hook shows `limit` (default 10); the device keeps the provider\'s (default 20, 1–50)', async () => {
  const probe = await mount({ two: () => useRecentlyViewed({ limit: 2 }), all: () => useRecentlyViewed() }, { storage, recentlyViewed: { limit: 3 } });
  assert.deepEqual(handles(probe.read('two').products), ['ring', 'charm']);
  await act(() => probe.read('two').record(chain));
  await settle();
  // Four recorded, three kept: the oldest (band) went, on the device too.
  assert.deepEqual(handles(probe.read('all').products), ['chain', 'ring', 'charm']);
  assert.deepEqual(stored(storage).map((entry) => entry.handle), ['chain', 'ring', 'charm']);
  await probe.unmount();
  // Twenty-five recorded with the default limit: twenty kept, ten shown.
  const many = memoryStorage();
  const wide = await mount({ list: () => useRecentlyViewed() }, { storage: many });
  await act(async () => {
    for (let n = 1; n <= 25; n += 1) await shopify.recentlyViewed.record({ id: String(1000 + n), handle: `p${1000 + n}` });
  });
  await settle();
  assert.equal(shopify.recentlyViewed.list().length, 20);
  assert.equal(stored(many).length, 20);
  assert.equal(shopify.recentlyViewed.list()[0].id, P(1025));
  assert.deepEqual(handles(wide.read('list').products), Array.from({ length: 10 }, (_, i) => `p${1025 - i}`));
  await wide.unmount();
  // A limit past 50 is 50; one under 1 is 1.
  const capped = await mount({}, { storage: memoryStorage(), recentlyViewed: { limit: 500 } });
  await act(async () => {
    for (let n = 1; n <= 60; n += 1) await shopify.recentlyViewed.record({ id: String(2000 + n), handle: `q${n}` });
  });
  assert.equal(shopify.recentlyViewed.list().length, 50);
  await capped.unmount();
  const one = await mount({}, { storage: memoryStorage(), recentlyViewed: { limit: 0 } });
  await act(async () => { await shopify.recentlyViewed.record(ring); await shopify.recentlyViewed.record(band); });
  assert.deepEqual(shopify.recentlyViewed.list().map((entry) => entry.handle), ['band']);
  await one.unmount();
});

await t.check('kept across a remount: the list is read back from the device', async () => {
  const kept = memoryStorage(storage.dump());
  const probe = await mount({ list: () => useRecentlyViewed() }, { storage: kept });
  assert.deepEqual(handles(probe.read('list').products), ['chain', 'ring', 'charm']);
  await probe.unmount();
  // A device with another list shows that one, and an empty device none: it is the device's list.
  const other = await mount({ list: () => useRecentlyViewed() }, {
    storage: memoryStorage({ [KEY]: JSON.stringify([{ id: P(2), handle: 'band', viewedAt: 5 }]) }),
  });
  assert.deepEqual(handles(other.read('list').products), ['band']);
  await other.unmount();
  const empty = await mount({ list: () => useRecentlyViewed() }, { storage: memoryStorage() });
  assert.deepEqual(empty.read('list').products, []);
  await empty.unmount();
  // `storageKey` keeps it under another key.
  const custom = memoryStorage();
  const keyed = await mount({ list: () => useRecentlyViewed() }, { storage: custom, recentlyViewed: { storageKey: 'my-app:seen' } });
  await act(() => keyed.read('list').record(ring));
  assert.equal(stored(custom, 'my-app:seen')[0].id, P(1));
  assert.equal(custom.map.has(KEY), false);
  await keyed.unmount();
});

await t.check('a product recorded while the device is still being read stays, in front of what was stored', async () => {
  const gate = deferred();
  const slow = memoryStorage({ [KEY]: JSON.stringify([{ id: P(1), handle: 'ring', viewedAt: 1 }, { id: P(2), handle: 'band', viewedAt: 0 }]) });
  const read = slow.getItem;
  slow.getItem = async (key) => { if (key === KEY) await gate.promise; return read(key); };
  const probe = await mount({ list: () => useRecentlyViewed() }, { storage: slow });
  assert.equal(probe.read('list').loading, true);
  await act(() => { void probe.read('list').record(charm); });
  // In memory at once (every list shows it), stored once the device's list is read.
  assert.equal(shopify.recentlyViewed.list()[0].handle, 'charm');
  assert.equal(slow.map.has(KEY) && stored(slow)[0].handle, 'ring');
  gate.resolve();
  await settle();
  assert.deepEqual(handles(probe.read('list').products), ['charm', 'ring', 'band']);
  assert.deepEqual(stored(slow).map((entry) => entry.handle), ['charm', 'ring', 'band']);
  await probe.unmount();
});

await t.check('leaveOut: the product a page has open is not shown, by id or by handle, and the list stays full', async () => {
  storage = memoryStorage();
  const probe = await mount({
    byId: () => useRecentlyViewed({ leaveOut: P(3), limit: 2 }),
    byHandle: () => useRecentlyViewed({ leaveOut: 'charm', limit: 2 }),
  }, { storage });
  await act(async () => { for (const product of [ring, band, charm]) await shopify.recentlyViewed.record(product); });
  await settle();
  assert.deepEqual(handles(probe.read('byId').products), ['band', 'ring']);
  assert.deepEqual(handles(probe.read('byHandle').products), ['band', 'ring']);
  await probe.unmount();
});

await t.check('a product the store no longer has is left out, taken off the device, and the next one shown', async () => {
  // The list in memory is the last test's until this provider reads its own: emptied, to count reads.
  await act(() => shopify.recentlyViewed.clear());
  forgetProducts();
  storage = memoryStorage();
  const before = calls.length;
  const probe = await mount({ list: () => useRecentlyViewed({ limit: 2 }) }, { storage });
  await act(async () => {
    for (const product of [ring, band, { id: P(404), handle: 'gone' }]) await shopify.recentlyViewed.record(product);
  });
  await settle();
  assert.deepEqual(handles(probe.read('list').products), ['band', 'ring']);
  assert.deepEqual(shopify.recentlyViewed.list().map((entry) => entry.id), [P(2), P(1)]);
  assert.deepEqual(stored(storage).map((entry) => entry.id), [P(2), P(1)]);
  // Read through `useProductsById`: each product once a session.
  const read = calls.slice(before).filter((call) => call.name === 'WishlistNodes').flatMap((call) => call.variables.ids);
  assert.deepEqual(read.sort(), [P(1), P(2), P(404)]);
  await probe.unmount();
});

await t.check('every useRecentlyViewed shows a product recorded anywhere, at once', async () => {
  storage = memoryStorage();
  const probe = await mount({ home: () => useRecentlyViewed(), account: () => useRecentlyViewed({ limit: 1 }) }, { storage });
  await act(() => probe.read('home').record(chain));
  await settle();
  assert.deepEqual(handles(probe.read('account').products), ['chain']);
  // Without React too: the screen of another app part records, both hooks follow.
  await act(() => shopify.recentlyViewed.record(ring));
  await settle();
  assert.deepEqual(handles(probe.read('home').products), ['ring', 'chain']);
  assert.deepEqual(handles(probe.read('account').products), ['ring']);
  await probe.unmount();
});

await t.check('clear empties every list and the device; anything not a product id is ignored', async () => {
  const probe = await mount({ home: () => useRecentlyViewed(), other: () => useRecentlyViewed() }, { storage });
  await act(() => probe.read('home').clear());
  await settle();
  assert.deepEqual(probe.read('other').products, []);
  assert.equal(storage.map.has(KEY), false);
  await act(async () => {
    await shopify.recentlyViewed.record({ id: 'gid://shopify/Collection/9', handle: 'sale' });
    await shopify.recentlyViewed.record({ id: '', handle: 'none' });
    await shopify.recentlyViewed.record({ id: '5', handle: 'stud' });
  });
  assert.deepEqual(shopify.recentlyViewed.list().map((entry) => entry.id), [P(5)]);
  await probe.unmount();
});

await t.check('enabled false: nothing read or shown, and record still works', async () => {
  forgetProducts();
  const before = count('WishlistNodes');
  const probe = await mount({ list: () => useRecentlyViewed({ enabled: false }) }, { storage: memoryStorage() });
  await act(() => probe.read('list').record(band));
  await settle();
  assert.deepEqual(probe.read('list').products, []);
  assert.equal(probe.read('list').loading, false);
  assert.equal(count('WishlistNodes'), before);
  assert.deepEqual(shopify.recentlyViewed.list().map((entry) => entry.id), [P(2)]);
  await probe.unmount();
});

// ── Products from past orders ───────────────────────────────────────────────
t.section('usePastOrderProducts');
const PAST_ORDER_READS = ['PastOrderProducts', 'CustomerPastOrderProducts', 'WishlistNodes'];

await t.check('signed out: nothing, not loading, no error, and nothing asked of Shopify', async () => {
  const before = calls.length;
  const probe = await mount({ past: () => usePastOrderProducts() }, { auth: SIGNED_OUT() });
  const { refresh, ...state } = probe.read('past');
  assert.deepEqual(state, { products: [], items: [], loading: false, error: false, signedIn: false });
  await act(() => refresh());
  await settle();
  assert.deepEqual(calls.slice(before).filter((call) => PAST_ORDER_READS.includes(call.name)), []);
  await probe.unmount();
});

storefrontPastOrders = [
  { processedAt: '2026-10-10T10:00:00Z', lineItems: { nodes: [sfLine(V(12), P(1)), sfLine(null), sfLine(V(99), P(404))] } },
  { processedAt: '2026-09-01T10:00:00Z', lineItems: { nodes: [sfLine(V(11), P(1)), sfLine(V(21), P(2))] } },
  { processedAt: '2026-08-01T10:00:00Z', lineItems: { nodes: [sfLine(V(31), P(3))] } },
];

await t.check('email and password: each product once, from its newest order, with the size bought; in two reads', async () => {
  forgetProducts();
  const before = calls.length;
  const probe = await mount({ past: () => usePastOrderProducts(), customer: () => useCustomer() }, { auth: PASSWORD() });
  const state = probe.read('past');
  assert.equal(state.signedIn, true);
  assert.equal(state.loading, false);
  assert.equal(state.error, false);
  assert.deepEqual(handles(state.products), ['ring', 'band', 'charm']);
  assert.deepEqual(state.items.map((item) => [item.product.handle, item.variantId, item.orderedAt]), [
    ['ring', V(12), '2026-10-10T10:00:00Z'],
    ['band', V(21), '2026-09-01T10:00:00Z'],
    ['charm', V(31), '2026-08-01T10:00:00Z'],
  ]);
  // One read of the orders (the Storefront API, 5 by default), one of their products.
  const sent = calls.slice(before).filter((call) => PAST_ORDER_READS.includes(call.name));
  assert.deepEqual(sent.map((call) => [call.api, call.name]), [['storefront', 'CustomerPastOrderProducts'], ['storefront', 'WishlistNodes']]);
  assert.equal(sent[0].variables.first, 5);
  assert.equal(sent[0].variables.accessToken, 'tok_live');
  assert.deepEqual(sent[1].variables.ids, [P(1), P(404), P(2), P(3)]);
  await probe.unmount();
});

await t.check('limit: at most that many; a product the store no longer has gives its place to the next', async () => {
  forgetProducts();
  const before = calls.length;
  const probe = await mount({ past: () => usePastOrderProducts({ limit: 2 }) }, { auth: PASSWORD() });
  assert.deepEqual(handles(probe.read('past').products), ['ring', 'band']);
  const reads = calls.slice(before).filter((call) => call.name === 'WishlistNodes').map((call) => call.variables.ids);
  assert.deepEqual(reads, [[P(1), P(404)], [P(2)]]);
  await probe.unmount();
});

await t.check('orders and limit are kept to 1–10 and 1–24', async () => {
  const before = calls.length;
  const wide = await mount({ past: () => usePastOrderProducts({ orders: 50, limit: 100 }) }, { auth: PASSWORD() });
  assert.equal(calls.slice(before).find((call) => call.name === 'CustomerPastOrderProducts').variables.first, 10);
  await wide.unmount();
  const middle = calls.length;
  const narrow = await mount({ past: () => usePastOrderProducts({ orders: 0, limit: 0 }) }, { auth: PASSWORD() });
  assert.equal(calls.slice(middle).find((call) => call.name === 'CustomerPastOrderProducts').variables.first, 1);
  assert.deepEqual(handles(narrow.read('past').products), ['ring']);
  await narrow.unmount();
});

await t.check('refresh reads the orders again; only a product not read this session is read', async () => {
  const probe = await mount({ past: () => usePastOrderProducts() }, { auth: PASSWORD() });
  storefrontPastOrders = [
    { processedAt: '2026-10-15T10:00:00Z', lineItems: { nodes: [sfLine(V(51), P(5))] } },
    ...storefrontPastOrders,
  ];
  const before = calls.length;
  await act(() => probe.read('past').refresh());
  await settle();
  assert.deepEqual(handles(probe.read('past').products), ['stud', 'ring', 'band', 'charm']);
  assert.equal(calls.slice(before).filter((call) => call.name === 'CustomerPastOrderProducts').length, 1);
  assert.deepEqual(calls.slice(before).filter((call) => call.name === 'WishlistNodes').map((call) => call.variables.ids), [[P(5)]]);
  await probe.unmount();
});

await t.check('a failed read says so; enabled false reads nothing', async () => {
  failNext.add('CustomerPastOrderProducts');
  const failed = await mount({ past: () => usePastOrderProducts() }, { auth: PASSWORD() });
  assert.equal(failed.read('past').error, true);
  assert.equal(failed.read('past').loading, false);
  assert.deepEqual(failed.read('past').products, []);
  await failed.unmount();
  const before = calls.length;
  const off = await mount({ past: () => usePastOrderProducts({ enabled: false }) }, { auth: PASSWORD() });
  assert.equal(off.read('past').signedIn, true);
  assert.equal(off.read('past').loading, false);
  assert.deepEqual(calls.slice(before).filter((call) => PAST_ORDER_READS.includes(call.name)), []);
  await off.unmount();
});

accountPastOrders = [
  { processedAt: '2026-10-12T10:00:00Z', lineItems: { nodes: [{ productId: P(4), variantId: V(40) }, { productId: null, variantId: null }] } },
  { processedAt: '2026-10-01T10:00:00Z', lineItems: { nodes: [{ productId: P(5), variantId: V(51) }, { productId: P(4), variantId: V(41) }] } },
];

await t.check('Shopify sign-in: the Customer Account API; a size the product no longer has is null', async () => {
  forgetProducts();
  const before = calls.length;
  const probe = await mount({ past: () => usePastOrderProducts() }, { auth: SHOPIFY() });
  const state = probe.read('past');
  assert.equal(state.signedIn, true);
  assert.deepEqual(state.items.map((item) => [item.product.handle, item.variantId, item.orderedAt]), [
    ['chain', null, '2026-10-12T10:00:00Z'],
    ['stud', V(51), '2026-10-01T10:00:00Z'],
  ]);
  const sent = calls.slice(before).filter((call) => PAST_ORDER_READS.includes(call.name));
  assert.deepEqual(sent.map((call) => [call.api, call.name]), [['account', 'PastOrderProducts'], ['storefront', 'WishlistNodes']]);
  assert.deepEqual(sent[1].variables.ids, [P(4), P(5)]);
  await probe.unmount();
});

t.done();
