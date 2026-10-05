// Store credit on the cart (`useCartStoreCredit`, decided 2026-10-05): one Apply at a time, a new
// idempotency key per Apply reused only to retry that attempt, the app's card found on the cart by its
// last characters (after a restart too), Remove taking off only that card, the balance read again on
// each trigger, and another shopper's balance never shown (here and in `useTileCredit`). Renders the
// real ShopifyProvider in jsdom with the Storefront API and Tile Credit stubbed at `fetch`.
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
const TOKENS = { 'a@example.com': 'tok_A', 'b@example.com': 'tok_B' };
const PEOPLE = { tok_A: { id: 'gid://shopify/Customer/1', email: 'a@example.com', balanceCents: 5000 }, tok_B: { id: 'gid://shopify/Customer/2', email: 'b@example.com', balanceCents: 900 } };

const service = {
  /** Cards minted, by idempotency key: the same key hands back the same card. */
  byKey: new Map(),
  minted: 0,
  /** The active card's last four, per token (one active card per customer). */
  active: new Map(),
  redeems: [],
  reads: [],
  holdRedeem: null,
  holdWallet: null,
};
const cart = {
  cards: [{ id: 'gid://shopify/AppliedGiftCard/other', lastCharacters: '9999', presentmentAmountUsed: money('5.00'), balance: money('0.00'), amountUsed: money('5.00') }],
  /** Shopify answers the next add without applying the code. */
  skipNextAdd: false,
  nextCard: 0,
};
const cartPayload = () => ({
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [], totalQuantity: 1,
  buyerIdentity: { countryCode: 'US', email: null, phone: null },
  lines: { nodes: [{ id: 'gid://line/1', quantity: 1, attributes: [], sellingPlanAllocation: null,
    merchandise: { id: 'gid://shopify/ProductVariant/1', title: 'S', price: money('60.00') }, cost: { totalAmount: money('60.00'), amountPerQuantity: money('60.00') } }] },
  cost: { subtotalAmount: money('60.00'), totalAmount: money('60.00') }, discountCodes: [],
  appliedGiftCards: cart.cards, createdAt: '', updatedAt: '',
});

global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://tile-credit.test/')) {
    const token = init.headers.Authorization.replace('Customer ', '');
    const path = new URL(url).pathname;
    const person = PEOPLE[token];
    if (!person) return response(401, { error: 'unauthorized', message: 'Invalid or expired customer access token' });
    if (path === '/public/me') {
      service.reads.push(token);
      if (service.holdWallet && token === 'tok_B') await service.holdWallet.promise;
      return response(200, { ok: true, appId: 'a', customer: {}, balanceCents: person.balanceCents, lifetimeEarnedCents: 0, lifetimeRedeemedCents: 0, expiringCents: 0 });
    }
    if (path === '/public/me/gift-cards') {
      const last4 = service.active.get(token);
      return response(200, { giftCards: last4 ? [{ id: 'r', shopifyGiftCardGid: 'g', last4, initialAmountCents: 0, currencyCode: 'USD', createdAt: '', expiresAt: null, status: 'active', ledgerEntryId: 'l', redemptionAmountCents: 0 }] : [] });
    }
    if (path === '/public/me/redeem') {
      const body = JSON.parse(init.body);
      service.redeems.push({ token, ...body });
      if (service.holdRedeem) await service.holdRedeem.promise;
      if (body.amountCents > person.balanceCents) return response(402, { error: 'insufficient_balance', message: 'Insufficient balance' });
      const known = service.byKey.get(body.idempotencyKey);
      const code = known ?? `CRED0000CARD${String(++service.minted).padStart(4, '0')}`;
      service.byKey.set(body.idempotencyKey, code);
      service.active.set(token, code.slice(-4));
      return response(200, { giftCardGid: `gid://shopify/GiftCard/${code}`, code, last4: code.slice(-4), amountCents: body.amountCents, currencyCode: 'USD',
        expiresOn: null, ledgerEntryId: 'l', duplicate: !!known, balanceCents: person.balanceCents });
    }
    if (path === '/public/config') return response(200, { ok: true, currency: 'USD', redemptionMinCents: 100, redemptionMaxCents: null });
    return response(404, { error: 'not_found' });
  }
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart: cartPayload(), userErrors: [] } } });
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart: cartPayload() } });
  if (name === 'CartGiftCardCodesAdd') {
    for (const code of variables.giftCardCodes) {
      if (cart.skipNextAdd) { cart.skipNextAdd = false; continue; }
      cart.cards = [...cart.cards, { id: `gid://shopify/AppliedGiftCard/${cart.nextCard++}`, lastCharacters: code.slice(-4).toLowerCase(),
        presentmentAmountUsed: money('20.00'), balance: money('0.00'), amountUsed: money('20.00') }];
    }
    return response(200, { data: { cartGiftCardCodesAdd: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CartGiftCardCodesRemove') {
    cart.cards = cart.cards.filter((c) => !variables.appliedGiftCardIds.includes(c.id));
    return response(200, { data: { cartGiftCardCodesRemove: { cart: cartPayload(), userErrors: [] } } });
  }
  if (name === 'CustomerAccessTokenCreate') {
    const accessToken = TOKENS[variables.input.email];
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken, expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'CustomerAccessTokenDelete') return response(200, { data: { customerAccessTokenDelete: { deletedAccessToken: 'x', userErrors: [] } } });
  if (name === 'Customer') {
    const who = PEOPLE[variables.accessToken];
    return response(200, { data: { customer: { id: who.id, email: who.email, firstName: 'F', lastName: 'L', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useShopify, useCartStoreCredit, useTileCredit } = await import('../dist/index.js');

const t = harness('cart: store credit (useCartStoreCredit)');
let api = null;
let credit = null;
/** Every balance a render showed, to prove another shopper's never did. */
const balancesShown = [];
function Probe() {
  api = useShopify();
  credit = useCartStoreCredit();
  balancesShown.push(credit.balance?.amount ?? null);
  return null;
}
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
const secure = keychain();
let root = createRoot(document.getElementById('root'));
async function mount() {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' },
        auth: { method: 'password', secureStorage: secure }, storeCredit: { source: 'tile', tileCreditBaseUrl: 'https://tile-credit.test' } },
      React.createElement(Probe),
    ));
  });
  await settle();
}
const login = async (email) => {
  await runAct(async () => { await api.customer.login(email, 'secret'); });
  await settle();
};

await mount();
t.section('reading');
await t.check('signed out: hidden, nothing read', () => {
  assert.equal(credit.status, 'hidden');
  assert.equal(credit.balance, null);
  assert.equal(service.reads.length, 0);
});
await login('a@example.com');
await t.check('signed in: the balance, ready to apply; another app’s gift card on the cart is not ours', () => {
  assert.equal(credit.source, 'tile');
  assert.equal(credit.status, 'ready');
  assert.deepEqual(credit.balance, money('50.00'));
  assert.equal(credit.applied, null);
  assert.equal(credit.error, null);
});

t.section('applying');
await t.check('one Apply at a time: a second tap while the first runs joins it, and one card is minted', async () => {
  service.holdRedeem = deferred();
  let first;
  let second;
  await runAct(async () => {
    first = credit.apply(2000);
    second = credit.apply(2000);
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.equal(first, second);
  assert.equal(credit.status, 'applying');
  await runAct(async () => {
    service.holdRedeem.resolve();
    service.holdRedeem = null;
    assert.equal(await first, true);
  });
  await settle();
  assert.equal(service.redeems.length, 1);
  assert.equal(service.redeems[0].amountCents, 2000);
});
await t.check('the card is found on the cart by its last characters: applied, and what it takes off', () => {
  assert.equal(credit.status, 'applied');
  assert.deepEqual(credit.applied, money('20.00'));
  assert.deepEqual(api.cart.cart.appliedGiftCards.map((c) => c.lastCharacters), ['9999', '0001']);
});
await t.check('the balance is read again after the Apply (unchanged: the card only reserves it)', () => {
  assert.ok(service.reads.length >= 2);
  assert.deepEqual(credit.balance, money('50.00'));
});

t.section('removing');
await t.check('Remove takes off only the app’s card; another gift card stays', async () => {
  await runAct(async () => { assert.equal(await credit.remove(), true); });
  await settle();
  assert.deepEqual(api.cart.cart.appliedGiftCards.map((c) => c.lastCharacters), ['9999']);
  assert.equal(credit.status, 'ready');
  assert.equal(credit.applied, null);
});

t.section('the idempotency key');
await t.check('every Apply gets a new key', async () => {
  await runAct(async () => { await credit.apply(1000); });
  await settle();
  const [a, b] = service.redeems.map((r) => r.idempotencyKey);
  assert.notEqual(a, b);
  await runAct(async () => { await credit.remove(); });
  await settle();
});
await t.check('a failed Apply retried as it was reuses its key, so the card already minted comes back, not a new one', async () => {
  cart.skipNextAdd = true;
  await runAct(async () => { assert.equal(await credit.apply(1500), false); });
  await settle();
  assert.equal(credit.error?.code, 'cart_refused');
  assert.equal(credit.status, 'ready');
  const minted = service.minted;
  await runAct(async () => { assert.equal(await credit.apply(1500), true); });
  await settle();
  const [failed, retried] = service.redeems.slice(-2);
  assert.equal(retried.idempotencyKey, failed.idempotencyKey);
  assert.equal(service.minted, minted, 'no second card');
  assert.equal(credit.status, 'applied');
  assert.equal(credit.error, null);
  await runAct(async () => { await credit.remove(); });
  await settle();
});
await t.check('after a success, or for another amount, the next Apply is a new attempt with a new key', async () => {
  const before = service.redeems.length;
  await runAct(async () => { await credit.apply(1500); });
  await settle();
  assert.notEqual(service.redeems[before].idempotencyKey, service.redeems[before - 1].idempotencyKey);
  await runAct(async () => { await credit.remove(); });
  await settle();
  cart.skipNextAdd = true;
  await runAct(async () => { await credit.apply(1200); });
  await runAct(async () => { await credit.apply(1300); });
  await settle();
  const [one, two] = service.redeems.slice(-2);
  assert.notEqual(one.idempotencyKey, two.idempotencyKey);
  await runAct(async () => { await credit.remove(); });
  await settle();
});
await t.check('the service’s refusals come back as their codes; no amount is not sent at all', async () => {
  const before = service.redeems.length;
  await runAct(async () => { assert.equal(await credit.apply(0), false); });
  assert.equal(credit.error?.code, 'validation');
  assert.equal(service.redeems.length, before);
  await runAct(async () => { assert.equal(await credit.apply(999999), false); });
  await settle();
  assert.equal(credit.error?.code, 'insufficient_balance');
  assert.equal(credit.status, 'ready');
});
await t.check('a new card disables the app’s earlier one, so an earlier card still on the cart comes off', async () => {
  await runAct(async () => { await credit.apply(1000); });
  await settle();
  const earlier = api.cart.cart.appliedGiftCards.at(-1).lastCharacters;
  // A screen offers Remove, not Apply, while a card is on; the hook still copes with an Apply.
  await runAct(async () => { assert.equal(await credit.apply(1100), true); });
  await settle();
  const endings = api.cart.cart.appliedGiftCards.map((c) => c.lastCharacters);
  assert.equal(endings.length, 2);
  assert.equal(endings[0], '9999', 'another gift card stays');
  assert.notEqual(endings[1], earlier);
  assert.equal(credit.status, 'applied');
});

t.section('after a restart');
await runAct(async () => { root.unmount(); });
root = createRoot(document.getElementById('root'));
await mount();
await t.check('the shopper’s active card on the cart is the app’s: applied, with Remove, though nothing was minted since', () => {
  assert.equal(api.customer.loggedIn, true);
  assert.equal(credit.status, 'applied');
  assert.deepEqual(credit.applied, money('20.00'));
});
await t.check('… and Remove takes off just that card', async () => {
  await runAct(async () => { await credit.remove(); });
  await settle();
  assert.deepEqual(api.cart.cart.appliedGiftCards.map((c) => c.lastCharacters), ['9999']);
});

t.section('triggers');
await t.check('the app coming back to the foreground reads the balance again', async () => {
  const before = service.reads.length;
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await runAct(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
  await settle();
  assert.equal(service.reads.length, before + 1);
});
await t.check('refresh() reads it again; two at once share one read', async () => {
  const before = service.reads.length;
  await runAct(async () => { await Promise.all([credit.refresh(), credit.refresh()]); });
  assert.equal(service.reads.length, before + 1);
});

t.section('another shopper');
await runAct(async () => { await api.customer.logout(); });
await settle();
service.holdWallet = deferred();
balancesShown.length = 0;
await runAct(async () => { await api.customer.login('b@example.com', 'secret'); });
await settle();
await t.check('while the next shopper’s balance is on its way, the last one’s never shows', () => {
  assert.equal(credit.status, 'loading');
  assert.equal(credit.balance, null);
  assert.ok(!balancesShown.includes('50.00'), `shown: ${balancesShown.join(', ')}`);
});
await runAct(async () => { service.holdWallet.resolve(); service.holdWallet = null; });
await settle();
await t.check('then theirs', () => {
  assert.deepEqual(credit.balance, money('9.00'));
  assert.equal(credit.status, 'ready');
});
await runAct(async () => { root.unmount(); });

t.section('useTileCredit (deprecated): the same fix');
let wallet = null;
const walletsShown = [];
function OldProbe({ token }) {
  const state = useTileCredit({ baseUrl: 'https://tile-credit.test', customerAccessToken: token, shopDomain: 'shop.myshopify.com' });
  wallet = state.wallet;
  walletsShown.push(state.wallet?.balanceCents ?? null);
  return null;
}
root = createRoot(document.getElementById('root'));
const renderOld = async (token) => {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' } },
      React.createElement(OldProbe, { token }),
    ));
  });
  await settle();
};
await renderOld('tok_A');
await t.check('reads the wallet for the token it is given', () => {
  assert.equal(wallet?.balanceCents, 5000);
});
service.holdWallet = deferred();
walletsShown.length = 0;
await renderOld('tok_B');
await t.check('a new token: the old wallet goes at once, and the new one is read (it used to keep the first shopper’s)', async () => {
  assert.equal(wallet, null);
  assert.ok(!walletsShown.includes(5000));
  await runAct(async () => { service.holdWallet.resolve(); service.holdWallet = null; });
  await settle();
  assert.equal(wallet?.balanceCents, 900);
});
await runAct(async () => { root.unmount(); });
t.done();
