// Renders useCollectionProducts under the real ShopifyProvider in jsdom, with the Storefront API
// stubbed at `fetch`, and asserts the filters each CollectionProducts request carries.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── Storefront API stub ─────────────────────────────────────────────────────
const IN_STOCK = JSON.stringify({ available: true });
const RED = JSON.stringify({ variantOption: { name: 'Color', value: 'Red' } });
const money = { amount: '10.00', currencyCode: 'USD' };
const emptyCart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [],
  createdAt: '', updatedAt: '',
};

/** Every CollectionProducts request, as `{ handle, filters }`. */
const reads = [];
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = op?.[1] || op?.[2] || 'unknown';
  const reply = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (name === 'ShopInfo' || query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } },
                   localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') return reply({ cartCreate: { cart: emptyCart, userErrors: [] } });
  if (name === 'CartGet' || query.includes('cart(id:')) return reply({ cart: emptyCart });
  if (name === 'CollectionProducts') {
    reads.push({ handle: variables.handle, filters: variables.filters ?? null });
    return reply({ collection: {
      handle: variables.handle, title: variables.handle,
      products: {
        nodes: [],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        filters: [{ id: 'filter.v.availability', label: 'Availability', type: 'LIST',
                    values: [{ id: 'in-stock', label: 'In stock', count: 3, input: IN_STOCK }] }],
      },
    } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useCollectionProducts } = await import('../dist/index.js');

let feed = null;
const props = { handle: 'dresses', filters: undefined };
function Probe() {
  feed = useCollectionProducts({ handle: props.handle, filters: props.filters });
  return null;
}

const root = createRoot(document.getElementById('root'));
const render = async () => {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      // cache: false — these checks read the request each change sends; reuse is tested in
      // request-cache.test.mjs.
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', cache: false } },
      React.createElement(Probe),
    ));
  });
  await runAct(async () => { await new Promise((r) => setTimeout(r, 40)); });
};
const act = async (fn) => {
  await runAct(async () => { fn(); });
  await runAct(async () => { await new Promise((r) => setTimeout(r, 20)); });
};
const last = () => reads[reads.length - 1];

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

console.log('collection filters');
await render();
check('first read has no filters, and nothing is selected', () => {
  assert.deepEqual(last(), { handle: 'dresses', filters: null });
  assert.deepEqual(feed.selectedFilters, []);
  assert.equal(feed.filterActive, false);
  assert.equal(feed.availableFilters[0].values[0].input, IN_STOCK);
});

await act(() => feed.setFilters([IN_STOCK, RED, IN_STOCK]));
check('setFilters takes the inputs as given, parses them for the request, and drops duplicates', () => {
  assert.deepEqual(feed.selectedFilters, [IN_STOCK, RED]);
  assert.equal(feed.filterActive, true);
  assert.deepEqual(last().filters, [JSON.parse(IN_STOCK), JSON.parse(RED)]);
});

const before = reads.length;
await act(() => feed.setFilters(['not json', '[1,2]', RED]));
check('an input that is not a Shopify filter is dropped, not sent', () => {
  assert.deepEqual(feed.selectedFilters, [RED]);
  assert.equal(reads.length, before + 1);
  assert.deepEqual(last().filters, [JSON.parse(RED)]);
});

await act(() => feed.clearFilters());
check('clearFilters reads the collection unfiltered again', () => {
  assert.deepEqual(feed.selectedFilters, []);
  assert.equal(feed.filterActive, false);
  assert.equal(last().filters, null);
});

props.filters = [{ available: true }];
await render();
await act(() => feed.setFilters([RED]));
check("the app's fixed filters come first, the shopper's selection on top", () => {
  assert.deepEqual(last().filters, [{ available: true }, JSON.parse(RED)]);
  assert.equal(feed.filterActive, true, 'fixed filters alone do not count as a selection');
});

const beforeSwitch = reads.length;
props.handle = 'shoes';
await render();
check('a new handle starts with no selection, and its first read carries no stale filters', () => {
  const firstShoes = reads.slice(beforeSwitch).find((r) => r.handle === 'shoes');
  assert.deepEqual(firstShoes.filters, [{ available: true }]);
  assert.deepEqual(feed.selectedFilters, []);
  assert.equal(feed.filterActive, false);
});

const beforeRefresh = reads.length;
await act(() => feed.refresh());
check('refresh re-reads the first page, like retry', () => {
  assert.equal(reads.length, beforeRefresh + 1);
  assert.equal(last().handle, 'shoes');
  assert.equal(feed.retry, feed.refresh);
});

await runAct(async () => { root.unmount(); });

console.log('price filter helpers');
const { priceRange, priceFilterInput, parsePriceFilterInput, isPriceFilterInput } = await import('../dist/index.js');
const PRICE = { id: 'filter.v.price', label: 'Price', type: 'PRICE_RANGE',
                values: [{ id: 'p', label: 'Price', count: 0, input: '{"price":{"min":0,"max":3132.99}}' }] };
check('priceRange reads the facet bounds; any other facet is null', () => {
  assert.deepEqual(priceRange(PRICE), { min: 0, max: 3132.99 });
  assert.equal(priceRange({ id: 'x', label: 'x', type: 'LIST', values: [] }), null);
});
check('priceFilterInput builds Shopify\'s shape and round-trips', () => {
  const input = priceFilterInput(20, 100, priceRange(PRICE));
  assert.equal(input, '{"price":{"min":20,"max":100}}');
  assert.deepEqual(parsePriceFilterInput(input), { min: 20, max: 100 });
  assert.equal(isPriceFilterInput(input), true);
  assert.equal(isPriceFilterInput(IN_STOCK), false);
});
check('bounds at or past the range are dropped; nothing left means no filter', () => {
  const range = priceRange(PRICE);
  assert.equal(priceFilterInput(0, 3132.99, range), null);
  assert.equal(priceFilterInput(null, undefined, range), null);
  assert.equal(priceFilterInput(50, 9999, range), '{"price":{"min":50}}');
  assert.equal(priceFilterInput(undefined, 80, range), '{"price":{"max":80}}');
});
check('reversed bounds are swapped, a negative min is 0, junk is ignored', () => {
  assert.equal(priceFilterInput(100, 20), '{"price":{"min":20,"max":100}}');
  assert.equal(priceFilterInput(-5, 40), '{"price":{"min":0,"max":40}}');
  assert.equal(priceFilterInput('abc', NaN), null);
  assert.equal(parsePriceFilterInput('not json'), null);
});

console.log(`\n${pass} checks passed`);
