// The Settings panel's "Alerts & Toasts" and "Cart" fields, read from where the
// editor publishes them: the app's Live Layer tree.
//
// This is the other half of the editor contract in `messages.ts`: those keys
// say WHICH alerts exist, these paths say WHERE the panel writes each one. An app
// reads the two subtrees from its Live Layer and hands them here, so no app keeps
// its own copy of the path table.
//
// One rule differs from `messages.ts` on purpose. There, an empty override falls
// back to the default copy, because a string that is merely missing must never
// render blank. Here the panel is explicit: a field published as `''` means the
// merchant cleared it, so that alert is silenced (no toast at all), while a field
// never published keeps the default.
import type { AlertMessageKey, AlertMessages, CartPolicy } from './types';

/** The Live Layer subtree holding every alert's copy. */
export const ALERT_SETTINGS_PATH = ['settings', 'alerts'] as const;

/** The panel's "Max Different Products in Cart". */
export const MAX_LINE_ITEMS_SETTING_PATH = ['settings', 'cart', 'maxLineItems'] as const;

/**
 * Where each alert's copy lives, as `[group, field]` under `ALERT_SETTINGS_PATH`.
 * `cart.outOfStock` sits in the Checkout group: that is where the panel shows it.
 */
export const ALERT_SETTING_FIELDS: Readonly<Record<AlertMessageKey, readonly [group: string, field: string]>> = {
  'cart.added': ['cart', 'added'],
  'cart.removed': ['cart', 'removed'],
  'cart.limitExceeded': ['cart', 'limitExceeded'],
  'cart.noMoreStock': ['cart', 'noMoreStock'],
  'cart.outOfStock': ['checkout', 'outOfStock'],
  'wishlist.added': ['wishlist', 'added'],
  'wishlist.removed': ['wishlist', 'removed'],
  'wishlist.empty': ['wishlist', 'empty'],
  'waitlist.added': ['waitlist', 'added'],
  'auth.loginSuccess': ['auth', 'loginSuccess'],
  'auth.loginFailed': ['auth', 'loginFailed'],
  'auth.loggedOut': ['auth', 'loggedOut'],
  'auth.resetLinkSent': ['auth', 'resetLinkSent'],
  'checkout.orderPlaced': ['checkout', 'orderPlaced'],
  'checkout.paymentFailed': ['checkout', 'paymentFailed'],
};

/** The panel caps every alert at this; a longer published value is cut, not refused. */
export const MAX_ALERT_LENGTH = 200;

/** The panel's bounds for the line limit. Outside them the value is ignored (no limit). */
export const MAX_LINE_ITEMS_RANGE = { min: 1, max: 100 } as const;

export interface AlertSettings {
  /** Published copy, ready for `<ShopifyProvider messages>`. */
  messages: AlertMessages;
  /** Alerts the merchant cleared: raise no toast for these. */
  silenced: ReadonlySet<AlertMessageKey>;
}

const ALERT_KEYS = Object.keys(ALERT_SETTING_FIELDS) as AlertMessageKey[];

/**
 * The alert copy and the silenced set from the `settings.alerts` subtree.
 * Anything that isn't a string (unpublished, a stray number) keeps the default.
 */
export function readAlertSettings(alerts: unknown): AlertSettings {
  const messages: AlertMessages = {};
  const silenced = new Set<AlertMessageKey>();
  const tree = isRecord(alerts) ? alerts : {};
  for (const key of ALERT_KEYS) {
    const [group, field] = ALERT_SETTING_FIELDS[key];
    const section = tree[group];
    const value = isRecord(section) ? section[field] : undefined;
    if (typeof value !== 'string') continue;
    if (value.trim() === '') silenced.add(key);
    else messages[key] = value.slice(0, MAX_ALERT_LENGTH);
  }
  return { messages, silenced };
}

/**
 * The cart policy from `settings.cart.maxLineItems`. The panel's number field may
 * publish a string; a value outside 1–100 would either block every add or mean
 * nothing, so it is ignored.
 */
export function readCartPolicy(maxLineItems: unknown): CartPolicy {
  const n = typeof maxLineItems === 'string' ? Number.parseInt(maxLineItems, 10) : maxLineItems;
  if (typeof n !== 'number' || !Number.isFinite(n)) return {};
  if (n < MAX_LINE_ITEMS_RANGE.min || n > MAX_LINE_ITEMS_RANGE.max) return {};
  return { maxLineItems: Math.round(n) };
}

/** Whether an event's alert was cleared in the panel. Events with no alert are never silenced. */
export function isAlertSilenced(
  event: { messageKey?: AlertMessageKey },
  silenced: ReadonlySet<AlertMessageKey>,
): boolean {
  return !!event.messageKey && silenced.has(event.messageKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
