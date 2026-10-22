// VIP early access (0.23.0): the store-data standard's custom.early_access_start / _end / allowed_segments,
// read with every product. Before the start nobody buys; from it, a customer with one of the tags; from
// the end, everyone.
import assert from 'node:assert/strict';

const { earlyAccessOf, EARLY_ACCESS_METAFIELDS, STANDARD_PRODUCT_METAFIELDS, getProductMetafields } = await import('../dist/index.js');

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };
console.log('early access');

const HOUR = 3_600_000;
const now = Date.parse('2026-10-22T12:00:00Z');
const at = (ms) => new Date(ms).toISOString();
const gated = (startMs, endMs, segments = '["Platinum VIP"]') => ({
  metafields: {
    ...(startMs === undefined ? {} : { 'custom.early_access_start': at(startMs) }),
    'custom.early_access_end': at(endMs),
    'custom.allowed_segments': segments,
  },
});

check('read with every product, after the auction winners', () => {
  assert.deepEqual(EARLY_ACCESS_METAFIELDS.map((m) => `${m.namespace}.${m.key}`), ['custom.early_access_start', 'custom.early_access_end', 'custom.allowed_segments']);
  assert.deepEqual(STANDARD_PRODUCT_METAFIELDS.map((m) => `${m.namespace}.${m.key}`), ['auction.winners', 'custom.early_access_start', 'custom.early_access_end', 'custom.allowed_segments']);
  assert.deepEqual(getProductMetafields(), [...STANDARD_PRODUCT_METAFIELDS]);
});

check('before the start: nobody buys; a VIP counts to the start, everyone else to the end', () => {
  const product = gated(now + HOUR, now + 2 * HOUR);
  assert.deepEqual(earlyAccessOf(product, [' platinum vip '], now), { gated: true, gatedUntilMs: now + 2 * HOUR, isVip: true, unlocksAtMs: now + HOUR });
  assert.deepEqual(earlyAccessOf(product, ['other'], now), { gated: true, gatedUntilMs: now + 2 * HOUR, isVip: false, unlocksAtMs: now + 2 * HOUR });
  assert.equal(earlyAccessOf(product, null, now).unlocksAtMs, now + 2 * HOUR, 'unread or signed out: as everyone else');
});

check('between the start and the end a VIP buys; no start is open from the first', () => {
  assert.equal(earlyAccessOf(gated(now - HOUR, now + HOUR), ['Platinum VIP'], now).unlocksAtMs, null);
  assert.equal(earlyAccessOf(gated(undefined, now + HOUR), ['Platinum VIP'], now).unlocksAtMs, null);
  assert.equal(earlyAccessOf(gated(undefined, now + HOUR), [], now).unlocksAtMs, now + HOUR);
});

check('from the end, or with no tags listed, no end, or unreadable values: not gated', () => {
  const open = { gated: false, gatedUntilMs: null, isVip: false, unlocksAtMs: null };
  assert.deepEqual(earlyAccessOf(gated(now - 2 * HOUR, now - HOUR), [], now), open);
  assert.deepEqual(earlyAccessOf(gated(now, now + HOUR, '[]'), [], now), open);
  assert.deepEqual(earlyAccessOf(gated(now, now + HOUR, 'not json'), [], now), open);
  assert.deepEqual(earlyAccessOf({ metafields: { 'custom.allowed_segments': '["VIP"]', 'custom.early_access_end': 'soon' } }, [], now), open);
  assert.deepEqual(earlyAccessOf(null, [], now), open);
});

console.log(`\n${pass} checks passed`);
