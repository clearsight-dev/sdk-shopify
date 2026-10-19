/**
 * When each hold in the cart ends (0.19.0, ENG-695), for `ShopifyProvider`: it tells the shopper once, at
 * the moment a reservation runs out, on whatever screen they are on, and reads the cart again afterwards
 * so the line Cart Hold's sweep takes goes from every screen, not only the Cart. Until 0.19.0 nothing said
 * a hold had run out, and only an open Cart page read the cart again.
 *
 * A line's hold comes from the provider's `cartExtensions` (`cartLineFacts(...).holdExpiresAt`: Cart
 * Hold's stamp), so this knows nothing of Cart Hold itself. The rules:
 *
 * - **One alert per hold, when it runs out**, never again when the sweep takes the line a minute or two
 *   later. Holds that run out together are one alert.
 * - **Only a hold seen running.** One that had already run out when the watch first saw its line (it ran
 *   out while the app was closed; a cart adopted from another device) is not announced. Its reads still
 *   happen, quietly.
 * - **A line the shopper takes out before then** is not announced: gone from the cart, or its removal
 *   still on its way (`lineLeaving`).
 * - **Another cart** (Cart Assist adopting one, the fresh cart after an order, a replaced cart) starts the
 *   watch over: nothing the old cart held is announced.
 * - **The reads after a hold ends** are the times the extensions ask for (`cartReadTimesAfterHold`), each
 *   read once; the ones still to come stop when the hold's line has gone. Reads that fall due together (the
 *   app coming back from the background) are one read.
 *
 * No React: the provider hands it each cart and stops it when it unmounts. The clock and the timers can be
 * swapped (`now`, `setTimer`, `clearTimer`), so the rules are tested without waiting.
 */
import { cartLineFacts, cartReadTimesAfterHold, type CartExtension } from "../cartPage";
import type { Cart } from "../types";

/** The longest a timer can wait: a longer one fires at once, on phones and in browsers. */
const LONGEST_TIMER_MS = 2_147_483_647;

export interface HoldEndWatchOptions {
  /** The provider's `cartExtensions`, asked on each cart. */
  extensions: () => readonly CartExtension[];
  /** Whether a hold that runs out now is announced (`reservationExpiredAlert.enabled`). */
  announcing: () => boolean;
  /** Raises `cart:reservationExpired`, with the cart as it is. */
  announce: (cart: Cart) => void;
  /** Reads the cart again (the provider's `refresh`). A failed read is dropped: the next one tries again. */
  readCart: () => Promise<unknown>;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface HoldEndWatch {
  /** The cart the provider shows, after every change (null: none). */
  follow(cart: Cart | null): void;
  /**
   * The shopper is taking this line out (a remove, or − to 0): call before the write, and call what it
   * returns once the write is done, landed or not. A hold that runs out meanwhile is not announced.
   */
  lineLeaving(lineId: string): () => void;
  /** Stops the timers (the provider unmounts). The next `follow` starts them again. */
  stop(): void;
}

/** The soonest of these times; null when there are none. */
function soonest(times: Iterable<number>): number | null {
  let first: number | null = null;
  for (const time of times) if (first === null || time < first) first = time;
  return first;
}

export function createHoldEndWatch(options: HoldEndWatchOptions): HoldEndWatch {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let cart: Cart | null = null;
  /** Lines whose hold was running when the watch first saw it, and when it ends: announced then. */
  const holdsToAnnounce = new Map<string, number>();
  /** Each hold end in the cart, and the reads still to come after it. */
  const readsAfterHoldEnd = new Map<number, number[]>();
  /** Lines the shopper is taking out right now. */
  const leavingLines = new Set<string>();
  let announceTimer: unknown = null;
  let readTimer: unknown = null;

  const waitUntil = (time: number) => Math.min(LONGEST_TIMER_MS, Math.max(0, time - now()));

  function stopTimers() {
    if (announceTimer !== null) clearTimer(announceTimer);
    if (readTimer !== null) clearTimer(readTimer);
    announceTimer = null;
    readTimer = null;
  }

  /** One timer for the soonest hold to announce, one for the soonest read. */
  function schedule() {
    stopTimers();
    const nextEnd = soonest(holdsToAnnounce.values());
    if (nextEnd !== null) announceTimer = setTimer(announceEndedHolds, waitUntil(nextEnd));
    const nextRead = soonest([...readsAfterHoldEnd.values()].flat());
    if (nextRead !== null) readTimer = setTimer(readAgain, waitUntil(nextRead));
  }

  function announceEndedHolds() {
    announceTimer = null;
    const time = now();
    let anyToTell = false;
    for (const [lineId, endsAt] of holdsToAnnounce) {
      if (endsAt > time) continue;
      holdsToAnnounce.delete(lineId);
      if (!leavingLines.has(lineId)) anyToTell = true;
    }
    if (anyToTell && cart && options.announcing()) options.announce(cart);
    schedule();
  }

  function readAgain() {
    readTimer = null;
    const time = now();
    let due = false;
    for (const [endsAt, times] of readsAfterHoldEnd) {
      const later = times.filter((at) => at > time);
      if (later.length < times.length) due = true;
      readsAfterHoldEnd.set(endsAt, later);
    }
    schedule();
    if (due) void Promise.resolve().then(options.readCart).catch(() => undefined);
  }

  return {
    follow(next) {
      if ((next?.id ?? null) !== (cart?.id ?? null)) {
        holdsToAnnounce.clear();
        readsAfterHoldEnd.clear();
      }
      cart = next;
      const time = now();
      const extensions = options.extensions();
      /** Each held line in this cart, and when its hold ends. */
      const holdEnds = new Map<string, number>();
      for (const line of next?.lines ?? []) {
        const endsAt = next ? cartLineFacts(line, next, extensions).holdExpiresAt : null;
        if (endsAt !== null && Number.isFinite(endsAt)) holdEnds.set(line.id, endsAt);
      }
      // A line that left the cart, or whose hold changed, isn't announced; a hold seen running is.
      for (const [lineId, endsAt] of holdsToAnnounce) {
        if (holdEnds.get(lineId) !== endsAt) holdsToAnnounce.delete(lineId);
      }
      for (const [lineId, endsAt] of holdEnds) {
        if (endsAt > time && !holdsToAnnounce.has(lineId)) holdsToAnnounce.set(lineId, endsAt);
      }
      // A hold's reads, worked out once when it is first seen; dropped once no line has that hold.
      const endsInCart = new Set(holdEnds.values());
      for (const endsAt of [...readsAfterHoldEnd.keys()]) {
        if (!endsInCart.has(endsAt)) readsAfterHoldEnd.delete(endsAt);
      }
      for (const endsAt of endsInCart) {
        if (next && !readsAfterHoldEnd.has(endsAt)) {
          readsAfterHoldEnd.set(endsAt, cartReadTimesAfterHold(next, endsAt, extensions).filter((at) => at > time));
        }
      }
      schedule();
    },
    lineLeaving(lineId) {
      leavingLines.add(lineId);
      return () => {
        leavingLines.delete(lineId);
      };
    },
    stop: stopTimers,
  };
}
