// Runtime checks against the built dist: message resolution, the cart-line-limit
// projection, and error classification. No network, no React.
import assert from 'node:assert/strict';

const M = await import('../dist/messages.js');
const P = await import('../dist/cartPolicy.js');
const E = await import('../dist/errors.js');
const T = await import('../dist/types.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

console.log('messages');
ok('defaults cover every panel field', () => {
  const keys = Object.keys(M.DEFAULT_MESSAGES);
  assert.equal(keys.length, 13);
  assert.equal(M.message('cart.added'), 'Product added to the Cart');
});
ok('panel override wins', () => {
  M.setMessages({ 'cart.added': 'Added to bag' });
  assert.equal(M.message('cart.added'), 'Added to bag');
});
ok('cleared field falls back to default, not empty', () => {
  M.setMessages({ 'cart.added': '   ' });
  assert.equal(M.message('cart.added'), 'Product added to the Cart');
});
ok('i18n resolver consulted only for unset keys, via its own key', () => {
  const seen = [];
  M.setMessages({ 'cart.removed': 'Gone' });
  M.setMessageResolver((key, fallback) => { seen.push(key); return key === 'toast.added_to_cart' ? 'कार्ट में जोड़ा गया' : fallback; });
  assert.equal(M.message('cart.added'), 'कार्ट में जोड़ा गया');
  assert.equal(M.message('cart.removed'), 'Gone');           // override beats i18n
  assert.deepEqual(seen, ['toast.added_to_cart']);            // not consulted for cart.removed
});
ok('throwing resolver still yields copy', () => {
  M.setMessageResolver(() => { throw new Error('i18n down'); });
  assert.equal(M.message('auth.loginFailed'), 'Incorrect email or password');
});
ok('setMessages swaps rather than merges', () => {
  M.setMessages({ 'cart.added': 'A' });
  M.setMessages({ 'cart.removed': 'B' });
  assert.equal(M.message('cart.added'), 'Product added to the Cart');
  M.patchMessages({ 'cart.added': 'C' });
  assert.equal(M.message('cart.added'), 'C');
  assert.equal(M.message('cart.removed'), 'B');
});
ok('limit copy interpolates the real max, but never an override', () => {
  M.setMessages({});
  M.setMessageResolver(null);
  assert.equal(M.limitExceededMessage(4), 'You can not add more than 4 items on cart');
  M.setMessages({ 'cart.limitExceeded': 'Bag is full' });
  assert.equal(M.limitExceededMessage(4), 'Bag is full');
  M.setMessages({});
});

console.log('cart line limit');
const line = (variant, attributes = []) => ({
  id: `gid://line/${variant}`, quantity: 1, merchandise: { id: variant }, attributes,
  product: null, cost: {},
});
const cartOf = (...lines) => ({ id: 'c1', lines });

ok('no policy means no limit', () => {
  P.setCartPolicy(null);
  assert.equal(P.maxLineItems(), null);
  assert.equal(P.wouldExceedLineLimit(cartOf(line('v1')), [{ merchandiseId: 'v2', quantity: 1 }]), false);
});
ok('garbage limit is treated as unlimited, not as blocking', () => {
  for (const bad of [0, -3, NaN, 'twenty', undefined]) {
    P.setCartPolicy({ maxLineItems: bad });
    assert.equal(P.maxLineItems(), null, String(bad));
  }
});
ok('counts LINES not units — quantity 30 of one variant is one line', () => {
  P.setCartPolicy({ maxLineItems: 2 });
  const cart = cartOf({ ...line('v1'), quantity: 30 });
  assert.equal(P.projectedLineCount(cart, []), 1);
  assert.equal(P.wouldExceedLineLimit(cart, [{ merchandiseId: 'v1', quantity: 30 }]), false);
});
ok('a merging add is free; a new variant is not', () => {
  P.setCartPolicy({ maxLineItems: 2 });
  const cart = cartOf(line('v1'), line('v2'));
  assert.equal(P.wouldExceedLineLimit(cart, [{ merchandiseId: 'v1', quantity: 1 }]), false);
  assert.equal(P.wouldExceedLineLimit(cart, [{ merchandiseId: 'v3', quantity: 1 }]), true);
});
ok('at the limit exactly is allowed', () => {
  P.setCartPolicy({ maxLineItems: 2 });
  assert.equal(P.wouldExceedLineLimit(cartOf(line('v1')), [{ merchandiseId: 'v2', quantity: 1 }]), false);
});
ok('two inputs for the same new variant open one line', () => {
  P.setCartPolicy({ maxLineItems: 2 });
  const cart = cartOf(line('v1'));
  assert.equal(P.projectedLineCount(cart, [
    { merchandiseId: 'v9', quantity: 1 },
    { merchandiseId: 'v9', quantity: 1 },
  ]), 2);
});
ok('an attribute opens a NEW line for the same variant (Shopify does not merge)', () => {
  P.setCartPolicy({ maxLineItems: 1 });
  const cart = cartOf(line('v1'));
  assert.equal(P.wouldExceedLineLimit(cart, [
    { merchandiseId: 'v1', quantity: 1, attributes: [{ key: '_gift', value: 'yes' }] },
  ]), true);
});
ok('empty cart with a limit of 1 accepts one line', () => {
  P.setCartPolicy({ maxLineItems: 1 });
  assert.equal(P.wouldExceedLineLimit(null, [{ merchandiseId: 'v1', quantity: 1 }]), false);
  assert.equal(P.wouldExceedLineLimit(null, [
    { merchandiseId: 'v1', quantity: 1 }, { merchandiseId: 'v2', quantity: 1 },
  ]), true);
});

console.log('error classification');
const err = (...errors) => new T.ShopifyError('cartLinesAdd failed', errors);
ok('out of stock by code', () => {
  assert.equal(E.isOutOfStockError(err({ message: 'nope', code: 'MERCHANDISE_OUT_OF_STOCK' })), true);
  assert.equal(E.isOutOfStockError(err({ message: 'nope', code: 'MERCHANDISE_NOT_ENOUGH_STOCK' })), true);
});
ok('out of stock by message when Shopify sends no code', () => {
  assert.equal(E.isOutOfStockError(err({ message: 'The merchandise is out of stock', code: null })), true);
});
ok('unrelated rejections are not out of stock', () => {
  assert.equal(E.isOutOfStockError(err({ message: 'Discount code invalid', code: 'INVALID' })), false);
});
ok('transport failures classify as neither', () => {
  assert.equal(E.isOutOfStockError(new Error('Network request failed')), false);
  assert.equal(E.classifyAuthFailure(new Error('Network request failed')), 'unknown');
});
ok('login failure reasons', () => {
  assert.equal(E.classifyAuthFailure(err({ message: 'Unidentified customer', code: 'UNIDENTIFIED_CUSTOMER' })), 'invalid-credentials');
  assert.equal(E.classifyAuthFailure(err({ message: 'Email has already been taken', code: 'TAKEN' })), 'email-taken');
  assert.equal(E.classifyAuthFailure(err({ message: 'too short', code: 'TOO_SHORT' })), 'invalid-input');
  assert.equal(E.classifyAuthFailure(err({ message: 'weird', code: 'SOMETHING_ELSE' })), 'unknown');
});

console.log(`\n${pass} checks passed`);
