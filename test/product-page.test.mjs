// Product page helpers and hooks: selection, per-value states, price, stock (including the
// pre-write ceiling and its alert), media, description, share link, and useProductPage from a grid's
// preview to the full product. Storefront stubbed at fetch, in jsdom.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const variant = (id, size, color, { qty = 5, available = true, price = '55.00', compareAt = null } = {}) => ({
  id: `gid://shopify/ProductVariant/${id}`, title: `${size} / ${color}`, sku: null, availableForSale: available,
  quantityAvailable: qty, price: money(price), compareAtPrice: compareAt ? money(compareAt) : null,
  selectedOptions: [{ name: 'Size', value: size }, { name: 'Color', value: color }], image: null,
});
const VARIANTS = [
  variant(1, 'S', 'Wine', { qty: 2, price: '50.00', compareAt: '60.00' }),
  variant(2, 'M', 'Wine', { qty: 0, available: false }),
  variant(3, 'S', 'Ivory', { qty: 5 }),
  variant(4, 'M', 'Ivory', { qty: null }),
];
const skirt = (full) => ({
  id: 'gid://shopify/Product/1', handle: 'skirt', title: 'Midi Skirt',
  description: 'Details: Lined', descriptionHtml: '<p><strong>Details:</strong> lined</p><ul><li>Elastic &amp; soft</li></ul>',
  vendor: 'V', productType: 'Skirt', tags: [], totalInventory: 7, availableForSale: true,
  priceRange: { minVariantPrice: money('50.00'), maxVariantPrice: money('55.00') },
  compareAtPriceRange: { minVariantPrice: money('60.00'), maxVariantPrice: money('60.00') },
  // Shopify's order is Size first; the page shows Color first.
  options: [{ id: 'o1', name: 'Size', values: ['S', 'M'] }, { id: 'o2', name: 'Color', values: ['Wine', 'Ivory'] }],
  variants: { nodes: VARIANTS },
  images: { nodes: [{ url: 'https://cdn.test/a_1080x.jpg?v=1', altText: null }] },
  featuredImage: { url: 'https://cdn.test/a_1080x.jpg?v=1', altText: null, width: 1080, height: 1350 },
  onlineStoreUrl: null, updatedAt: '', createdAt: '',
  media: { nodes: full
    ? [
      { mediaContentType: 'VIDEO', alt: 'clip', id: 'm-v', previewImage: { url: 'https://cdn.test/v.jpg' }, sources: [{ url: 'https://cdn.test/v.mp4', mimeType: 'video/mp4', width: 720, height: 720 }] },
      { mediaContentType: 'IMAGE', alt: 'front', id: 'm-1', previewImage: { url: 'https://cdn.test/a_1080x.jpg?v=1' }, image: { url: 'https://cdn.test/a_1080x.jpg?v=1', altText: 'front', width: 1600, height: 2000 } },
    ]
    : [{ mediaContentType: 'VIDEO' }, { mediaContentType: 'IMAGE' }] },
});

let cartLines = [];
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout',
  totalQuantity: cartLines.reduce((n, l) => n + l.quantity, 0),
  lines: { nodes: cartLines.map((l, i) => ({
    id: `gid://line/${i}`, quantity: l.quantity, attributes: l.attributes ?? [],
    merchandise: { id: l.merchandiseId }, cost: { totalAmount: money('1'), amountPerQuantity: money('1') },
  })) },
  cost: { subtotalAmount: money('1'), totalAmount: money('1') }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
});
const calls = {};
const sentLines = [];
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(query) || [])[1] || 'anon';
  calls[name] = (calls[name] ?? 0) + 1;
  await new Promise((r) => setTimeout(r, 5));
  const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) });
  if (name === 'ShopInfo') return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } });
  if (name === 'CartCreate') { cartLines = []; return reply({ cartCreate: { cart: cartPayload(), userErrors: [] } }); }
  if (name === 'CartGet') return reply({ cart: cartPayload() });
  if (name === 'CartLinesAdd') {
    sentLines.push(...variables.lines);
    for (const l of variables.lines) {
      const existing = cartLines.find((x) => x.merchandiseId === l.merchandiseId);
      if (existing) existing.quantity += l.quantity;
      else cartLines.push({ ...l });
    }
    return reply({ cartLinesAdd: { cart: cartPayload(), userErrors: [] } });
  }
  if (name === 'CollectionProducts') {
    return reply({ collection: { handle: variables.handle, title: 'Skirts', products: { nodes: [skirt(false)], filters: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } } } });
  }
  if (name === 'ProductByHandle') return reply({ product: skirt(true) });
  if (name === 'Recommended') {
    // Shopify can list the product itself; one recommendation is in an auction.
    return reply({ productRecommendations: [skirt(false), rec(2, 'top'), rec(3, 'auction', ['SEARCH-BLOCKED']), rec(4, 'belt'), rec(5, 'scarf')] });
  }
  return reply({});
};
const rec = (n, handle, tags = []) => ({ ...skirt(false), id: `gid://shopify/Product/${n}`, handle, title: handle, tags });

const sdk = await import('../dist/index.js');
const {
  shopify, ShopifyProvider, useProductPage, useVariantSelection,
  selectableOptions, findVariant, initialSelection, optionStates, selectionLabel, variantPrice, isLowStock,
  stockCeiling, quantityInCart, withinCeiling, initialMediaIndex, firstImageUrl, sizedImageUrl,
  parseDescriptionHtml, productShareUrl, isPlaceholderOption, DEFAULT_MESSAGES, ALERT_SETTING_FIELDS,
  peekProduct,
} = sdk;

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const V = VARIANTS;

console.log('pure helpers');
const OPTIONS = [{ id: 'o1', name: 'Size', values: ['S', 'M'] }, { id: 'o2', name: 'Color', values: ['Wine', 'Ivory'] }];
await check('options: placeholder dropped, Color before Size, custom order and filter', () => {
  const placeholder = { id: 'p', name: 'Title', values: ['Default Title'] };
  assert.equal(isPlaceholderOption(placeholder), true);
  assert.deepEqual(selectableOptions([placeholder, ...OPTIONS]).map((o) => o.name), ['Color', 'Size']);
  assert.deepEqual(selectableOptions(OPTIONS, { order: ['size'] }).map((o) => o.name), ['Size', 'Color']);
  assert.deepEqual(selectableOptions(OPTIONS, { include: (o) => o.name !== 'Size' }).map((o) => o.name), ['Color']);
});
await check('selection: first purchasable variant; findVariant; label in display order', () => {
  const start = initialSelection(V);
  assert.deepEqual(start, { Size: 'S', Color: 'Wine' });
  assert.equal(findVariant(V, { Size: 'M', Color: 'Ivory' }).id, V[3].id);
  assert.equal(findVariant(V, { Size: 'XL', Color: 'Ivory' }), null);
  assert.equal(selectionLabel(selectableOptions(OPTIONS), start), 'Wine / S');
  assert.deepEqual(initialSelection([{ ...V[1] }]), { Size: 'M', Color: 'Wine' }, 'all sold out: the first');
});
await check('option states: each value with what it would select, following the other option', () => {
  const states = optionStates(selectableOptions(OPTIONS), V, { Size: 'S', Color: 'Wine' });
  const size = states.find((s) => s.name === 'Size');
  assert.deepEqual(size.values.map((v) => [v.value, v.selected, v.available, v.quantityAvailable]), [['S', true, true, 2], ['M', false, false, 0]]);
  const color = states.find((s) => s.name === 'Color');
  assert.deepEqual(color.values.map((v) => [v.value, v.available]), [['Wine', true], ['Ivory', true]]);
  const custom = optionStates(selectableOptions(OPTIONS), V, { Size: 'S', Color: 'Wine' }, () => false);
  assert.equal(custom.every((s) => s.values.every((v) => v.available)), true, 'a custom availability rule wins');
});
await check('price: the variant\'s, compare-at only when higher; without a variant the product\'s lowest', () => {
  assert.deepEqual(variantPrice(V[0]), { price: money('50.00'), compareAtPrice: money('60.00'), onSale: true });
  assert.deepEqual(variantPrice(V[2]), { price: money('55.00'), compareAtPrice: null, onSale: false });
  assert.deepEqual(variantPrice({ ...V[2], compareAtPrice: money('0.0') }).onSale, false);
  const fromProduct = variantPrice(null, { priceRange: { min: money('50.00') }, compareAtPriceRange: { min: money('60.00') } });
  assert.equal(fromProduct.price.amount, '50.00');
  assert.equal(fromProduct.onSale, true);
});
await check('stock: ceilings, cart count across lines, low stock threshold', () => {
  assert.equal(stockCeiling(V[0]), 2);
  assert.equal(stockCeiling(V[1]), 0);
  assert.equal(stockCeiling(V[3]), null, 'untracked: no ceiling');
  assert.equal(stockCeiling({ availableForSale: true, quantityAvailable: -3 }), null, 'oversell / pre-order');
  const cart = { lines: [{ merchandise: { id: V[0].id }, quantity: 1 }, { merchandise: { id: V[0].id }, quantity: 1 }] };
  assert.equal(quantityInCart(cart, V[0].id), 2);
  assert.equal(withinCeiling(2, 2, 1), false);
  assert.equal(withinCeiling(null, 99, 1), true);
  assert.equal(isLowStock(7, true), true);
  assert.equal(isLowStock(7, true, 5), false);
  assert.equal(isLowStock(7, true, null), false, 'null turns it off');
});
await check('media: open on the first image, or the video when asked; first still', () => {
  const media = [{ id: 'v', kind: 'video', posterUrl: 'v.jpg' }, { id: 'i', kind: 'image', posterUrl: 'i.jpg' }];
  assert.equal(initialMediaIndex(media), 1);
  assert.equal(initialMediaIndex(media, true), 0);
  assert.equal(firstImageUrl({ media, featuredImage: null }), 'i.jpg');
  assert.equal(firstImageUrl({ media: [], featuredImage: { url: 'f.jpg' } }), 'f.jpg');
});
await check('image sizing: rewrites Shopify size suffixes, else adds width=', () => {
  assert.equal(sizedImageUrl('https://cdn/x/p_1080x.png?v=1', 660), 'https://cdn/x/p_660x.png?v=1');
  assert.equal(sizedImageUrl('https://cdn/x/p_200x@2x.jpg?v=1', 96), 'https://cdn/x/p_96x.jpg?v=1');
  assert.equal(sizedImageUrl('https://cdn/x/p.jpg?v=1', 288), 'https://cdn/x/p.jpg?v=1&width=288');
  assert.equal(sizedImageUrl(null, 288), null);
});
await check('description: paragraphs, bold labels, bullets, entities, **merchant emphasis**', () => {
  const blocks = parseDescriptionHtml('<p><strong>Details:</strong> lined</p><ul><li>Elastic &amp; soft</li></ul><p>***FIT*** true</p>');
  assert.deepEqual(blocks, [
    { spans: [{ text: 'Details:', bold: true }, { text: ' lined', bold: false }], bullet: false },
    { spans: [{ text: 'Elastic & soft', bold: false }], bullet: true },
    { spans: [{ text: 'FIT', bold: true }, { text: ' true', bold: false }], bullet: false },
  ]);
  assert.deepEqual(parseDescriptionHtml(''), []);
});
await check('share link: onlineStoreUrl, else the store domain', () => {
  assert.equal(productShareUrl({ handle: 'h', onlineStoreUrl: 'https://shop.com/products/h' }), 'https://shop.com/products/h');
  assert.equal(productShareUrl({ handle: 'h', onlineStoreUrl: null }, 'acme.myshopify.com'), 'https://acme.myshopify.com/products/h');
});
await check('the stock alert is a Settings panel field like the others', () => {
  assert.equal(DEFAULT_MESSAGES['cart.noMoreStock'], 'No more stock available');
  assert.deepEqual(ALERT_SETTING_FIELDS['cart.noMoreStock'], ['cart', 'noMoreStock']);
});

// ── Hooks ───────────────────────────────────────────────────────────────────
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' };
const events = [];

async function mount(useHook) {
  const renders = [];
  let latest = null;
  function Probe() {
    latest = useHook();
    renders.push(latest);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await runAct(async () => {
    root.render(React.createElement(ShopifyProvider, { config: CONFIG, onEvent: (e) => events.push(e) }, React.createElement(Probe)));
  });
  const settle = async (ms = 80) => { await runAct(async () => { await wait(ms); }); };
  await settle();
  return { renders, now: () => latest, settle, act: runAct, unmount: () => runAct(async () => root.unmount()) };
}

console.log('useProductPage');
await shopify.init(CONFIG);
await shopify.collections.products('skirts', { first: 12 }); // the grid the shopper tapped in

await check('first render, from the grid: picker, price and Add to Cart already work', async () => {
  const viewed = [];
  const page = await mount(() => useProductPage('skirt', { onView: (p) => viewed.push(p.id) }));
  const first = page.renders[0];
  assert.equal(first.level, 'base');
  assert.equal(first.status, 'available');
  assert.equal(first.selection.known, true);
  assert.deepEqual(first.selection.options.map((o) => o.name), ['Color', 'Size']);
  assert.equal(first.selection.variant.id, V[0].id);
  assert.equal(first.selection.label, 'Wine / S');
  assert.equal(first.selection.price.price.amount, '50.00');
  assert.equal(first.selection.price.onSale, true);
  assert.equal(first.selection.lowStock, true);
  assert.equal(first.description.blocks.length, 2);
  assert.equal(first.media.items.length, 0, 'the gallery waits for the full product');
  assert.equal(first.media.previewImageUrl, 'https://cdn.test/a_1080x.jpg?v=1');
  assert.equal(first.cart.canAddMore, true);
  const done = page.now();
  assert.equal(done.level, 'full');
  assert.equal(done.media.items.length, 2);
  assert.equal(done.media.initialIndex, 1, 'opens on the image, not the video');
  assert.deepEqual([done.media.items[1].width, done.media.items[1].height], [1600, 2000], 'the still carries its original size');
  assert.deepEqual([done.media.items[0].width, done.media.items[0].height], [null, null], 'no size when Shopify gives none');
  assert.deepEqual(viewed, ['gid://shopify/Product/1'], 'onView once, when the full product lands');
  assert.equal(done.shareUrl, 'https://shop.myshopify.com/products/skirt');
  await page.unmount();
});

await check('choosing values: the variant, price and status follow; a sold-out combination is unavailable', async () => {
  const page = await mount(() => useProductPage('skirt'));
  await page.act(async () => page.now().selection.setOption('Color', 'Ivory'));
  assert.equal(page.now().selection.variant.id, V[2].id);
  assert.equal(page.now().selection.price.price.amount, '55.00');
  await page.act(async () => page.now().selection.setOption('Color', 'Wine'));
  await page.act(async () => page.now().selection.setOption('Size', 'M'));
  assert.equal(page.now().status, 'unavailable', 'Wine / M is sold out: the waitlist case');
  await page.act(async () => page.now().selection.selectVariant(V[3].id));
  assert.equal(page.now().selection.label, 'Ivory / M');
  assert.equal(page.now().status, 'available');
  await page.unmount();
});

await check('customised: blocked rule, deferred description, starting variant, own order and threshold', async () => {
  const page = await mount(() => useProductPage('skirt', {
    isBlocked: (p) => p.productType === 'Skirt',
    parseDescription: false,
    initialVariantId: V[2].id,
    optionOrder: ['size'],
    lowStockThreshold: null,
  }));
  const p = page.now();
  assert.equal(p.status, 'blocked');
  assert.deepEqual(p.description.blocks, []);
  assert.equal(p.selection.variant.id, V[2].id);
  assert.deepEqual(p.selection.options.map((o) => o.name), ['Size', 'Color']);
  assert.equal(p.selection.lowStock, false);
  await page.unmount();
});

await check('add to cart: lands, and the SDK-only ceiling field never reaches Shopify', async () => {
  const added = [];
  const page = await mount(() => useProductPage('skirt', { onAdded: (r) => added.push(r.ok) }));
  let result;
  await page.act(async () => { result = await page.now().cart.add(); });
  assert.equal(result.ok, true);
  assert.deepEqual(added, [true]);
  assert.equal(page.now().cart.inCart, 1);
  assert.ok(sentLines.length > 0 && sentLines.every((l) => !('maxQuantity' in l)), 'maxQuantity stripped before the write');
  await page.unmount();
});

await check('past the stock: refused before the write, with the Settings-panel alert', async () => {
  const refused = [];
  const page = await mount(() => useProductPage('skirt', { onRefused: (r) => refused.push(r.reason) }));
  // Wine / S has 2 left and the cart already holds 1.
  await page.act(async () => { await page.now().cart.add(); });
  assert.equal(page.now().cart.canAddMore, false);
  const before = calls.CartLinesAdd;
  events.length = 0;
  let result;
  await page.act(async () => { result = await page.now().cart.add(); });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stock');
  assert.equal(result.message, 'No more stock available');
  assert.deepEqual(refused, ['stock']);
  assert.equal(calls.CartLinesAdd, before, 'no request made');
  const alert = events.find((e) => e.type === 'cart:stockLimit');
  assert.equal(alert?.messageKey, 'cart.noMoreStock');
  assert.equal(alert?.severity, 'error');
  await page.unmount();
});

console.log('useVariantSelection');
await check('works on any product object, e.g. a buy sheet with its own data', async () => {
  const product = { ...(await shopify.products.byHandle('skirt')) };
  const sheet = await mount(() => useVariantSelection(product, { separator: ', ' }));
  assert.equal(sheet.now().selection.Color, 'Wine');
  assert.equal(sheet.now().label, 'Wine, S');
  await sheet.unmount();
});

await check('you may also like: nothing read unless asked; then without itself or blocked, capped, stored', async () => {
  const before = calls.Recommended ?? 0;
  const plain = await mount(() => useProductPage('skirt'));
  assert.deepEqual(plain.now().recommendations, { products: [], loading: false, error: false });
  assert.equal(calls.Recommended ?? 0, before, 'not asked for: not read');
  await plain.unmount();

  const isBlocked = (p) => p.tags.includes('SEARCH-BLOCKED');
  const page = await mount(() => useProductPage('skirt', { isBlocked, recommendations: { limit: 2 } }));
  await page.settle();
  const { products, loading, error } = page.now().recommendations;
  assert.deepEqual(products.map((p) => p.handle), ['top', 'belt'], 'not the product itself, not the auctioned one, at most 2');
  assert.equal(loading, false);
  assert.equal(error, false);
  assert.equal(calls.Recommended, before + 1);
  assert.equal(peekProduct('belt')?.base?.variants?.length, VARIANTS.length, 'a tapped recommendation opens with its variants');
  await page.unmount();

  const again = await mount(() => useProductPage('skirt', { isBlocked, recommendations: { limit: 2 } }));
  assert.deepEqual(again.renders[0].recommendations.products.map((p) => p.handle), ['top', 'belt'], 'reopened: there on the first render');
  assert.equal(calls.Recommended, before + 1, 'kept for the session');
  await again.unmount();
});

await check('you may also like: waits while disabled (a page that is still settling)', async () => {
  let enabled = false;
  const page = await mount(() => useProductPage('skirt', { recommendations: { enabled, imageTransform: { maxWidth: 660 } } }));
  assert.equal(page.now().recommendations.products.length, 0);
  const before = calls.Recommended;
  enabled = true;
  await page.act(async () => page.now().selection.setOption('Color', 'Ivory')); // any re-render
  await page.settle();
  assert.equal(calls.Recommended, before + 1, 'read once enabled');
  assert.ok(page.now().recommendations.products.length > 0);
  await page.unmount();
});

console.log(`\n${pass} checks passed`);
