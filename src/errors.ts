// Turning Shopify's rejections into something a screen can act on.
//
// `assertNoUserErrors` flattens a mutation's `userErrors` into one
// `ShopifyError` whose message is prose — fine for logs, useless for choosing
// between "Out of stock" and "Something went wrong". The codes survive on
// `ShopifyError.errors[]`, so classification reads them back out.
import { ShopifyError } from './types';
import type { AuthFailureReason, UserError } from './types';

/** Shopify rejected the CONTENTS of a mutation, as opposed to failing to answer
 *  it — only `userErrors` populate `errors[]`, so transport and GraphQL
 *  failures arrive empty. */
export function isUserErrorRejection(error: unknown): boolean {
  return error instanceof ShopifyError && error.errors.length > 0;
}

export function userErrorsOf(error: unknown): UserError[] {
  return error instanceof ShopifyError ? error.errors : [];
}

function hasCode(errors: UserError[], ...codes: string[]): boolean {
  return errors.some((e) => !!e.code && codes.includes(e.code));
}

function messageMatches(errors: UserError[], pattern: RegExp): boolean {
  return errors.some((e) => pattern.test(e.message || ''));
}

/**
 * True when a cart write failed because the merchandise cannot be sold right
 * now. Shopify's own codes are checked first; the message sniff is the fallback
 * for the storefront responses that carry no code.
 */
export function isOutOfStockError(error: unknown): boolean {
  const errors = userErrorsOf(error);
  if (errors.length === 0) return false;
  return (
    hasCode(
      errors,
      'MERCHANDISE_OUT_OF_STOCK',
      'MERCHANDISE_NOT_ENOUGH_STOCK',
      'PRODUCT_NOT_AVAILABLE',
    ) || messageMatches(errors, /out of stock|not enough (units|stock)|sold out|unavailable/i)
  );
}

/**
 * Which auth alert a failed customer mutation deserves. `invalid-credentials`
 * is Shopify's `UNIDENTIFIED_CUSTOMER`; everything else stays `unknown` so the
 * caller can decide between generic copy and the raw error.
 */
export function classifyAuthFailure(error: unknown): AuthFailureReason {
  const errors = userErrorsOf(error);
  if (errors.length === 0) return 'unknown';
  if (hasCode(errors, 'UNIDENTIFIED_CUSTOMER')) return 'invalid-credentials';
  if (hasCode(errors, 'TAKEN')) return 'email-taken';
  if (hasCode(errors, 'TOO_SHORT', 'TOO_LONG', 'INVALID', 'BLANK')) return 'invalid-input';
  if (hasCode(errors, 'CUSTOMER_DISABLED')) return 'account-disabled';
  if (messageMatches(errors, /unidentified|incorrect email or password/i)) return 'invalid-credentials';
  if (messageMatches(errors, /already been taken|has an account/i)) return 'email-taken';
  return 'unknown';
}
