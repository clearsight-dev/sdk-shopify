/**
 * Metafields the app asks for (nothing is read unless configured).
 *
 * Configure once at startup and every read of that object carries them:
 *
 *   setConfig({ ...credentials, productMetafields: [{ namespace: 'custom', key: 'badge_text' }] })
 *   product.metafields['custom.badge_text']   // → 'Going Fast'
 *
 * - `productMetafields`: every product read; `variantMetafields` (0.23.0): every product read's variants;
 * - `cartMetafields` (0.23.0): every cart read, as `cart.metafields`;
 * - `customerMetafields` (0.23.0): every profile read, as `customer.metafields`;
 * - one product page's own names (0.23.0): `useProduct` / `useProductPage(handle, { metafields,
 *   variantMetafields })`, read on that page's read only, on top of the configured ones.
 *
 * The SDK names no metafield of its own: which ones a store keeps where is the app's to say (or the SDK
 * that owns the feature, such as live selling's auction metafields, which the app passes in).
 *
 * The identifiers are inlined into the fragment rather than passed as a GraphQL variable, because a
 * variable has to be declared by every operation that spreads the fragment — miss one and it fails at
 * runtime. Inlining also means an unconfigured SDK sends the exact query it always sent.
 *
 * Storefront only returns a metafield whose definition grants storefront read access. An undefined
 * or private one comes back null and is simply absent from the record.
 */

import type { MetafieldIdentifier, ProductReadMetafields } from './types';

/** `$` is allowed for Shopify's reserved app-owned namespaces (`$app:foo`). */
const SAFE_IDENT = /^[A-Za-z0-9_.:$-]+$/;

/** Shopify caps a single `metafields(identifiers:)` selection at 250. */
const MAX_IDENTIFIERS = 250;

function assertSafe(part: string, what: string): void {
  if (!part || !SAFE_IDENT.test(part)) {
    throw new Error(`sdk-shopify: invalid metafield ${what} ${JSON.stringify(part)}`);
  }
}

function checkedList(list: readonly MetafieldIdentifier[] | undefined | null, what: string): MetafieldIdentifier[] {
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
    throw new Error(`sdk-shopify: at most ${MAX_IDENTIFIERS} ${what} metafields, got ${next.length}`);
  }
  return next;
}

/** `namespace.key` for each, the way `metafields` records are keyed. */
export const metafieldIds = (list: readonly MetafieldIdentifier[]): string[] => list.map((i) => `${i.namespace}.${i.key}`);

let identifiers: MetafieldIdentifier[] = [];
let variantIdentifiers: MetafieldIdentifier[] = [];
let cartIdentifiers: MetafieldIdentifier[] = [];
let customerIdentifiers: MetafieldIdentifier[] = [];
let signature = '';
const updateSignature = () => {
  // Unchanged for an app that configures only product metafields, so its built queries stay the same.
  const parts = [metafieldIds(identifiers).join('|')];
  if (variantIdentifiers.length) parts.push(`v:${metafieldIds(variantIdentifiers).join('|')}`);
  if (cartIdentifiers.length) parts.push(`c:${metafieldIds(cartIdentifiers).join('|')}`);
  if (customerIdentifiers.length) parts.push(`u:${metafieldIds(customerIdentifiers).join('|')}`);
  signature = parts.join('#');
};

export function setProductMetafields(list: MetafieldIdentifier[] | undefined | null): void {
  identifiers = checkedList(list, 'product');
  updateSignature();
}

/** Variant metafields (0.23.0): as `productMetafields`, read on every product read's variants. */
export function setVariantMetafields(list: MetafieldIdentifier[] | undefined | null): void {
  variantIdentifiers = checkedList(list, 'variant');
  updateSignature();
}

/** Cart metafields (0.23.0): read on every cart read, as `cart.metafields`. */
export function setCartMetafields(list: MetafieldIdentifier[] | undefined | null): void {
  cartIdentifiers = checkedList(list, 'cart');
  updateSignature();
}

/** Customer metafields (0.23.0): read on every profile read, as `customer.metafields`. */
export function setCustomerMetafields(list: MetafieldIdentifier[] | undefined | null): void {
  customerIdentifiers = checkedList(list, 'customer');
  updateSignature();
}

export function getProductMetafields(): MetafieldIdentifier[] {
  return identifiers;
}

export function getVariantMetafields(): MetafieldIdentifier[] {
  return variantIdentifiers;
}

export function getCartMetafields(): MetafieldIdentifier[] {
  return cartIdentifiers;
}

export function getCustomerMetafields(): MetafieldIdentifier[] {
  return customerIdentifiers;
}

/** Cache key for built query strings — changes only when the configured set changes. */
export function productMetafieldsSignature(): string {
  return signature;
}

/** A product page's own names (0.23.0), on top of the configured ones. */
export type ExtraMetafields = ProductReadMetafields;

/** The configured list with a read's own names after it, checked and without repeats. */
function withExtra(configured: MetafieldIdentifier[], extra: readonly MetafieldIdentifier[] | undefined, what: string): MetafieldIdentifier[] {
  return extra?.length ? checkedList([...configured, ...extra], what) : configured;
}

/** What a product read with these extras asks for: the product's and the variants' names. */
export function productMetafieldsAskedFor(extra?: ExtraMetafields): { product: MetafieldIdentifier[]; variant: MetafieldIdentifier[] } {
  return { product: withExtra(identifiers, extra?.metafields, 'product'), variant: withExtra(variantIdentifiers, extra?.variantMetafields, 'variant') };
}

/** A read's own names as one key: '' for none. */
export function extraMetafieldsKey(extra?: ExtraMetafields): string {
  const product = checkedList(extra?.metafields, 'product');
  const variant = checkedList(extra?.variantMetafields, 'variant');
  return product.length || variant.length ? `${metafieldIds(product).join('|')}#v:${metafieldIds(variant).join('|')}` : '';
}

function selectionOf(list: MetafieldIdentifier[]): string {
  if (!list.length) return '';
  const ids = list.map((i) => `{namespace:"${i.namespace}",key:"${i.key}"}`).join(',');
  return `metafields(identifiers: [${ids}]) { namespace key value type }`;
}

/** The selection to splice into a product fragment, or '' when nothing is configured or asked for. */
export function metafieldSelection(extra?: ExtraMetafields): string {
  return selectionOf(productMetafieldsAskedFor(extra).product);
}

/** The selection to splice into a product's variants, or '' when nothing is configured or asked for. */
export function variantMetafieldSelection(extra?: ExtraMetafields): string {
  return selectionOf(productMetafieldsAskedFor(extra).variant);
}

/** The selection to splice into the cart fragment, or '' when nothing is configured. */
export function cartMetafieldSelection(): string {
  return selectionOf(cartIdentifiers);
}

/** The selection to splice into a customer's profile, or '' when nothing is configured. */
export function customerMetafieldSelection(): string {
  return selectionOf(customerIdentifiers);
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

