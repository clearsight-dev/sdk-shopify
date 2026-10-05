// Tile Credit's client and its token (decided 2026-10-05): the token is read before every request, a
// 401 renews it once and sends the request again, and a 401 that stays never signs the shopper out.
// Then the provider's session as the source of both (`useStoreCredit` through `tileCreditClientFor`),
// for a Shopify sign-in (renews by refreshing) and a password one (can't renew). Plus the two pure
// helpers the cart's store credit leans on: the typed-amount parser and finding a card by its ending.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, jwt, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const {
  TileCreditClient,
  TileCreditError,
  ShopifyProvider,
  useShopify,
  useStoreCredit,
  typedAmountToCents,
  giftCardsEndingIn,
  giftCardCodesNotOnCart,
} = await import('../dist/index.js');

const t = harness('tile credit: the client, its token, and the amount typed');

// ── The amount a shopper types ────────────────────────────────────────────────
t.section('typedAmountToCents');
await t.check('plain, grouped and decimal amounts, with or without a currency sign', () => {
  assert.equal(typedAmountToCents('1500'), 150000);
  assert.equal(typedAmountToCents('1,500'), 150000, 'old Amore read this as 1.5');
  assert.equal(typedAmountToCents('1500.5'), 150050);
  assert.equal(typedAmountToCents('$1,500.00'), 150000);
  assert.equal(typedAmountToCents(' 25 '), 2500);
  assert.equal(typedAmountToCents('1,500,000'), 150000000);
  assert.equal(typedAmountToCents('.5'), 50);
  assert.equal(typedAmountToCents('5.'), 500);
});
await t.check('a decimal comma (a phone keyboard in some regions), and both marks with the last one decimal', () => {
  assert.equal(typedAmountToCents('12,5'), 1250);
  assert.equal(typedAmountToCents('€12,50'), 1250);
  assert.equal(typedAmountToCents('1.500,00'), 150000);
  assert.equal(typedAmountToCents('1.500'), 150, 'a dot alone is the decimal point');
});
await t.check('more than two decimals round to the cent', () => {
  assert.equal(typedAmountToCents('1500.555'), 150056);
  assert.equal(typedAmountToCents('0.004'), 0);
});
await t.check('letters, a minus, two decimal points, nothing, or too long: not an amount', () => {
  for (const typed of ['abc', '12abc', 'USD 10', '-5', '−5', '1.2.3', '', '   ', '$', ',', '12345678901234', null, undefined, 12]) {
    assert.equal(typedAmountToCents(typed), null, JSON.stringify(typed));
  }
});
await t.check('zero is an answer, not an error', () => {
  assert.equal(typedAmountToCents('0'), 0);
  assert.equal(typedAmountToCents('0.00'), 0);
});

// ── Finding a card by how it ends ─────────────────────────────────────────────
t.section('gift cards by their last characters');
const card = (id, lastCharacters, used = '0.0') => ({
  id, lastCharacters, presentmentAmountUsed: { amount: used, currencyCode: 'USD' }, balance: { amount: '0', currencyCode: 'USD' }, amountUsed: { amount: '0', currencyCode: 'USD' },
});
await t.check('a card is found by a full code or its last four, in any case; a short ending finds nothing', () => {
  const cart = { appliedGiftCards: [card('g1', 'ab12'), card('g2', 'zz99')] };
  assert.deepEqual(giftCardsEndingIn(cart, ['XXXXXXXXXXXXAB12']).map((c) => c.id), ['g1']);
  assert.deepEqual(giftCardsEndingIn(cart, ['ZZ99']).map((c) => c.id), ['g2']);
  assert.deepEqual(giftCardsEndingIn(cart, ['12']), []);
  assert.deepEqual(giftCardsEndingIn(null, ['ab12']), []);
  assert.deepEqual(giftCardCodesNotOnCart(cart, ['QQQQQQQQQQQQAB12', 'QQQQQQQQQQQQCD34']), ['QQQQQQQQQQQQCD34']);
});

// ── The client ────────────────────────────────────────────────────────────────
t.section('TileCreditClient');
const wallet = { ok: true, appId: 'a', customer: {}, balanceCents: 4200, lifetimeEarnedCents: 0, lifetimeRedeemedCents: 0, expiringCents: 0 };
/** The service: accepts the tokens in `good`, 401 for anything else. */
let good = new Set();
const sent = [];
const tileFetch = async (url, init = {}) => {
  sent.push({ url: String(url), auth: init.headers.Authorization, shop: init.headers['x-shopify-shop-domain'] });
  const token = init.headers.Authorization.replace('Customer ', '');
  if (!good.has(token)) return response(401, { error: 'unauthorized', message: 'Invalid or expired customer access token' });
  return response(200, wallet);
};

await t.check('reads the token before every request, so a refreshed one is used at once', async () => {
  global.fetch = tileFetch;
  good = new Set(['one', 'two']);
  sent.length = 0;
  let token = 'one';
  const client = new TileCreditClient({ shopDomain: 'Shop.myshopify.com', getAccessToken: async () => token });
  await client.getWallet();
  token = 'two';
  await client.getWallet();
  assert.deepEqual(sent.map((s) => s.auth), ['Customer one', 'Customer two']);
  assert.equal(sent[0].shop, 'shop.myshopify.com');
  assert.equal(sent[0].url, 'https://tile-credit.apptile.io/public/me');
});
await t.check('a 401 renews the token once and sends the request again', async () => {
  good = new Set(['fresh']);
  sent.length = 0;
  let renewals = 0;
  const client = new TileCreditClient({
    shopDomain: 'shop.myshopify.com',
    getAccessToken: async () => 'stale',
    renewAccessToken: async () => { renewals += 1; return 'fresh'; },
  });
  const read = await client.getWallet();
  assert.equal(read.balanceCents, 4200);
  assert.equal(renewals, 1);
  assert.deepEqual(sent.map((s) => s.auth), ['Customer stale', 'Customer fresh']);
});
await t.check('a 401 that stays is `unauthorized` after one renewal, never a loop', async () => {
  good = new Set();
  sent.length = 0;
  let renewals = 0;
  const client = new TileCreditClient({
    shopDomain: 'shop.myshopify.com',
    getAccessToken: async () => 'a',
    renewAccessToken: async () => { renewals += 1; return 'b'; },
  });
  await assert.rejects(client.getWallet(), (e) => e instanceof TileCreditError && e.code === 'unauthorized' && e.status === 401);
  assert.equal(renewals, 1);
  assert.equal(sent.length, 2);
});
await t.check('nothing to renew with (a password session): the first 401 stands, sent once', async () => {
  sent.length = 0;
  const client = new TileCreditClient({ shopDomain: 'shop.myshopify.com', getAccessToken: async () => 'a', renewAccessToken: async () => null });
  await assert.rejects(client.getWallet(), (e) => e.code === 'unauthorized');
  assert.equal(sent.length, 1);
  const fixed = new TileCreditClient({ shopDomain: 'shop.myshopify.com', customerAccessToken: 'a' });
  await assert.rejects(fixed.getWallet(), (e) => e.code === 'unauthorized');
  assert.equal(sent.length, 2);
});
await t.check('signed out (no token): `unauthorized` without reaching the service', async () => {
  sent.length = 0;
  const client = new TileCreditClient({ shopDomain: 'shop.myshopify.com', getAccessToken: async () => null });
  await assert.rejects(client.getWallet(), (e) => e.code === 'unauthorized');
  assert.equal(sent.length, 0);
});
await t.check('a renewal that fails (offline) is `network`', async () => {
  good = new Set();
  const client = new TileCreditClient({
    shopDomain: 'shop.myshopify.com',
    getAccessToken: async () => 'a',
    renewAccessToken: async () => { throw new TypeError('Network request failed'); },
  });
  await assert.rejects(client.getWallet(), (e) => e.code === 'network');
});
await t.check('a client needs a token source and a shop', () => {
  assert.throws(() => new TileCreditClient({ shopDomain: 'shop.myshopify.com' }));
  assert.throws(() => new TileCreditClient({ getAccessToken: async () => 'a' }));
});

// ── Through the provider's session ────────────────────────────────────────────
t.section('the provider’s session as the token source');
const SHOP_ID = '68843864220';
const money = { amount: '10.00', currencyCode: 'USD' };
const cart = { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] }, buyerIdentity: { countryCode: 'US', email: null, phone: null },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], attributes: [], createdAt: '', updatedAt: '' };
let refreshes = 0;
const tileSent = [];
let tileGood = new Set(['at_2']);
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/oauth/token')) {
    refreshes += 1;
    return response(200, { access_token: `at_${refreshes + 1}`, refresh_token: `rt_${refreshes + 1}`, expires_in: 3600, id_token: jwt({}) });
  }
  if (url.includes('/account/customer/api/')) {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/7', firstName: 'Amber', lastName: 'Marie',
      emailAddress: { emailAddress: 'amber@example.com', marketingState: 'NOT_SUBSCRIBED' }, phoneNumber: null, defaultAddress: null } } });
  }
  if (url.startsWith('https://tile-credit.test/')) {
    const token = init.headers.Authorization.replace('Customer ', '');
    tileSent.push(token);
    if (!tileGood.has(token)) return response(401, { error: 'unauthorized', message: 'Unknown shop' });
    return response(200, wallet);
  }
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart, userErrors: [] } } });
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart } });
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_pw', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'Customer') {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'p@example.com', firstName: 'P', lastName: 'W', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });

let api = null;
let credit = null;
function Probe() {
  api = useShopify();
  credit = useStoreCredit();
  return null;
}
const secure = keychain();
secure.map.set('auth.token', 'at_1');
secure.map.set('auth.refreshToken', 'rt_1');
secure.map.set('auth.expiresAt', String(Date.now() + 3_600_000));
const authFor = (method) => ({ method, secureStorage: secure, random: () => new Uint8Array(32), customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } });
let root = createRoot(document.getElementById('root'));
const render = async (method) => {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth: authFor(method), storeCredit: { source: 'tile', tileCreditBaseUrl: 'https://tile-credit.test' } },
      React.createElement(Probe),
    ));
  });
  await settle();
};

await render('shopify');
await t.check('Shopify sign-in: a token Tile Credit refuses is refreshed once (the session’s refresh) and the read goes through', () => {
  assert.equal(api.customer.sessionKind, 'shopify');
  assert.deepEqual(tileSent, ['at_1', 'at_2']);
  assert.equal(refreshes, 1);
  assert.deepEqual(credit.balance, { amount: '42.00', currencyCode: 'USD' });
  assert.equal(secure.map.get('auth.token'), 'at_2', 'the renewed token is the session’s from now on');
});

tileGood = new Set();
tileSent.length = 0;
await runAct(async () => { await credit.refresh(); });
await settle();
await t.check('a 401 that stays: `unauthorized`, one renewal, and the shopper is still signed in', () => {
  assert.equal(credit.error?.code, 'unauthorized');
  assert.equal(tileSent.length, 2);
  assert.equal(api.customer.loggedIn, true);
  assert.equal(api.customer.sessionKind, 'shopify');
  assert.ok(secure.map.get('auth.token'), 'the session is kept');
});

await runAct(async () => { await api.customer.logout(); });
await settle();
await runAct(async () => { await api.customer.login('p@example.com', 'secret'); });
await settle();
tileSent.length = 0;
await runAct(async () => { await credit.refresh(); });
await settle();
await t.check('password sign-in: renewal has nothing to offer, so a 401 is sent once and the session stays', async () => {
  assert.equal(api.customer.sessionKind, 'password');
  assert.equal(await api.customer.renewAccessToken(), null);
  assert.deepEqual(tileSent, ['tok_pw']);
  assert.equal(credit.error?.code, 'unauthorized');
  assert.equal(api.customer.loggedIn, true);
});

await runAct(async () => { root.unmount(); });
t.done();
