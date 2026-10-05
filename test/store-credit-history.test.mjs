// Store-credit history (`useStoreCreditHistory`) from both sources: Tile Credit's ledger and Shopify's
// store-credit transactions (Customer Account API). The pure pieces first (how each line reads, how
// each source pages), then the hook rendered in jsdom with the real ShopifyProvider and the services
// stubbed at `fetch`.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { counterRandom, harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const {
  ShopifyProvider,
  useShopify,
  useStoreCreditHistory,
  tileCreditEntry,
  tileCreditHistory,
  shopifyStoreCreditHistory,
  storeCreditHistoryNextQuery,
  STORE_CREDIT_HISTORY_QUERY,
} = await import('../dist/index.js');

const t = harness('store credit: history');

/** A Tile Credit ledger line, with what the test cares about laid over a plain grant. */
const ledgerLine = (over) => ({
  id: 'l1', type: 'earn', amountCents: 500, currencyCode: 'USD', reason: null, source: 'signup', sourceRef: null,
  createdAt: '2026-10-01T10:00:00Z', expiresAt: null, giftCardGid: null, idempotencyKey: null, ...over,
});

t.section('Tile Credit: one line');
await t.check('each source is its kind; earned credit adds, a redemption, an expiry and a deduction take away', () => {
  const read = (over) => tileCreditEntry(ledgerLine(over), 'USD');
  assert.deepEqual([read({ source: 'signup' }).kind, read({ source: 'signup' }).isCredit], ['signupBonus', true]);
  assert.equal(read({ source: 'live-join' }).kind, 'liveShowReward');
  assert.equal(read({ source: 'order-fulfilled' }).kind, 'orderReward');
  assert.deepEqual([read({ type: 'adjust', source: 'manual-grant' }).kind, read({ type: 'adjust', source: 'manual-grant' }).isCredit], ['addedByStore', true]);
  // Old Amore showed a manual deduction (`adjust`) as "+".
  assert.deepEqual([read({ type: 'adjust', source: 'manual-deduct' }).kind, read({ type: 'adjust', source: 'manual-deduct' }).isCredit], ['removedByStore', false]);
  assert.deepEqual([read({ type: 'redeem', source: 'redemption' }).kind, read({ type: 'redeem', source: 'redemption' }).isCredit], ['spent', false]);
  assert.deepEqual([read({ type: 'expire', source: 'expiry-sweep' }).kind, read({ type: 'expire', source: 'expiry-sweep' }).isCredit], ['expired', false]);
});
await t.check('a source it does not know reads by its type, and a negative amount always takes away', () => {
  const read = (over) => tileCreditEntry(ledgerLine(over), 'USD');
  assert.deepEqual([read({ source: 'something-new', type: 'earn' }).kind, read({ source: 'something-new', type: 'earn' }).isCredit], ['added', true]);
  assert.equal(read({ source: 'something-new', type: 'redeem' }).kind, 'spent');
  assert.equal(read({ source: 'something-new', type: 'expire' }).kind, 'expired');
  const negative = read({ source: 'something-new', type: 'adjust', amountCents: -250 });
  assert.deepEqual([negative.kind, negative.isCredit, negative.amount], ['removed', false, { amount: '2.50', currencyCode: 'USD' }]);
});
await t.check('the amount is never negative, in the line’s currency or else the shop’s', () => {
  assert.deepEqual(tileCreditEntry(ledgerLine({ type: 'redeem', source: 'redemption', amountCents: -1250 }), 'USD').amount, { amount: '12.50', currencyCode: 'USD' });
  assert.deepEqual(tileCreditEntry(ledgerLine({ amountCents: 1050, currencyCode: '' }), 'CAD').amount, { amount: '10.50', currencyCode: 'CAD' });
});
await t.check('the store’s own words show only for a change made by hand, and only when they read as a sentence', () => {
  const note = (over) => tileCreditEntry(ledgerLine({ type: 'adjust', source: 'manual-grant', ...over }), 'USD').note;
  assert.equal(note({ reason: '  Sorry for the late delivery ' }), 'Sorry for the late delivery');
  assert.equal(note({ reason: 'dispenser-4f3a9c02-1b2c-4d5e-8f90-123456789abc' }), null);
  assert.equal(note({ reason: 'gid://shopify/Order/6543210' }), null);
  assert.equal(note({ reason: '6543210' }), null);
  assert.equal(note({ reason: 'Goodwill' }), null);
  assert.equal(note({ reason: 'A reason far too long to sit on one line of a statement' }), null);
  // The service's own sources never show their reason: it is a reference, or the app's wording.
  assert.equal(tileCreditEntry(ledgerLine({ type: 'redeem', source: 'redemption', reason: 'Wallet redemption' }), 'USD').note, null);
});
await t.check('an order’s name is picked out of the reference or the reason; an id is not a name', () => {
  assert.equal(tileCreditEntry(ledgerLine({ source: 'order-fulfilled', sourceRef: 'order #1043' }), 'USD').orderName, '#1043');
  assert.equal(tileCreditEntry(ledgerLine({ type: 'adjust', source: 'manual-grant', reason: 'Refund for #1050' }), 'USD').orderName, '#1050');
  const both = tileCreditEntry(ledgerLine({ type: 'adjust', source: 'manual-grant', reason: 'Refund for #1050' }), 'USD');
  assert.equal(both.note, null, 'the name shows once, as the order, not again in the words');
  assert.equal(tileCreditEntry(ledgerLine({ source: 'order-fulfilled', sourceRef: 'gid://shopify/Order/6543210' }), 'USD').orderName, null);
});
await t.check('only credit has an expiry date', () => {
  assert.equal(tileCreditEntry(ledgerLine({ expiresAt: '2026-12-31T00:00:00Z' }), 'USD').expiresAt, '2026-12-31T00:00:00Z');
  assert.equal(tileCreditEntry(ledgerLine({ type: 'redeem', source: 'redemption', expiresAt: '2026-12-31T00:00:00Z' }), 'USD').expiresAt, null);
});

t.section('Tile Credit: pages');
await t.check('reads the ledger by its own cursor, the page size as its limit', async () => {
  const asked = [];
  const client = {
    async getLedger(opts) {
      asked.push(opts);
      return opts.before
        ? { entries: [ledgerLine({ id: 'old' })], nextCursor: null }
        : { entries: [ledgerLine({ id: 'new' })], nextCursor: 'c-1' };
    },
  };
  const history = tileCreditHistory(client, 'USD');
  const first = await history.page(25, null);
  const second = await history.page(25, first.nextCursor);
  assert.deepEqual(asked, [{ limit: 25, before: undefined }, { limit: 25, before: 'c-1' }]);
  assert.deepEqual([first.entries.map((e) => e.id), first.nextCursor], [['new'], 'c-1']);
  assert.deepEqual([second.entries.map((e) => e.id), second.nextCursor], [['old'], null]);
});

t.section('Shopify store credit: lines and pages');
const tx = (cursor, typename, amount, createdAt, extra = {}) => ({
  cursor,
  node: { __typename: typename, amount: { amount, currencyCode: 'USD' }, createdAt, event: null, ...extra },
});
const account = (id, cursor, edges, more = null) => ({
  cursor,
  node: { id, transactions: { pageInfo: { hasNextPage: !!more, endCursor: more }, edges } },
});

await t.check('each transaction type reads one way; its event says why', async () => {
  const request = async () => ({ customer: { storeCreditAccounts: { edges: [account('A', 'acc-a', [
    tx('t1', 'StoreCreditAccountCreditTransaction', '10.0', '2026-10-06T00:00:00Z', { event: 'ADJUSTMENT', expiresAt: '2027-01-01T00:00:00Z' }),
    tx('t2', 'StoreCreditAccountCreditTransaction', '5.0', '2026-10-05T00:00:00Z', { event: 'ORDER_REFUND' }),
    tx('t3', 'StoreCreditAccountDebitTransaction', '-7.5', '2026-10-04T00:00:00Z', { event: 'ORDER_PAYMENT' }),
    tx('t4', 'StoreCreditAccountDebitTransaction', '-1.0', '2026-10-03T00:00:00Z', { event: 'ADJUSTMENT' }),
    tx('t5', 'StoreCreditAccountDebitRevertTransaction', '7.5', '2026-10-02T00:00:00Z', { event: 'PAYMENT_FAILURE' }),
    tx('t6', 'StoreCreditAccountExpirationTransaction', '-2.0', '2026-10-01T00:00:00Z'),
  ])] } } });
  const { entries, nextCursor } = await shopifyStoreCreditHistory(request, 'USD').page(25, null);
  assert.deepEqual(entries.map((e) => [e.kind, e.isCredit, e.amount.amount]), [
    ['addedByStore', true, '10.00'],
    ['refunded', true, '5.00'],
    ['spent', false, '7.50'],
    ['removedByStore', false, '1.00'],
    ['refunded', true, '7.50'],
    ['expired', false, '2.00'],
  ]);
  assert.equal(entries[0].expiresAt, '2027-01-01T00:00:00Z');
  assert.equal(entries[0].id, 'A:t1');
  assert.deepEqual([entries[0].note, entries[0].orderName], [null, null]);
  assert.equal(nextCursor, null);
});

await t.check('one account: its next page continues from its last transaction', async () => {
  const calls = [];
  const request = async (query, variables) => {
    calls.push({ query, variables });
    if (query === STORE_CREDIT_HISTORY_QUERY) {
      return { customer: { storeCreditAccounts: { edges: [account('A', 'acc-a', [tx('t1', 'StoreCreditAccountCreditTransaction', '1.0', '2026-10-02T00:00:00Z')], 'end-a1')] } } };
    }
    return { customer: { account0: { edges: [account('A', 'acc-a', [tx('t2', 'StoreCreditAccountCreditTransaction', '1.0', '2026-10-01T00:00:00Z')])] } } };
  };
  const history = shopifyStoreCreditHistory(request, 'USD');
  const first = await history.page(25, null);
  assert.deepEqual(calls[0].variables, { first: 25 });
  const second = await history.page(25, first.nextCursor);
  assert.equal(calls[1].query, storeCreditHistoryNextQuery(1));
  assert.deepEqual(calls[1].variables, { first: 25, account0: null, after0: 'end-a1' });
  assert.deepEqual(second.entries.map((e) => e.id), ['A:t2']);
  assert.equal(second.nextCursor, null);
});

await t.check('several accounts (currencies): each that has more is read again at its own place, the pages merged newest first', async () => {
  const calls = [];
  const request = async (query, variables) => {
    calls.push(variables);
    if (query === STORE_CREDIT_HISTORY_QUERY) {
      return { customer: { storeCreditAccounts: { edges: [
        account('USD-acct', 'acc-1', [tx('u1', 'StoreCreditAccountCreditTransaction', '1.0', '2026-10-03T00:00:00Z')], 'end-u'),
        account('CAD-acct', 'acc-2', [tx('c1', 'StoreCreditAccountCreditTransaction', '2.0', '2026-10-04T00:00:00Z')]),
        account('EUR-acct', 'acc-3', [tx('e1', 'StoreCreditAccountCreditTransaction', '3.0', '2026-10-01T00:00:00Z')], 'end-e'),
      ] } } };
    }
    return { customer: {
      account0: { edges: [account('USD-acct', 'acc-1', [tx('u2', 'StoreCreditAccountCreditTransaction', '1.0', '2026-09-01T00:00:00Z')])] },
      // The list changed: another account now sits after acc-2, so EUR's history stops here.
      account1: { edges: [account('GBP-acct', 'acc-9', [tx('g1', 'StoreCreditAccountCreditTransaction', '9.0', '2026-09-30T00:00:00Z')])] },
    } };
  };
  const history = shopifyStoreCreditHistory(request, 'USD');
  const first = await history.page(10, null);
  assert.deepEqual(first.entries.map((e) => e.id), ['CAD-acct:c1', 'USD-acct:u1', 'EUR-acct:e1']);
  const second = await history.page(10, first.nextCursor);
  // Each account is "the one after the account before it": USD is first (no cursor), EUR after CAD's.
  assert.deepEqual(calls[1], { first: 10, account0: null, after0: 'end-u', account1: 'acc-2', after1: 'end-e' });
  assert.deepEqual(second.entries.map((e) => e.id), ['USD-acct:u2']);
  assert.equal(second.nextCursor, null);
});

await t.check('a cursor it cannot read ends the history instead of throwing', async () => {
  const history = shopifyStoreCreditHistory(async () => { throw new Error('not called'); }, 'USD');
  assert.deepEqual(await history.page(25, 'not json'), { entries: [], nextCursor: null });
});

// ── The hook, in the real provider ───────────────────────────────────────────

const SHOP_ID = '68843864220';
const money = { amount: '10.00', currencyCode: 'USD' };
const cart = { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '' };

/** Tile Credit's ledger: 3 lines, 2 a page, newest first. */
const LEDGER = [
  ledgerLine({ id: 'g3', createdAt: '2026-10-03T00:00:00Z' }),
  ledgerLine({ id: 'g2', type: 'redeem', source: 'redemption', amountCents: -300, createdAt: '2026-10-02T00:00:00Z' }),
  ledgerLine({ id: 'g1', source: 'live-join', createdAt: '2026-09-20T00:00:00Z' }),
];
const tileCalls = [];
let ledgerFails = false;
let accountCalls = 0;
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://tile-credit.test/')) {
    const { searchParams, pathname } = new URL(url);
    tileCalls.push({ path: pathname, before: searchParams.get('before'), limit: searchParams.get('limit'), auth: init.headers.Authorization, shop: init.headers['x-shopify-shop-domain'] });
    if (pathname === '/public/me/ledger') {
      if (ledgerFails) return response(503, { error: 'down' });
      const start = searchParams.get('before') ? Number(searchParams.get('before')) : 0;
      const limit = Number(searchParams.get('limit'));
      const end = start + limit;
      return response(200, { entries: LEDGER.slice(start, end), nextCursor: end < LEDGER.length ? String(end) : null });
    }
    return response(200, { ok: true, appId: 'a', customer: {}, balanceCents: 4200, lifetimeEarnedCents: 0, lifetimeRedeemedCents: 0, expiringCents: 0 });
  }
  if (url.includes('/account/customer/api/')) {
    accountCalls += 1;
    return response(200, { data: {} });
  }
  // Storefront API.
  const { query } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  if (name === 'CartCreate') return response(200, { data: { cartCreate: { cart, userErrors: [] } } });
  if (name === 'CartGet' || query.includes('cart(id:')) return response(200, { data: { cart } });
  if (name === 'CustomerAccessTokenCreate') {
    return response(200, { data: { customerAccessTokenCreate: { customerAccessToken: { accessToken: 'tok_shopper', expiresAt: '2030-01-01T00:00:00Z' }, customerUserErrors: [] } } });
  }
  if (name === 'CustomerAccessTokenDelete') return response(200, { data: { customerAccessTokenDelete: { deletedAccessToken: 'tok_shopper', userErrors: [] } } });
  if (name === 'Customer') {
    return response(200, { data: { customer: { id: 'gid://shopify/Customer/9', email: 'shopper@example.com', firstName: 'Ada', lastName: 'Shopper', phone: null, defaultAddress: null, acceptsMarketing: false } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;

let api = null;
let history = null;
function Probe() {
  api = useShopify();
  history = useStoreCreditHistory({ pageSize: 2 });
  return null;
}
const root = createRoot(document.getElementById('root'));
const settle = () => runAct(async () => { await new Promise((r) => setTimeout(r, 30)); });
const secure = keychain();
const auth = { method: 'password', secureStorage: secure, random: counterRandom(), customerAccount: { shopId: SHOP_ID, clientId: 'client-1' } };
async function render(storeCredit) {
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'Shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth, storeCredit },
      React.createElement(Probe),
    ));
  });
  await settle();
}

t.section('useStoreCreditHistory');
await render({ source: 'tile', tileCreditBaseUrl: 'https://tile-credit.test' });
await t.check('signed out: empty, not loading, nothing read', () => {
  assert.equal(history.available, false);
  assert.deepEqual(history.entries, []);
  assert.equal(history.loading, false);
  assert.equal(tileCalls.length, 0);
});

await runAct(async () => { await api.customer.login('shopper@example.com', 'secret'); });
await settle();
await t.check('signed in: the newest page from the same service, token and shop as the balance', () => {
  assert.equal(history.available, true);
  assert.equal(history.loading, false);
  assert.deepEqual(history.entries.map((e) => e.id), ['g3', 'g2']);
  assert.equal(history.hasMore, true);
  const ledgerCalls = tileCalls.filter((call) => call.path === '/public/me/ledger');
  assert.equal(ledgerCalls.length, 1, 'read once, though the profile arrives after the session');
  assert.deepEqual(ledgerCalls[0], { path: '/public/me/ledger', before: null, limit: '2', auth: 'Customer tok_shopper', shop: 'shop.myshopify.com' });
  assert.deepEqual(history.entries[1].amount, { amount: '3.00', currencyCode: 'USD' });
  assert.equal(history.entries[1].isCredit, false);
});

await runAct(async () => { history.loadMore(); });
await settle();
await t.check('loadMore: the next page after the ledger’s cursor, appended; then the end', () => {
  assert.deepEqual(history.entries.map((e) => e.id), ['g3', 'g2', 'g1']);
  assert.equal(history.hasMore, false);
  assert.equal(history.loadingMore, false);
  assert.equal(tileCalls.at(-1).before, '2');
});

const before = tileCalls.length;
await runAct(async () => { history.loadMore(); });
await settle();
await t.check('at the end, loadMore reads nothing', () => {
  assert.equal(tileCalls.length, before);
});

ledgerFails = true;
await runAct(async () => { await history.refresh(); });
await settle();
await t.check('a failed refresh keeps the lines on screen and says so', () => {
  assert.deepEqual(history.entries.map((e) => e.id), ['g3', 'g2', 'g1']);
  assert.ok(history.error);
  assert.equal(history.loading, false);
});

ledgerFails = false;
let joined;
await runAct(async () => {
  const one = history.refresh();
  const two = history.refresh();
  joined = one === two;
  await one;
});
await settle();
await t.check('a refresh starts the list over from the newest page; a second one asked meanwhile joins it', () => {
  assert.equal(joined, true);
  assert.deepEqual(history.entries.map((e) => e.id), ['g3', 'g2']);
  assert.equal(history.hasMore, true);
  assert.equal(history.error, null);
});

await runAct(async () => { await api.customer.logout(); });
await settle();
await t.check('signed out again: the lines go', () => {
  assert.equal(history.available, false);
  assert.deepEqual(history.entries, []);
});

await runAct(async () => { await api.customer.login('shopper@example.com', 'secret'); });
await settle();
await render({ source: 'shopify' });
await t.check('Shopify store credit needs a Shopify sign-in: a password session reads nothing', () => {
  assert.equal(history.source, 'shopify');
  assert.equal(history.available, false);
  assert.deepEqual(history.entries, []);
  assert.equal(history.loading, false);
  assert.equal(accountCalls, 0);
});

await render(undefined);
await t.check('no store credit chosen: nothing', () => {
  assert.equal(history.source, null);
  assert.equal(history.available, false);
});

await runAct(async () => { root.unmount(); });
t.done();
