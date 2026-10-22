/**
 * VIP early access (0.23.0), the store-data standard: a product with `custom.allowed_segments` (a JSON list
 * of customer tags) and `custom.early_access_end` is an early-access product until that end. Before
 * `custom.early_access_start` nobody may buy it; from the start, a customer with one of the tags (trimmed,
 * case-insensitive) may; from the end, everyone may. The metafields are read with every product
 * (`STANDARD_PRODUCT_METAFIELDS`).
 */
import type { MetafieldIdentifier } from './types';

export const EARLY_ACCESS_METAFIELDS: readonly MetafieldIdentifier[] = Object.freeze([
  { namespace: 'custom', key: 'early_access_start' },
  { namespace: 'custom', key: 'early_access_end' },
  { namespace: 'custom', key: 'allowed_segments' },
]);

export interface EarlyAccess {
  /** An early-access product until its end (the badge). */
  gated: boolean;
  /** When the product opens to everyone, epoch ms; null when it isn't gated. */
  gatedUntilMs: number | null;
  /** The customer has one of the product's tags. */
  isVip: boolean;
  /** When this customer may buy, epoch ms; null when they may now (or the product isn't gated). */
  unlocksAtMs: number | null;
}

const NOT_GATED: EarlyAccess = Object.freeze({ gated: false, gatedUntilMs: null, isVip: false, unlocksAtMs: null });

/** Null for absent or unreadable, so a missing date never reads as "unlocks at epoch 0". */
function dateMs(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function segments(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()) : [];
  } catch {
    return [];
  }
}

/** The early-access lock for a customer with `customerTags` (none while signed out or unread) at `nowMs`. */
export function earlyAccessOf(
  product: { metafields?: Record<string, string> | null } | null | undefined,
  customerTags: readonly string[] | null | undefined,
  nowMs: number,
): EarlyAccess {
  const metafields = product?.metafields ?? {};
  const endMs = dateMs(metafields['custom.early_access_end']);
  const allowed = segments(metafields['custom.allowed_segments']);
  if (!allowed.length || endMs === null || endMs <= nowMs) return NOT_GATED;
  const startMs = dateMs(metafields['custom.early_access_start']);
  const wanted = new Set(allowed.map((tag) => tag.trim().toLowerCase()));
  const isVip = !!customerTags?.some((tag) => wanted.has(tag.trim().toLowerCase()));
  const open = startMs === null || startMs <= nowMs;
  return { gated: true, gatedUntilMs: endMs, isVip, unlocksAtMs: !isVip ? endMs : open ? null : startMs };
}
