// When the cart's holds end (0.19.0, ENG-695): `createHoldEndWatch`, the provider's watch, on a fake clock
// whose timers run only when the test moves it on. One rule per check: one alert at the moment a hold runs
// out and none at the sweep, none for a hold that ran out while the app was closed, none for a line taken
// out first or a cart swapped, the switch, and the reads after each hold.
import assert from 'node:assert/strict';
import { harness } from './auth-helpers.mjs';

const { createHoldEndWatch } = await import('../dist/react/holdEndWatch.js');

const t = harness('holds that run out: the watch (holdEndWatch.ts)');

const START = 1_800_000_000_000;
const SECOND = 1000;

/**
 * A clock and timers that move only when told: `advance` runs each timer as its time comes, in order;
 * `sleep` moves the clock without running any, as a phone's timers wait while the app is in the background.
 */
function fakeClock() {
  let time = START;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, run });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const until = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].run();
        await new Promise((resolve) => setImmediate(resolve));
      }
      time = until;
      await new Promise((resolve) => setImmediate(resolve));
    },
    sleep(ms) {
      time += ms;
    },
    pending: () => timers.size,
  };
}

/** Cart Hold's rules, as `cartHoldExtension()` has them: a line's stamp, and reads 1, 30 and 60 s after the next hold ends. */
const holdOf = (line) => Number(line.attributes.find((a) => a.key === '_hold')?.value) || null;
const READ_SECONDS = [1, 30, 60];
const cartHoldLike = {
  name: 'cart-hold-like',
  lineFacts: (line) => ({ holdExpiresAt: holdOf(line) }),
  refreshDelays: (cart, now) => {
    const next = cart.lines.map(holdOf).filter((at) => at !== null && at > now).sort((a, b) => a - b)[0];
    return next === undefined ? [] : READ_SECONDS.map((seconds) => next - now + seconds * SECOND).filter((delay) => delay > 0);
  },
};

const line = (id, holdEndsAt) => ({ id, quantity: 1, attributes: holdEndsAt ? [{ key: '_hold', value: String(holdEndsAt) }] : [], merchandise: { id: `variant-${id}` } });
const cart = (lines, id = 'cart-1') => ({ id, lines });

/** A watch on a fake clock, with what it announced and read. */
function watching({ on = true } = {}) {
  const clock = fakeClock();
  const told = [];
  const reads = [];
  const settings = { on };
  const watch = createHoldEndWatch({
    extensions: () => [cartHoldLike],
    announcing: () => settings.on,
    announce: (heldCart) => told.push(heldCart),
    readCart: async () => { reads.push(clock.now()); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, told, reads, settings, watch };
}

t.section('one alert, at the moment a hold runs out');
await t.check('nothing before; one alert at the end, with the cart', async () => {
  const { clock, told, watch } = watching();
  const held = cart([line('a', START + 60 * SECOND)]);
  watch.follow(held);
  await clock.advance(60 * SECOND - 1);
  assert.equal(told.length, 0);
  await clock.advance(1);
  assert.equal(told.length, 1);
  assert.equal(told[0], held);
});
await t.check('not again on later reads while the line is still there, nor when the sweep takes it', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  await clock.advance(10 * SECOND);
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  await clock.advance(30 * SECOND);
  watch.follow(cart([]));
  await clock.advance(5 * 60 * SECOND);
  assert.equal(told.length, 1);
});
await t.check('holds that run out together are one alert; a second apart, two', async () => {
  const { clock, told, watch } = watching();
  const end = START + 10 * SECOND;
  watch.follow(cart([line('a', end), line('b', end), line('c', end + SECOND)]));
  await clock.advance(10 * SECOND);
  assert.equal(told.length, 1);
  await clock.advance(SECOND);
  assert.equal(told.length, 2);
});
await t.check('a timer that fires late (the app was in the background at the end) tells once, as it comes back', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  clock.sleep(10 * 60 * SECOND);
  assert.equal(told.length, 0);
  await clock.advance(0);
  assert.equal(told.length, 1);
});
await t.check('a hold past the longest timer is not told early', async () => {
  const { clock, told, watch } = watching();
  const farOff = START + 40 * 24 * 60 * 60 * SECOND;
  watch.follow(cart([line('a', farOff)]));
  await clock.advance(30 * 24 * 60 * 60 * SECOND);
  assert.equal(told.length, 0);
  await clock.advance(10 * 24 * 60 * 60 * SECOND);
  assert.equal(told.length, 1);
});
await t.check('a line with no hold is never told', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', null)]));
  await clock.advance(60 * SECOND);
  assert.equal(told.length, 0);
});
await t.check('a hold given a new end (stamped again) is told at the new end', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  await clock.advance(5 * SECOND);
  watch.follow(cart([line('a', START + 20 * SECOND)]));
  await clock.advance(5 * SECOND);
  assert.equal(told.length, 0);
  await clock.advance(10 * SECOND);
  assert.equal(told.length, 1);
});

t.section('holds that ran out while the app was closed');
await t.check('no alert for a hold that had already run out when the cart was first seen', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START - 20 * SECOND), line('b', START - 3 * 60 * 60 * SECOND)]));
  await clock.advance(5 * 60 * SECOND);
  assert.equal(told.length, 0);
});
await t.check('its reads still to come happen, quietly: 30 and 60 s after it ran out, not the 1 s already past', async () => {
  const { clock, told, reads, watch } = watching();
  watch.follow(cart([line('a', START - 20 * SECOND)]));
  await clock.advance(5 * 60 * SECOND);
  assert.deepEqual(reads, [START + 10 * SECOND, START + 40 * SECOND]);
  assert.equal(told.length, 0);
});
await t.check('a hold that ran out hours ago: no read either', async () => {
  const { clock, reads, watch } = watching();
  watch.follow(cart([line('a', START - 3 * 60 * 60 * SECOND)]));
  await clock.advance(5 * 60 * SECOND);
  assert.deepEqual(reads, []);
});

t.section('lines the shopper took out first');
await t.check('a line removed before its hold ends: no alert', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND), line('b', null)]));
  await clock.advance(5 * SECOND);
  watch.follow(cart([line('b', null)]));
  await clock.advance(60 * SECOND);
  assert.equal(told.length, 0);
});
await t.check('a remove still on its way when the hold ends: no alert, and none after it lands', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  await clock.advance(9 * SECOND);
  const removed = watch.lineLeaving('a');
  await clock.advance(2 * SECOND);
  watch.follow(cart([]));
  removed();
  await clock.advance(60 * SECOND);
  assert.equal(told.length, 0);
});
await t.check('another line ending at the same moment is still told', async () => {
  const { clock, told, watch } = watching();
  const end = START + 10 * SECOND;
  watch.follow(cart([line('a', end), line('b', end)]));
  const removed = watch.lineLeaving('a');
  await clock.advance(10 * SECOND);
  removed();
  assert.equal(told.length, 1);
});

t.section('a cart swapped for another');
await t.check("the old cart's holds are not told; the new cart's running ones are", async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND)], 'phone-cart'));
  await clock.advance(5 * SECOND);
  // Cart Assist adopts the account's cart: one hold already over, one still running.
  watch.follow(cart([line('x', START - 60 * SECOND), line('y', START + 30 * SECOND)], 'account-cart'));
  await clock.advance(10 * SECOND);
  assert.equal(told.length, 0, 'not at the old hold\'s end');
  await clock.advance(20 * SECOND);
  assert.equal(told.length, 1, 'at the new cart\'s running hold');
  assert.equal(told[0].id, 'account-cart');
});
await t.check('no cart (gone): nothing is told', async () => {
  const { clock, told, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  watch.follow(null);
  await clock.advance(60 * SECOND);
  assert.equal(told.length, 0);
});

t.section('the switch (reservationExpiredAlert.enabled)');
await t.check('off: no alert, and the reads still happen', async () => {
  const { clock, told, reads, watch } = watching({ on: false });
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  await clock.advance(2 * 60 * SECOND);
  assert.equal(told.length, 0);
  assert.equal(reads.length, 3);
});
await t.check('read when a hold ends: turned on meanwhile, the next one is told', async () => {
  const { clock, told, settings, watch } = watching({ on: false });
  watch.follow(cart([line('a', START + 10 * SECOND), line('b', START + 20 * SECOND)]));
  await clock.advance(10 * SECOND);
  settings.on = true;
  await clock.advance(10 * SECOND);
  assert.equal(told.length, 1);
});

t.section('the reads after a hold ends');
await t.check("at each time the extension asks for (1, 30 and 60 s after), once each, though every read is a new cart", async () => {
  const { clock, reads, watch } = watching();
  const end = START + 10 * SECOND;
  watch.follow(cart([line('a', end)]));
  await clock.advance(10 * SECOND + 1);
  // Each read hands the watch a new cart with the line still there. Until 0.19.0 the cart page started its
  // timers again from such a cart, from the next hold still running, so only the 1 s read ever happened.
  for (let i = 0; i < 70; i += 1) {
    watch.follow(cart([line('a', end)]));
    await clock.advance(SECOND);
  }
  assert.deepEqual(reads, [end + SECOND, end + 30 * SECOND, end + 60 * SECOND]);
});
await t.check('the reads still to come stop once the line has gone (the sweep was seen)', async () => {
  const { clock, reads, watch } = watching();
  const end = START + 10 * SECOND;
  watch.follow(cart([line('a', end)]));
  await clock.advance(11 * SECOND);
  watch.follow(cart([]));
  await clock.advance(5 * 60 * SECOND);
  assert.deepEqual(reads, [end + SECOND]);
});
await t.check('reads due together (the app back from the background) are one read', async () => {
  const { clock, reads, watch } = watching();
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  clock.sleep(10 * 60 * SECOND);
  await clock.advance(0);
  assert.deepEqual(reads, [START + 10 * 60 * SECOND]);
});
await t.check('two holds, each with its own reads', async () => {
  const { clock, reads, watch } = watching();
  const first = START + 10 * SECOND;
  const second = START + 100 * SECOND;
  watch.follow(cart([line('a', first), line('b', second)]));
  await clock.advance(5 * 60 * SECOND);
  assert.deepEqual(reads, [first + SECOND, first + 30 * SECOND, first + 60 * SECOND, second + SECOND, second + 30 * SECOND, second + 60 * SECOND]);
});
await t.check('a read that fails is dropped; the next one still runs', async () => {
  const clock = fakeClock();
  const reads = [];
  const watch = createHoldEndWatch({
    extensions: () => [cartHoldLike],
    announcing: () => true,
    announce: () => undefined,
    readCart: async () => { reads.push(clock.now()); throw new Error('offline'); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  watch.follow(cart([line('a', START + 10 * SECOND)]));
  await clock.advance(2 * 60 * SECOND);
  assert.equal(reads.length, 3);
});

t.section('stopping');
await t.check('stop() leaves no timer; the next cart starts them again', async () => {
  const { clock, told, watch } = watching();
  const held = cart([line('a', START + 10 * SECOND)]);
  watch.follow(held);
  watch.stop();
  assert.equal(clock.pending(), 0);
  await clock.advance(5 * SECOND);
  watch.follow(held);
  await clock.advance(5 * SECOND);
  assert.equal(told.length, 1);
});

t.done();
