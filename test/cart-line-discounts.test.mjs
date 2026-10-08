// Each cart line's discounts (`line.discounts`): what each discount takes off the line and which code
// or discount it came from, read from Shopify's `discountAllocations`. Storefront stubbed at fetch.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const line = (id, discountAllocations) => ({
  id: `gid://shopify/CartLine/${id}`, quantity: 1, attributes: [], sellingPlanAllocation: null,
  merchandise: { id: `gid://shopify/ProductVariant/${id}`, title: 'Olive / M', price: money('20.0') },
  cost: { totalAmount: money('10.0'), amountPerQuantity: money('20.0'), compareAtAmountPerQuantity: null },
  ...(discountAllocations === undefined ? {} : { discountAllocations }),
});
// Amore's cart of 2026-10-08, as Shopify answered it: a $20 giveaway code for Olive / M spread $10 and
// $10 over the prize and a paid line of the same size; a line with an automatic discount; a line with none;
// and a line from an answer that didn't carry the field at all.
let lines = [];
const cart = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: lines.length,
  lines: { nodes: lines }, cost: { subtotalAmount: money('20.0'), totalAmount: money('20.0') },
  discountCodes: [{ code: 'GIVEAWAY-1791449255616', applicable: true }], appliedGiftCards: [], createdAt: '', updatedAt: '',
});
const sent = [];
global.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(body.query) || [])[1];
  sent.push({ name, query: body.query });
  const data = name === 'CartGet' ? { cart: cart() } : name === 'ShopInfo' ? { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } } : {};
  return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
};

const { shopify } = await import('../dist/index.js');
await shopify.init({ storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', cache: false });

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };

console.log("each cart line's discounts");

await check('the cart read asks for each line\'s discount allocations: the amount, and the code or the name', async () => {
  lines = [];
  await shopify.cart.get('gid://shopify/Cart/1');
  const query = sent.find((s) => s.name === 'CartGet').query;
  assert.match(query, /discountAllocations\s*\{\s*discountedAmount \{ \.\.\.MoneyFields \}/);
  assert.match(query, /\.\.\. on CartCodeDiscountAllocation \{ code \}/);
  assert.match(query, /\.\.\. on CartAutomaticDiscountAllocation \{ title \}/);
  assert.match(query, /\.\.\. on CartCustomDiscountAllocation \{ title \}/);
});

await check('a code spread over two lines: each line carries its share and the code', async () => {
  const code = [{ discountedAmount: money('10.0'), code: 'GIVEAWAY-1791449255616' }];
  lines = [line(1, code), line(2, code)];
  const read = await shopify.cart.get('gid://shopify/Cart/1');
  for (const cartLine of read.lines) {
    assert.deepEqual(cartLine.discounts, [{ amount: money('10.0'), code: 'GIVEAWAY-1791449255616', title: null }]);
  }
});

await check('an automatic discount has its name and no code; a line with nothing off has none', async () => {
  lines = [line(1, [{ discountedAmount: money('2.0'), title: 'Fall sale' }]), line(2, [])];
  const read = await shopify.cart.get('gid://shopify/Cart/1');
  assert.deepEqual(read.lines[0].discounts, [{ amount: money('2.0'), code: null, title: 'Fall sale' }]);
  assert.deepEqual(read.lines[1].discounts, []);
});

await check('an answer without the field, or with an allocation missing its amount, reads as none', async () => {
  lines = [line(1, undefined), line(2, [{ code: 'BROKEN' }])];
  const read = await shopify.cart.get('gid://shopify/Cart/1');
  assert.deepEqual(read.lines[0].discounts, []);
  assert.deepEqual(read.lines[1].discounts, []);
});

console.log(`\n${pass} checks passed`);
