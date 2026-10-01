// The pure attribution functions against the shared fixtures (contract C9), plus the rules the
// fixtures cannot express: no mutation, numeric variant keys, ignored bad quantities.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  ATTRIBUTION_ATTRIBUTE_KEY,
  parseAttribution,
  serializeAttribution,
  recordAdd,
  recordRemove,
  mergeAttribution,
} = await import('../dist/index.js');

const fixtures = JSON.parse(readFileSync(new URL('../src/attribution.fixtures.json', import.meta.url), 'utf8'));

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };

function run(c) {
  let a = parseAttribution(c.start) ?? { v: 1 };
  for (const step of c.steps) {
    if (step.op === 'add') a = recordAdd(a, step.source, step.variantId, step.lineType, step.quantity, step.now);
    else if (step.op === 'remove') a = recordRemove(a, step.variantId, step.lineType, step.quantity);
    else if (step.op === 'merge') a = mergeAttribution(a, parseAttribution(step.with));
    else throw new Error(`unknown op ${step.op}`);
  }
  return a;
}

console.log('fixtures');
for (const c of fixtures.cases) {
  check(c.name, () => {
    const out = run(c);
    assert.deepEqual(out, c.expected);
    assert.equal(serializeAttribution(out), c.serialized);
    assert.deepEqual(parseAttribution(c.serialized), c.expected);
  });
}
for (const c of fixtures.parse) {
  check(`parse: ${c.name}`, () => {
    assert.deepEqual(parseAttribution(c.input === '__undefined__' ? undefined : c.input), c.expected);
  });
}

console.log('rules');
check('the key constant', () => assert.equal(ATTRIBUTION_ATTRIBUTE_KEY, '_apptile_attribution'));

check('no function mutates its input', () => {
  const a = parseAttribution('{"v":1,"live":{"s":{"t":1,"items":{"111":{"n":2}}}},"app":{"111":{"n":1}}}');
  const b = parseAttribution('{"v":1,"live":{"s":{"t":5,"items":{"111":{"n":1}}}}}');
  const frozenA = JSON.stringify(a);
  const frozenB = JSON.stringify(b);
  const added = recordAdd(a, { type: 'live', showId: 's' }, '111', 'n', 1, 9);
  const removed = recordRemove(a, '111', 'n', 3);
  const merged = mergeAttribution(a, b);
  assert.equal(JSON.stringify(a), frozenA);
  assert.equal(JSON.stringify(b), frozenB);
  assert.notEqual(added, a);
  assert.notEqual(removed, a);
  assert.notEqual(merged, a);
  assert.notEqual(added.live.s, a.live.s);
});

check('stored variant keys are always the numeric id, given a GID or a bare id', () => {
  let a = { v: 1 };
  a = recordAdd(a, { type: 'app' }, 'gid://shopify/ProductVariant/45123456789', 'n', 1, 1);
  a = recordAdd(a, { type: 'live', showId: 's' }, 'gid://shopify/ProductVariant/45123456789', 'p', 1, 1);
  a = recordAdd(a, { type: 'replay', showId: 's' }, '45123456789', 'n', 2, 1);
  assert.deepEqual(Object.keys(a.app), ['45123456789']);
  assert.deepEqual(Object.keys(a.live.s.items), ['45123456789']);
  assert.deepEqual(Object.keys(a.replay.s.items), ['45123456789']);
  assert.equal(recordRemove(a, 'gid://shopify/ProductVariant/45123456789', 'n', 1).app, undefined);
});

check('zero, negative and fractional quantities change nothing', () => {
  const a = { v: 1, app: { 111: { n: 1 } } };
  for (const q of [0, -1, 1.5, NaN]) {
    assert.deepEqual(recordAdd(a, { type: 'app' }, '111', 'n', q, 1), a);
    assert.deepEqual(recordRemove(a, '111', 'n', q), a);
  }
});

check('t is epoch seconds, whole', () => {
  const a = recordAdd({ v: 1 }, { type: 'live', showId: 's' }, '1', 'n', 1, 1700000000.9);
  assert.equal(a.live.s.t, 1700000000);
});

check('serialized output is compact', () => {
  assert.equal(serializeAttribution({ v: 1, app: { 1: { n: 1 } } }), '{"v":1,"app":{"1":{"n":1}}}');
});

console.log(`\n${pass} checks passed`);
