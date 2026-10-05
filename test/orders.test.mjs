// Orders (`useOrders`, `useOrder`, `buyAgain`) for both kinds of session, rendered in jsdom with the
// real ShopifyProvider and Shopify stubbed at `fetch`: the Customer Account API for a Shopify sign-in,
// the Storefront API for email and password. Plus the pure pieces: the progress rule, the refresh
// merge, and Buy again's stock plan.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { deferred, harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const SHOP_ID = '68843864220';
const ACCOUNT_URL = `https://shopify.com/${SHOP_ID}/account/customer/api/2026-07/graphql`;
const DAY = 24 * 3600_000;
const usd = (amount) => ({ amount, currencyCode: 'USD' });

// ── Fake Shopify ────────────────────────────────────────────────────────────

/** A history of `count` orders, newest first, in either API's field names. */
function history(count, { storefront = false } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const n = count - i;
    return {
      id: storefront ? `gid://shopify/Order/${n}?key=k${n}` : `gid://shopify/Order/${n}`,
      name: `#${1000 + n}`,
      processedAt: new Date(Date.UTC(2026, 0, 1) + n * DAY).toISOString(),
      [storefront ? 'canceledAt' : 'cancelledAt']: null,
      fulfillmentStatus: 'UNFULFILLED',
      [storefront ? 'statusUrl' : 'statusPageUrl']: `https://shop/status/${n}`,
      totalPrice: usd('10.0'),
      lineItems: { nodes: [{ quantity: 1 }] },
    };
  });
}

/** The Shopify sign-in's order in full (Customer Account API field names). */
const ACCOUNT_ORDER = {
  id: 'gid://shopify/Order/501',
  name: '#1501',
  processedAt: '2026-09-01T10:00:00Z',
  cancelledAt: null,
  fulfillmentStatus: 'PARTIALLY_FULFILLED',
  statusPageUrl: 'https://shop/status/501',
  totalPrice: usd('51.0'),
  subtotal: usd('45.0'),
  totalShipping: usd('0.0'),
  totalTax: usd('6.0'),
  totalRefunded: usd('0.0'),
  discountApplications: { nodes: [{ code: 'WELCOME5' }, {}] },
  lineItems: { nodes: [
    { title: 'Blush Dress', variantTitle: 'S / Blush', quantity: 2, variantId: 'v-dress', image: { url: 'https://cdn/dress.jpg' }, price: usd('15.0'), totalPrice: usd('30.0') },
    { title: 'Silk Scarf', variantTitle: 'Default Title', quantity: 1, variantId: 'v-scarf', image: null, price: usd('10.0'), totalPrice: usd('10.0') },
    { title: 'Gift Wrap', variantTitle: null, quantity: 1, variantId: null, image: null, price: usd('5.0'), totalPrice: usd('5.0') },
    { title: 'Old Tee', variantTitle: 'M', quantity: 1, variantId: 'v-old', image: null, price: usd('5.0'), totalPrice: usd('5.0') },
  ] },
};

/** The password session's order in full (Storefront field names): cancelled after it shipped. */
const STOREFRONT_ORDER = {
  id: 'gid://shopify/Order/77?key=k77',
  name: '#1077',
  processedAt: '2026-08-01T10:00:00Z',
  canceledAt: '2026-08-05T10:00:00Z',
  fulfillmentStatus: 'FULFILLED',
  statusUrl: 'https://shop/status/77',
  totalPrice: usd('55.0'),
  subtotalPrice: usd('50.0'),
  totalShippingPrice: usd('5.0'),
  totalTax: usd('0.0'),
  totalRefunded: usd('55.0'),
  discountApplications: { nodes: [] },
  lineItems: { nodes: [
    { title: 'Linen Pants', quantity: 2, originalTotalPrice: usd('40.0'), variant: { id: 'v-pants', title: 'M', image: { url: 'https://cdn/pants.jpg' } } },
    { title: 'Silk Scarf', quantity: 1, originalTotalPrice: usd('10.0'), variant: { id: 'v-scarf', title: 'Default Title', image: null } },
  ] },
};

/** Stock as the store has it now, for Buy again. A variant not listed no longer exists. */
const stock = {
  'v-dress': { availableForSale: true, quantityAvailable: 1 },
  'v-scarf': { availableForSale: true, quantityAvailable: null },
  'v-old': { availableForSale: false, quantityAvailable: 0 },
  'v-pants': { availableForSale: true, quantityAvailable: 10 },
};

let accountOrders = [];
let storefrontOrders = [];
let cartLines = [];
/** Every request, as `{ api, name, variables }`, in order. */
const calls = [];
const count = (name) => calls.filter((c) => c.name === name).length;
const last = (name) => calls.filter((c) => c.name === name).at(-1);
/** Operation name → a deferred the next such request waits on. */
const holds = new Map();
/** Operation names whose next request fails as if offline. */
const failNext = new Set();

const cursorOf = (order) => `cursor:${order.id}`;
function page(list, first, after) {
  const start = after ? list.findIndex((o) => cursorOf(o) === after) + 1 : 0;
  const nodes = list.slice(start, start + first);
  return { nodes, pageInfo: { hasNextPage: start + first < list.length, endCursor: nodes.length ? cursorOf(nodes.at(-1)) : null } };
}
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout',
  totalQuantity: cartLines.reduce((n, l) => n + l.quantity, 0),
  lines: { nodes: cartLines.map((l, i) => ({ id: `gid://line/${i}`, quantity: l.quantity, attributes: [], sellingPlanAllocation: null,
    merchandise: { id: l.merchandiseId, title: 'V', price: usd('10.0') }, cost: { totalAmount: usd('10.0'), amountPerQuantity: usd('10.0') } })) },
  cost: { subtotalAmount: usd('0.0'), totalAmount: usd('0.0') }, discountCodes: [], appliedGiftCards: [], attributes: [], createdAt: '', updatedAt: '',
});
const variantNode = (id) => stock[id]
  ? { __typename: 'ProductVariant', id, title: 'V', sku: null, ...stock[id], price: usd('10.0'), compareAtPrice: null, selectedOptions: [], image: null,
      sellingPlanAllocations: { nodes: [] }, product: { id: 'gid://shopify/Product/1', title: 'P', handle: 'p', featuredImage: null, media: { nodes: [] } } }
  : null;

const account = {
  CustomerProfile: () => ({ customer: { id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
    emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } }),
  OrderHistory: ({ first, after }) => ({ customer: { orders: page(accountOrders, first, after) } }),
  OrderDetail: ({ id }) => ({ order: id === ACCOUNT_ORDER.id ? ACCOUNT_ORDER : null }),
};

const storefront = {
  ShopInfo: () => ({ shop: { name: 'Shop', moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } }),
  Customer: ({ accessToken }) => ({ customer: accessToken === 'tok_live'
    ? { id: 'gid://shopify/Customer/1', email: 'amber@example.com', firstName: 'Amber', lastName: 'Marie', phone: null, defaultAddress: null, acceptsMarketing: false }
    : null }),
  CustomerOrderHistory: ({ accessToken, first, after }) => ({ customer: accessToken === 'tok_live' ? { orders: page(storefrontOrders, first, after) } : null }),
  CustomerOrderIds: ({ after }) => {
    const { nodes, pageInfo } = page(storefrontOrders, 250, after);
    return { customer: { orders: { pageInfo, edges: nodes.map((node) => ({ cursor: cursorOf(node), node: { id: node.id } })) } } };
  },
  CustomerOrderDetail: ({ after }) => ({ customer: { orders: { nodes: page(storefrontOrders, 1, after).nodes } } }),
  VariantNodes: ({ ids }) => ({ nodes: ids.map(variantNode) }),
  CartCreate: () => ({ cartCreate: { cart: cartPayload(), userErrors: [] } }),
  CartGet: () => ({ cart: cartPayload() }),
  CartLinesAdd: ({ lines }) => {
    for (const line of lines) {
      const same = cartLines.find((l) => l.merchandiseId === line.merchandiseId);
      if (same) same.quantity += line.quantity;
      else cartLines.push({ merchandiseId: line.merchandiseId, quantity: line.quantity });
    }
    return { cartLinesAdd: { cart: cartPayload(), userErrors: [] } };
  },
};

global.fetch = async (url, init = {}) => {
  const api = String(url) === ACCOUNT_URL ? 'account' : 'storefront';
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:mutation|query) (\w+)/.exec(query)?.[1] ?? 'anon';
  calls.push({ api, name, variables: variables ?? {} });
  const hold = holds.get(name);
  if (hold) {
    holds.delete(name);
    await hold.promise;
  }
  if (failNext.delete(name)) throw new TypeError('Network request failed');
  if (api === 'account' && init.headers.Authorization !== 'at_live') return response(401, {});
  const handler = (api === 'account' ? account : storefront)[name];
  if (!handler) throw new Error(`unexpected ${api} operation ${name}`);
  return response(200, { data: handler(variables ?? {}) });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useOrders, useOrder, useCart, useCustomer, ORDERS_PAGE_SIZE } = await import('../dist/index.js');
const { orderProgress, planBuyAgain, withFreshFirstPage } = await import('../dist/orders.js');

const t = harness('orders: useOrders, useOrder, buyAgain');

// ── Pure pieces ─────────────────────────────────────────────────────────────
t.section('progress (production\'s status card rule)');
await t.check('cancelled wins over every fulfilment status', () => {
  assert.equal(orderProgress('2026-08-05T10:00:00Z', 'FULFILLED'), 'cancelled');
  assert.equal(orderProgress('2026-08-05T10:00:00Z', 'PARTIALLY_FULFILLED'), 'cancelled');
  assert.equal(orderProgress('2026-08-05T10:00:00Z', null), 'cancelled');
});
await t.check('then FULFILLED, PARTIALLY_FULFILLED, and everything else is confirmed', () => {
  assert.equal(orderProgress(null, 'FULFILLED'), 'fulfilled');
  assert.equal(orderProgress(null, 'PARTIALLY_FULFILLED'), 'partiallyFulfilled');
  for (const status of ['UNFULFILLED', 'ON_HOLD', 'IN_PROGRESS', 'SCHEDULED', 'RESTOCKED', null, undefined]) {
    assert.equal(orderProgress(null, status), 'confirmed', String(status));
  }
});

t.section('buy again: the stock plan');
const line = (variantId, quantity) => ({ title: 'x', variantTitle: null, quantity, imageUrl: null, unitPrice: null, totalPrice: null, variantId });
await t.check('a line with no variant, a variant gone, and one not for sale are skipped', () => {
  const plan = planBuyAgain([line(null, 1), line('v-gone', 1), line('v-off', 1)], [{ id: 'v-off', availableForSale: false, quantityAvailable: 0 }], null);
  assert.deepEqual(plan, { inputs: [], skipped: 3 });
});
await t.check('a quantity over what is left is cut to it, counting what the cart already holds', () => {
  const cart = { lines: [{ merchandise: { id: 'v1' }, quantity: 1 }] };
  const plan = planBuyAgain([line('v1', 3)], [{ id: 'v1', availableForSale: true, quantityAvailable: 3 }], cart);
  assert.deepEqual(plan, { inputs: [{ merchandiseId: 'v1', quantity: 2 }], skipped: 0 });
});
await t.check('two lines of one variant share its stock; nothing left is skipped', () => {
  const plan = planBuyAgain([line('v1', 2), line('v1', 2)], [{ id: 'v1', availableForSale: true, quantityAvailable: 3 }], null);
  assert.deepEqual(plan, { inputs: [{ merchandiseId: 'v1', quantity: 2 }, { merchandiseId: 'v1', quantity: 1 }], skipped: 0 });
  const full = planBuyAgain([line('v1', 1)], [{ id: 'v1', availableForSale: true, quantityAvailable: 2 }], { lines: [{ merchandise: { id: 'v1' }, quantity: 2 }] });
  assert.deepEqual(full, { inputs: [], skipped: 1 });
});
await t.check('untracked stock, or overselling allowed, has no ceiling', () => {
  const plan = planBuyAgain([line('v1', 5), line('v2', 4)], [
    { id: 'v1', availableForSale: true, quantityAvailable: null },
    { id: 'v2', availableForSale: true, quantityAvailable: 0 },
  ], null);
  assert.deepEqual(plan.inputs.map((i) => i.quantity), [5, 4]);
});

await t.check('a pre-order variant still sold out goes back on its plan, at the ordered quantity', () => {
  const plan = planBuyAgain([line('v-pre', 3)], [{ id: 'v-pre', availableForSale: true, quantityAvailable: 0, sellingPlan: { id: 'plan-1' } }], null);
  assert.deepEqual(plan, { inputs: [{ merchandiseId: 'v-pre', quantity: 3, sellingPlanId: 'plan-1' }], skipped: 0 });
});
await t.check('a pre-order variant back in stock goes back as an ordinary line, by the stock rule', () => {
  const plan = planBuyAgain([line('v-pre', 3)], [{ id: 'v-pre', availableForSale: true, quantityAvailable: 2, sellingPlan: { id: 'plan-1' } }], null);
  assert.deepEqual(plan, { inputs: [{ merchandiseId: 'v-pre', quantity: 2 }], skipped: 0 });
});
await t.check('a pre-order variant no longer for sale is skipped', () => {
  const plan = planBuyAgain([line('v-pre', 1)], [{ id: 'v-pre', availableForSale: false, quantityAvailable: 0, sellingPlan: { id: 'plan-1' } }], null);
  assert.deepEqual(plan, { inputs: [], skipped: 1 });
});
await t.check('skipVariant: every line of a variant it names is skipped, asked by variant id, only for lines still in play', () => {
  const asked = [];
  const skipVariant = (id) => { asked.push(id); return id === 'v1'; };
  const plan = planBuyAgain([line('v1', 2), line('v2', 1), line('v-gone', 1), line('v1', 1)], [
    { id: 'v1', availableForSale: true, quantityAvailable: 5 },
    { id: 'v2', availableForSale: true, quantityAvailable: 5 },
  ], null, { skipVariant });
  assert.deepEqual(plan, { inputs: [{ merchandiseId: 'v2', quantity: 1 }], skipped: 3 });
  assert.deepEqual(asked, ['v1', 'v2', 'v1']);
});
await t.check('skipVariant applies to a pre-order line too', () => {
  const plan = planBuyAgain([line('v-pre', 1)], [{ id: 'v-pre', availableForSale: true, quantityAvailable: 0, sellingPlan: { id: 'plan-1' } }], null, { skipVariant: () => true });
  assert.deepEqual(plan, { inputs: [], skipped: 1 });
});

t.section('refresh: a fresh first page over what is shown');
const summaries = (ids) => ids.map((id) => ({ id }));
await t.check('later pages are kept behind a fresh first page, with their cursor', () => {
  const shown = { orders: summaries(['a', 'b', 'c', 'd', 'e']), endCursor: 'after-e', hasMore: true };
  const merged = withFreshFirstPage(shown, { orders: summaries(['new', 'a', 'b']), endCursor: 'after-b', hasNextPage: true });
  assert.deepEqual(merged.orders.map((o) => o.id), ['new', 'a', 'b', 'c', 'd', 'e']);
  assert.equal(merged.endCursor, 'after-e');
  assert.equal(merged.hasMore, true);
});
await t.check('a fresh page that is the whole history, or doesn\'t reach the old list, replaces it', () => {
  const shown = { orders: summaries(['a', 'b', 'c']), endCursor: 'after-c', hasMore: true };
  assert.deepEqual(withFreshFirstPage(shown, { orders: summaries(['x', 'a']), endCursor: 'after-a', hasNextPage: false }).orders.map((o) => o.id), ['x', 'a']);
  assert.deepEqual(withFreshFirstPage(shown, { orders: summaries(['x', 'y']), endCursor: 'after-y', hasNextPage: true }).orders.map((o) => o.id), ['x', 'y']);
});

// ── Rendered ────────────────────────────────────────────────────────────────
let list = null;
let one = null;
let cart = null;
let customer = null;
/**
 * Stands in for a screen: it refreshes whenever the shopper is signed in, the way the order screens
 * refresh on focus, so a double read on mount would show up here.
 */
function Probe({ orderId, pageSize }) {
  list = useOrders(pageSize ? { pageSize } : undefined);
  one = useOrder(orderId);
  cart = useCart();
  customer = useCustomer();
  const { loggedIn } = customer;
  const { refresh } = list;
  const refreshOne = one.refresh;
  React.useEffect(() => {
    if (loggedIn) {
      void refresh();
      void refreshOne();
    }
  }, [loggedIn, refresh, refreshOne]);
  return null;
}

let root = null;
/** The provider's `cartGuard` for the next `open`; none unless a section sets one. */
let cartGuard;
const settle = (ms = 30) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function open(kind, props = {}) {
  if (root) await runAct(async () => { root.unmount(); });
  root = createRoot(document.getElementById('root'));
  const secureStorage =
    kind === 'password' ? keychain({ 'auth.storefrontToken': 'tok_live', 'auth.storefrontExpiresAt': String(Date.now() + 30 * DAY) })
    : kind === 'shopify' ? keychain({ 'auth.token': 'at_live', 'auth.refreshToken': 'rt_live', 'auth.expiresAt': String(Date.now() + 3600_000) })
    : keychain();
  const auth = { method: kind ?? 'password', secureStorage, customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } };
  calls.length = 0;
  await render(auth, props);
  return auth;
}
async function render(auth, props) {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth, cartGuard },
      React.createElement(Probe, props),
    ));
  });
  await settle();
}

t.section('signed out');
await open(null, { orderId: ACCOUNT_ORDER.id });
await t.check('empty, not loading, no error, and nothing asked of Shopify', async () => {
  assert.equal(customer.loggedIn, false);
  assert.deepEqual(list.orders, []);
  assert.equal(list.loading, false);
  assert.equal(list.error, null);
  assert.equal(list.hasMore, false);
  assert.equal(one.order, null);
  assert.equal(one.loading, false);
  assert.equal(one.notFound, false);
  await runAct(async () => { await list.refresh(); await one.refresh(); list.loadMore(); });
  assert.deepEqual(calls.filter((c) => /Order/.test(c.name)).map((c) => c.name), []);
});
let nothing;
await runAct(async () => { nothing = await one.buyAgain(); });
await t.check('buyAgain with no order adds nothing', () => assert.deepEqual(nothing, { added: 0, skipped: 0 }));

t.section('Shopify sign-in: the Customer Account API');
accountOrders = history(30);
await open('shopify');
await t.check('one read on mount, though the screen also refreshes as the session arrives', () => {
  assert.equal(customer.sessionKind, 'shopify');
  assert.equal(count('OrderHistory'), 1);
  const sent = last('OrderHistory');
  assert.equal(sent.api, 'account');
  assert.deepEqual(sent.variables, { first: ORDERS_PAGE_SIZE, after: null });
});
await t.check('the first page, newest first, with hasMore', () => {
  assert.equal(list.loading, false);
  assert.equal(list.orders.length, 25);
  assert.equal(list.hasMore, true);
  assert.deepEqual(list.orders[0], {
    id: 'gid://shopify/Order/30', name: '#1030', processedAt: accountOrders[0].processedAt, progress: 'confirmed',
    cancelledAt: null, totalPrice: usd('10.0'), itemCount: 1, statusPageUrl: 'https://shop/status/30',
  });
});

let more = deferred();
holds.set('OrderHistory', more);
await runAct(async () => { list.loadMore(); });
await settle(5);
await t.check('loadMore: loadingMore while the next page is on its way, after the last cursor', () => {
  assert.equal(list.loadingMore, true);
  assert.equal(list.loading, false);
  assert.equal(last('OrderHistory').variables.after, 'cursor:gid://shopify/Order/6');
});
await runAct(async () => { list.loadMore(); });
await t.check('a second loadMore while one is on its way sends nothing', () => assert.equal(count('OrderHistory'), 2));
more.resolve();
await settle();
await t.check('the next page is added; no more after it', () => {
  assert.equal(list.loadingMore, false);
  assert.equal(list.orders.length, 30);
  assert.equal(list.orders.at(-1).id, 'gid://shopify/Order/1');
  assert.equal(list.hasMore, false);
});

accountOrders = [...history(31).slice(0, 1), ...accountOrders];
const refreshing = deferred();
holds.set('OrderHistory', refreshing);
let refreshed;
await runAct(async () => { refreshed = list.refresh(); });
await t.check('a refresh keeps the list on screen, not loading', () => {
  assert.equal(list.loading, false);
  assert.equal(list.orders.length, 30);
});
refreshing.resolve();
await runAct(async () => { await refreshed; });
await t.check('then lays the fresh first page over it: the new order on top, the second page kept', () => {
  assert.equal(list.orders.length, 31);
  assert.equal(list.orders[0].id, 'gid://shopify/Order/31');
  assert.equal(list.orders.at(-1).id, 'gid://shopify/Order/1');
  assert.equal(new Set(list.orders.map((o) => o.id)).size, 31);
  assert.equal(list.hasMore, false);
});

failNext.add('OrderHistory');
await runAct(async () => { await list.refresh(); });
await t.check('a failed refresh keeps the list and sets error', () => {
  assert.ok(list.error instanceof Error);
  assert.equal(list.orders.length, 31);
  assert.equal(list.loading, false);
});
await runAct(async () => { await list.refresh(); });
await t.check('the next refresh that works clears it', () => assert.equal(list.error, null));

t.section('Shopify sign-in: one order');
cartLines = [];
await open('shopify', { orderId: ACCOUNT_ORDER.id });
await t.check('one read of the order, by id, from the Customer Account API', () => {
  assert.equal(count('OrderDetail'), 1);
  assert.deepEqual(last('OrderDetail').variables, { id: ACCOUNT_ORDER.id });
  assert.equal(one.loading, false);
  assert.equal(one.notFound, false);
});
await t.check('the summary fields, as the list has them', () => {
  const o = one.order;
  assert.equal(o.name, '#1501');
  assert.equal(o.progress, 'partiallyFulfilled');
  assert.equal(o.statusPageUrl, 'https://shop/status/501');
  assert.equal(o.itemCount, 5);
  assert.deepEqual(o.totalPrice, usd('51.0'));
});
await t.check('lines: unit and line prices, the default variant title read as none, a gone variant as null', () => {
  const [dress, scarf, wrap] = one.order.lineItems;
  assert.deepEqual(dress, { title: 'Blush Dress', variantTitle: 'S / Blush', quantity: 2, imageUrl: 'https://cdn/dress.jpg',
    unitPrice: usd('15.0'), totalPrice: usd('30.0'), variantId: 'v-dress' });
  assert.equal(scarf.variantTitle, null);
  assert.equal(wrap.variantId, null);
});
await t.check('totals: subtotal before discounts, the discount the gap to Shopify\'s, free shipping kept, no refund row', () => {
  const o = one.order;
  assert.deepEqual(o.subtotal, usd('50.00'));
  assert.deepEqual(o.totalDiscount, usd('5.00'));
  assert.deepEqual(o.discountCodes, ['WELCOME5']);
  assert.deepEqual(o.totalShipping, usd('0.0'));
  assert.deepEqual(o.totalTax, usd('6.0'));
  assert.equal(o.totalRefunded, null);
});

let bought;
await runAct(async () => { bought = await one.buyAgain(); });
await settle();
await t.check('buyAgain: a gone variant and one not for sale skipped, a quantity over the stock cut to it', () => {
  assert.deepEqual(bought, { added: 2, skipped: 2 });
  assert.deepEqual(last('VariantNodes').variables.ids, ['v-dress', 'v-scarf', 'v-old']);
  assert.deepEqual(last('CartLinesAdd').variables.lines, [{ merchandiseId: 'v-dress', quantity: 1 }, { merchandiseId: 'v-scarf', quantity: 1 }]);
  assert.equal(count('CartLinesAdd'), 1);
  assert.equal(cart.cart.totalQuantity, 2);
});
await runAct(async () => { bought = await one.buyAgain(); });
await t.check('again: the dress is now all in the cart, so only the scarf (untracked stock) goes in', () => {
  assert.deepEqual(bought, { added: 1, skipped: 3 });
  assert.deepEqual(last('CartLinesAdd').variables.lines, [{ merchandiseId: 'v-scarf', quantity: 1 }]);
});
failNext.add('VariantNodes');
await runAct(async () => { bought = await one.buyAgain(); });
await t.check('offline, it doesn\'t throw: every line counts as skipped', () => assert.deepEqual(bought, { added: 0, skipped: 4 }));

await open('shopify', { orderId: 'gid://shopify/Order/404' });
await t.check('an id this shopper has no order for: notFound, no error', () => {
  assert.equal(one.order, null);
  assert.equal(one.notFound, true);
  assert.equal(one.error, null);
  assert.equal(one.loading, false);
});

t.section('email and password: the Storefront API');
const older = history(40, { storefront: true });
storefrontOrders = [...older.slice(0, 3), STOREFRONT_ORDER, ...older.slice(3)];
await open('password', { pageSize: 10 });
await t.check('the history read with the session\'s token, a page of pageSize', () => {
  assert.equal(customer.sessionKind, 'password');
  assert.equal(count('CustomerOrderHistory'), 1);
  assert.deepEqual(last('CustomerOrderHistory').variables, { accessToken: 'tok_live', first: 10, after: null });
  assert.equal(list.orders.length, 10);
  assert.equal(list.hasMore, true);
});
await t.check('Storefront names mapped: canceledAt, statusUrl; cancelled wins over FULFILLED', () => {
  const o = list.orders[3];
  assert.equal(o.id, STOREFRONT_ORDER.id);
  assert.equal(o.cancelledAt, '2026-08-05T10:00:00Z');
  assert.equal(o.progress, 'cancelled');
  assert.equal(o.statusPageUrl, 'https://shop/status/77');
  assert.equal(o.itemCount, 3);
});
await runAct(async () => { list.loadMore(); });
await settle();
await t.check('paging by cursor', () => {
  assert.equal(last('CustomerOrderHistory').variables.after, cursorOf(storefrontOrders[9]));
  assert.equal(list.orders.length, 20);
});

cartLines = [];
await open('password', { orderId: STOREFRONT_ORDER.id });
await t.check('one order: found in the id list, then read after the order before it', () => {
  assert.equal(count('CustomerOrderIds'), 1);
  assert.equal(count('CustomerOrderDetail'), 1);
  assert.deepEqual(last('CustomerOrderDetail').variables, { accessToken: 'tok_live', after: cursorOf(storefrontOrders[2]) });
  assert.equal(one.order.id, STOREFRONT_ORDER.id);
});
await t.check('the same shape as the Shopify sign-in\'s: unit price worked out, no zero tax, the refund shown', () => {
  const o = one.order;
  assert.equal(o.progress, 'cancelled');
  assert.deepEqual(o.lineItems[0], { title: 'Linen Pants', variantTitle: 'M', quantity: 2, imageUrl: 'https://cdn/pants.jpg',
    unitPrice: usd('20.00'), totalPrice: usd('40.0'), variantId: 'v-pants' });
  assert.equal(o.lineItems[1].variantTitle, null);
  assert.deepEqual(o.subtotal, usd('50.00'));
  assert.equal(o.totalDiscount, null);
  assert.deepEqual(o.discountCodes, []);
  assert.deepEqual(o.totalShipping, usd('5.0'));
  assert.equal(o.totalTax, null);
  assert.deepEqual(o.totalRefunded, usd('55.0'));
});
await runAct(async () => { bought = await one.buyAgain(); });
await t.check('buyAgain, everything in stock: all lines added at their quantities', () => {
  assert.deepEqual(bought, { added: 2, skipped: 0 });
  assert.deepEqual(last('CartLinesAdd').variables.lines, [{ merchandiseId: 'v-pants', quantity: 2 }, { merchandiseId: 'v-scarf', quantity: 1 }]);
});

await open('password', { orderId: 'gid://shopify/Order/404?key=nope' });
await t.check('an id not in the history: notFound after the id list, with no detail read', () => {
  assert.equal(one.notFound, true);
  assert.equal(count('CustomerOrderDetail'), 0);
});

t.section('buy again through the cart guard (Cart Hold\'s rules)');
// A guard like Cart Hold's: it approves only the units still free (1 pair of pants of the 2 ordered),
// and records what it was asked.
const guardAsked = [];
cartGuard = {
  beforeAdd: (input, options) => {
    guardAsked.push({ variantId: input.merchandiseId, quantity: input.quantity, options });
    return input.merchandiseId === 'v-pants' ? { ...input, quantity: 1 } : input;
  },
};
cartLines = [];
await open('password', { orderId: STOREFRONT_ORDER.id });
await runAct(async () => { bought = await one.buyAgain(); });
await t.check('every line goes through the guard, told { quiet: true }', () => {
  assert.deepEqual(guardAsked, [
    { variantId: 'v-pants', quantity: 2, options: { quiet: true } },
    { variantId: 'v-scarf', quantity: 1, options: { quiet: true } },
  ]);
});
await t.check('a line the guard cut (2 ordered, 1 free) goes in at what it approved, and counts as added', () => {
  assert.deepEqual(bought, { added: 2, skipped: 0 });
  assert.deepEqual(last('CartLinesAdd').variables.lines, [{ merchandiseId: 'v-pants', quantity: 1 }, { merchandiseId: 'v-scarf', quantity: 1 }]);
});
guardAsked.length = 0;
await runAct(async () => { bought = await one.buyAgain({ skipVariant: (id) => id === 'v-pants' }); });
await t.check('skipVariant (Cart Hold\'s held out): that line is skipped before the guard is asked', () => {
  assert.deepEqual(bought, { added: 1, skipped: 1 });
  assert.deepEqual(guardAsked.map((asked) => asked.variantId), ['v-scarf']);
  assert.deepEqual(last('CartLinesAdd').variables.lines, [{ merchandiseId: 'v-scarf', quantity: 1 }]);
});
cartGuard.beforeAdd = (input) => (input.merchandiseId === 'v-scarf' ? null : input);
await runAct(async () => { bought = await one.buyAgain(); });
await t.check('a line the guard refuses counts as skipped; the rest still goes in', () => {
  assert.deepEqual(bought, { added: 1, skipped: 1 });
  assert.deepEqual(last('CartLinesAdd').variables.lines, [{ merchandiseId: 'v-pants', quantity: 2 }]);
});
cartGuard = undefined;

t.section('signing out');
await open('shopify', { orderId: ACCOUNT_ORDER.id });
await runAct(async () => { await customer.logout(); });
await settle();
await t.check('the shopper\'s orders go at once, with no error', () => {
  assert.deepEqual(list.orders, []);
  assert.equal(list.error, null);
  assert.equal(one.order, null);
  assert.equal(one.notFound, false);
});

await runAct(async () => { root.unmount(); });
t.done();
