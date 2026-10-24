// The search query template (0.23.0): `useSearch` / `useSearchPage` send the term through a store's
// template (`{query}* -tag:hidden`), while the page keeps showing what was typed.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = { amount: '0.00', currencyCode: 'USD' };
const cart = { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '' };
const searched = [];
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (/search\(/.test(query)) searched.push(variables.query);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1];
  const data = /search\(/.test(query)
    ? { search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, productFilters: [], totalCount: 0 } }
    : name === 'CartCreate' ? { cartCreate: { cart, userErrors: [] } } : query.includes('cart(id:') ? { cart } : {};
  return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, searchQueryFrom, useSearch } = await import('../dist/index.js');

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };
console.log('search query template');

await check('{query} stands for the trimmed term; every one is replaced', () => {
  assert.equal(searchQueryFrom('  ring ', '{query}* -tag:hidden'), 'ring* -tag:hidden');
  assert.equal(searchQueryFrom('ring', '{query} OR title:{query}'), 'ring OR title:ring');
});
await check('a template without {query} goes after the term; none, or no term, sends the term', () => {
  assert.equal(searchQueryFrom('ring', '-tag:hidden'), 'ring -tag:hidden');
  assert.equal(searchQueryFrom('ring', ''), 'ring');
  assert.equal(searchQueryFrom('ring'), 'ring');
  assert.equal(searchQueryFrom('  ', '{query}*'), '');
});

await check('a search sends the term as given: the SDK leaves out no tag of its own (an app passes a template)', async () => {
  const { shopify } = await import('../dist/index.js');
  await shopify.init({ storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' });
  await shopify.products.search('ring');
  await shopify.products.search('band -tag:SEARCH-BLOCKED');
  assert.deepEqual(searched.splice(0), ['ring', 'band -tag:SEARCH-BLOCKED']);
});

let result = null;
function Screen({ template }) {
  result = useSearch('ring', { debounceMs: 0, queryTemplate: template });
  return null;
}
const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });

const config = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' };
const render = (template) => runAct(async () => root.render(React.createElement(ShopifyProvider, { config }, React.createElement(Screen, { template }))));
await render('{query}* -tag:hidden');
await settle();
await check('useSearch sends the template, and still reports the term typed', () => {
  assert.deepEqual(searched, ['ring* -tag:hidden']);
  assert.equal(result.query, 'ring');
});

await render(undefined);
await settle();
await check('without one, the term as typed (its own cache entry)', () => {
  assert.deepEqual(searched, ['ring* -tag:hidden', 'ring']);
});

await runAct(async () => root.unmount());
console.log(`\n${pass} checks passed`);
