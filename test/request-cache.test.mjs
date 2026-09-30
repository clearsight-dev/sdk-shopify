// One network call per identical Storefront read: in-flight sharing for every query, reuse of
// recent catalogue answers, never for mutations, cart or customer. `fetch` is a counting stub.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = { amount: '10.00', currencyCode: 'USD' };
const emptyCart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [],
  createdAt: '', updatedAt: '',
};
const page = (handle) => ({ collection: {
  handle, title: handle,
  products: { nodes: [], filters: [],
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
} });

/** Calls per operation name, and switches to make the next response fail. */
const calls = {};
const fail = { http: 0, graphql: 0 };
const count = (name) => calls[name] ?? 0;
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const name = (/mutation (\w+)|query (\w+)/.exec(query) || [])[1] || (/query (\w+)/.exec(query) || [])[1] || 'anon';
  calls[name] = count(name) + 1;
  // A tick of latency, so concurrent callers genuinely overlap.
  await new Promise((r) => setTimeout(r, 5));
  if (fail.http > 0) { fail.http--; return { ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' }; }
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
  if (fail.graphql > 0) { fail.graphql--; return reply({ errors: [{ message: 'Throttled' }] }); }
  if (name === 'ShopInfo') return reply({ data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } } });
  if (name === 'CollectionProducts') return reply({ data: page(variables.handle) });
  if (name === 'CartGet') return reply({ data: { cart: emptyCart } });
  if (name === 'CartCreate') return reply({ data: { cartCreate: { cart: emptyCart, userErrors: [] } } });
  if (name === 'CustomerRecover') return reply({ data: { customerRecover: { customerUserErrors: [] } } });
  return reply({ data: {} });
};

const sdk = await import('../dist/index.js');
const { shopify, clearRequestCache } = sdk;
const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };

console.log('request cache: shared calls');
await shopify.init(CONFIG);

await check('six identical collection reads at once are ONE network call', async () => {
  const before = count('CollectionProducts');
  const results = await Promise.all(Array.from({ length: 6 }, () => shopify.collections.products('dresses', { first: 12 })));
  assert.equal(count('CollectionProducts') - before, 1);
  for (const r of results) assert.deepEqual(r, results[0]);
  // Each caller parses its own copy: mutating one result cannot reach another caller.
  results[0].nodes.push({ id: 'x' });
  assert.equal(results[1].nodes.length, 0);
});

await check('a seventh read moments later is answered from memory', async () => {
  const before = count('CollectionProducts');
  const again = await shopify.collections.products('dresses', { first: 12 });
  assert.equal(count('CollectionProducts') - before, 0);
  assert.equal(again.nodes.length, 0, 'the cached copy was not changed by the earlier mutation');
});

await check('fresh: true (pull-to-refresh) goes to the network', async () => {
  const before = count('CollectionProducts');
  await shopify.collections.products('dresses', { first: 12, fresh: true });
  assert.equal(count('CollectionProducts') - before, 1);
});

await check('different variables are different calls', async () => {
  const before = count('CollectionProducts');
  await Promise.all([
    shopify.collections.products('shoes', { first: 12 }),
    shopify.collections.products('dresses', { first: 24 }),
  ]);
  assert.equal(count('CollectionProducts') - before, 2);
});

await check('mutations are never shared: two identical writes are two calls', async () => {
  const before = count('CustomerRecover');
  await Promise.all([shopify.customer.recoverPassword('a@b.c'), shopify.customer.recoverPassword('a@b.c')]);
  assert.equal(count('CustomerRecover') - before, 2);
});

await check('the cart is shared while in flight but never reused afterwards', async () => {
  const before = count('CartGet');
  await Promise.all([shopify.cart.get('gid://shopify/Cart/1'), shopify.cart.get('gid://shopify/Cart/1')]);
  assert.equal(count('CartGet') - before, 1, 'concurrent reads share one call');
  await shopify.cart.get('gid://shopify/Cart/1');
  assert.equal(count('CartGet') - before, 2, 'a later read goes to the network');
});

await check('a failed call is not kept: HTTP 500, then the next read retries', async () => {
  clearRequestCache();
  fail.http = 1;
  const before = count('CollectionProducts');
  await assert.rejects(shopify.collections.products('bags', { first: 12 }), /HTTP 500/);
  await shopify.collections.products('bags', { first: 12 });
  assert.equal(count('CollectionProducts') - before, 2);
});

await check('a GraphQL error is not kept either', async () => {
  fail.graphql = 1;
  const before = count('CollectionProducts');
  await assert.rejects(shopify.collections.products('hats', { first: 12 }), /Throttled/);
  await shopify.collections.products('hats', { first: 12 });
  assert.equal(count('CollectionProducts') - before, 2);
});

await check('clearRequestCache forgets every kept answer', async () => {
  await shopify.collections.products('dresses', { first: 12 });
  const before = count('CollectionProducts');
  clearRequestCache();
  await shopify.collections.products('dresses', { first: 12 });
  assert.equal(count('CollectionProducts') - before, 1);
});

console.log('request cache: config');
await check('cache: false stops reuse but still shares calls in flight', async () => {
  await shopify.init({ ...CONFIG, cache: false });
  const before = count('CollectionProducts');
  await Promise.all([shopify.collections.products('dresses'), shopify.collections.products('dresses')]);
  await shopify.collections.products('dresses');
  assert.equal(count('CollectionProducts') - before, 2);
});

await check('a per-operation ttl expires on time', async () => {
  await shopify.init({ ...CONFIG, cache: { ttl: { CollectionProducts: 30 } } });
  const before = count('CollectionProducts');
  await shopify.collections.products('dresses');
  await shopify.collections.products('dresses');
  assert.equal(count('CollectionProducts') - before, 1, 'reused within 30 ms');
  await wait(45);
  await shopify.collections.products('dresses');
  assert.equal(count('CollectionProducts') - before, 2, 'read again after it expired');
});

await check('maxEntries evicts the least recently used answer', async () => {
  await shopify.init({ ...CONFIG, cache: { maxEntries: 2 } });
  await shopify.collections.products('a');
  await shopify.collections.products('b');
  await shopify.collections.products('a'); // a is now the most recent
  await shopify.collections.products('c'); // evicts b
  const before = count('CollectionProducts');
  await shopify.collections.products('a');
  assert.equal(count('CollectionProducts') - before, 0, 'a survived');
  await shopify.collections.products('b');
  assert.equal(count('CollectionProducts') - before, 1, 'b was evicted');
});

console.log('request cache: six hooks on one collection');
await shopify.init(CONFIG);
clearRequestCache();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useCollectionProducts } = sdk;
const feeds = [];
function Grid({ i }) {
  feeds[i] = useCollectionProducts({ handle: 'new-arrivals', pageSize: 12 });
  return null;
}
const root = createRoot(document.getElementById('root'));
const before = count('CollectionProducts');
await runAct(async () => {
  root.render(React.createElement(
    ShopifyProvider,
    { config: CONFIG },
    ...Array.from({ length: 6 }, (_, i) => React.createElement(Grid, { key: i, i })),
  ));
});
// The provider's own startup (shop, cart, wishlist, customer) runs first; give it all time to settle.
for (let i = 0; i < 20 && !feeds.every((f) => f && f.title); i++) await runAct(async () => { await wait(25); });
await check('six useCollectionProducts on the same collection make ONE request', async () => {
  if (!feeds.every((f) => f && f.title)) console.log('    state:', feeds.map((f) => f && { loading: f.loading, error: f.error, title: f.title }));
  assert.equal(count('CollectionProducts') - before, 1);
  assert.ok(feeds.every((f) => f && f.loading === false && f.error === false && f.title === 'new-arrivals'));
});
await runAct(async () => { feeds[0].refresh(); });
await runAct(async () => { await wait(30); });
await check("one grid's pull-to-refresh goes to the network; the others don't refetch", async () => {
  assert.equal(count('CollectionProducts') - before, 2);
});
await runAct(async () => { root.unmount(); });

console.log(`\n${pass} checks passed`);
