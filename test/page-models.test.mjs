// 0.15.0's page models, moved from amore-v2's page hooks: their rules on their own, then the hooks
// rendered in jsdom with the real ShopifyProvider and the Storefront API stubbed at `fetch` with an
// in-memory cart. Orders and Buy again are in orders.test.mjs; the alert words in alerts.test.mjs.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, memoryStorage } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const usd = (amount) => ({ amount, currencyCode: 'USD' });

// ── The store ──────────────────────────────────────────────────────────────────

const carts = new Map();
let nextCartId = 1;
const calls = [];
/** Names of mutations to refuse once, as Shopify being unreachable. */
const failNext = new Set();
const lineKey = (l) => `${l.merchandiseId}|${l.sellingPlanId ?? ''}|${JSON.stringify(l.attributes ?? [])}`;
const payload = (id) => {
  const c = carts.get(id);
  const subtotal = c.lines.reduce((sum, l) => sum + 20 * l.quantity, 0).toFixed(2);
  return {
    id, checkoutUrl: `https://shop/checkout/${id.split('/').pop()}`, note: '', attributes: c.attributes,
    totalQuantity: c.lines.reduce((n, l) => n + l.quantity, 0),
    buyerIdentity: { countryCode: 'US', email: null, phone: null },
    lines: { nodes: c.lines.map((l) => ({ id: l.id, quantity: l.quantity, attributes: l.attributes ?? [],
      sellingPlanAllocation: l.sellingPlanId ? { sellingPlan: { id: l.sellingPlanId, name: 'Pre-order' } } : null,
      merchandise: { id: l.merchandiseId, title: 'M', price: usd('20.00'), availableForSale: true, quantityAvailable: 5 },
      cost: { totalAmount: usd((20 * l.quantity).toFixed(2)), amountPerQuantity: usd('20.00') } })) },
    cost: { subtotalAmount: usd(subtotal), totalAmount: usd(subtotal) },
    discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
  };
};

global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const op = /mutation (\w+)|query (\w+)/.exec(query);
  const name = op?.[1] || op?.[2] || 'unknown';
  calls.push({ name, variables });
  const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }), json: async () => ({ data }) });
  await new Promise((r) => setTimeout(r, 2));
  if (failNext.delete(name)) throw new TypeError('Network request failed');
  if (query.includes('shop {')) {
    return reply({ shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } });
  }
  if (name === 'CartCreate') {
    const id = `gid://shopify/Cart/${nextCartId++}`;
    carts.set(id, { attributes: variables.input?.attributes ?? [], lines: [] });
    return reply({ cartCreate: { cart: payload(id), userErrors: [] } });
  }
  if (name === 'CartGet' || query.includes('cart(id:')) return reply({ cart: carts.has(variables.id) ? payload(variables.id) : null });
  if (name === 'CartLinesAdd') {
    const c = carts.get(variables.cartId);
    for (const l of variables.lines) {
      const existing = c.lines.find((x) => lineKey(x) === lineKey(l));
      if (existing) existing.quantity += l.quantity;
      else c.lines.push({ ...l, id: `${variables.cartId}/line/${c.lines.length + 1}` });
    }
    return reply({ cartLinesAdd: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartLinesUpdate') {
    const c = carts.get(variables.cartId);
    for (const l of variables.lines) c.lines.find((x) => x.id === l.id).quantity = l.quantity;
    return reply({ cartLinesUpdate: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartLinesRemove') {
    const c = carts.get(variables.cartId);
    c.lines = c.lines.filter((x) => !variables.lineIds.includes(x.id));
    return reply({ cartLinesRemove: { cart: payload(variables.cartId), userErrors: [] } });
  }
  if (name === 'CartAttributesUpdate') {
    carts.get(variables.cartId).attributes = variables.attributes;
    return reply({ cartAttributesUpdate: { cart: payload(variables.cartId), userErrors: [] } });
  }
  return reply({});
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const SDK = await import('../dist/index.js');
const {
  ShopifyProvider, useCart, useCheckout, useCheckoutPage, useProductPurchase, useAddToCart, useQuickAdd, useSignIn,
  useGridColumns, forgetGridColumns, useVariantHeldOut,
} = SDK;

const t = harness('page models (0.15.0)');

// ── Rules ──────────────────────────────────────────────────────────────────────

t.section('store credit on the cart');
await t.check('the amount sheet opens with what the cart still owes, no more than the balance', () => {
  const cart = { cost: { subtotalAmount: usd('58.00') }, appliedGiftCards: [{ presentmentAmountUsed: usd('8.00') }] };
  assert.deepEqual(SDK.suggestedStoreCreditAmount(cart, usd('100.00')), usd('50.00'));
  assert.deepEqual(SDK.suggestedStoreCreditAmount(cart, usd('12.34')), usd('12.34'));
  assert.equal(SDK.suggestedStoreCreditAmount(cart, usd('0.00')), null, 'no balance');
  assert.equal(SDK.suggestedStoreCreditAmount({ cost: { subtotalAmount: usd('8.00') }, appliedGiftCards: [{ presentmentAmountUsed: usd('8.00') }] }, usd('5.00')), null, 'nothing owed');
  assert.equal(SDK.suggestedStoreCreditAmount(null, usd('5.00')), null, 'no cart');
});
await t.check('a cart holding a pre-order line (a selling plan) is blocked; any other isn\'t', () => {
  assert.equal(SDK.cartHoldsPreOrder({ lines: [{ sellingPlanId: null }, { sellingPlanId: 'gid://plan/1' }] }), true);
  assert.equal(SDK.cartHoldsPreOrder({ lines: [{ sellingPlanId: null }] }), false);
  assert.equal(SDK.cartHoldsPreOrder(null), false);
});
await t.check('the currency sign beside a typed amount is the shop\'s', () => {
  assert.equal(SDK.currencySymbolOf('USD'), '$');
  assert.equal(SDK.currencySymbolOf(''), '');
  assert.equal(SDK.currencySymbolOf(null), '');
});

t.section('held out (a cart extension\'s isHeldOut)');
await t.check('any extension that says so; one that throws never does', () => {
  const extensions = [{ name: 'broken', isHeldOut: () => { throw new Error('boom'); } }, { name: 'hold', isHeldOut: (id) => id === 'v1' }];
  assert.equal(SDK.isVariantHeldOut('v1', extensions), true);
  assert.equal(SDK.isVariantHeldOut('v2', extensions), false);
  assert.equal(SDK.isVariantHeldOut(null, extensions), false);
  assert.equal(SDK.isVariantHeldOut('v1', []), false);
});

t.section('the waitlist page');
const size = (id, price, action) => ({ id, action, variant: { id, price: usd(price) } });
await t.check('ready for you first (pre-order, add to cart, in your cart), each group in the order given', () => {
  const items = [size('a', '10', 'waiting'), size('b', '10', 'addToCart'), size('c', '10', 'blocked'), size('d', '10', 'inCart'), size('e', '10', 'preorder')];
  assert.deepEqual(SDK.readyFirst(items).map((item) => item.id), ['b', 'd', 'e', 'a', 'c']);
  assert.equal(SDK.isWaitlistReady('blocked'), false, 'being auctioned still waits');
});
await t.check('Status keeps the ticked group, none or both ticked keep all; Price keeps a size within the range', () => {
  const items = [size('a', '10', 'waiting'), size('b', '40', 'addToCart'), size('c', '70', 'preorder')];
  const ids = (filters) => SDK.filterWaitlist(items, filters).map((item) => item.id);
  assert.deepEqual(ids([SDK.WAITLIST_READY_FILTER]), ['b', 'c']);
  assert.deepEqual(ids([SDK.WAITLIST_WAITING_FILTER]), ['a']);
  assert.deepEqual(ids([SDK.WAITLIST_READY_FILTER, SDK.WAITLIST_WAITING_FILTER]), ['a', 'b', 'c']);
  assert.deepEqual(ids([SDK.priceFilterInput(20, 50)]), ['b']);
  assert.deepEqual(ids([SDK.priceFilterInput(50, null)]), ['c']);
  assert.deepEqual(ids(['{"something":"else"}']), ['a', 'b', 'c'], 'a filter it doesn\'t know is ignored');
  assert.deepEqual(SDK.filterWaitlist([size('gift', '', 'waiting')], [SDK.priceFilterInput(20, 60)]).map((item) => item.id), ['gift'], 'a size whose price isn\'t known stays');
});

t.section('listings');
await t.check('a collection\'s eight orders, 0.15.0\'s five first, featured needing no key; a search sorts by price or nothing', () => {
  assert.deepEqual(Object.keys(SDK.COLLECTION_SORTS), [
    'featured', 'created-descending', 'best-selling', 'price-ascending', 'price-descending',
    'title-ascending', 'title-descending', 'created-ascending',
  ]);
  assert.equal(SDK.COLLECTION_SORTS.featured, undefined);
  assert.deepEqual(SDK.COLLECTION_SORTS['created-descending'], { key: 'CREATED', reverse: true });
  assert.deepEqual(SDK.SEARCH_SORTS['price-descending'], { key: 'PRICE', reverse: true });
  assert.equal(SDK.SEARCH_SORTS.relevance, undefined);
});
await t.check('0.16.0\'s three: the name A to Z and Z to A, and oldest first (Shopify\'s TITLE and CREATED)', () => {
  assert.deepEqual(SDK.COLLECTION_SORTS['title-ascending'], { key: 'TITLE' });
  assert.deepEqual(SDK.COLLECTION_SORTS['title-descending'], { key: 'TITLE', reverse: true });
  assert.deepEqual(SDK.COLLECTION_SORTS['created-ascending'], { key: 'CREATED' });
});

// ── Rendered ───────────────────────────────────────────────────────────────────

const events = [];
const take = (prefix) => {
  const found = events.filter((event) => !prefix || event.type.startsWith(prefix));
  events.length = 0;
  return found;
};
let probe = {};
let root = null;
const settle = (ms = 40) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function mount(Probe, props = {}, provider = {}) {
  if (root) await runAct(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  calls.length = 0;
  events.length = 0;
  probe = {};
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, onEvent: (event) => events.push(event), ...provider },
      React.createElement(Probe, props),
    ));
  });
  await settle();
}

t.section('useCheckout(outcomes).start()');
const routes = [];
function CheckoutProbe() {
  probe.cart = useCart();
  probe.checkout = useCheckout({ onReady: () => routes.push('checkout'), onLapsedHold: () => routes.push('cart') });
  return null;
}
await mount(CheckoutProbe);
let answer;
await runAct(async () => { answer = await probe.checkout.start(); });
await t.check('no lines: empty, nowhere to go, and checkout:reservationExpired says so', () => {
  assert.equal(answer, 'empty');
  assert.deepEqual(routes, []);
  const [event] = take('checkout:');
  assert.equal(event.type, 'checkout:reservationExpired');
  assert.equal(event.message, 'Your reservation expired and the item was released.');
  assert.equal(event.severity, 'error');
});
await runAct(async () => { await probe.cart.addLine({ merchandiseId: 'v-dress', quantity: 1 }); });
await settle();
take();
await runAct(async () => { answer = await probe.checkout.start(); });
await t.check('a cart with lines: ready, and onReady opens the checkout page', () => {
  assert.equal(answer, 'ready');
  assert.deepEqual(routes, ['checkout']);
  assert.deepEqual(take('checkout:'), []);
});
await runAct(async () => { answer = await probe.checkout.start({ hasLapsedHold: () => true }); });
await t.check('a lapsed reservation: lapsedHold, and onLapsedHold shows the cart', () => {
  assert.equal(answer, 'lapsedHold');
  assert.deepEqual(routes, ['checkout', 'cart']);
});
await runAct(async () => { answer = await probe.checkout.follow('failed'); });
await t.check('follow(a preparation made elsewhere): failed raises checkout:couldNotStart', () => {
  assert.equal(answer, 'failed');
  assert.deepEqual(take('checkout:').map((event) => [event.type, event.message]), [['checkout:couldNotStart', "Couldn't open checkout. Try again."]]);
});

t.section('useCheckoutPage');
const placed = [];
function CheckoutPageProbe({ checkoutUrl, source }) {
  probe.cart = useCart();
  probe.page = useCheckoutPage({ checkoutUrl, source, onOrderPlaced: (order) => placed.push({ order, linesLeft: probe.cart.cart?.lines.length }) });
  return null;
}
await mount(CheckoutPageProbe);
await runAct(async () => { await probe.cart.addLine({ merchandiseId: 'v-dress', quantity: 1 }); });
await settle();
await t.check('the cart\'s own checkout link, once the cart has lines', () => {
  assert.match(probe.page.url, /^https:\/\/shop\/checkout\//);
  assert.equal(typeof probe.page.openedAt, 'number');
});
const placedCartId = probe.cart.cart.id;
take();
await runAct(async () => { probe.page.orderPlaced(); probe.page.orderPlaced(); });
await settle();
await t.check('the order lands once: checkout:completed with the cart as placed, then onOrderPlaced, then a fresh cart', () => {
  const completed = events.filter((event) => event.type === 'checkout:completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].cart.id, placedCartId);
  assert.deepEqual(completed[0].shows, { live: [], replay: [] });
  assert.equal(placed.length, 1);
  assert.equal(placed[0].order.checkoutOpenedAt, probe.page.openedAt);
  assert.equal(placed[0].linesLeft, 1, 'onOrderPlaced comes before the cart is reset');
  assert.ok(events.some((event) => event.type === 'checkout:orderPlaced'));
  assert.notEqual(probe.cart.cart?.id ?? null, placedCartId);
});
placed.length = 0;
await mount(CheckoutPageProbe);
await runAct(async () => { await probe.cart.addLine({ merchandiseId: 'v-dress', quantity: 1 }); });
await settle();
take();
await runAct(async () => { await probe.cart.removeLine(probe.cart.cart.lines[0].id); });
await settle();
await t.check('the cart empties under an open checkout: checkout:reservationExpired, and no link', () => {
  assert.ok(take('checkout:').some((event) => event.type === 'checkout:reservationExpired'));
  assert.equal(probe.page.url, null);
});
await mount(CheckoutPageProbe, { checkoutUrl: 'https://shop/wins/1', source: 'auctionWins' });
const cartBefore = probe.cart.cart?.id ?? null;
await runAct(async () => { probe.page.orderPlaced(); });
await settle();
await t.check('a checkout of its own link: its source, no cart, and the shopper\'s cart left alone', () => {
  assert.equal(probe.page.url, 'https://shop/wins/1');
  const [completed] = events.filter((event) => event.type === 'checkout:completed');
  assert.equal(completed.source, 'auctionWins');
  assert.equal(completed.cart, undefined);
  assert.equal(events.some((event) => event.type === 'checkout:orderPlaced'), false);
  assert.equal(probe.cart.cart?.id ?? null, cartBefore);
});

t.section('buying on a product page (useProductPurchase)');
const PLAN = { id: 'gid://plan/1', name: 'Pre-order' };
const VARIANT = { id: 'v-dress', title: 'M', availableForSale: true, quantityAvailable: 3, sellingPlan: null, price: usd('20.00') };
const SOLD_OUT_PREORDER = { ...VARIANT, id: 'v-pre', quantityAvailable: 0, sellingPlan: PLAN };
const PRODUCT = { id: 'p-dress', handle: 'dress', title: 'Dress' };
const joined = [];
let signInsAsked = 0;
const PRIZE_EXTENSION = [{ name: 'prizes', lineFacts: (line) => (line.attributes.some((a) => a.key === '_prize') ? { prize: { nowPerUnit: usd('0.00'), costsNothing: true, fullPrice: usd('20.00') } } : {}) }];
function PurchaseProbe({ variant, status = 'available' }) {
  probe.cart = useCart();
  const selection = { variant, known: true };
  const cart = useAddToCart(variant);
  probe.purchase = useProductPurchase(
    { shown: PRODUCT, status, selection, cart },
    { onSignInNeeded: () => { signInsAsked += 1; }, onJoinedWaitlist: (entry) => joined.push(entry) },
  );
  return null;
}
await mount(PurchaseProbe, { variant: VARIANT }, { cartExtensions: PRIZE_EXTENSION });
await t.check('buy, nothing in the cart yet', () => {
  assert.equal(probe.purchase.mode, 'buy');
  assert.equal(probe.purchase.inCartCount, 0);
});
await runAct(async () => { probe.purchase.add(); });
await settle();
await runAct(async () => { await probe.cart.addLine({ merchandiseId: 'v-dress', quantity: 1, attributes: [{ key: '_prize', value: 'true' }] }); });
await settle();
await t.check('add puts one in; a prize of the same size isn\'t counted', () => {
  assert.equal(probe.cart.cart.totalQuantity, 2);
  assert.equal(probe.purchase.inCartCount, 1);
});
await runAct(async () => { probe.purchase.increase(); });
await settle();
await runAct(async () => { probe.purchase.removeOne(); });
await settle();
await t.check('+ adds one more; − takes one off the size\'s last counted line, never the prize', () => {
  assert.equal(probe.purchase.inCartCount, 1);
  assert.ok(probe.cart.cart.lines.some((line) => line.attributes.some((a) => a.key === '_prize')));
});
await runAct(async () => { probe.purchase.removeOne(); });
await settle();
await t.check('− at 1 removes the line', () => {
  assert.equal(probe.purchase.inCartCount, 0);
  assert.equal(probe.purchase.updating, false);
});
await runAct(async () => { probe.purchase.joinWaitlist(); });
await t.check('the waitlist while signed out asks for a sign-in, and joins nothing', () => {
  assert.equal(signInsAsked, 1);
  assert.deepEqual(joined, []);
});
await mount(PurchaseProbe, { variant: SOLD_OUT_PREORDER });
await t.check('a sold-out size on a pre-order plan: preorder', () => assert.equal(probe.purchase.mode, 'preorder'));
await runAct(async () => { probe.purchase.preorder(); });
await settle();
await t.check('Preauthorize Now adds one on the plan, and only pre-order lines are counted', () => {
  const sent = calls.filter((call) => call.name === 'CartLinesAdd').at(-1).variables.lines[0];
  assert.equal(sent.sellingPlanId, PLAN.id);
  assert.equal(probe.purchase.inCartCount, 1);
});
await mount(PurchaseProbe, { variant: VARIANT, status: 'blocked' });
await t.check('an auction wins over everything', () => assert.equal(probe.purchase.mode, 'blocked'));

t.section('held out, through the cart extensions (useVariantHeldOut)');
const heldOut = new Set();
const heldListeners = new Set();
const HOLD_EXTENSION = [{
  name: 'hold',
  isHeldOut: (id) => heldOut.has(id),
  subscribeHeldOut: (listener) => { heldListeners.add(listener); return () => heldListeners.delete(listener); },
}];
function HeldProbe() {
  probe.held = useVariantHeldOut('v-dress');
  probe.cart = useCart();
  probe.purchase = useProductPurchase({ shown: PRODUCT, status: 'available', selection: { variant: VARIANT, known: true }, cart: useAddToCart(VARIANT) });
  return null;
}
await mount(HeldProbe, {}, { cartExtensions: HOLD_EXTENSION });
await t.check('not held out at first', () => {
  assert.equal(probe.held, false);
  assert.equal(probe.purchase.mode, 'buy');
});
await runAct(async () => { heldOut.add('v-dress'); heldListeners.forEach((listener) => listener()); });
await t.check('the extension says so: held out, and the bar offers the waitlist', () => {
  assert.equal(probe.held, true);
  assert.equal(probe.purchase.mode, 'heldInOtherCarts');
});
await runAct(async () => root.unmount());
root = null;
await t.check('unmounting stops listening', () => assert.equal(heldListeners.size, 0));

t.section('useQuickAdd');
const chosen = [];
const added = [];
function QuickAddProbe() {
  probe.cart = useCart();
  probe.quickAdd = useQuickAdd({
    credit: (product) => ({ lineAttributes: [{ key: '_stream_id', value: `s-${product.id}` }] }),
    onChooseVariant: (product) => chosen.push(product.id),
    onAdded: (product, variant) => added.push([product.id, variant.id]),
  });
  return null;
}
const ONE_SIZE = { id: 'p-1', variants: [{ id: 'v-1', availableForSale: true, quantityAvailable: 2 }] };
const MANY_SIZES = { id: 'p-2', variants: [{ id: 'v-2', availableForSale: true }, { id: 'v-3', availableForSale: true }] };
const ONE_SIZE_SOLD_OUT = { id: 'p-3', variants: [{ id: 'v-4', availableForSale: false }] };
await mount(QuickAddProbe);
await runAct(async () => { probe.quickAdd.add(ONE_SIZE); });
await t.check('one size for sale: it is adding, its card says so', () => assert.deepEqual(probe.quickAdd.addingProductIds, ['p-1']));
await settle();
await t.check('it lands with the product\'s credit, onAdded is told, and the card is done', () => {
  const sent = calls.filter((call) => call.name === 'CartLinesAdd').at(-1).variables.lines[0];
  assert.deepEqual(sent.attributes, [{ key: '_stream_id', value: 's-p-1' }]);
  assert.deepEqual(added, [['p-1', 'v-1']]);
  assert.deepEqual(probe.quickAdd.addingProductIds, []);
});
await runAct(async () => { probe.quickAdd.add(MANY_SIZES); probe.quickAdd.add(ONE_SIZE_SOLD_OUT); });
await t.check('a choice to make (several sizes, or its one not for sale): onChooseVariant, nothing added', () => {
  assert.deepEqual(chosen, ['p-2', 'p-3']);
  assert.equal(added.length, 1);
});

t.section('useSignIn');
const pagesOpened = [];
function SignInProbe() {
  probe.signIn = useSignIn({ onOpenSignInPage: (method) => pagesOpened.push(method) });
  return null;
}
await mount(SignInProbe, {}, { auth: { method: 'password', secureStorage: memoryStorage() } });
await runAct(async () => { await probe.signIn.start(); });
await t.check('email and password: the app\'s own page, as password', () => assert.deepEqual(pagesOpened, ['password']));
await mount(SignInProbe, {}, { auth: { method: 'shopify', signInSurface: 'webview', secureStorage: memoryStorage(), customerAccount: { shopId: '1', clientId: 'c' } } });
await runAct(async () => { await probe.signIn.start(); });
await t.check('Shopify\'s page in a web view: the app\'s own page, as shopify', () => assert.deepEqual(pagesOpened, ['password', 'shopify']));
await mount(SignInProbe, {}, { auth: { method: 'shopify', secureStorage: memoryStorage(), customerAccount: { shopId: '1', clientId: 'c' } } });
await runAct(async () => { await probe.signIn.start(); });
await t.check('the system sheet that can\'t open: failed, and no page', () => {
  assert.equal(probe.signIn.failed, true);
  assert.equal(probe.signIn.signingIn, false);
  assert.deepEqual(pagesOpened, ['password', 'shopify']);
});

t.section('useGridColumns');
function ColumnsProbe({ fallback }) {
  probe.columns = useGridColumns(fallback);
  return null;
}
forgetGridColumns();
const prefs = memoryStorage({ 'prefs.productGridColumns': '1' });
await mount(ColumnsProbe, { fallback: '3' }, { storage: prefs, gridColumnsStorageKey: 'prefs.productGridColumns' });
await t.check('the choice saved under the app\'s key wins over the grid\'s own', () => assert.equal(probe.columns.columns, '1'));
await runAct(async () => { probe.columns.setColumns('2'); });
await settle();
await t.check('a new choice shows at once and is saved', () => {
  assert.equal(probe.columns.columns, '2');
  assert.equal(prefs.map.get('prefs.productGridColumns'), '2');
});
forgetGridColumns();
await mount(ColumnsProbe, { fallback: 'nonsense' }, { storage: memoryStorage() });
await t.check('nothing saved and no usable setting: 2', () => assert.equal(probe.columns.columns, '2'));

t.section('useCollectionPage: the order it opens on (0.16.0)');
const { useCollectionPage } = SDK;
function CollectionPageProbe(options) {
  probe.page = useCollectionPage(options);
  return null;
}
/** What each CollectionProducts request for `handle` asked Shopify for. */
const collectionReads = (handle) => calls
  .filter((call) => call.name === 'CollectionProducts' && call.variables.handle === handle)
  .map((call) => ({ sortKey: call.variables.sortKey ?? null, reverse: call.variables.reverse }));
/** The same root, new props: what a screen's re-render does. */
async function rerender(Probe, props) {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't' }, onEvent: (event) => events.push(event) },
      React.createElement(Probe, props),
    ));
  });
  await settle();
}
// Each mount reads its own collection: a handle read moments ago is served from the feed's cache.
await mount(CollectionPageProbe, { handle: 'opens-default' });
await t.check('no initialSortId: featured, as in 0.15.0, read once with no sort key', () => {
  assert.equal(probe.page.sortId, 'featured');
  assert.deepEqual(collectionReads('opens-default'), [{ sortKey: null, reverse: false }]);
});
await mount(CollectionPageProbe, { handle: 'opens-newest', initialSortId: 'created-descending' });
await t.check('initialSortId created-descending: the first and only read is newest first', () => {
  assert.equal(probe.page.sortId, 'created-descending');
  assert.deepEqual(collectionReads('opens-newest'), [{ sortKey: 'CREATED', reverse: true }]);
});
for (const [sortId, expected] of [
  ['title-ascending', { sortKey: 'TITLE', reverse: false }],
  ['title-descending', { sortKey: 'TITLE', reverse: true }],
  ['created-ascending', { sortKey: 'CREATED', reverse: false }],
]) {
  const handle = `opens-${sortId}`;
  await mount(CollectionPageProbe, { handle, initialSortId: sortId });
  await t.check(`initialSortId ${sortId}: one read, sortKey ${expected.sortKey}, reverse ${expected.reverse}`, () => {
    assert.equal(probe.page.sortId, sortId);
    assert.deepEqual(collectionReads(handle), [expected]);
  });
}
await mount(CollectionPageProbe, { handle: 'opens-unknown', initialSortId: 'random' });
await t.check('an id Shopify has no order for opens on featured', () => {
  assert.equal(probe.page.sortId, 'featured');
  assert.deepEqual(collectionReads('opens-unknown'), [{ sortKey: null, reverse: false }]);
});
await mount(CollectionPageProbe, { handle: 'chosen', initialSortId: 'created-descending' });
await runAct(async () => { probe.page.setSortId('title-descending'); });
await settle();
await t.check('the shopper\'s choice wins over the starting order, and is read in its own order', () => {
  assert.equal(probe.page.sortId, 'title-descending');
  assert.deepEqual(collectionReads('chosen'), [{ sortKey: 'CREATED', reverse: true }, { sortKey: 'TITLE', reverse: true }]);
});
await rerender(CollectionPageProbe, { handle: 'chosen', initialSortId: 'price-ascending' });
await t.check('a later initialSortId is ignored: the page opened once', () => {
  assert.equal(probe.page.sortId, 'title-descending');
  assert.equal(collectionReads('chosen').length, 2);
});
await rerender(CollectionPageProbe, { handle: 'chosen-next', initialSortId: 'created-descending' });
await t.check('a new handle on the same page keeps the order on screen, as in 0.15.0', () => {
  assert.equal(probe.page.sortId, 'title-descending');
  assert.deepEqual(collectionReads('chosen-next'), [{ sortKey: 'TITLE', reverse: true }]);
});

await runAct(async () => root.unmount());
t.done();
