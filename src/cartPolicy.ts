// "Cart Line Item Maximum Limit" from the Settings panel.
//
// Ported from v1's checkoutAction, which counted DISTINCT lines rather than
// units: adding quantity 30 of one variant is one line and stays under a limit
// of 25, while adding a 26th different variant does not. The projected count
// only grows for inputs that would open a NEW line — an add that merges into an
// existing one is free.
import type { Cart, CartLineInput, CartPolicy } from './types';

interface PolicyState {
  policy: CartPolicy;
}

const state: PolicyState = { policy: {} };

export function setCartPolicy(policy?: CartPolicy | null): void {
  state.policy = policy ? { ...policy } : {};
}

export function getCartPolicy(): CartPolicy {
  return { ...state.policy };
}

/** Normalised limit, or `null` for "no limit" — including a garbage config
 *  value, which must not silently block every add. */
export function maxLineItems(): number | null {
  const max = state.policy.maxLineItems;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return null;
  return Math.floor(max);
}

/**
 * The line an input would land on, if the cart already holds one.
 *
 * Shopify merges an add into an existing line only when the merchandise AND the
 * line attributes match, so a per-add attribute opens a new line. Selling plans
 * split lines too, but `CartLine` carries no `sellingPlanAllocation` today, so a
 * subscription add can look like a merge into the one-off line — which counts
 * one line low and makes the limit slightly lenient rather than falsely
 * blocking a shopper.
 */
function mergesInto(cart: Cart, input: CartLineInput): boolean {
  const attrs = input.attributes ?? [];
  return cart.lines.some((line) => {
    if (line.merchandise?.id !== input.merchandiseId) return false;
    if (attrs.length !== line.attributes.length) return false;
    return attrs.every((a) => line.attributes.some((b) => b.key === a.key && b.value === a.value));
  });
}

/** How many distinct lines the cart would hold once `inputs` are added. */
export function projectedLineCount(cart: Cart | null, inputs: CartLineInput[]): number {
  let count = cart?.lines.length ?? 0;
  // Two inputs for the same new variant open one line between them, so track
  // what this batch has already accounted for.
  const opened = new Set<string>();
  for (const input of inputs) {
    if (cart && mergesInto(cart, input)) continue;
    const key = `${input.merchandiseId}|${JSON.stringify(input.attributes ?? [])}`;
    if (opened.has(key)) continue;
    opened.add(key);
    count += 1;
  }
  return count;
}

/**
 * True when adding `inputs` would push the cart past `maxLineItems`. Checked
 * before the mutation so a refusal costs no round trip — and so the shopper
 * sees the configured message instead of a Shopify error.
 */
export function wouldExceedLineLimit(cart: Cart | null, inputs: CartLineInput[]): boolean {
  const max = maxLineItems();
  if (max === null) return false;
  return projectedLineCount(cart, inputs) > max;
}
