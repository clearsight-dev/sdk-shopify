// A product's variants carry their pre-order plan (`variant.sellingPlan`): which reads ask for it, how
// it is shaped, that a page opened from a grid card has it in its first frame, and that a pre-order
// add of a sold-out size goes out on the plan with no stock ceiling. A cart line bought on a plan
// carries it with what checkout takes now and later (`line.sellingPlan`). Storefront stubbed at fetch,
// in jsdom.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const PLAN = { id: 'gid://shopify/SellingPlan/9970811195', name: 'Pre-authorize' };
const money = (amount) => ({ amount, currencyCode: 'USD' });
const variant = (id, color, size, { qty, available = true, plan = PLAN }) => ({
  id: `gid://shopify/ProductVariant/${id}`, title: `${color} / ${size}`, sku: null, availableForSale: available,
  quantityAvailable: qty, price: money('58.00'), compareAtPrice: null,
  selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: size }], image: null,
  // Shopify's shape: a connection of allocations, none when the store enrolled the variant in no plan.
  sellingPlanAllocations: { nodes: plan ? [{ sellingPlan: plan }] : [] },
});
// The blouse's sold-out sizes are enrolled; the cap's sold-out colour is neither for sale nor enrolled.
const BLOUSE_VARIANTS = [
  variant(1, 'Navy', 'S', { qty: 0 }),
  variant(2, 'Navy', 'M', { qty: 20 }),
];
const product = (n, handle, variants) => ({
  id: `gid://shopify/Product/${n}`, handle, title: handle, description: '', descriptionHtml: '',
  vendor: 'V', productType: 'Top', tags: [], totalInventory: 20, availableForSale: true,
  priceRange: { minVariantPrice: money('58.00'), maxVariantPrice: money('58.00') },
  compareAtPriceRange: { minVariantPrice: money('0.0'), maxVariantPrice: money('0.0') },
  options: [{ id: 'o1', name: 'Color', values: [...new Set(variants.map((v) => v.selectedOptions[0].value))] },
    { id: 'o2', name: 'Size', values: [...new Set(variants.map((v) => v.selectedOptions[1].value))] }],
  variants: { nodes: variants },
  images: { nodes: [] }, featuredImage: null, onlineStoreUrl: null, updatedAt: '', createdAt: '',
  media: { nodes: [] },
});
const blouse = () => product(1, 'blouse', BLOUSE_VARIANTS);
const cap = () => product(2, 'cap', [variant(3, 'Gray', 'One Size', { qty: 0, available: false, plan: null }), variant(4, 'Brown', 'One Size', { qty: 48, plan: null })]);

let cartLines = [];
// Shopify's answer for a line on the pre-authorize plan: the amounts are PER UNIT whatever the quantity
// (a line of 2 at $250 on Amore's store said $0 now and $250 later, 2026-10-05). `amounts: false` is an
// allocation without them.
const allocationFor = (l) => ({
  sellingPlan: { id: l.sellingPlanId, name: PLAN.name },
  ...(l.amounts === false ? {} : { checkoutChargeAmount: money('0.0'), remainingBalanceChargeAmount: money(l.unitPrice ?? '58.0') }),
});
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout',
  totalQuantity: cartLines.reduce((n, l) => n + l.quantity, 0),
  lines: { nodes: cartLines.map((l, i) => ({
    id: `gid://line/${i}`, quantity: l.quantity, attributes: [],
    sellingPlanAllocation: l.sellingPlanId ? allocationFor(l) : null,
    merchandise: { id: l.merchandiseId }, cost: { totalAmount: money('1'), amountPerQuantity: money('1') },
  })) },
  cost: { subtotalAmount: money('1'), totalAmount: money('1') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
});
const queries = {};
const sentLines = [];
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(query) || [])[1] || 'anon';
  queries[name] = query;
  await new Promise((r) => setTimeout(r, 5));
  const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) });
  if (name === 'ShopInfo') return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } });
  if (name === 'CartCreate') { cartLines = []; return reply({ cartCreate: { cart: cartPayload(), userErrors: [] } }); }
  if (name === 'CartGet') return reply({ cart: cartPayload() });
  if (name === 'CartLinesAdd') {
    sentLines.push(...variables.lines);
    for (const l of variables.lines) cartLines.push({ ...l });
    return reply({ cartLinesAdd: { cart: cartPayload(), userErrors: [] } });
  }
  if (name === 'CollectionProducts') {
    return reply({ collection: { handle: variables.handle, title: 'Tops', products: { nodes: [blouse(), cap()], filters: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } } } });
  }
  if (name === 'ProductByHandle') return reply({ product: variables.handle === 'cap' ? cap() : blouse() });
  if (name === 'Recommended') return reply({ productRecommendations: [cap()] });
  return reply({});
};

const sdk = await import('../dist/index.js');
const { shopify, ShopifyProvider, useProductPage, peekProduct } = sdk;

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' };

console.log('selling plans on product reads');
await shopify.init(CONFIG);

await check('every product read asks for one allocation per variant; the cart does not', async () => {
  await shopify.collections.products('tops', { first: 12 });
  await shopify.products.byHandle('blouse');
  await shopify.products.recommended('gid://shopify/Product/1');
  for (const name of ['CollectionProducts', 'ProductByHandle', 'Recommended']) {
    assert.match(queries[name], /sellingPlanAllocations\(first: 1\) \{ nodes \{ sellingPlan \{ id name \} \} \}/, name);
  }
  await shopify.cart.create();
  assert.doesNotMatch(queries.CartCreate, /sellingPlanAllocations/, 'a cart line has its own allocation');
});

await check('shaped as { id, name }, null without a plan, and Shopify\'s connection is not passed on', async () => {
  const read = await shopify.products.byHandle('blouse');
  assert.deepEqual(read.variants[0].sellingPlan, PLAN);
  assert.equal('sellingPlanAllocations' in read.variants[0], false);
  const plain = await shopify.products.byHandle('cap');
  assert.equal(plain.variants[0].sellingPlan, null);
  assert.equal(plain.variants[0].availableForSale, false);
});

await check('the store keeps it: a page opened from a grid card has the plan before its own read', async () => {
  const base = peekProduct('blouse')?.base;
  assert.deepEqual(base.variants.find((v) => v.title === 'Navy / S').sellingPlan, PLAN);
  assert.equal(peekProduct('cap')?.base.variants[0].sellingPlan, null);
});

// ── A pre-order add from the product page ──────────────────────────────────
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;

async function mount(useHook, providerProps = {}) {
  const renders = [];
  let latest = null;
  function Probe() {
    latest = useHook();
    renders.push(latest);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await runAct(async () => {
    root.render(React.createElement(ShopifyProvider, { config: CONFIG, ...providerProps }, React.createElement(Probe)));
  });
  await runAct(async () => { await wait(80); });
  return { renders, now: () => latest, act: runAct, unmount: () => runAct(async () => root.unmount()) };
}

await check('first render: the sold-out size knows its plan; a pre-order add goes out on it with no ceiling', async () => {
  const guarded = [];
  // What Cart Hold sees: it lets a line with a selling plan through without claiming stock.
  const cartGuard = { beforeAdd: (input) => { guarded.push(input); return input; } };
  const added = [];
  const page = await mount(() => useProductPage('blouse', { onAdded: (r) => added.push(r.ok) }), { cartGuard });
  const first = page.renders[0];
  assert.equal(first.selection.variant.title, 'Navy / S', 'the first for-sale size, as the page opens');
  assert.deepEqual(first.selection.variant.sellingPlan, PLAN, 'known in the first frame');
  assert.equal(page.now().status, 'unavailable', 'sold out: what the app shows as pre-order when there is a plan');
  assert.equal(page.now().cart.canAddMore, true, 'no stock ceiling while it is still for sale');
  sentLines.length = 0;
  let result;
  await page.act(async () => { result = await page.now().cart.add({ sellingPlanId: PLAN.id }); });
  assert.equal(result.ok, true);
  assert.deepEqual(added, [true], 'onAdded, as for any add (the app\'s "Success!")');
  assert.equal(sentLines.length, 1);
  assert.equal(sentLines[0].sellingPlanId, PLAN.id);
  assert.equal('maxQuantity' in sentLines[0], false);
  assert.equal(guarded[0].sellingPlanId, PLAN.id, 'the guard is told it is a pre-order');
  assert.equal(page.now().cart.inCart, 1);
  assert.equal(result.cart.lines[0].sellingPlanId, PLAN.id, 'the line carries its plan');
  await page.act(async () => { result = await page.now().cart.add({ sellingPlanId: PLAN.id }); });
  assert.equal(result.ok, true, 'a second unit too: nothing caps a pre-order');
  await page.unmount();
});

// ── A cart line bought on a plan ───────────────────────────────────────────
console.log('selling plans on cart lines');

await check('the cart asks for the line\'s plan with its two amounts', async () => {
  await shopify.cart.create();
  assert.match(
    queries.CartCreate,
    /sellingPlanAllocation \{\s*sellingPlan \{ id name \}\s*checkoutChargeAmount \{ \.\.\.MoneyFields \}\s*remainingBalanceChargeAmount \{ \.\.\.MoneyFields \}\s*\}/,
  );
});

await check('line.sellingPlan: the plan, nothing now and the price times the quantity later; null when bought outright', async () => {
  const created = await shopify.cart.create();
  const cart = await shopify.cart.addLines(created.id, [
    { merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 2, sellingPlanId: PLAN.id },
    { merchandiseId: 'gid://shopify/ProductVariant/2', quantity: 1 },
  ]);
  assert.deepEqual(cart.lines[0].sellingPlan, {
    id: PLAN.id,
    name: 'Pre-authorize',
    checkoutCharge: money('0.0'),
    remainingBalance: money('116.0'),
  });
  assert.equal(cart.lines[0].sellingPlanId, PLAN.id, 'sellingPlanId stays');
  assert.equal(cart.lines[1].sellingPlan, null);
  assert.equal(cart.lines[1].sellingPlanId, null);
});

await check('amounts multiply exactly, keep Shopify\'s decimals, and are null (unknown, not zero) when Shopify leaves them out', async () => {
  const created = await shopify.cart.create();
  let cart = await shopify.cart.addLines(created.id, [
    { merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 3, sellingPlanId: PLAN.id, unitPrice: '0.10' },
  ]);
  assert.deepEqual(cart.lines[0].sellingPlan.remainingBalance, money('0.30'), '0.1 × 3 is 0.30, not 0.30000000000000004');
  cart = await shopify.cart.addLines(created.id, [
    { merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1, sellingPlanId: PLAN.id, amounts: false },
  ]);
  assert.equal(cart.lines[1].sellingPlan.checkoutCharge, null);
  assert.equal(cart.lines[1].sellingPlan.remainingBalance, null);
  assert.equal(cart.lines[1].sellingPlan.id, PLAN.id);
});

console.log(`\n${pass} checks passed`);
