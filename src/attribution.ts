/**
 * Units of one variant from one source, by line type (`AttributionLineType`). Positive integers only; a
 * count that reaches 0 is deleted.
 */
export type AttributionCounts = { n?: number; p?: number; [lineType: string]: number | undefined };
/** One show (or auction). `t` = epoch SECONDS of the last add from it (each group separately). */
export type AttributionShow = { t: number; items: Record<string, AttributionCounts> };
export type Attribution = {
  v: 1;
  live?: Record<string, AttributionShow>;              // key = a live shopping show's streamId (live-selling `streamingId`)
  replay?: Record<string, AttributionShow>;            // key = the SAME streamId of the show the replay is of (NOT the replay feed id)
  auction?: Record<string, AttributionShow>;           // key = a live auction show's streamId: added or won on it
  'auction-replay'?: Record<string, AttributionShow>;  // key = the streamId of the auction show the replay is of
  'silent-auction'?: Record<string, AttributionShow>;  // key = the silent auction's id: its wins
  app?: Record<string, AttributionCounts>;             // key = variant id
};
/** Where units came from: a show or an auction by its id (see `Attribution`), else the app. */
export type AttributionSource =
  | { type: 'live'; showId: string }
  | { type: 'replay'; showId: string }
  | { type: 'auction'; showId: string }
  | { type: 'auction-replay'; showId: string }
  | { type: 'silent-auction'; showId: string }
  | { type: 'app' };
/**
 * One lowercase letter. The provider writes `n` (normal) and `p` (pre-authorised, `lineTypeOf`); another
 * SDK may count its own lines under a letter of its own, which parse, merge and remove keep.
 */
export type AttributionLineType = 'n' | 'p' | (string & {});

export const ATTRIBUTION_ATTRIBUTE_KEY = '_apptile_attribution';

type ShowGroup = 'live' | 'replay' | 'auction' | 'auction-replay' | 'silent-auction';
/** Every group keyed by a show or an auction, in the order units come off them (`recordRemove`, after `app`). */
const SHOW_GROUPS: ShowGroup[] = ['replay', 'auction-replay', 'silent-auction', 'live', 'auction'];
const isLineType = (x: string): boolean => /^[a-z]$/.test(x);
/** `n`, `p`, then any other line types alphabetically: one order, so the same counts serialize the same. */
const byLineType = (x: string, y: string): number => {
  const rank = (t: string) => (t === 'n' ? 0 : t === 'p' ? 1 : 2);
  return rank(x) - rank(y) || x.localeCompare(y);
};

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0;

/** `gid://shopify/ProductVariant/45123456789` → `"45123456789"`; a bare id passes through. */
function variantKey(variantId: string): string {
  return String(variantId).split('/').pop()!.split('?')[0];
}

function cleanCounts(raw: unknown): AttributionCounts | null {
  if (!isRecord(raw)) return null;
  const out: AttributionCounts = {};
  for (const type of Object.keys(raw).sort(byLineType)) if (isLineType(type) && isCount(raw[type])) out[type] = raw[type] as number;
  return Object.keys(out).length ? out : null;
}

function cleanItems(raw: unknown): Record<string, AttributionCounts> {
  const out: Record<string, AttributionCounts> = {};
  if (!isRecord(raw)) return out;
  for (const [variant, counts] of Object.entries(raw)) {
    const clean = cleanCounts(counts);
    if (clean) out[variant] = clean;
  }
  return out;
}

function cleanShows(raw: unknown): Record<string, AttributionShow> {
  const out: Record<string, AttributionShow> = {};
  if (!isRecord(raw)) return out;
  for (const [showId, show] of Object.entries(raw)) {
    if (!isRecord(show)) continue;
    const items = cleanItems(show.items);
    if (Object.keys(items).length === 0) continue;
    out[showId] = { t: typeof show.t === 'number' && Number.isFinite(show.t) ? show.t : 0, items };
  }
  return out;
}

/** Rebuilds `a` as a fresh object with zeros and empty items, shows and groups dropped. */
function normalize(a: Partial<Record<ShowGroup | 'app', unknown>>): Attribution {
  const out: Attribution = { v: 1 };
  for (const group of ['live', 'replay', 'auction', 'auction-replay', 'silent-auction'] as const) {
    const shows = cleanShows(a[group]);
    if (Object.keys(shows).length) out[group] = shows;
  }
  const app = cleanItems(a.app);
  if (Object.keys(app).length) out.app = app;
  return out;
}

/** Any `_preauthorized` value but `'false'` (blank included) is a pre-auth line. */
export function lineTypeOf(attributes: { key: string; value: string }[] | undefined): AttributionLineType {
  const flag = attributes?.find((attr) => attr.key === '_preauthorized');
  return flag && flag.value !== 'false' ? 'p' : 'n';
}

/** `attributes` with `_apptile_attribution` set to `value`, every other pair kept in order. */
export function withAttributionAttribute(
  attributes: { key: string; value: string }[] | undefined,
  value: Attribution,
): { key: string; value: string }[] {
  return [
    ...(attributes ?? []).filter((attr) => attr.key !== ATTRIBUTION_ATTRIBUTE_KEY),
    { key: ATTRIBUTION_ATTRIBUTE_KEY, value: serializeAttribution(value) },
  ];
}

export function parseAttribution(value: string | null | undefined): Attribution | null {
  if (typeof value !== 'string' || value === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  return normalize(raw);
}

export function serializeAttribution(a: Attribution): string {
  return JSON.stringify(normalize(a));
}

/** The shows a cart holds units from: see `showsInCart`. */
export type ShowsInCart = { live: string[]; replay: string[] };

/**
 * The shows a cart holds units from, read off its `_apptile_attribution` (0.10, SDK move 7): `live`
 * and `replay` are both the shows' streaming ids (a replay is counted under the show it records). An
 * auction show is listed with `live` and its replay with `replay`; a silent auction isn't a show.
 * A show whose units have all left the cart isn't listed. Empty lists for a cart with no show's units
 * or no attribution. For the analytics events `streamCheckout` and `streamPurchase`
 * (`@tiledev/sdk-analytics-core`'s `streamCheckoutParams`).
 *
 * It reads the cart as Shopify last returned it; `useCart().flushAttribution()` lands a value still
 * being written.
 */
export function showsInCart(cart: { attributes?: { key: string; value: string }[] | null } | null | undefined): ShowsInCart {
  const value = cart?.attributes?.find((attr) => attr.key === ATTRIBUTION_ATTRIBUTE_KEY)?.value;
  const attribution = parseAttribution(value);
  const ids = (...groups: ShowGroup[]) => [...new Set(groups.flatMap((group) => Object.keys(attribution?.[group] ?? {})))];
  return { live: ids('live', 'auction'), replay: ids('replay', 'auction-replay') };
}

export function recordAdd(
  a: Attribution,
  source: AttributionSource,
  variantId: string,
  lineType: AttributionLineType,
  quantity: number,
  nowSeconds: number,
): Attribution {
  const next = normalize(a);
  if (!isCount(quantity) || !isLineType(lineType)) return next;
  const variant = variantKey(variantId);
  const bump = (items: Record<string, AttributionCounts>) => {
    const counts = { ...(items[variant] ?? {}) };
    counts[lineType] = (counts[lineType] ?? 0) + quantity;
    items[variant] = counts;
  };
  if (source.type === 'app') {
    next.app = next.app ?? {};
    bump(next.app);
    return next;
  }
  const group: Record<string, AttributionShow> = next[source.type] ?? {};
  const show = group[source.showId] ?? { t: 0, items: {} };
  show.t = Math.floor(nowSeconds);
  bump(show.items);
  group[source.showId] = show;
  next[source.type] = group;
  return next;
}

/**
 * Takes `quantity` units off: `app` first, then each show group's shows oldest first, in `SHOW_GROUPS`'
 * order: replays, auction replays, silent auctions, live shows, auction shows.
 */
export function recordRemove(
  a: Attribution,
  variantId: string,
  lineType: AttributionLineType,
  quantity: number,
): Attribution {
  const next = normalize(a);
  if (!isCount(quantity) || !isLineType(lineType)) return next;
  const variant = variantKey(variantId);
  let left = quantity;
  const take = (items: Record<string, AttributionCounts> | undefined) => {
    const counts = items?.[variant];
    const have = counts?.[lineType] ?? 0;
    if (!counts || have === 0 || left === 0) return;
    const taken = Math.min(have, left);
    counts[lineType] = have - taken;
    left -= taken;
  };
  take(next.app);
  const oldestFirst = (group: ShowGroup) =>
    Object.entries(next[group] ?? {}).sort(([idA, x], [idB, y]) => x.t - y.t || idA.localeCompare(idB));
  for (const group of SHOW_GROUPS) for (const [, show] of oldestFirst(group)) take(show.items);
  return normalize(next);
}

function sumItems(
  x: Record<string, AttributionCounts> = {},
  y: Record<string, AttributionCounts> = {},
): Record<string, AttributionCounts> {
  const out: Record<string, AttributionCounts> = {};
  for (const variant of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const counts: AttributionCounts = {};
    for (const type of [...new Set([...Object.keys(x[variant] ?? {}), ...Object.keys(y[variant] ?? {})])].sort(byLineType)) {
      const total = (x[variant]?.[type] ?? 0) + (y[variant]?.[type] ?? 0);
      if (total > 0) counts[type] = total;
    }
    out[variant] = counts;
  }
  return out;
}

function mergeShows(
  x: Record<string, AttributionShow> = {},
  y: Record<string, AttributionShow> = {},
): Record<string, AttributionShow> {
  const out: Record<string, AttributionShow> = {};
  for (const showId of new Set([...Object.keys(x), ...Object.keys(y)])) {
    out[showId] = {
      t: Math.max(x[showId]?.t ?? 0, y[showId]?.t ?? 0),
      items: sumItems(x[showId]?.items, y[showId]?.items),
    };
  }
  return out;
}

export function mergeAttribution(a: Attribution, b: Attribution): Attribution {
  const x = normalize(a);
  const y = normalize(b);
  return normalize({
    ...Object.fromEntries(SHOW_GROUPS.map((group) => [group, mergeShows(x[group], y[group])])),
    app: sumItems(x.app, y.app),
  });
}
