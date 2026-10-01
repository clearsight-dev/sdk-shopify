/** Units of one variant from one source. Positive integers only; a count that reaches 0 is deleted. */
export type AttributionCounts = { n?: number; p?: number };
/** One show. `t` = epoch SECONDS of the last add from this show (live or replay group separately). */
export type AttributionShow = { t: number; items: Record<string, AttributionCounts> };
export type Attribution = {
  v: 1;
  live?: Record<string, AttributionShow>;   // key = the show's streamId (live-selling `streamingId`)
  replay?: Record<string, AttributionShow>; // key = the SAME streamId of the show the replay is of (NOT the replay feed id)
  app?: Record<string, AttributionCounts>;  // key = variant id
};
export type AttributionSource =
  | { type: 'live'; showId: string }
  | { type: 'replay'; showId: string }
  | { type: 'app' };
export type AttributionLineType = 'n' | 'p';

export const ATTRIBUTION_ATTRIBUTE_KEY = '_apptile_attribution';

type ShowGroup = 'live' | 'replay';
const LINE_TYPES: AttributionLineType[] = ['n', 'p'];

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
  for (const type of LINE_TYPES) if (isCount(raw[type])) out[type] = raw[type] as number;
  return out.n || out.p ? out : null;
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
function normalize(a: { live?: unknown; replay?: unknown; app?: unknown }): Attribution {
  const out: Attribution = { v: 1 };
  const live = cleanShows(a.live);
  const replay = cleanShows(a.replay);
  const app = cleanItems(a.app);
  if (Object.keys(live).length) out.live = live;
  if (Object.keys(replay).length) out.replay = replay;
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

export function recordAdd(
  a: Attribution,
  source: AttributionSource,
  variantId: string,
  lineType: AttributionLineType,
  quantity: number,
  nowSeconds: number,
): Attribution {
  const next = normalize(a);
  if (!isCount(quantity)) return next;
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

/** Takes `quantity` units off: `app` first, then replay shows oldest first, then live shows oldest first. */
export function recordRemove(
  a: Attribution,
  variantId: string,
  lineType: AttributionLineType,
  quantity: number,
): Attribution {
  const next = normalize(a);
  if (!isCount(quantity)) return next;
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
  for (const [, show] of oldestFirst('replay')) take(show.items);
  for (const [, show] of oldestFirst('live')) take(show.items);
  return normalize(next);
}

function sumItems(
  x: Record<string, AttributionCounts> = {},
  y: Record<string, AttributionCounts> = {},
): Record<string, AttributionCounts> {
  const out: Record<string, AttributionCounts> = {};
  for (const variant of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const counts: AttributionCounts = {};
    for (const type of LINE_TYPES) {
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
    live: mergeShows(x.live, y.live),
    replay: mergeShows(x.replay, y.replay),
    app: sumItems(x.app, y.app),
  });
}
