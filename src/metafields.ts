/**
 * Opt-in product metafields.
 *
 * Configure once at startup and every product the SDK returns carries them:
 *
 *   setConfig({ ...credentials, productMetafields: [{ namespace: 'custom', key: 'badge_text' }] })
 *   product.metafields['custom.badge_text']   // → 'Going Fast'
 *
 * The identifiers are inlined into the product fragment rather than passed as a GraphQL variable,
 * because a variable has to be declared by every operation that spreads the fragment — miss one and
 * it fails at runtime. Inlining also means an unconfigured SDK sends the exact query it sends today,
 * so nothing changes for apps that never ask for metafields.
 *
 * Storefront only returns a metafield whose definition grants storefront read access. An undefined
 * or private one comes back null and is simply absent from the record.
 */

import type { MetafieldIdentifier } from './types';

/** `$` is allowed for Shopify's reserved app-owned namespaces (`$app:foo`). */
const SAFE_IDENT = /^[A-Za-z0-9_.:$-]+$/;

/** Shopify caps a single `metafields(identifiers:)` selection at 250. */
const MAX_IDENTIFIERS = 250;

let identifiers: MetafieldIdentifier[] = [];
let signature = '';

function assertSafe(part: string, what: string): void {
  if (!part || !SAFE_IDENT.test(part)) {
    throw new Error(`sdk-shopify: invalid metafield ${what} ${JSON.stringify(part)}`);
  }
}

export function setProductMetafields(list: MetafieldIdentifier[] | undefined | null): void {
  const seen = new Set<string>();
  const next: MetafieldIdentifier[] = [];

  for (const item of list ?? []) {
    assertSafe(item?.namespace, 'namespace');
    assertSafe(item?.key, 'key');
    const id = `${item.namespace}.${item.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    next.push({ namespace: item.namespace, key: item.key });
  }

  if (next.length > MAX_IDENTIFIERS) {
    throw new Error(`sdk-shopify: at most ${MAX_IDENTIFIERS} product metafields, got ${next.length}`);
  }

  identifiers = next;
  signature = next.map(i => `${i.namespace}.${i.key}`).join('|');
}

export function getProductMetafields(): MetafieldIdentifier[] {
  return identifiers;
}

/** Cache key for built query strings — changes only when the configured set changes. */
export function productMetafieldsSignature(): string {
  return signature;
}

/** The selection to splice into a product fragment, or '' when nothing is configured. */
export function metafieldSelection(): string {
  if (!identifiers.length) return '';
  const list = identifiers.map(i => `{namespace:"${i.namespace}",key:"${i.key}"}`).join(',');
  return `metafields(identifiers: [${list}]) { namespace key value type }`;
}

type RawMetafield = { namespace?: string; key?: string; value?: string | null } | null;

export function normalizeMetafields(raw: unknown): Record<string, string> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const node of raw as RawMetafield[]) {
    if (!node?.namespace || !node?.key || node.value == null) continue;
    out[`${node.namespace}.${node.key}`] = node.value;
  }
  return out;
}

/**
 * Read one metafield off a product. `id` is `namespace.key`, e.g. `custom.badge_text`.
 * Returns null for absent, unconfigured, or blank-after-trim — a metafield holding only whitespace
 * is not a value any caller wants to render.
 */
export function productMetafield(
  product: { metafields?: Record<string, string> } | null | undefined,
  id: string,
): string | null {
  const value = product?.metafields?.[id];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Memoize a query builder against the configured identifiers, so the string is rebuilt only when
 * the configuration actually changes rather than on every request.
 */
export function memoizeQuery(build: () => string): () => string {
  let cachedFor: string | null = null;
  let cached = '';
  return () => {
    const current = signature;
    if (cachedFor !== current) {
      cached = build();
      cachedFor = current;
    }
    return cached;
  };
}
