/**
 * Dates as a Tile app's blog tiles show them (0.21.1). From the base app's `src/core/utils/dates.ts`, the
 * one its tiles' wiring imported: same words, same rule. The month names are English, as the app's were.
 */

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A date Shopify sent (ISO), or null for none or one that can't be read. */
function readDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "June 14, 2026": a blog article's day, its month in full (as the blog section's cards), in the phone's
 * time zone. Empty for a date that can't be read, so a byline that joins it with the author drops it.
 */
export function longDate(iso: string | null | undefined): string {
  const date = readDate(iso);
  return date ? `${FULL_MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}` : '';
}
