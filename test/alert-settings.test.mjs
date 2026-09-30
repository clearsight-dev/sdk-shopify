// The Settings panel's alerts and cart limit, read from the Live Layer tree the
// editor publishes: the path table, the "cleared means silent" rule, the limit
// bounds, and the hook that turns them into ShopifyProvider props.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.IS_REACT_ACT_ENVIRONMENT = true;

const A = await import('../dist/alertSettings.js');
const M = await import('../dist/messages.js');
const { useAlertSettings } = await import('../dist/index.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

console.log('alert settings');
ok('every alert the SDK knows has a panel field', () => {
  assert.deepEqual(Object.keys(A.ALERT_SETTING_FIELDS).sort(), Object.keys(M.DEFAULT_MESSAGES).sort());
  assert.deepEqual([...A.ALERT_SETTINGS_PATH], ['settings', 'alerts']);
  assert.deepEqual(A.ALERT_SETTING_FIELDS['cart.outOfStock'], ['checkout', 'outOfStock']);
});
ok('published copy becomes messages', () => {
  const { messages, silenced } = A.readAlertSettings({
    cart: { added: 'Added to bag' },
    checkout: { outOfStock: 'Gone!' },
  });
  assert.deepEqual(messages, { 'cart.added': 'Added to bag', 'cart.outOfStock': 'Gone!' });
  assert.equal(silenced.size, 0);
});
ok('a cleared field silences its alert; an unpublished one keeps the default', () => {
  const { messages, silenced } = A.readAlertSettings({ cart: { added: '', removed: '   ' } });
  assert.deepEqual(messages, {});
  assert.deepEqual([...silenced].sort(), ['cart.added', 'cart.removed']);
  assert.equal(silenced.has('cart.limitExceeded'), false);
});
ok('long copy is cut to the panel limit', () => {
  const { messages } = A.readAlertSettings({ auth: { loginSuccess: 'x'.repeat(500) } });
  assert.equal(messages['auth.loginSuccess'].length, A.MAX_ALERT_LENGTH);
});
ok('junk trees and non-string values read as "nothing published"', () => {
  for (const tree of [undefined, null, 'x', 42, [], { cart: 'x' }, { cart: { added: 7 } }]) {
    const { messages, silenced } = A.readAlertSettings(tree);
    assert.deepEqual(messages, {});
    assert.equal(silenced.size, 0);
  }
});
ok('cart limit: numbers and numeric strings inside 1–100', () => {
  assert.deepEqual(A.readCartPolicy(25), { maxLineItems: 25 });
  assert.deepEqual(A.readCartPolicy('12'), { maxLineItems: 12 });
  assert.deepEqual(A.readCartPolicy(2.6), { maxLineItems: 3 });
});
ok('cart limit: anything else is no limit', () => {
  for (const v of [undefined, null, '', 'abc', 0, -1, 101, NaN, Infinity, {}]) {
    assert.deepEqual(A.readCartPolicy(v), {}, String(v));
  }
});
ok('isAlertSilenced only matches events that carry a cleared key', () => {
  const silenced = new Set(['cart.added']);
  assert.equal(A.isAlertSilenced({ messageKey: 'cart.added' }, silenced), true);
  assert.equal(A.isAlertSilenced({ messageKey: 'cart.removed' }, silenced), false);
  assert.equal(A.isAlertSilenced({}, silenced), false);
});

console.log('useAlertSettings');
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;

let props = null;
function Probe(options) {
  props = useAlertSettings(options);
  return null;
}
const root = createRoot(document.getElementById('root'));
const shown = [];
const render = (options) => runAct(async () => { root.render(React.createElement(Probe, options)); });

await render({
  alerts: { cart: { added: 'Added to bag', removed: '' } },
  maxLineItems: '5',
  show: (m, s) => shown.push(['first', m, s]),
});
ok('returns provider props from the two Live Layer values', () => {
  assert.deepEqual(props.messages, { 'cart.added': 'Added to bag' });
  assert.deepEqual(props.cartPolicy, { maxLineItems: 5 });
});
ok('onEvent shows resolved copy, skips cleared alerts and message-less events', () => {
  props.onEvent({ type: 'cart:add', severity: 'success', messageKey: 'cart.added', message: 'Added to bag' });
  props.onEvent({ type: 'cart:remove', severity: 'success', messageKey: 'cart.removed', message: 'Product removed from the Cart' });
  props.onEvent({ type: 'cart:update', severity: 'info' });
  assert.deepEqual(shown.splice(0), [['first', 'Added to bag', 'success']]);
});
const firstOnEvent = props.onEvent;
await render({
  alerts: { cart: { added: 'Added to bag' } },
  maxLineItems: '5',
  show: (m, s) => shown.push(['second', m, s]),
});
ok('onEvent keeps its identity; a republish and a new show() apply at once', () => {
  assert.equal(props.onEvent, firstOnEvent);
  props.onEvent({ type: 'cart:remove', severity: 'success', messageKey: 'cart.removed', message: 'Removed' });
  assert.deepEqual(shown.splice(0), [['second', 'Removed', 'success']]);
});
await runAct(async () => root.unmount());

console.log(`\n${pass} checks passed`);
