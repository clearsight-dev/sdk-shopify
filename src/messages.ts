// User-facing copy for the alerts the editor's Settings panel configures
// ("Alerts & Toasts": Cart / Wishlist / Login / Checkout).
//
// The SDK never renders anything. It resolves the right string and hands it to
// the host through `ShopifyEvent.message`, so a screen can toast without
// keeping its own copy table or mapping error shapes to sentences.
//
// Resolution order, highest first:
//   1. `messages` passed to `shopify.init()` / `<ShopifyProvider messages>` —
//      the Settings-panel value, and what a Live Layer publish overwrites.
//   2. `translate(key, fallback)` — the i18n workspace, whose `components`
//      namespace already carries keys like `toast.added_to_cart`.
//   3. DEFAULT_MESSAGES below.
//
// Keys are the SDK's contract with the editor: the panel writes straight into
// this shape, so a new alert means one entry here and one field there.
import type { AlertMessageKey, AlertMessages, MessageResolver } from './types';

/** Ships the same copy the v1 Shopify panel used as its placeholders. */
export const DEFAULT_MESSAGES: Readonly<Record<AlertMessageKey, string>> = {
  'cart.added': 'Product added to the Cart',
  'cart.removed': 'Product removed from the Cart',
  'cart.limitExceeded': 'You can not add more than 25 items on cart',
  'cart.outOfStock': 'Sorry, this item is out of stock',
  'wishlist.added': 'Saved to your wishlist',
  'wishlist.removed': 'Removed from wishlist',
  'wishlist.empty': 'Your wishlist is empty',
  'auth.loginSuccess': 'Welcome back!',
  'auth.loginFailed': 'Incorrect email or password',
  'auth.loggedOut': 'You have been signed out',
  'auth.resetLinkSent': 'Check your email for a reset link',
  'checkout.orderPlaced': 'Your order has been placed 🎉',
  'checkout.paymentFailed': 'Payment could not be processed',
};

/** i18n keys the Translations workspace uses, where they differ from ours. */
const TRANSLATION_KEYS: Partial<Record<AlertMessageKey, string>> = {
  'cart.added': 'toast.added_to_cart',
};

interface MessageState {
  overrides: AlertMessages;
  translate: MessageResolver | null;
}

const state: MessageState = { overrides: {}, translate: null };

/**
 * Replaces the override set — a full swap, not a merge, so clearing a field in
 * the Settings panel falls back to the default rather than sticking.
 */
export function setMessages(messages?: AlertMessages | null): void {
  state.overrides = messages ? { ...messages } : {};
}

/** Merges into the current overrides. For a Live Layer publish of one field. */
export function patchMessages(messages: AlertMessages): void {
  state.overrides = { ...state.overrides, ...messages };
}

export function setMessageResolver(resolver?: MessageResolver | null): void {
  state.translate = resolver ?? null;
}

export function getMessages(): AlertMessages {
  return { ...state.overrides };
}

/**
 * The string to show for `key`. Never throws and never returns empty — an
 * override of `''` (a cleared panel field) is treated as "not set".
 */
export function message(key: AlertMessageKey): string {
  const override = state.overrides[key];
  if (typeof override === 'string' && override.trim() !== '') return override;

  const fallback = DEFAULT_MESSAGES[key];
  if (state.translate) {
    try {
      const translated = state.translate(TRANSLATION_KEYS[key] ?? key, fallback);
      if (typeof translated === 'string' && translated.trim() !== '') return translated;
    } catch {
      // A broken resolver must not cost the shopper their toast.
    }
  }
  return fallback;
}

/**
 * `cart.limitExceeded` mentions a number, and the default says 25 while the
 * configured limit may be anything. Substitutes the real one into the default
 * copy; an explicit override is left exactly as authored.
 */
export function limitExceededMessage(max: number): string {
  const text = message('cart.limitExceeded');
  if (state.overrides['cart.limitExceeded']) return text;
  return text.replace('25', String(max));
}
