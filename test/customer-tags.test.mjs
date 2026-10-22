// The customer's tags store (0.23.0): unread is not untagged, a failed read keeps what was known, re-reads
// have a floor, and a read for the previous customer never lands on the next.
import assert from 'node:assert/strict';

const { createCustomerTagsStore, hasCustomerTag, CUSTOMER_TAGS_MIN_GAP_MS, customerRestrictionsOf, BID_BLOCKED_TAG, APP_BLOCKED_TAG } = await import('../dist/index.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const clock = { now: 1_000_000 };
  const reads = [];
  let next = () => Promise.resolve([]);
  const store = createCustomerTagsStore({ now: () => clock.now, readTags: () => { const r = next(); reads.push(r); return r; } });
  return { store, clock, reads, answer: (v) => { next = typeof v === 'function' ? v : () => Promise.resolve(v); } };
}

assert.equal(hasCustomerTag(['Platinum VIP'], ' platinum vip'), true);
assert.equal(hasCustomerTag(null, 'vip'), false);

// The store-data standard: BIDBLOCKED stops bidding, APPBLOCKED stops bidding and mutes comments; unread is unknown.
assert.equal(BID_BLOCKED_TAG, 'BIDBLOCKED');
assert.equal(APP_BLOCKED_TAG, 'APPBLOCKED');
assert.deepEqual(customerRestrictionsOf({ tags: ['vip'], known: true }), { bidding: 'allowed', commentsMuted: false });
assert.deepEqual(customerRestrictionsOf({ tags: [' bidblocked '], known: true }), { bidding: 'blocked', commentsMuted: false });
assert.deepEqual(customerRestrictionsOf({ tags: ['AppBlocked'], known: true }), { bidding: 'blocked', commentsMuted: true });
assert.deepEqual(customerRestrictionsOf({ tags: null, known: false }), { bidding: 'unknown', commentsMuted: false });
assert.deepEqual(customerRestrictionsOf({ tags: [], known: true }), { bidding: 'allowed', commentsMuted: false }, 'signed out');

{ // signed out: known, nothing read
  const h = harness();
  assert.deepEqual(h.store.getState(), { customerId: null, tags: [], known: true });
  await h.store.refresh();
  assert.equal(h.reads.length, 0);
}
{ // sign-in reads once; unread is unknown
  const h = harness();
  let release;
  h.answer(() => new Promise((r) => (release = r)));
  h.store.setCustomer('c1');
  assert.deepEqual(h.store.getState(), { customerId: 'c1', tags: null, known: false });
  release(['vip']);
  await tick();
  assert.deepEqual(h.store.getState(), { customerId: 'c1', tags: ['vip'], known: true });
}
{ // a failed first read stays unknown and retries at once; a failed re-read keeps what was known
  const h = harness();
  h.answer(() => Promise.reject(new Error('offline')));
  h.store.setCustomer('c1');
  await tick();
  assert.equal(h.store.getState().known, false);
  h.answer(['vip']);
  await h.store.refresh();
  assert.deepEqual(h.store.getState().tags, ['vip']);
  h.clock.now += CUSTOMER_TAGS_MIN_GAP_MS;
  h.answer(() => Promise.reject(new Error('offline')));
  await h.store.refresh();
  assert.deepEqual(h.store.getState().tags, ['vip']);
}
{ // the floor once known; asks while one is out share it; force skips the floor
  const h = harness();
  h.store.setCustomer('c1');
  await tick();
  await h.store.refresh();
  assert.equal(h.reads.length, 1);
  h.clock.now += CUSTOMER_TAGS_MIN_GAP_MS;
  h.answer(['blocked']);
  await Promise.all([h.store.refresh(), h.store.refresh({ force: true })]);
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.store.getState().tags, ['blocked']);
  await h.store.refresh({ force: true });
  assert.equal(h.reads.length, 3);
}
{ // the account changing hands: the old read never lands
  const h = harness();
  let releaseFirst;
  h.answer(() => new Promise((r) => (releaseFirst = r)));
  h.store.setCustomer('a');
  h.answer(['vip']);
  h.store.setCustomer('b');
  releaseFirst(['blocked']);
  await tick();
  assert.deepEqual(h.store.getState(), { customerId: 'b', tags: ['vip'], known: true });
  h.store.setCustomer(null);
  assert.deepEqual(h.store.getState(), { customerId: null, tags: [], known: true });
}
console.log('customer-tags: ok');
