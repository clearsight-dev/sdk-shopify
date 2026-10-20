/**
 * Star ratings on every product (0.20.0), from Shopify's standard review metafields.
 *
 * A review app (Judge.me, Yotpo, Okendo and others) writes two metafields on each product it has
 * reviews for, under Shopify's standard definitions:
 *
 * - `reviews.rating`, a `rating` value: JSON `{ "value": "4.6", "scale_min": "1.0", "scale_max": "5.0" }`
 * - `reviews.rating_count`, an integer: `"12"`
 *
 * Every product read asks for both (the product fragments in `queries.ts`), so a card has its stars
 * with no second request. `product.rating` is null when the product has none, when the store hasn't
 * given those definitions Storefront access (the Storefront API then returns them as null), or when
 * what the app wrote can't be read as a rating. Reading one never throws.
 */
import type { ProductRating } from './types';

/**
 * The selection the product fragment carries. Named `ratingMetafields` because the app's own
 * `productMetafields` are read as `metafields` on the same product, and two `metafields` selections
 * with different identifiers under one name are a GraphQL error.
 */
export const RATING_METAFIELDS_SELECTION =
  'ratingMetafields: metafields(identifiers: [{namespace: "reviews", key: "rating"}, {namespace: "reviews", key: "rating_count"}]) { key value }';

/** A number from a rating's JSON or a metafield's text: `4.6` or `"4.6"`. Null for anything else. */
function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jsonFrom(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The product's rating from its `ratingMetafields` (the Storefront answer: a list with a null where a
 * metafield is missing). Null without a readable `reviews.rating`. The average is kept between 0 and
 * the scale's top; a missing or unreadable count is 0.
 */
export function productRatingFrom(ratingMetafields: unknown): ProductRating | null {
  if (!Array.isArray(ratingMetafields)) return null;
  let ratingText: unknown = null;
  let countText: unknown = null;
  for (const metafield of ratingMetafields) {
    if (!metafield || typeof metafield !== 'object') continue;
    if (metafield.key === 'rating') ratingText = metafield.value;
    else if (metafield.key === 'rating_count') countText = metafield.value;
  }
  if (typeof ratingText !== 'string') return null;

  const rating = jsonFrom(ratingText) as { value?: unknown; scale_max?: unknown } | null;
  if (!rating || typeof rating !== 'object') return null;
  const value = numberFrom(rating.value);
  const scaleMax = numberFrom(rating.scale_max);
  if (value === null || scaleMax === null || scaleMax <= 0) return null;

  const count = numberFrom(countText);
  return {
    value: Math.min(scaleMax, Math.max(0, value)),
    scaleMax,
    count: count === null ? 0 : Math.max(0, Math.floor(count)),
  };
}
