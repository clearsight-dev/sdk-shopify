/**
 * Price filters: the one Shopify facet whose input the app builds itself.
 *
 * Every other facet value arrives with a ready `FilterValue.input` the shopper just picks. A
 * `PRICE_RANGE` facet instead carries one value whose input is the collection's whole range
 * (`{"price":{"min":0,"max":3132.99}}`), and the shopper's own range has to be encoded in that
 * shape to be sent back. These helpers keep that format in one place.
 */
import type { Filter } from './types';

export interface PriceRange {
  min: number;
  max: number;
}

function finite(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * The `{ min, max }` a price input encodes, or null when the input isn't a price filter. Either
 * bound may be missing: Shopify reads an absent `min` as 0 and an absent `max` as no ceiling.
 */
export function parsePriceFilterInput(input: string): { min?: number; max?: number } | null {
  try {
    const parsed = JSON.parse(input) as { price?: { min?: unknown; max?: unknown } };
    if (!parsed || typeof parsed !== 'object' || !parsed.price || typeof parsed.price !== 'object') return null;
    return { min: finite(parsed.price.min), max: finite(parsed.price.max) };
  } catch {
    return null;
  }
}

/** True for a `FilterValue.input` (or a built one) that is a price filter. */
export function isPriceFilterInput(input: string): boolean {
  return parsePriceFilterInput(input) !== null;
}

/** The bounds of a `PRICE_RANGE` facet, from its one value. Null for any other facet. */
export function priceRange(filter: Filter): PriceRange | null {
  if (filter.type !== 'PRICE_RANGE') return null;
  const bounds = filter.values.length ? parsePriceFilterInput(filter.values[0].input) : null;
  if (!bounds || bounds.max === undefined) return null;
  return { min: bounds.min ?? 0, max: bounds.max };
}

/**
 * The input for a range the shopper chose, to pass to `setFilters` with the other inputs. Null
 * when it wouldn't narrow anything: no bounds, or bounds covering the whole `range`. Bounds given
 * the wrong way round are swapped rather than sent as an empty range.
 */
export function priceFilterInput(
  min: number | null | undefined,
  max: number | null | undefined,
  range?: PriceRange | null,
): string | null {
  let lo = finite(min);
  let hi = finite(max);
  if (lo !== undefined && lo < 0) lo = 0;
  if (lo !== undefined && hi !== undefined && lo > hi) [lo, hi] = [hi, lo];
  if (range) {
    if (lo !== undefined && lo <= range.min) lo = undefined;
    if (hi !== undefined && hi >= range.max) hi = undefined;
  }
  if (lo === undefined && hi === undefined) return null;
  const price: { min?: number; max?: number } = {};
  if (lo !== undefined) price.min = lo;
  if (hi !== undefined) price.max = hi;
  return JSON.stringify({ price });
}
