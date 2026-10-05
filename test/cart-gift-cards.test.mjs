// Gift cards on the provider's cart (`useCart().addGiftCardCodes` / `removeGiftCards`, 2026-10-05):
// they wait in the cart's write queue like every other write, add rather than replace
// (`cartGiftCardCodesAdd`), set a country only on a cart with none while keeping the buyer's email and
// customer link, report a code Shopify silently skipped, and remove only the cards asked for. Then the
// non-React `redeemAndApplyToCart`, fixed the same way. Renders the real ShopifyProvider in jsdom with
// the Storefront API and Tile Credit stubbed at `fetch`.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { deferred, harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
/** The cart on the "server". `cards`: what's applied; Shopify only applies codes it knows (`issued`). */
const server = {
  lines: [],
  cards: [],
  buyerIdentity: { countryCode: 'US', email: 'buyer@example.com', phone: null },
  issued: new Set(['GIFT0000CARD1111', 'GIFT0000CARD2222', 'GIFT0000CARD3333']),
};
let nextLine = 0;
let nextCard = 0;
const sent = [];
/** Set to hold the next `cartLinesAdd` answer until the test lets it go. */
let holdLineAdd = null;
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [],
  totalQuantity: server.lines.reduce((n, l) => n + l.quantity, 0),
  buyerIdentity: server.buyerIdentity,
  lines: { nodes: server.lines.map((l) => ({ id: l.id, quantity: l.quantity, attributes: [], sellingPlanAllocation: null,
    merchandise: { id: l.merchandiseId, title: 'S', price: money('50.00') }, cost: { totalAmount: money('50.00'), amountPerQuantity: money('50.00') } })) },
  cost: { subtotalAmount: money('50.00'), totalAmount: money('50.00') }, discountCodes: [],
  appliedGiftCards: server.cards, createdAt: '', updatedAt: '',
});

global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://tile-credit.test/')) {
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push({ name: `tile ${new URL(url).pathname}`, body });
    return response(200, { giftCardGid: 'gid://shopify/GiftCard/3', code: 'GIFT0000CARD3333', last4: '3333', amountCents: body.amountCents,
      currencyCode: 'USD', expiresOn: null, ledgerEntryId: 'l', duplicate: false, balanceCents: 5000 });
  }
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  sent.push({ name, variables });
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart: cartPayload(), userErrors: [] } } });
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart: cartPayload() } });
  if (name === 'CartLinesAdd') {
    if (holdLineAdd) await holdLineAdd.promise;
    for (const l of variables.lines) server.lines.push({ id: `gid://line/${nextLine++}`, ...l });
    return response(200, { data: { cartLinesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartGiftCardCodesAdd') {
    for (const code of variables.giftCardCodes) {
      const ending = code.slice(-4).toLowerCase();
      // Shopify answers a code it doesn't take with no error at all (Storefront API 2026-07).
      if (server.issued.has(code.toUpperCase()) && !server.cards.some((c) => c.lastCharacters === ending)) {
        server.cards.push({ id: `gid://shopify/AppliedGiftCard/${nextCard++}`, lastCharacters: ending,
          presentmentAmountUsed: money('20.00'), balance: money('0.00'), amountUsed: money('20.00') });
      }
    }
    return response(200, { data: { cartGiftCardCodesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartGiftCardCodesUpdate') throw new Error('UPDATE replaces every card: never used to add one');
  if (name === 'CartGiftCardCodesRemove') {
    server.cards = server.cards.filter((c) => !variables.appliedGiftCardIds.includes(c.id));
    return response(200, { data: { cartGiftCardCodesRemove: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartBuyerIdentityUpdate') {
    // It REPLACES the identity: whatever isn't sent is gone.
    const bi = variables.buyerIdentity;
    server.buyerIdentity = { countryCode: bi.countryCode ?? null, email: bi.email ?? null, phone: null };
    return response(200, { data: { cartBuyerIdentityUpdate: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_pw', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'Customer') {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'buyer@example.com', firstName: 'B', lastName: 'Y', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, shopify } = await import('../dist/index.js');

const t = harness('cart: gift cards through the provider');
let api = null;
function Probe() {
  api = useShopify();
  return null;
}
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
const root = createRoot(document.getElementById('root'));
await runAct(async () => {
  root.render(React.createElement(
    ShopifyProvider,
    { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07', country: 'CA' },
      auth: { method: 'password', secureStorage: keychain() } },
    React.createElement(Probe),
  ));
});
await settle();
const names = () => sent.map((s) => s.name);

t.section('adding');
await t.check('waits in the cart’s write queue behind a line add still on its way', async () => {
  sent.length = 0;
  holdLineAdd = deferred();
  let lineAdd;
  let cardAdd;
  await runAct(async () => {
    lineAdd = api.cart.addLine({ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1 });
    await new Promise((r) => setTimeout(r, 10));
    cardAdd = api.cart.addGiftCardCodes(['GIFT0000CARD1111']);
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.deepEqual(names(), ['CartLinesAdd'], 'the gift card waits');
  await runAct(async () => {
    holdLineAdd.resolve();
    holdLineAdd = null;
    await lineAdd;
    await cardAdd;
  });
  assert.deepEqual(names(), ['CartLinesAdd', 'CartGiftCardCodesAdd']);
  assert.deepEqual(api.cart.cart.appliedGiftCards.map((c) => c.lastCharacters), ['1111']);
  assert.equal(api.cart.cart.lines.length, 1, 'the line add landed too');
});
await t.check('a cart that has a country keeps its buyer identity untouched; the cards already on it stay', async () => {
  sent.length = 0;
  await runAct(async () => { await api.cart.addGiftCardCodes(['GIFT0000CARD2222']); });
  assert.deepEqual(names(), ['CartGiftCardCodesAdd']);
  assert.deepEqual(api.cart.cart.appliedGiftCards.map((c) => c.lastCharacters), ['1111', '2222']);
  assert.deepEqual(api.cart.cart.buyerIdentity, { countryCode: 'US', email: 'buyer@example.com', phone: null });
});
await t.check('Shopify answering without applying a code is an error, with the cart still updated', async () => {
  await runAct(async () => {
    await assert.rejects(api.cart.addGiftCardCodes(['NOTACARD9999']), (e) => e.name === 'ShopifyError' && e.errors[0].code === 'GIFT_CARD_NOT_APPLIED' && /9999/.test(e.message));
  });
  assert.equal(api.cart.cart.appliedGiftCards.length, 2);
});

t.section('a cart with no country');
server.buyerIdentity = { countryCode: null, email: 'buyer@example.com', phone: null };
await runAct(async () => { await api.cart.refresh(); });
await runAct(async () => { await api.customer.login('buyer@example.com', 'secret'); });
await settle();
await t.check('gets the app’s country first, keeping the email and the signed-in shopper’s link', async () => {
  sent.length = 0;
  await runAct(async () => { await api.cart.removeGiftCards(api.cart.cart.appliedGiftCards.map((c) => c.id)); });
  await runAct(async () => { await api.cart.addGiftCardCodes(['GIFT0000CARD1111']); });
  assert.deepEqual(names(), ['CartGiftCardCodesRemove', 'CartBuyerIdentityUpdate', 'CartGiftCardCodesAdd']);
  assert.deepEqual(sent[1].variables.buyerIdentity, { countryCode: 'CA', email: 'buyer@example.com', customerAccessToken: 'tok_pw' });
  assert.deepEqual(api.cart.cart.buyerIdentity, { countryCode: 'CA', email: 'buyer@example.com', phone: null });
});

t.section('removing');
await t.check('takes off only the cards asked for', async () => {
  await runAct(async () => { await api.cart.addGiftCardCodes(['GIFT0000CARD2222']); });
  const [first, second] = api.cart.cart.appliedGiftCards;
  sent.length = 0;
  await runAct(async () => { await api.cart.removeGiftCards([second.id]); });
  assert.deepEqual(sent.map((s) => s.variables.appliedGiftCardIds), [[second.id]]);
  assert.deepEqual(api.cart.cart.appliedGiftCards.map((c) => c.id), [first.id]);
});
await t.check('nothing asked for: nothing sent', async () => {
  sent.length = 0;
  await runAct(async () => { await api.cart.removeGiftCards([]); });
  assert.equal(sent.length, 0);
});

t.section('redeemAndApplyToCart (no React; deprecated)');
await t.check('adds the minted card next to the others, sets a missing country and keeps the email', async () => {
  server.buyerIdentity = { countryCode: null, email: 'buyer@example.com', phone: null };
  sent.length = 0;
  shopify.tileCredit.configure({ baseUrl: 'https://tile-credit.test', shopDomain: 'shop.myshopify.com', getAccessToken: async () => 'tok_pw' });
  const { redeemed, cart } = await shopify.tileCredit.redeemAndApplyToCart({ cartId: 'gid://shopify/Cart/1', amountCents: 2000, countryFallback: 'GB', customerAccessToken: 'tok_pw' });
  assert.equal(redeemed.last4, '3333');
  assert.deepEqual(names(), ['CartGet', 'tile /public/me/redeem', 'CartBuyerIdentityUpdate', 'CartGiftCardCodesAdd']);
  assert.deepEqual(sent[2].variables.buyerIdentity, { countryCode: 'GB', email: 'buyer@example.com', customerAccessToken: 'tok_pw' });
  assert.deepEqual(cart.appliedGiftCards.map((c) => c.lastCharacters), ['1111', '3333']);
});
await t.check('a card Shopify skips is `cart_refused`', async () => {
  server.issued.delete('GIFT0000CARD3333');
  server.cards = [];
  await assert.rejects(
    shopify.tileCredit.redeemAndApplyToCart({ cartId: 'gid://shopify/Cart/1', amountCents: 2000 }),
    (e) => e.name === 'TileCreditError' && e.code === 'cart_refused' && e.details.last4 === '3333',
  );
});

await runAct(async () => { root.unmount(); });
t.done();
