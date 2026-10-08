/**
 * A link's tracking tags: the `ref` and `utm…` query parameters an influencer's or a campaign's link
 * carries (`?ref=brandi10&utm_source=instagram&utm_campaign=fall_drop`), saved on the phone and put on
 * the cart so the order says where the shopper came from (0.11.0, decided 2026-10-08 by Tile's Head
 * of Engineering).
 *
 * Pure: the provider (`ShopifyProvider`'s `linkTags`) reads and writes storage and the cart with these.
 *
 * - **Which tags:** every query parameter whose name starts with `utm` or `ref`, in any case
 *   (`utm_source`, `UTM_Medium`, `ref`, `ref_code`, `referrer`). Others (`fbclid`, `gclid`, a
 *   product's `variant`) are not tags. A tag with no value is skipped.
 * - **As the link spells them:** each key and value goes on the cart as it was in the link, decoded.
 *   At most `LINK_TAG_MAX_COUNT` tags, each value cut to `LINK_TAG_MAX_LENGTH` characters.
 * - **The last link wins:** a newer link's tags replace every tag the cart had (`withLinkTags`), and
 *   restart the clock. A link with no tags changes nothing.
 * - **Kept `keepDays`, counted from the save** (`liveLinkTags`), with the days as they are when read,
 *   so a changed setting applies to tags already saved.
 */
import type { CartAttribute } from './types';

/** Where the phone keeps the last link's tags. */
export const LINK_TAGS_STORAGE_KEY = 'links.trackingTags.v1';
/** The most tags one link can put on a cart. */
export const LINK_TAG_MAX_COUNT = 20;
/** The longest tag value put on a cart, in characters. */
export const LINK_TAG_MAX_LENGTH = 255;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A link's tags, by name, as the link spelled them. */
export type LinkTags = Record<string, string>;

/** `ShopifyProvider`'s `linkTags`. */
export interface LinkTagOptions {
  /**
   * How many days a link's tags are kept and put on new carts, counted from the link. 0 or less is
   * off: no link is saved and no tags go on a cart.
   */
  keepDays: number;
  /** The link the app was opened with, read once at start (React Native: `Linking.getInitialURL`). */
  getInitialUrl?: () => Promise<string | null>;
  /**
   * Calls back with each link that reaches the running app, and returns what stops it (React Native:
   * `Linking.addEventListener('url', …)`). Pass the same function every render: a new one subscribes
   * again.
   */
  subscribe?: (onLink: (url: string) => void) => () => void;
}

/** The last link's tags and when they were saved (epoch milliseconds). */
export interface SavedLinkTags {
  savedAt: number;
  tags: LinkTags;
}

/** A query parameter or cart attribute that is a link tag: its name starts with `utm` or `ref`. */
export function isLinkTagKey(key: string): boolean {
  return /^(utm|ref)/i.test(key);
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    // A stray `%` in a hand-typed link: keep what was there.
    return part;
  }
}

/**
 * The tags on a link, or null when it has none.
 *
 * Read by hand rather than with `URL`: React Native's `URL` doesn't implement `searchParams` on every
 * version, and a custom scheme (`amorefashion://collections/x?ref=a`) must read the same as https.
 * A name given twice keeps its last value.
 */
export function linkTagsFrom(url: string | null | undefined): LinkTags | null {
  if (typeof url !== 'string') return null;
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return null;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  const tags: LinkTags = {};
  let count = 0;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const key = decode(equals < 0 ? pair : pair.slice(0, equals)).trim();
    const value = decode(equals < 0 ? '' : pair.slice(equals + 1)).trim();
    if (!key || !value || !isLinkTagKey(key)) continue;
    if (!(key in tags)) {
      if (count >= LINK_TAG_MAX_COUNT) continue;
      count += 1;
    }
    tags[key] = value.slice(0, LINK_TAG_MAX_LENGTH);
  }
  return count ? tags : null;
}

/** The saved record, or null when there is none or it doesn't read as one. */
export function readSavedLinkTags(raw: string | null | undefined): SavedLinkTags | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedLinkTags>;
    if (typeof parsed?.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return null;
    const tags = parsed.tags;
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return null;
    const clean: LinkTags = {};
    for (const [key, value] of Object.entries(tags)) {
      if (isLinkTagKey(key) && typeof value === 'string' && value) clean[key] = value;
    }
    return Object.keys(clean).length ? { savedAt: parsed.savedAt, tags: clean } : null;
  } catch {
    return null;
  }
}

/**
 * The saved tags while they are still kept, else null: none saved, `keepDays` 0 or less (off), or
 * more than `keepDays` since the save.
 */
export function liveLinkTags(saved: SavedLinkTags | null, keepDays: number, now: number): LinkTags | null {
  if (!saved || !Number.isFinite(keepDays) || keepDays <= 0) return null;
  return now - saved.savedAt < keepDays * DAY_MS ? saved.tags : null;
}

/** The cart's attributes with its link tags replaced by `tags`: every other attribute kept, in order. */
export function withLinkTags(attributes: CartAttribute[], tags: LinkTags): CartAttribute[] {
  return [
    ...attributes.filter((attribute) => !isLinkTagKey(attribute.key)),
    ...Object.entries(tags).map(([key, value]) => ({ key, value })),
  ];
}

/** True when the cart's link tags are exactly `tags`, so there's nothing to write. */
export function cartHasLinkTags(attributes: CartAttribute[], tags: LinkTags): boolean {
  const onCart = attributes.filter((attribute) => isLinkTagKey(attribute.key));
  const wanted = Object.entries(tags);
  return (
    onCart.length === wanted.length &&
    wanted.every(([key, value]) => onCart.some((attribute) => attribute.key === key && attribute.value === value))
  );
}
