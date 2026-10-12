// The cart page's rules without React (0.14.0, moved from amore-v2's useCartPage with its tests): the
// line facts other SDKs add through `cartExtensions`, the line order, + and pre-orders, and the summary.
import assert from 'node:assert/strict';
import { harness } from './auth-helpers.mjs';

const {
  amountChargedWhenShipped,
  canIncreaseLine,
  cartAmountsDueNow,
  cartLineFacts,
  cartRefreshDelays,
  hasLapsedHoldIn,
  increaseAddsLine,
  orderCartLines,
  preorderAmounts,
} = await import('../dist/index.js');

const t = harness('cart page: the rules (cartPage.ts)');
const usd = (amount) => ({ amount, currencyCode: 'USD' });

/** A cart line as the SDK reads it; a pre-order one has a plan and its two amounts (or not, read before). */
function line(id, price, quantity = 1, { plan, stock = 10, attributes = [] } = {}) {
  return {
    id,
    quantity,
    merchandise: { id: `gid://shopify/ProductVariant/${id}`, title: 'Navy / S', price: usd(price), availableForSale: true, quantityAvailable: stock },
    product: { id: `gid://shopify/Product/${id}`, title: `Product ${id}`, handle: `product-${id}` },
    attributes,
    sellingPlanId: plan ? 'gid://shopify/SellingPlan/1' : null,
    sellingPlan: plan ? { id: 'gid://shopify/SellingPlan/1', name: 'Pre-authorize', checkoutCharge: usd('0.00'), remainingBalance: plan.remaining === null ? null : usd(plan.remaining) } : null,
  };
}

function cart(lines, subtotal, { checkoutCharge, discounts, giftCards = [] } = {}) {
  return {
    id: 'gid://shopify/Cart/1',
    lines,
    note: null,
    attributes: [],
    discountCodes: [],
    ...(discounts ? { discounts: discounts.map((d) => ({ amount: usd(d.amount), code: d.code ?? null, title: d.title ?? null, onShipping: !!d.onShipping })) } : {}),
    appliedGiftCards: giftCards.map((used, i) => ({ id: `card-${i}`, lastCharacters: 'a1b2', presentmentAmountUsed: usd(used), amountUsed: usd(used), balance: usd('0.0') })),
    // Shopify's own total is never read: whether it counts a gift card isn't known.
    cost: { subtotalAmount: usd(subtotal), totalAmount: usd('999.0'), totalTaxAmount: null, checkoutChargeAmount: checkoutCharge ? usd(checkoutCharge) : null },
  };
}

// Decided 2026-10-08 by the Head of Engineering (amore-v2): a pre-order (Pre-authorize) line is charged 0 at
// checkout, so the summary counts it at 0.
t.section('amountChargedWhenShipped: what pre-order lines leave for later');
await t.check('a cart of pre-order lines only: everything is later', () => {
  assert.equal(amountChargedWhenShipped(cart([line('1', '250.00', 2, { plan: { remaining: '500.00' } })], '500.00')), 500);
});
await t.check('a mixed cart: only the pre-order lines are left for later', () => {
  assert.equal(amountChargedWhenShipped(cart([line('1', '250.00', 2, { plan: { remaining: '500.00' } }), line('2', '20.00')], '520.00')), 500);
});
await t.check('no pre-order line: nothing is left for later', () => {
  assert.equal(amountChargedWhenShipped(cart([line('2', '20.00')], '20.00')), 0);
});
await t.check("a pre-order line read without its amounts falls back on Shopify's charge-now amount", () => {
  assert.equal(amountChargedWhenShipped(cart([line('1', '250.00', 2, { plan: { remaining: null } }), line('2', '20.00')], '520.00', { checkoutCharge: '20.00' })), 500);
});
await t.check("with neither, unknown: keep Shopify's full figures rather than guess", () => {
  assert.equal(amountChargedWhenShipped(cart([line('1', '250.00', 2, { plan: { remaining: null } })], '500.00')), null);
});
await t.check('no cart yet: nothing', () => {
  assert.equal(amountChargedWhenShipped(null), 0);
});

// Decided 2026-10-08 by the Head of Engineering (amore-v2's cart footer, Option A).
t.section('cartAmountsDueNow: the summary');
const money = (m) => (m ? m.amount : null);
await t.check('a free-shipping discount takes nothing off (the store\'s FREESHIP, $9.80 off shipping)', () => {
  const a = cartAmountsDueNow(cart([line('1', '29.0')], '29.0', { discounts: [{ amount: '9.8', title: 'FREESHIP', onShipping: true }] }));
  assert.deepEqual([money(a.subtotalNow), money(a.orderDiscount), money(a.storeCredit), money(a.totalNow)], ['29.0', null, null, '29.00']);
});
await t.check('an order discount comes off, named by its code; an automatic one has no code', () => {
  let a = cartAmountsDueNow(cart([line('1', '58.0')], '58.0', { discounts: [{ amount: '5.8', code: 'SAVE10' }, { amount: '9.8', title: 'FREESHIP', onShipping: true }] }));
  assert.equal(money(a.orderDiscount), '5.80');
  assert.deepEqual(a.orderDiscountCodes, ['SAVE10']);
  assert.equal(money(a.totalNow), '52.20');
  a = cartAmountsDueNow(cart([line('1', '58.0')], '58.0', { discounts: [{ amount: '5.8', title: 'Fall sale' }] }));
  assert.deepEqual(a.orderDiscountCodes, []);
});
await t.check("store credit comes off on its own row, whatever Shopify's total says", () => {
  const a = cartAmountsDueNow(cart([line('1', '49.0')], '49.0', { giftCards: ['20.0'] }));
  assert.deepEqual([money(a.storeCredit), money(a.orderDiscount), money(a.totalNow)], ['20.00', null, '29.00']);
});
await t.check('a discount and store credit both come off; the total never goes below nothing', () => {
  let a = cartAmountsDueNow(cart([line('1', '58.0')], '58.0', { discounts: [{ amount: '5.8', code: 'SAVE10' }], giftCards: ['20.0'] }));
  assert.equal(money(a.totalNow), '32.20');
  a = cartAmountsDueNow(cart([line('1', '10.0')], '10.0', { giftCards: ['10.0', '5.0'] }));
  assert.deepEqual([money(a.storeCredit), money(a.totalNow)], ['15.00', '0.00']);
});
await t.check('a cart read before discounts were asked for (no `discounts`) shows the subtotal alone', () => {
  const a = cartAmountsDueNow(cart([line('1', '29.0')], '29.0'));
  assert.deepEqual([money(a.orderDiscount), money(a.totalNow)], [null, '29.00']);
});
await t.check('pre-order lines come off the subtotal: a cart of only those is $0.00 now', () => {
  const a = cartAmountsDueNow(cart([line('1', '250.00', 2, { plan: { remaining: '500.00' } })], '500.00'));
  assert.deepEqual([money(a.subtotalNow), money(a.totalNow)], ['0.00', '0.00']);
});
await t.check('no cart: every figure null, no codes', () => {
  assert.deepEqual(cartAmountsDueNow(null), { subtotalNow: null, orderDiscount: null, orderDiscountCodes: [], storeCredit: null, totalNow: null });
});

t.section('the lines: order, +, pre-orders');
await t.check("newestFirst is Shopify's order; oldestFirst puts a line just added at the bottom (amore-v2, 2026-10-09)", () => {
  const lines = [line('3', '9.0'), line('2', '20.0'), line('1', '20.0')];
  assert.deepEqual(orderCartLines(lines).map((l) => l.id), ['3', '2', '1']);
  assert.deepEqual(orderCartLines(lines, 'oldestFirst').map((l) => l.id), ['1', '2', '3']);
  assert.deepEqual(lines.map((l) => l.id), ['3', '2', '1'], 'the cart\'s own list is left alone');
});
await t.check('+ stops at the stock; a pre-order always can', () => {
  const two = line('1', '20.0', 2, { stock: 2 });
  assert.equal(canIncreaseLine(two, cart([two], '40.0')), false);
  const one = line('1', '20.0', 1, { stock: 2 });
  assert.equal(canIncreaseLine(one, cart([one], '20.0')), true);
  const preorder = line('2', '20.0', 5, { stock: 0, plan: { remaining: '100.0' } });
  assert.equal(canIncreaseLine(preorder, cart([preorder], '100.0')), true);
});
await t.check("a pre-order line's amounts, now and when it ships; null for any other line", () => {
  assert.deepEqual(preorderAmounts(line('1', '250.00', 2, { plan: { remaining: '500.00' } })), { dueNow: usd('0.00'), dueLater: usd('500.00') });
  assert.equal(preorderAmounts(line('2', '20.0')), null);
});

t.section('cart extensions (what Cart Hold and live selling add)');
const heldUntil = 1_000_000;
const heldLine = line('1', '20.0', 1, { attributes: [{ key: '_hold', value: String(heldUntil) }] });
const prizeLine = line('2', '9.0', 1, { attributes: [{ key: '_prize', value: 'true' }] });
const hold = {
  name: 'hold',
  lineFacts: (l) => ({ holdExpiresAt: Number(l.attributes.find((a) => a.key === '_hold')?.value) || null }),
  increaseAddsLine: (l) => l.attributes.some((a) => a.key === '_hold'),
  refreshDelays: () => [1000, 30000],
  hasLapsedHold: (lines) => lines.some((l) => l.attributes.some((a) => a.key === '_hold' && Number(a.value) < 2_000_000)),
};
const prizes = {
  name: 'prizes',
  lineFacts: (l) => (l.attributes.some((a) => a.key === '_prize') ? { prize: { nowPerUnit: usd('0.00'), costsNothing: true, fullPrice: usd('9.0') }, holdExpiresAt: 5 } : {}),
};
const c = cart([heldLine, prizeLine], '29.0');
await t.check('no extension: no hold, no prize, not a service line', () => {
  assert.deepEqual(cartLineFacts(heldLine, c, []), { holdExpiresAt: null, prize: null, isServiceLine: false });
});
await t.check('each extension adds what it knows; a prize never shows a reservation, whatever an extension says', () => {
  assert.equal(cartLineFacts(heldLine, c, [hold, prizes]).holdExpiresAt, heldUntil);
  const prize = cartLineFacts(prizeLine, c, [hold, prizes]);
  assert.equal(prize.prize.costsNothing, true);
  assert.equal(prize.holdExpiresAt, null);
});
await t.check('a service line (an app\'s own extension) shows no reservation either', () => {
  const service = { name: 'redo', lineFacts: () => ({ isServiceLine: true }) };
  const facts = cartLineFacts(heldLine, c, [hold, service]);
  assert.equal(facts.isServiceLine, true);
  assert.equal(facts.holdExpiresAt, null);
});
await t.check('an extension that throws is left out, with a warning, and never breaks the cart', () => {
  const broken = { name: 'broken', lineFacts: () => { throw new Error('boom'); }, increaseAddsLine: () => { throw new Error('boom'); } };
  assert.equal(cartLineFacts(heldLine, c, [broken, hold]).holdExpiresAt, heldUntil);
  assert.equal(increaseAddsLine(heldLine, [broken]), false);
  assert.ok(t.warnings.some((w) => w.includes('broken failed')));
});
await t.check('+ adds a line where an extension says so, never on a pre-order', () => {
  assert.equal(increaseAddsLine(heldLine, [hold]), true);
  assert.equal(increaseAddsLine(line('3', '20.0'), [hold]), false);
  const heldPreorder = { ...heldLine, sellingPlanId: 'gid://shopify/SellingPlan/1' };
  assert.equal(increaseAddsLine(heldPreorder, [hold]), false);
});
await t.check('re-reads from every extension, soonest first, once each, nothing at or below 0', () => {
  const other = { name: 'other', refreshDelays: () => [30000, -5, 0, Number.NaN, 500] };
  assert.deepEqual(cartRefreshDelays(c, 0, [hold, other]), [500, 1000, 30000]);
  assert.deepEqual(cartRefreshDelays(c, 0, []), []);
});
await t.check('a lapsed reservation, when any extension says so', () => {
  assert.equal(hasLapsedHoldIn([heldLine], [hold]), true);
  assert.equal(hasLapsedHoldIn([heldLine], [prizes]), false);
  assert.equal(hasLapsedHoldIn([heldLine], []), false);
});

t.done();
