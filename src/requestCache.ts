/**
 * One network call per identical Storefront read.
 *
 * Every read goes through `request()`, and before this each call was its own `fetch`: six places
 * showing the same collection meant six identical requests. Two layers fix that.
 *
 * 1. **In flight.** An identical query already on the wire is joined, not repeated. This applies to
 *    every query, including the cart and customer ones: identical variables (same cart id, same
 *    token) mean an identical answer. Mutations are never joined; each one is a separate write.
 * 2. **Recent answers.** A catalogue read answered in the last little while (`DEFAULT_CACHE_TTL_MS`)
 *    is answered again from memory. Only operations listed there are kept. Anything personal or
 *    stock-sensitive (cart, customer, orders, variant stock) is in-flight sharing only.
 *
 * Responses are kept as the raw JSON text, and every caller parses its own copy, so one caller
 * mutating what it got cannot change what the next caller gets. Nothing here is persisted: this is
 * memory only, and it is cleared whenever `init` sets a new config.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * How long an answer to each operation is reused. Anything absent is shared only while in flight.
 * Catalogue data is the same for every shopper in a market (the market is part of the key), and a
 * price shown a minute old is corrected by the cart, which is always read fresh.
 */
export const DEFAULT_CACHE_TTL_MS: Readonly<Record<string, number>> = {
  ShopInfo: 30 * MINUTE,
  ShopLocalization: 30 * MINUTE,
  Collections: 10 * MINUTE,
  CollectionByHandle: 10 * MINUTE,
  Blogs: 10 * MINUTE,
  BlogByHandle: 10 * MINUTE,
  BlogArticles: 10 * MINUTE,
  BlogArticleByHandle: 10 * MINUTE,
  Recommended: 5 * MINUTE,
  CollectionProducts: MINUTE,
  Products: MINUTE,
  ProductByHandle: MINUTE,
  ProductById: MINUTE,
  WishlistNodes: MINUTE,
  SearchProducts: 30 * SECOND,
};

export interface RequestCacheOptions {
  /** Per-operation reuse time in ms, merged over `DEFAULT_CACHE_TTL_MS`. `0` means in-flight only. */
  ttl?: Partial<Record<string, number>>;
  /** Most answers kept at once; the least recently used go first. Default 50. */
  maxEntries?: number;
}

interface Entry {
  text: string;
  expires: number;
}

const DEFAULT_MAX_ENTRIES = 50;
/** A ceiling on kept text, so a few huge product lists can't hold megabytes on a low-end phone. */
const MAX_CHARS = 2_000_000;

let enabled = true;
let ttl: Record<string, number> = { ...DEFAULT_CACHE_TTL_MS };
let maxEntries = DEFAULT_MAX_ENTRIES;
const inflight = new Map<string, Promise<string>>();
const answers = new Map<string, Entry>();
let chars = 0;
/** Bumped by `clearRequestCache`, so a request that was in flight across a clear isn't kept. */
let generation = 0;

/**
 * Set from `ShopifyConfig.cache`. `false` turns off reuse of recent answers; identical requests in
 * flight are still shared, since that never changes what a caller sees.
 */
export function configureRequestCache(options: false | RequestCacheOptions | undefined): void {
  enabled = options !== false;
  const o = options || {};
  ttl = { ...DEFAULT_CACHE_TTL_MS };
  for (const [name, ms] of Object.entries(o.ttl ?? {})) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) ttl[name] = ms;
  }
  maxEntries = o.maxEntries && o.maxEntries > 0 ? Math.floor(o.maxEntries) : DEFAULT_MAX_ENTRIES;
  clearRequestCache();
}

/** Forget every kept answer. Requests in flight still reach their callers, but aren't kept. */
export function clearRequestCache(): void {
  answers.clear();
  inflight.clear();
  chars = 0;
  generation += 1;
}

/** `query Name`, `mutation Name`, or an anonymous/shorthand query, ignoring leading fragments. */
export function operationOf(query: string): { kind: 'query' | 'mutation'; name: string | null } {
  const m = query.match(/(^|\n)[ \t]*(query|mutation)\b[ \t]*([A-Za-z_][A-Za-z0-9_]*)?/);
  if (!m) return { kind: 'query', name: null };
  return { kind: m[2] as 'query' | 'mutation', name: m[3] ?? null };
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` are one key. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Only a clean answer is worth keeping: parseable, with data and without GraphQL errors. */
function isKeepable(text: string): boolean {
  try {
    const json = JSON.parse(text) as { data?: unknown; errors?: unknown[] };
    return json.data != null && !(json.errors && json.errors.length > 0);
  } catch {
    return false;
  }
}

function keep(key: string, text: string, ms: number): void {
  const old = answers.get(key);
  if (old) {
    chars -= old.text.length;
    answers.delete(key);
  }
  answers.set(key, { text, expires: Date.now() + ms });
  chars += text.length;
  // Map order is insertion order, and a hit re-inserts, so the first key is the least recently used.
  while (answers.size > maxEntries || chars > MAX_CHARS) {
    const oldest = answers.keys().next();
    if (oldest.done) break;
    chars -= answers.get(oldest.value)!.text.length;
    answers.delete(oldest.value);
  }
}

/**
 * The response text for `query` + `variables`: a recent answer, the identical request already in
 * flight, or a new call to `send`. `scope` separates stores and tokens. `fresh` skips recent answers
 * (pull-to-refresh) but still joins a request already on the wire.
 */
export function readThrough(
  scope: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  fresh: boolean,
  send: () => Promise<string>,
): Promise<string> {
  const { kind, name } = operationOf(query);
  if (kind === 'mutation') return send();

  const key = `${scope}\n${query}\n${stable(variables ?? {})}`;
  const ms = enabled && name ? ttl[name] ?? 0 : 0;

  if (ms > 0 && !fresh) {
    const hit = answers.get(key);
    if (hit && hit.expires > Date.now()) {
      answers.delete(key);
      answers.set(key, hit);
      return Promise.resolve(hit.text);
    }
    if (hit) {
      chars -= hit.text.length;
      answers.delete(key);
    }
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const startedIn = generation;
  const call = send().then(
    (text) => {
      if (inflight.get(key) === call) inflight.delete(key);
      if (ms > 0 && startedIn === generation && isKeepable(text)) keep(key, text, ms);
      return text;
    },
    (error: unknown) => {
      if (inflight.get(key) === call) inflight.delete(key);
      throw error;
    },
  );
  inflight.set(key, call);
  return call;
}
