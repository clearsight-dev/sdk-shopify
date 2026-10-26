import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { shopify } from "../shopify";
import { isConfigured, setConfig } from "../client";
import { addGiftCardsKeepingBuyer } from "../cart";
import { prepareCheckout, type CheckoutPreparation, type PrepareCheckoutOptions } from "../checkout";
import { showsInCart, type AttributionSource, type ShowsInCart } from "../attribution";
import { hasLapsedHoldIn, type CartExtension } from "../cartPage";
import { createAttributionRecorder } from "./attributionRecorder";
import { CHECKOUT_STARTED_KEY, createCartRecovery, type CartRecovery } from "./cartRecovery";
import { createHoldEndWatch, type HoldEndWatch } from "./holdEndWatch";
import {
  LINK_TAGS_STORAGE_KEY,
  cartHasLinkTags,
  linkTagsFrom,
  liveLinkTags,
  readSavedLinkTags,
  withLinkTags,
  type LinkTagOptions,
  type SavedLinkTags,
} from "../linkTags";
import { wouldExceedLineLimit, maxLineItems } from "../cartPolicy";
import { quantityInCart, withinCeiling } from "../productPage";
import { isMissingCartError, isOutOfStockError, isUserErrorRejection } from "../errors";
import { fillMessage, limitExceededMessage, message, setMessageResolver } from "../messages";
import { setStoreWebDomains } from "../storeLinks";
import { ShopifyError } from "../types";
import { createCustomerSession, type CustomerSession, type ProfileChanges, type SessionState, type SignupInput } from "../auth/session";
import type {
  AlertMessageKey,
  CartAddOutcome,
  CartLinesWriteResult,
  AuthMethod,
  AuthOptions,
  AlertMessages,
  Cart,
  CartLine,
  CartAttribute,
  CartLineAttribute,
  CartLineGuard,
  CartLineInput,
  CartLineUpdateInput,
  CartPolicy,
  CartWriteResult,
  Customer,
  MessageResolver,
  Product,
  RecentlyViewedOptions,
  ShopifyConfig,
  SignInAttempt,
  StoreCreditOptions,
  WaitlistEntryInput,
  WaitlistItem,
  WishlistItem,
  WishlistStorageAdapter,
} from "../types";

/**
 * Shopify rejecting the *contents* of a mutation rather than failing to answer it: only
 * `userErrors` populate `ShopifyError.errors`, so transport and GraphQL failures arrive empty.
 */
function isLineRejection(error: unknown): boolean {
  return isUserErrorRejection(error);
}

function sameAttributes(a: CartLineAttribute[], b: CartLineAttribute[]): boolean {
  return (
    a.length === b.length &&
    a.every((one) => b.some((other) => other.key === one.key && other.value === one.value))
  );
}

/**
 * The line a just-sent input became. Shopify merges an add into an existing line only when the
 * attributes match too, so a per-add attribute yields a *new* line for the same variant.
 */
function lineFor(cart: Cart, input: CartLineInput): CartLine | null {
  const candidates = cart.lines.filter((line) => line.merchandise?.id === input.merchandiseId);
  if (candidates.length === 0) return null;
  const exact = candidates.find((line) => sameAttributes(input.attributes ?? [], line.attributes));
  return exact ?? candidates[candidates.length - 1];
}

interface CartState {
  cart: Cart | null;
  loading: boolean;
  itemCount: number;
  /** Distinct lines, which is what `maxLineItems` limits — not `itemCount`. */
  lineCount: number;
  /** The configured `maxLineItems`, or `null` when unlimited. */
  maxLineItems: number | null;
  /**
   * `ok: false` means nothing was written: a `cartGuard` veto (`reason: 'guard'`) or the
   * line limit (`reason: 'limit'`, with the configured message). Shopify refusing the
   * line still throws — an unsellable one emits `cart:outOfStock` on the way out.
   */
  addLine:            (input: CartLineInput) => Promise<CartWriteResult>;
  /**
   * `addLinesDetailed`'s cart: `null` when nothing landed, which now includes a batch Shopify clamped
   * to nothing (0.13.1). One unsellable line fails the whole `cartLinesAdd`, so a rejected batch is
   * retried line by line and the successes are kept.
   *
   * `options.quiet`: the caller reports the outcome itself. Every `cartGuard.beforeAdd` is passed it
   * (so the guard says nothing about a refusal), and the one `cart:outOfStock` the line-by-line retry
   * raises for the lines Shopify refused is not emitted. `cart:add` (something landed) and
   * `cart:limitExceeded` (the line limit refused the whole batch) still are.
   */
  addLines:           (inputs: CartLineInput[], options?: { quiet?: boolean }) => Promise<Cart | null>;
  /**
   * `addLines` with what each input really added (0.13.1): Shopify clamps an add past the stock without
   * an error, so units are counted before and after. `ok` when any landed; nothing landed and some were
   * clamped is `reason: 'clamped'` with `cart.noMoreStock`'s copy. A clamp raises `cart:stockLimit`
   * (with `clamped`) unless `quiet`. A guard veto of every input is `reason: 'guard'`, the line limit
   * `reason: 'limit'`. Shopify refusing the lines still throws, as for `addLines`.
   */
  addLinesDetailed:   (inputs: CartLineInput[], options?: { quiet?: boolean }) => Promise<CartLinesWriteResult>;
  /**
   * `false` when a `cartGuard` cancelled the increase. `attributes` REPLACE the line's set —
   * Shopify does not merge them — so omit the argument to leave them untouched. `opts.source` is
   * where an increase came from, for `attribution` (default `app`).
   */
  updateLine:         (
    lineId: string,
    quantity: number,
    attributes?: CartLineAttribute[],
    opts?: { source?: AttributionSource },
  ) => Promise<boolean>;
  removeLine:         (lineId: string) => Promise<void>;
  applyDiscountCodes: (codes: string[]) => Promise<void>;
  /**
   * The shopper's order note, carried to the order. `null` clears it.
   *
   * Not debounced here — a note is typed and then committed (on blur, or a Save), and writing per
   * keystroke would put a mutation on every character. The caller decides when it is done.
   */
  updateNote: (note: string | null) => Promise<void>;
  /**
   * Attributes the order to a buyer and opens checkout signed in. `false` when there is no cart
   * yet. New customer accounts pass their Customer Account API token straight through.
   */
  setBuyerIdentity: (identity: {
    email?: string;
    countryCode?: string;
    customerAccessToken?: string;
  }) => Promise<boolean>;
  /**
   * Adds gift-card codes to the cart and keeps the cards already on it (`cartGiftCardCodesAdd`), in
   * the cart's write queue like every other write. Returns the cart; null when there is no cart yet
   * (none is created for this).
   *
   * Shopify takes a gift card only on a cart with a country, so a cart without one gets the
   * provider's `config.country` (else the shop's) first, keeping its email and, when signed in, the
   * shopper's link. A cart that has a country keeps its buyer identity untouched.
   *
   * Throws a `ShopifyError` when Shopify refuses a code (its `userErrors`), and also when it answers
   * without applying one, which it does without an error (`code: 'GIFT_CARD_NOT_APPLIED'`, the cart
   * still updated). Gift cards change no lines, so `cartGuard` isn't asked.
   */
  addGiftCardCodes: (codes: string[]) => Promise<Cart | null>;
  /**
   * Takes the given gift cards off the cart by their `AppliedGiftCard.id` (not the code), leaving every
   * other card on it, in the write queue. Null when there is no cart.
   */
  removeGiftCards: (appliedGiftCardIds: string[]) => Promise<Cart | null>;
  /** Re-reads the cart and returns it, so a caller need not wait for the re-render. */
  refresh:            () => Promise<Cart | null>;
  /**
   * Switches to a cart handed over from elsewhere — another device, a support agent, the web store.
   * A read and a swap, not a mutation: nothing is written to either cart. Null when that id no
   * longer resolves, in which case the current cart is left alone.
   */
  adopt:              (cartId: string) => Promise<Cart | null>;
  reset:              () => Promise<void>;
  /**
   * Waits for queued `attribution` writes and retries an unsent value once. True when the cart holds
   * the device's value (and always when attribution is off). Never throws. Await before checkout:
   * a failed write is otherwise only retried by the next change.
   */
  flushAttribution:   () => Promise<boolean>;
  /**
   * Sets `pairs` on the cart (overwriting a different value) and keeps every other attribute,
   * `_apptile_attribution` included. Queued behind pending cart writes; no request when every pair
   * is already there. Never throws: false when it could not be written or there is no cart yet.
   */
  ensureCartAttributes: (pairs: CartAttribute[]) => Promise<boolean>;
  /**
   * Saves a link's `ref` and `utm…` tags and puts them on the cart, as for a link that reached
   * `linkTags.subscribe` (0.11.0): for a link the app routes itself. True when the tags were saved;
   * false when the link has none or `linkTags` is off. The cart write is tried again at checkout if it
   * fails now. Never throws.
   */
  saveLinkTags: (url: string) => Promise<boolean>;
}

interface WishlistState {
  items:        WishlistItem[];
  /** The wishlisted product ids, in `items` order. The same array until the wishlist changes. */
  ids:          string[];
  count:        number;
  has:          (productId: string) => boolean;
  /** Alias for `has`. */
  isWishlisted: (productId: string) => boolean;
  add:          (product: Product | string) => Promise<void>;
  /**
   * `silent` (0.23.0): no toast (e.g. what an order just bought). The `wishlist:remove` event still goes
   * out, for analytics, with no `message`.
   */
  remove:       (productId: string, options?: { silent?: boolean }) => Promise<void>;
  toggle:       (product: Product | string) => Promise<boolean>;
  clear:        () => Promise<void>;
  refresh:      () => Promise<void>;
}

/** The sizes or colours the shopper is waiting on, kept on the device (see `WaitlistItem`). */
interface WaitlistState {
  items:   WaitlistItem[];
  /** The variant ids waited on, in `items` order. The same array until the list changes. */
  ids:     string[];
  count:   number;
  has:     (variantId: string) => boolean;
  /** Emits `waitlist:add` ("Added to waitlist"). */
  add:     (entry: WaitlistEntryInput) => Promise<void>;
  /** Emits `waitlist:remove`, which carries no message: removing raises no toast. */
  remove:  (variantId: string) => Promise<void>;
  /** Fetches every variant again; rejects, changing nothing, when it can't (offline). */
  refresh: () => Promise<void>;
}

/**
 * The shopper's session, for both ways of signing in: email and password (`login`, `signup`,
 * `recoverPassword`) and Shopify's web sign-in (`signIn`, `startSignIn`). `auth.method` on the
 * provider says which one the app offers now; `sessionKind` says which one the current session is.
 * The session itself lives in `auth/session.ts`; base cases in test/auth-*.test.mjs.
 */
interface CustomerState {
  customer: Customer | null;
  /**
   * A session exists. Offline on app open it can be true while `customer` is still null: the
   * profile loads on the next `refresh()`.
   */
  loggedIn: boolean;
  /** The current access token, possibly stale. Callers that send it somewhere use `getAccessToken()`. */
  accessToken: string | null;
  loading: boolean;
  /** Reading a stored session on app open, as distinct from "signed out". */
  restoring: boolean;
  /** Which sign-in the app offers now: `auth.method`, `password` when unset. */
  method: AuthMethod;
  /** Where Shopify's sign-in page opens: `auth.signInSurface`, `sheet` when unset (0.15.0). */
  signInSurface: 'sheet' | 'webview';
  /** How the current session was signed in; null when signed out. */
  sessionKind: AuthMethod | null;
  /** Password sign-in. `false` on bad credentials, which emits `auth:loginFailed`. Everything else throws. */
  login:  (email: string, password: string) => Promise<boolean>;
  signup: (input: SignupInput) => Promise<boolean>;
  /** Always resolves: Shopify being unreachable still ends the local session. */
  logout: () => Promise<void>;
  /** Emits `auth:recoverSent`. Shopify does not reveal whether the email exists. */
  recoverPassword: (email: string) => Promise<void>;
  /** Re-reads the profile. Null when signed out or the session ended. */
  refresh: () => Promise<Customer | null>;
  /**
   * Changes the name and email marketing consent, for either kind of session, sending only what
   * differs from `customer`. `true` once Shopify accepted it all, with `customer` showing the new
   * values. `false` when signed out, refused or offline (logged with `console.warn`). Never throws.
   */
  updateProfile: (changes: ProfileChanges) => Promise<boolean>;
  /**
   * Shopify web sign-in in the system browser sheet (`auth.openAuthSession`). `false` when the
   * shopper backs out (no event) or Shopify refuses (`auth:loginFailed`). Throws when offline.
   */
  signIn: () => Promise<boolean>;
  /** Shopify web sign-in in the app's own web view. See `SignInAttempt`. */
  startSignIn: () => SignInAttempt;
  /** A usable access token, refreshed when needed. Null when signed out or the session ended. */
  getAccessToken: () => Promise<string | null>;
  /**
   * A token renewed now, even if the current one looks valid: for a service that just answered 401
   * (Tile Credit does). A Shopify session refreshes, sharing a refresh already on its way; a password
   * session can't renew, so null. It never signs the shopper out; only Shopify refusing the refresh
   * ends the session, as it would anyway. Throws when offline.
   */
  renewAccessToken: () => Promise<string | null>;
  /** A Customer Account API GraphQL call for the signed-in shopper (`shopify` sessions only). */
  request: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
}

/**
 * Checkout is Shopify-hosted, so the SDK cannot see the outcome itself. The host
 * webview reports it here and gets the configured copy on the event, rather than
 * every app hard-coding "Your order has been placed".
 *
 * Before it opens, `prepare` gets the cart ready (SDK move 6); the page's address says when the order
 * is placed (`isOrderPlacedUrl`, `../checkout`).
 */
interface CheckoutState {
  /**
   * Gets the cart ready for checkout: reads it again, checks for a reservation that ran out
   * (`options.hasLapsedHold`), attaches the signed-in shopper with the cart's country, lands the
   * cart's attribution and the provider's `cartAttributes` (with 0.9.1's attribution), and reports
   * the start. Answers `ready`,
   * `empty`, `lapsedHold` or `failed` (`prepareCheckout` in `../checkout` has the rule). Never throws.
   * Going to the checkout page is the app's, on `ready`.
   */
  prepare: (options?: PrepareCheckoutOptions) => Promise<CheckoutPreparation>;
  /** This hook's `prepare` is running (for a spinner on the button that started it). */
  preparing: boolean;
  /**
   * `prepare`, then where the answer leads (0.15.0): `ready` calls `useCheckout`'s `onReady` (the app
   * opens its checkout page), `lapsedHold` its `onLapsedHold` (the app shows the cart). `empty` raises
   * `checkout:reservationExpired` and `failed` `checkout:couldNotStart`, whose alerts say so. Resolves
   * the answer. Never throws: an `onReady` that throws counts as `failed`.
   */
  start: (options?: PrepareCheckoutOptions) => Promise<CheckoutPreparation>;
  /** `start` for a cart some other caller prepared (`useCartPage().checkout.start()`). */
  follow: (preparation: Promise<CheckoutPreparation> | CheckoutPreparation) => Promise<CheckoutPreparation>;
  /**
   * Call as checkout opens for the shared cart. A checked-out cart reads back null exactly like an
   * expired one, so without this a missed `reportOrderPlaced` would refill the cart on next launch
   * with what was just bought. Any later add, update or remove clears it.
   */
  reportCheckoutStarted: () => Promise<void>;
  /** Emits `checkout:orderPlaced`, then resets the cart so the next visit starts clean. */
  reportOrderPlaced: (details?: { orderId?: string; orderNumber?: string | number }) => Promise<void>;
  /** Emits `checkout:paymentFailed`. Leaves the cart alone so the shopper can retry. */
  reportPaymentFailed: (error?: unknown) => void;
}

interface ShopifyContextType {
  ready:    boolean;
  error:    string | null;
  cart:     CartState;
  wishlist: WishlistState;
  waitlist: WaitlistState;
  customer: CustomerState;
  /** `useCheckout()` adds `preparing`, `start` and `follow`, which are each caller's own. */
  checkout: Omit<CheckoutState, "preparing" | "start" | "follow">;
  /** The app's store-credit choice, read by `useStoreCredit`. */
  storeCredit: StoreCreditOptions | null;
  /** Resolved alert copy, for labelling UI that isn't a toast — e.g. the
   *  empty-wishlist placeholder (`wishlist.empty`), which has no event. `fill`
   *  fills its `{name}` placeholders (0.15.0). */
  message:  (key: AlertMessageKey, fill?: Readonly<Record<string, string>>) => string;
  /** Every event the provider raises, for `useShopifyEvents` (0.10). */
  events: { subscribe: (listener: (event: ShopifyEvent) => void) => () => void };
  /**
   * Raises an event as the provider's own writes do, its alert's copy resolved and filled (0.15.0):
   * how the SDK's page models (`useCheckout().start`, `useCheckoutPage`, `useOrder().buyAgain`,
   * `useCartStoreCredit`, `useSignIn`) report what happened. Never throws.
   */
  report: (type: ShopifyEventType, details?: ReportDetails) => void;
  /** The provider's `storage`, for the shopper's preferences on this phone (`useGridColumns`, 0.15.0). */
  deviceStorage: WishlistStorageAdapter | null;
  /** Where `useGridColumns` keeps its choice (`gridColumnsStorageKey`). */
  gridColumnsStorageKey: string;
  /** `useCollectionPage`'s page size unless it is given one (`productsPerPage`). */
  productsPerPage: number | null;
  /** `useQuickAdd`'s `addStraightToCart` unless it is given one (`quickAddStraightToCart`, 0.22.0). */
  quickAddStraightToCart: boolean;
  /**
   * The provider's `attribution.enabled` (0.23.0): whether carts carry `_apptile_attribution`. For a cart
   * built outside this provider (another SDK's checkout) to write the same record.
   */
  attributionEnabled: boolean;
  /** For `useCartPage` (0.14.0): the provider's `cartExtensions`, and its two events. */
  cartPage: {
    extensions: readonly CartExtension[];
    reportViewed: (cart: Cart | null) => void;
    reportCheckoutStarted: (cart: Cart | null) => void;
  };
}

const NO_CART_EXTENSIONS: readonly CartExtension[] = [];

/** An alert's copy with its placeholders filled: the context's `message`. */
const filledMessage = (key: AlertMessageKey, fill?: Readonly<Record<string, string>>): string => fillMessage(message(key), fill);

const ShopifyContext = createContext<ShopifyContextType | undefined>(undefined);

const CART_STORAGE_KEY = "shopify:cart-id:v1";
/**
 * Everything the host may want to tell the shopper about. One event per alert the
 * editor's Settings panel configures, plus the writes that carry no copy of their own.
 *
 * Failures are events too — a "Payment failed" or "Out of stock" toast needs a
 * signal as much as a success does, and wrapping every call in try/catch to find
 * out is what this replaces. Errors still throw for callers that want them.
 */
export type ShopifyEventType =
  | "cart:add"
  | "cart:update"
  | "cart:remove"
  | "cart:limitExceeded"
  | "cart:stockLimit"
  | "cart:outOfStock"
  | "cart:buyerIdentity"
  /** The stored cart was gone in Shopify (ordered or expired) and a new one took its place. No message. */
  | "cart:recovered"
  | "wishlist:add"
  | "wishlist:remove"
  | "waitlist:add"
  | "waitlist:remove"
  | "auth:loginSuccess"
  | "auth:loginFailed"
  | "auth:signup"
  | "auth:logout"
  | "auth:recoverSent"
  /** A session Shopify stopped accepting, while the app was in use. No message: a host may route to sign-in. */
  | "auth:sessionExpired"
  | "checkout:orderPlaced"
  | "checkout:paymentFailed"
  /** The cart page came into view (`useCartPage().viewed()`, 0.14.0). Carries the cart. No message. */
  | "cart:viewed"
  /** Checkout was started from the cart page (`useCartPage().checkout.start()`, 0.14.0). Carries the cart and its `shows`. No message. */
  | "checkout:started"
  // 0.15.0: what the page models (`useCheckout().start`, `useCheckoutPage`, `useOrder().buyAgain`,
  // `useCartStoreCredit`, `updateProfile`, `useSignIn`) report, so an app needs no words of its own.
  /** `useCheckout().start()`: the cart came back empty (a reservation that ran out took its lines), or emptied under an open checkout (`useCheckoutPage`). */
  | "checkout:reservationExpired"
  /** `useCheckout().start()`: getting the cart ready failed. */
  | "checkout:couldNotStart"
  /**
   * `useCheckoutPage` saw the order placed. Carries the cart as it was (before it is reset) and its
   * `shows`; a checkout of its own link (an auction's wins) carries `source` instead. No message: the
   * analytics SDK reports it (`purchase`), Cart Assist marks the cart checked out.
   */
  | "checkout:completed"
  /** A quantity change the cart refused (the product page's stepper). */
  | "cart:updateFailed"
  /**
   * A line's reservation ran out (0.19.0): raised at that moment, on any screen, once per hold, with the
   * cart (`reservationExpiredAlert`). Severity `info`: news, not a refusal.
   */
  | "cart:reservationExpired"
  /** `useOrder().buyAgain()`: every item went back in the cart. */
  | "orders:boughtAgain"
  /** Some did; the message counts both. */
  | "orders:boughtAgainPartly"
  /** None did. */
  | "orders:nothingToBuyAgain"
  /** `updateProfile` saved the changes. */
  | "auth:profileUpdated"
  /** A sign-in that couldn't reach the store (offline), when its caller asked for the alert. */
  | "auth:couldNotReachStore"
  /** Store credit went on the cart; the message says what it takes off. */
  | "storeCredit:applied"
  /** Store credit came off the cart. */
  | "storeCredit:removed";

export interface ShopifyEvent {
  type: ShopifyEventType;
  /** How to present it — a toast tone, not a log level. */
  severity: "success" | "error" | "info";
  /**
   * Resolved copy for this event, already through the Settings panel → i18n →
   * default chain. Absent for the events that have no configurable message
   * (`cart:update`, `cart:buyerIdentity`), which are state signals, not alerts.
   */
  message?: string;
  /** Which panel field `message` came from, for hosts that key off it. */
  messageKey?: AlertMessageKey;
  /** Present on failures. `ShopifyError.errors` carries the Shopify codes. */
  error?: unknown;
  /**
   * The cart after the write, on `cart:add`, `cart:update` and `cart:remove` (0.10). A listener can
   * report from it straight away: React's `useCart().cart` hasn't caught up when the event arrives.
   */
  cart?: Cart;
  /**
   * The lines the write changed, on the same three events (0.10): usually one; an `addLines` that
   * landed several lines lists each once. Empty when the line wasn't in the cart the write started from.
   */
  changedLines?: CartLineChange[];
  /** The product saved or unsaved, on `wishlist:add` and `wishlist:remove` (0.10). */
  productId?: string;
  /** On `cart:recovered`: the cart that was gone, the one that replaced it (also `cart`), and why. */
  recovery?: CartRecovery;
  /** On a `cart:stockLimit` raised by a clamp: each add Shopify cut short, with what landed (0.13.1). */
  clamped?: CartAddOutcome[];
  /**
   * The signed-in customer, on `auth:loginSuccess` (0.10). Null when their profile hadn't loaded when
   * the sign-in finished: `useCustomer().customer` has it once it does.
   */
  customer?: Customer | null;
  /** How that session signed in (`useCustomer().sessionKind`), on `auth:loginSuccess` (0.10). */
  sessionKind?: AuthMethod | null;
  /** The live shows and replays the cart holds units from (`showsInCart`), on `checkout:started` (0.14.0) and `checkout:completed` (0.15.0). */
  shows?: ShowsInCart;
  /** On `checkout:completed` for a checkout of its own link: what it was for (`auctionWins`), as its caller named it (0.15.0). */
  source?: string;
}

/** One cart line a write changed, on `ShopifyEvent.changedLines`. */
export interface CartLineChange {
  /** The line after the write. For a line the write took out of the cart, the line as it was. */
  line: CartLine;
  /** Units added (above 0) or taken away (below 0). 0 when only the line's attributes changed. */
  quantityChange: number;
}

export type { CartRecovery, CartRecoveryReason } from "./cartRecovery";

/** What a page model attaches to an event it reports (`useShopify().report`, 0.15.0). */
export interface ReportDetails {
  error?: unknown;
  cart?: Cart;
  shows?: ShowsInCart;
  source?: string;
  /** Values for the message's `{name}` placeholders. */
  fill?: Readonly<Record<string, string>>;
}

/** What `emit` attaches to an event besides its type. */
interface EventDetails {
  error?: unknown;
  cart?: Cart;
  changedLines?: CartLineChange[];
  productId?: string;
  recovery?: CartRecovery;
  clamped?: CartAddOutcome[];
  shows?: ShowsInCart;
  source?: string;
  /** Values for the message's `{name}` placeholders (`fillMessage`). */
  fill?: Readonly<Record<string, string>>;
  /** Sent without its message, so nothing shows a toast; `onEvent` still hears it (0.23.0). */
  silent?: boolean;
}

/**
 * What an add changed: each line the inputs landed on, once, with the units added to it (two
 * inputs that landed on one line, same variant and attributes, are counted together).
 */
function changesForAdds(cart: Cart, inputs: CartLineInput[]): CartLineChange[] {
  const changes: CartLineChange[] = [];
  for (const input of inputs) {
    const line = lineFor(cart, input);
    if (!line) continue;
    const sameLine = changes.find((change) => change.line.id === line.id);
    if (sameLine) sameLine.quantityChange += input.quantity;
    else changes.push({ line, quantityChange: input.quantity });
  }
  return changes;
}

/**
 * What each input really added. Shopify clamps an add past the stock to an answer that adds nothing,
 * so it is counted: the rise in each variant's units over `before`, across every line (selling-plan and
 * attribute-split lines count), shared out in input order when inputs repeat a variant.
 */
function landedQuantities(before: Cart, after: Cart, inputs: CartLineInput[]): number[] {
  const rise = new Map<string, number>();
  return inputs.map(({ merchandiseId, quantity }) => {
    const left = rise.get(merchandiseId)
      ?? Math.max(0, quantityInCart(after, merchandiseId) - quantityInCart(before, merchandiseId));
    const landed = Math.min(quantity, left);
    rise.set(merchandiseId, left - landed);
    return landed;
  });
}

/** Alert-carrying events and the message key each resolves. */
const EVENT_MESSAGE: Partial<Record<ShopifyEventType, AlertMessageKey>> = {
  "cart:add": "cart.added",
  "cart:remove": "cart.removed",
  "cart:limitExceeded": "cart.limitExceeded",
  "cart:stockLimit": "cart.noMoreStock",
  "cart:outOfStock": "cart.outOfStock",
  "wishlist:add": "wishlist.added",
  "wishlist:remove": "wishlist.removed",
  "waitlist:add": "waitlist.added",
  "auth:loginSuccess": "auth.loginSuccess",
  "auth:loginFailed": "auth.loginFailed",
  "auth:logout": "auth.loggedOut",
  "auth:recoverSent": "auth.resetLinkSent",
  "checkout:orderPlaced": "checkout.orderPlaced",
  "checkout:paymentFailed": "checkout.paymentFailed",
  "checkout:reservationExpired": "checkout.reservationExpired",
  "checkout:couldNotStart": "checkout.couldNotStart",
  "cart:updateFailed": "cart.updateFailed",
  "cart:reservationExpired": "cart.reservationExpired",
  "orders:boughtAgain": "orders.boughtAgain",
  "orders:boughtAgainPartly": "orders.boughtAgainPartly",
  "orders:nothingToBuyAgain": "orders.nothingToBuyAgain",
  "auth:profileUpdated": "auth.profileUpdated",
  "auth:couldNotReachStore": "auth.couldNotReachStore",
  "storeCredit:applied": "storeCredit.applied",
  "storeCredit:removed": "storeCredit.removed",
};

const ERROR_EVENTS: ReadonlySet<ShopifyEventType> = new Set<ShopifyEventType>([
  "cart:limitExceeded",
  "cart:stockLimit",
  "cart:outOfStock",
  "auth:loginFailed",
  "checkout:paymentFailed",
  "checkout:reservationExpired",
  "checkout:couldNotStart",
  "cart:updateFailed",
  "orders:nothingToBuyAgain",
  "auth:couldNotReachStore",
]);

/** Alerts that are news rather than the answer to something the shopper did: `info`, not `success`. */
const INFO_EVENTS: ReadonlySet<ShopifyEventType> = new Set<ShopifyEventType>([
  "cart:reservationExpired",
]);

export interface ShopifyProviderProps {
  children: ReactNode;
  config: ShopifyConfig;
  /**
   * Backs the cart id, the customer session and the wishlist. Defaults to
   * `window.localStorage`; React Native and Node consumers pass an
   * AsyncStorage-compatible adapter.
   */
  storage?: WishlistStorageAdapter;
  onEvent?: (event: ShopifyEvent) => void;
  /** Vets cart writes — see `CartLineGuard`. On the provider so no screen can bypass it. */
  cartGuard?: CartLineGuard;
  /** See `WishlistInitOptions.keepDeleted`. Recommended for a shopper-facing wishlist. */
  wishlistKeepDeleted?: boolean;
  /** See `WishlistInitOptions.storageKey`: an app moving from Apptile's engine passes its old key. */
  wishlistStorageKey?: string;
  /** See `WishlistInitOptions.migrateFrom`: keys an earlier app kept its wishlist under. */
  wishlistMigrateFrom?: string[];
  /**
   * See `WishlistInitOptions.hydrateOnInit` (0.23.0). False: saved products aren't re-read at launch, only
   * when a page asks (`useFavoritesPage` does when it opens). For a long wishlist read only where it shows.
   */
  wishlistHydrateOnInit?: boolean;
  /** See `WishlistInitOptions.batchSize` (0.23.0): products per re-read request. */
  wishlistBatchSize?: number;
  /** See `WaitlistInitOptions.storageKey`: an app moving from Apptile's engine passes its old key. */
  waitlistStorageKey?: string;
  /** See `WaitlistInitOptions.migrateFrom`: keys an earlier app kept its waitlist under. */
  waitlistMigrateFrom?: string[];
  /**
   * Where the products the shopper opened are kept, and how many (0.17.0, `useRecentlyViewed`):
   * `storage` (default: this provider's `storage`), `storageKey` (default
   * `tile:shopify:recentlyViewed:v1`), `limit` (default 20, 1–50). Read when the provider mounts.
   */
  recentlyViewed?: RecentlyViewedOptions;
  /**
   * Alert copy, outside `config` so a Live Layer publish can change it without
   * re-running `init` (which would re-load the shop and re-create the cart).
   * Merged over `config.messages`; re-applied whenever this object changes.
   */
  messages?: AlertMessages;
  /** i18n resolver for keys `messages` does not set. Same reason as above. */
  translate?: MessageResolver;
  /** Cart rules. Live-updatable for the same reason. */
  cartPolicy?: CartPolicy;
  /**
   * What a product card's Add to Cart does, app-wide (`useQuickAdd`, 0.22.0): true (the default), a
   * product with one variant for sale goes straight into the cart and one with more opens the variant
   * page; false, every tap opens the variant page. The app's Common Buttons "Allow Quick Add to Cart".
   * Every `useQuickAdd` under the provider follows it, another SDK's included, unless the call passes
   * its own `addStraightToCart`. Live-updatable, and read at the tap.
   */
  quickAddStraightToCart?: boolean;
  /**
   * Attributes stamped on every cart this provider creates, and backfilled onto a stored cart that
   * predates them. They reach the order as its `customAttributes`.
   *
   * On the provider because the cart is created here — during hydration, on the first add, and on
   * reset — with no screen involved, so a caller has nowhere else to set them. A host that needs
   * the order to identify the app it came from (an app-only discount function, an order webhook)
   * sets it here or the cart goes out anonymous.
   */
  cartAttributes?: CartAttribute[];
  /**
   * How shoppers sign in. Unset: email and password only, as before. `method` can change while the
   * app runs: `password` for App Store review, `shopify` for shoppers.
   */
  auth?: AuthOptions;
  /** Where store credit comes from, for `useStoreCredit`. Unset: the app shows none. */
  storeCredit?: StoreCreditOptions;
  /**
   * Records where the cart's units came from (live show, replay, or the rest of the app) in the
   * `_apptile_attribution` cart attribute, after each line write lands. Off by default.
   */
  attribution?: { enabled: boolean };
  /**
   * Saves the `ref` and `utm…` tags of each link that opens the app, and puts them on the cart, so the
   * order says which link the shopper came from (0.11.0; see `linkTags.ts`). Off when unset or when
   * `keepDays` is 0. The last link wins: a newer link's tags replace the older ones on the phone and on
   * the cart. New carts get the tags for `keepDays`; a cart that already has them keeps them after that.
   */
  linkTags?: LinkTagOptions;
  /**
   * What other SDKs know about cart lines, for `useCartPage` (0.14.0): Cart Hold's
   * `cartHoldExtension()` (reservations), live selling's `giveawayPrizeExtension()` (prizes), or an
   * app's own. Pass a list that keeps its identity (a module constant). `useCheckout().prepare` also
   * asks them about a reservation that ran out when its caller doesn't say. See `CartExtension`.
   */
  cartExtensions?: readonly CartExtension[];
  /**
   * Tells the shopper when a line's reservation runs out (0.19.0, ENG-695): `cart:reservationExpired`
   * (`cart.reservationExpired`'s words, severity `info`) at the moment a hold the `cartExtensions` report
   * ends, on any screen, once per hold. Not for a hold that had already run out when the provider first saw
   * its line (the app was closed then), a line the shopper took out first, or a cart that was swapped. On
   * unless `enabled` is false; read when a hold ends, so a Live Layer publish applies at once. The cart is
   * read again after each hold ends (the extensions' `refreshDelays`) whether this is on or off.
   */
  reservationExpiredAlert?: { enabled: boolean };
  /**
   * Where `useGridColumns` keeps the shopper's products-per-row choice in `storage` (0.15.0). Default
   * `shopify:grid-columns:v1`; an app that kept it elsewhere passes its own key.
   */
  gridColumnsStorageKey?: string;
  /**
   * Products per page on every `useCollectionPage` that isn't given its own (0.15.0): a store setting
   * (amore-v2's "Products Loaded Per Page"). Rounded, 1–250; anything else is left out.
   */
  productsPerPage?: number | null;
}

function defaultStorage(): WishlistStorageAdapter | null {
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).localStorage !== "undefined") {
    return (globalThis as any).localStorage as WishlistStorageAdapter;
  }
  return null;
}

export function ShopifyProvider({
  children,
  config,
  storage,
  onEvent,
  cartGuard,
  wishlistKeepDeleted,
  wishlistStorageKey,
  wishlistMigrateFrom,
  wishlistHydrateOnInit,
  wishlistBatchSize,
  waitlistStorageKey,
  waitlistMigrateFrom,
  recentlyViewed,
  messages,
  translate,
  cartPolicy,
  cartAttributes,
  auth,
  storeCredit,
  attribution,
  linkTags,
  cartExtensions = NO_CART_EXTENSIONS,
  reservationExpiredAlert,
  gridColumnsStorageKey = "shopify:grid-columns:v1",
  productsPerPage,
  quickAddStraightToCart = true,
}: ShopifyProviderProps) {
  const pageSizeSetting =
    typeof productsPerPage === "number" && Number.isFinite(productsPerPage) && productsPerPage >= 1
      ? Math.min(250, Math.round(productsPerPage))
      : null;
  const [ready, setReady]           = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [cart, setCart]             = useState<Cart | null>(null);
  // The cart as of the newest write, for a write that waited in the queue behind others.
  const latestCart                  = useRef<Cart | null>(null);
  latestCart.current = cart;
  const [cartLoading, setCartLoad]  = useState(false);
  const [wlItems, setWlItems]       = useState<WishlistItem[]>([]);
  const wlUnsubRef                  = useRef<(() => void) | null>(null);
  const [wtItems, setWtItems]       = useState<WaitlistItem[]>([]);
  const wtUnsubRef                  = useRef<(() => void) | null>(null);

  const storageRef = useRef<WishlistStorageAdapter | null>(null);
  storageRef.current = storage ?? defaultStorage();

  // In a ref so the cart callbacks keep their identity when the host passes a new guard object.
  const guardRef = useRef<CartLineGuard | undefined>(cartGuard);
  guardRef.current = cartGuard;

  // Same for onEvent: a host that passes an inline arrow would otherwise rebuild
  // every cart callback on each render.
  const onEventRef = useRef<((event: ShopifyEvent) => void) | undefined>(onEvent);
  onEventRef.current = onEvent;

  /** Listeners added with `useShopifyEvents`, told after `onEvent`, in the order they subscribed. */
  const eventListeners = useRef(new Set<(event: ShopifyEvent) => void>());
  /** Declared before `emit`, which reads the signed-in customer from it for `auth:loginSuccess`. */
  const sessionRef = useRef<CustomerSession | null>(null);

  /**
   * Resolves the copy for `type` and hands the event to the host's `onEvent`, then to every
   * `useShopifyEvents` listener. A throwing listener must not fail the write that triggered it —
   * the mutation already landed, so swallowing here is the only honest option.
   */
  const emit = useCallback((type: ShopifyEventType, details?: EventDetails) => {
    const listener = onEventRef.current;
    if (!listener && eventListeners.current.size === 0) return;
    const key = details?.silent ? undefined : EVENT_MESSAGE[type];
    // The session has already taken the new customer when it announces the sign-in.
    const signedIn = type === "auth:loginSuccess" ? sessionRef.current?.getState() : undefined;
    const max = maxLineItems();
    const event: ShopifyEvent = {
      type,
      severity: ERROR_EVENTS.has(type) ? "error" : key && !INFO_EVENTS.has(type) ? "success" : "info",
      ...(key
        ? {
            messageKey: key,
            message:
              type === "cart:limitExceeded" && max !== null
                ? limitExceededMessage(max)
                : fillMessage(message(key), details?.fill),
          }
        : {}),
      ...(details?.error === undefined ? {} : { error: details.error }),
      ...(details?.cart ? { cart: details.cart } : {}),
      ...(details?.changedLines ? { changedLines: details.changedLines } : {}),
      ...(details?.productId ? { productId: details.productId } : {}),
      ...(details?.recovery ? { recovery: details.recovery } : {}),
      ...(details?.clamped ? { clamped: details.clamped } : {}),
      ...(details?.shows ? { shows: details.shows } : {}),
      ...(details?.source ? { source: details.source } : {}),
      ...(signedIn ? { customer: signedIn.customer, sessionKind: signedIn.kind } : {}),
    };
    if (listener) {
      try {
        listener(event);
      } catch (listenerError) {
        console.warn("[ShopifyProvider] onEvent threw", listenerError);
      }
    }
    for (const eventListener of [...eventListeners.current]) {
      try {
        eventListener(event);
      } catch (listenerError) {
        console.warn("[ShopifyProvider] a useShopifyEvents listener threw", listenerError);
      }
    }
  }, []);

  const subscribeToEvents = useCallback((eventListener: (event: ShopifyEvent) => void) => {
    eventListeners.current.add(eventListener);
    return () => {
      eventListeners.current.delete(eventListener);
    };
  }, []);
  const events = useMemo(() => ({ subscribe: subscribeToEvents }), [subscribeToEvents]);

  // ── Customer session ────────────────────────────────────────────────────────
  // One per provider, created on first render. `auth` is read through a ref on every use, so a Live
  // Layer publish that flips `auth.method` applies at once and leaves the current session alone.
  const authRef = useRef<AuthOptions | undefined>(auth);
  authRef.current = auth;
  const configRef = useRef(config);
  configRef.current = config;
  if (!sessionRef.current) {
    sessionRef.current = createCustomerSession({
      storage: () => authRef.current?.secureStorage ?? storageRef.current,
      legacyStorage: () => storageRef.current,
      options: () => authRef.current,
      apiVersion: () => configRef.current.apiVersion,
      emit: (type, error) => emit(type, error === undefined ? undefined : { error }),
    });
  }
  const session = sessionRef.current;
  const [sessionState, setSessionState] = useState<SessionState>(session.getState);
  useEffect(() => {
    setSessionState(session.getState());
    const unsubscribe = session.subscribe(() => setSessionState(session.getState()));
    // Not gated on the shop loading: a stored session is restored offline too.
    void session.restore();
    return unsubscribe;
  }, [session]);

  /**
   * Alert copy and cart rules, re-applied whenever the host passes new ones so a
   * Live Layer publish lands without a re-init. `config` values are the base;
   * the props win, which is what makes the panel's value authoritative.
   */
  const resolvedMessages = useMemo(
    () => ({ ...(config.messages ?? {}), ...(messages ?? {}) }),
    [config.messages, messages],
  );
  const resolvedPolicy = cartPolicy ?? config.cart;
  const resolvedTranslate = translate ?? config.translate;

  /**
   * Applied DURING render, not in an effect. The context value below reports the
   * resolved limit in this same pass, and an effect-queued write would leave
   * `cart.maxLineItems` at null until some unrelated re-render happened to
   * recompute it. These are idempotent writes to module singletons, so a
   * StrictMode double render costs nothing.
   */
  const appliedRef = useRef<{
    messages: AlertMessages;
    policy: CartPolicy | undefined;
    translate: MessageResolver | undefined;
  } | null>(null);
  if (!appliedRef.current || appliedRef.current.messages !== resolvedMessages) {
    shopify.alerts.setMessages(resolvedMessages);
  }
  if (!appliedRef.current || appliedRef.current.policy !== resolvedPolicy) {
    shopify.alerts.setPolicy(resolvedPolicy);
  }
  if (!appliedRef.current || appliedRef.current.translate !== resolvedTranslate) {
    setMessageResolver(resolvedTranslate);
  }
  appliedRef.current = {
    messages: resolvedMessages,
    policy: resolvedPolicy,
    translate: resolvedTranslate,
  };

  /**
   * The config, set during the first render rather than waiting for `init` in the effect below:
   * children's first render can then read the product store (its keys depend on store and
   * market), so a product page or grid paints from cache on frame one. Children's effects also run
   * before this provider's, and with the config set their reads can start at once.
   */
  if (!isConfigured()) {
    try {
      setConfig(config);
    } catch {
      // A bad config is reported by `init` below, where it has always been reported.
    }
  }

  /**
   * The store's web domains, for `openWebPage` and `isStoreWebLink` (0.21.0). Set during render for the
   * same reason, so a tap on the first frame already knows them, and set again whenever the host passes
   * others: the config above is set once, and `init` runs once.
   */
  const appliedWebDomains = useRef<{ domains: string[] | undefined } | null>(null);
  if (!appliedWebDomains.current || appliedWebDomains.current.domains !== config.webDomains) {
    setStoreWebDomains(config.webDomains);
    appliedWebDomains.current = { domains: config.webDomains };
  }

  /**
   * Re-applies what the render above already applied. `shopify.init()` sets both
   * from `config` for the benefit of non-React consumers, so it runs AFTER this
   * render and would otherwise clobber the props with the config's (often
   * absent) values — the props are the authority.
   */
  const reapplyAlertConfig = useCallback(() => {
    const applied = appliedRef.current;
    if (!applied) return;
    shopify.alerts.setMessages(applied.messages);
    shopify.alerts.setPolicy(applied.policy);
    setMessageResolver(applied.translate);
  }, []);


  /**
   * Shopify rejects concurrent writes to one cart ("The cart conflicted with another request"), so
   * every mutation waits for the one before it. The chain is never poisoned by a failure: the next
   * write runs either way, while the caller still sees its own error.
   */
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = useCallback(<T,>(write: () => Promise<T>): Promise<T> => {
    const run = writeQueue.current.then(write, write);
    writeQueue.current = run.catch(() => undefined);
    return run;
  }, []);

  const attributionOn = useRef(false);
  attributionOn.current = !!attribution?.enabled;
  const recorderRef = useRef<ReturnType<typeof createAttributionRecorder> | null>(null);
  if (!recorderRef.current) {
    recorderRef.current = createAttributionRecorder({
      enabled: () => attributionOn.current,
      serialize,
      storage: () => storageRef.current,
      write: (cartId, attrs) => shopify.cart.updateAttributes(cartId, attrs),
      onWritten: (next) => persistCartRef.current(next),
    });
  }
  const recorder = recorderRef.current;
  const recoveryRef = useRef<ReturnType<typeof createCartRecovery> | null>(null);
  if (!recoveryRef.current) {
    recoveryRef.current = createCartRecovery({
      storage: () => storageRef.current,
      newCartAttributes: () => newCartAttributes(),
      restoreAttributes: (base) => recorder.restoreAttributes(base),
      current: () => cartRef.current,
      persist: (next) => persistCartRef.current(next),
      onRecovered: (recovered, next) => emit("cart:recovered", { cart: next, recovery: recovered }),
    });
  }
  const recovery = recoveryRef.current;
  // The cart the last write returned, for work queued behind it that must not read a stale render.
  const cartRef = useRef<Cart | null>(null);

  // ── Holds that run out (0.19.0, ENG-695) ── Told once at that moment, on any screen, and the cart read
  // again after (`holdEndWatch.ts`). Every cart the provider shows is handed to it (`persistCart`, and the
  // cart loaded at launch).
  const extensionsRef = useRef(cartExtensions);
  extensionsRef.current = cartExtensions;
  const announceHoldEnds = useRef(true);
  announceHoldEnds.current = reservationExpiredAlert?.enabled !== false;
  /** `refresh`, defined further down. */
  const readCartRef = useRef<() => Promise<Cart | null>>(async () => null);
  const holdWatchRef = useRef<HoldEndWatch | null>(null);
  if (!holdWatchRef.current) {
    holdWatchRef.current = createHoldEndWatch({
      extensions: () => extensionsRef.current,
      announcing: () => announceHoldEnds.current,
      announce: (heldCart) => emit("cart:reservationExpired", { cart: heldCart }),
      readCart: () => readCartRef.current(),
    });
  }
  const holdWatch = holdWatchRef.current;
  // Stopped when the provider unmounts; started again from the cart it shows (React's dev double mount).
  useEffect(() => {
    holdWatch.follow(cartRef.current);
    return () => holdWatch.stop();
  }, [holdWatch]);

  /**
   * A guard is advisory: a hook that throws must not take the cart down with it. `fallback` is what
   * that failure means — approval for the `before*` hooks, nothing for the observers.
   */
  const runGuard = useCallback(async <T,>(work: () => T | Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch (guardError) {
      console.warn("[ShopifyProvider] cartGuard failed; continuing", guardError);
      return fallback;
    }
  }, []);

  const approveAdd = useCallback(async (
    input: CartLineInput,
    options?: { quiet?: boolean },
  ): Promise<CartLineInput | null> => {
    const guard = guardRef.current;
    if (!guard?.beforeAdd) return input;
    const approved = await runGuard(() => guard.beforeAdd!(input, options), input);
    // A guard that rebuilds the input must not lose where it came from.
    return approved && !approved.source && input.source ? { ...approved, source: input.source } : approved;
  }, [runGuard]);

  /**
   * Hands back units the guard approved for a write that then didn't land. An add passes its approved
   * input (the guard's receipt rides on its attributes); an increase passes the line it was to grow.
   */
  const releaseRejected = useCallback((input: CartLineInput, line: CartLine | null = null) => {
    const guard = guardRef.current;
    if (!guard?.onReleased) return;
    void runGuard(
      () =>
        guard.onReleased!({
          variantId: input.merchandiseId,
          quantity: input.quantity,
          reason: "rejected",
          line,
          ...(line ? {} : { input }),
          cart: null,
        }),
      undefined,
    );
  }, [runGuard]);

  const announceLanded = useCallback((input: CartLineInput, next: Cart) => {
    const guard = guardRef.current;
    if (!guard?.onLanded) return;
    void runGuard(
      () =>
        guard.onLanded!({
          variantId: input.merchandiseId,
          quantity: input.quantity,
          line: lineFor(next, input),
          cart: next,
        }),
      undefined,
    );
  }, [runGuard]);

  // Recently viewed is on the device: read when the provider mounts, without waiting for the shop to
  // load, so a product page opened at once records into the stored list (0.17.0).
  useEffect(() => {
    void shopify.recentlyViewed.init({
      storage: recentlyViewed?.storage ?? storageRef.current ?? undefined,
      storageKey: recentlyViewed?.storageKey,
      limit: recentlyViewed?.limit,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await shopify.init(config);
        reapplyAlertConfig();

        // The wishlist first, on its own: it is on the device, so it loads with no network, and a
        // cart that can't load (offline) must not take it down with it.
        try {
          const initialItems = await shopify.wishlist.init({
            storage: storageRef.current ?? undefined,
            storageKey: wishlistStorageKey,
            migrateFrom: wishlistMigrateFrom,
            keepDeleted: wishlistKeepDeleted,
            hydrateOnInit: wishlistHydrateOnInit,
            batchSize: wishlistBatchSize,
          });
          if (mounted) setWlItems(initialItems);
          wlUnsubRef.current = shopify.wishlist.onChange((items) => {
            if (mounted) setWlItems(items);
          });
        } catch (e) {
          console.error("[ShopifyProvider] wishlist init failed", e);
        }
        // The waitlist the same way, for the same reason.
        try {
          const initialWaitlist = await shopify.waitlist.init({
            storage: storageRef.current ?? undefined,
            storageKey: waitlistStorageKey,
            migrateFrom: waitlistMigrateFrom,
          });
          if (mounted) setWtItems(initialWaitlist);
          wtUnsubRef.current = shopify.waitlist.onChange((items) => {
            if (mounted) setWtItems(items);
          });
        } catch (e) {
          console.error("[ShopifyProvider] waitlist init failed", e);
        }

        // The last link's tags before the cart, so a cart created below already carries them; then the
        // link the app was opened with, without waiting for it (0.11.0).
        if (linkTagOptions.current) {
          const s = storageRef.current;
          const stored = s ? readSavedLinkTags(await Promise.resolve(s.getItem(LINK_TAGS_STORAGE_KEY)).catch(() => null)) : null;
          // A link that arrived while storage was read is newer.
          if (stored && !savedLinkTags.current) savedLinkTags.current = stored;
          const opening = linkTagOptions.current.getInitialUrl;
          if (opening) {
            void Promise.resolve()
              .then(opening)
              .then((url) => (url ? saveLinkTagsRef.current(url) : false))
              .catch(() => false);
          }
        }

        setCartLoad(true);
        try {
          const s = storageRef.current;
          const savedId = s ? await Promise.resolve(s.getItem(CART_STORAGE_KEY)) : null;
          const stored = savedId ? await shopify.cart.get(savedId) : null;
          // A stored cart predates this session, so it may have been created in another market.
          let next = stored ? await applyCartAttributes(await pinMarket(stored)) : null;
          if (!next) {
            // A cart created now is already in the configured market — `@inContext` saw to that.
            const replaced = await recovery.replace(savedId);
            next = replaced.cart;
            if (s) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
            if (replaced.reason === "ordered") await recovery.clearCheckoutMark();
          }
          // Both return the cart they were given when they wrote nothing.
          await recovery.saveSnapshot(next, next !== stored);
          cartRef.current = next;
          await recorder.sync(next);
          if (mounted) {
            setCart(next);
            holdWatch.follow(next);
          }
          // A stored cart from before the last link, or a link that landed while the cart loaded.
          void syncLinkTagsRef.current();
        } finally {
          if (mounted) setCartLoad(false);
        }

        if (mounted) setReady(true);
      } catch (e) {
        console.error("[ShopifyProvider] init failed", e);
        if (mounted) {
          setError(e instanceof Error ? e.message : String(e));
          // Ready so downstream UIs render an error state rather than an indefinite spinner.
          setReady(true);
        }
      }
    })();
    return () => {
      mounted = false;
      wlUnsubRef.current?.();
      wtUnsubRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Moves a cart into the configured market when it is not already in it.
   *
   * `@inContext` fixes a cart's currency **at creation**, and nothing later moves it — a re-read in
   * context returns the original currency (verified). So a cart restored from storage, or adopted
   * from the shopper's other device, keeps whatever market it was born in: this store has 189 markets
   * enabled, so a customer with an Indian address gets an INR cart while the app browses in USD.
   * `cartBuyerIdentityUpdate` is the only lever — verified 14600.0 INR → 149.0 USD on one cart.
   *
   * **Guarded by a comparison, not a flag.** That mutation REPLACES the buyer identity rather than
   * merging into it — an email set on the cart comes back null afterwards — so it must not run on a
   * cart that is already correct. `email` and `phone` are re-sent because they are readable;
   * a Storefront `customerAccessToken` is not readable back and cannot be preserved, which is why
   * this only fires when the market genuinely differs.
   *
   * Failure is swallowed: a cart in the wrong currency still beats no cart.
   */
  /**
   * In a ref so the cart callbacks keep their identity when the host passes a new array each
   * render — the same reason `cartGuard` is held this way.
   */
  const cartAttrsRef = useRef<CartAttribute[] | undefined>(cartAttributes);
  cartAttrsRef.current = cartAttributes;

  // ── Link tags (0.11.0) ── In refs, so a new options object each render changes nothing.
  const linkTagOptions = useRef<LinkTagOptions | undefined>(linkTags);
  linkTagOptions.current = linkTags;
  /** The last link's tags as saved. Whether they still count is decided each time they're used. */
  const savedLinkTags = useRef<SavedLinkTags | null>(null);
  const currentLinkTags = useCallback(
    () => liveLinkTags(savedLinkTags.current, linkTagOptions.current?.keepDays ?? 0, Date.now()),
    [],
  );
  /** What a new cart starts with: the provider's `cartAttributes` and the link tags that still count. */
  const newCartAttributes = useCallback((): CartAttribute[] | undefined => {
    const tags = currentLinkTags();
    return tags ? withLinkTags(cartAttrsRef.current ?? [], tags) : cartAttrsRef.current;
  }, [currentLinkTags]);

  /**
   * Backfills the configured attributes onto a cart that is missing them.
   *
   * A stored cart outlives the build that made it, so a shopper who had a cart before these were
   * configured would otherwise keep an attribute-less cart indefinitely — and cart ids persist for
   * weeks. Existing pairs win: only keys the cart does not already carry are added, so a value the
   * cart set for itself is never overwritten by a default.
   *
   * Failure is swallowed, as in `pinMarket`: a cart missing an attribute still beats no cart.
   */
  const applyCartAttributes = useCallback(async (next: Cart): Promise<Cart> => {
    const wanted = cartAttrsRef.current;
    if (!wanted?.length) return next;
    const have = new Set((next.attributes ?? []).map((a) => a.key));
    const missing = wanted.filter((a) => !have.has(a.key));
    if (!missing.length) return next;
    try {
      return await shopify.cart.updateAttributes(next.id, [...(next.attributes ?? []), ...missing]);
    } catch {
      return next;
    }
  }, []);

  const pinMarket = useCallback(async (next: Cart): Promise<Cart> => {
    const country = config.country;
    if (!country || !next.buyerIdentity) return next;
    if ((next.buyerIdentity.countryCode ?? "").toUpperCase() === country.toUpperCase()) return next;
    try {
      return await shopify.cart.setBuyerIdentity(next.id, {
        countryCode: country,
        email: next.buyerIdentity.email ?? undefined,
      });
    } catch {
      return next;
    }
  }, [config.country]);

  /** `written: false` for a cart only read, which must not count as used (`saveSnapshot`). */
  const persistCart = useCallback(async (next: Cart | null, written = true) => {
    latestCart.current = next;
    setCart(next);
    cartRef.current = next;
    holdWatch.follow(next);
    const synced = recorder.sync(next);
    const s = storageRef.current;
    if (s) {
      if (next) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
      else await Promise.resolve(s.removeItem(CART_STORAGE_KEY));
    }
    await recovery.saveSnapshot(next, written);
    await synced;
  }, [recorder, recovery, holdWatch]);
  const persistCartRef = useRef(persistCart);
  persistCartRef.current = persistCart;

  /**
   * Every cart write: queued, and made on the cart as it is when its turn comes (`cartRef`, not a
   * render's), so a write from a callback made before a replacement lands on the replacement. When
   * Shopify says the cart is gone it is replaced right here, before the queue moves on; then
   * `retryOnDeadCart` writes once more on the new cart, and otherwise the original error is thrown.
   * The replacement never queues anything itself, or it would wait on the write it runs inside.
   */
  const writeCart = useCallback(<T,>(
    write: (current: Cart) => Promise<T>,
    options?: { retryOnDeadCart?: boolean; noCart?: T },
  ): Promise<T> =>
    serialize(async () => {
      const current = cartRef.current;
      if (!current) {
        if (options && "noCart" in options) return options.noCart as T;
        throw new Error("[ShopifyProvider] there is no cart to write to");
      }
      try {
        return await write(current);
      } catch (failure) {
        if (!isMissingCartError(failure)) throw failure;
        const live = await recovery.recover(current.id, { confirm: true });
        if (!live || !options?.retryOnDeadCart) throw failure;
        return write(live);
      }
    }), [serialize, recovery]);

  /**
   * `cartLinesAdd` with the cart it was written to: after a replacement that is the new cart before the
   * retried add (empty, or rebuilt with these items in it), so what landed is measured against it.
   * `cartRef` moves on inside the queue, so an add queued behind this one measures from its result.
   */
  const addMeasured = useCallback((lines: CartLineInput[], retryOnDeadCart: boolean) =>
    writeCart(async (current) => {
      const after = await shopify.cart.addLines(current.id, lines);
      cartRef.current = after;
      return { before: current, after };
    }, { retryOnDeadCart }), [writeCart]);

  const ensureCartId = useCallback(async (): Promise<string> => {
    if (cart?.id) return cart.id;
    const created = await shopify.cart.create({ attributes: newCartAttributes() });
    await persistCart(created);
    return created.id;
  }, [cart, persistCart]);

  /**
   * Classifies a failed cart write and emits the matching alert before the error
   * carries on to the caller. Returns true when it was an out-of-stock refusal,
   * which the batch retry treats differently from a dead request.
   */
  const reportCartFailure = useCallback((failure: unknown): boolean => {
    if (isOutOfStockError(failure)) {
      emit("cart:outOfStock", { error: failure });
      return true;
    }
    return false;
  }, [emit]);

  const cartAddLine = useCallback(async (input: CartLineInput): Promise<CartWriteResult> => {
    // The variant's stock, when the caller knows it: Shopify would accept the
    // add and clamp it silently, so the shopper would be told it worked. Before
    // the guard, so a guard that reserves stock (Cart Hold) never reserves for an
    // add that is then refused.
    if (input.maxQuantity != null && !withinCeiling(input.maxQuantity, quantityInCart(cart, input.merchandiseId), input.quantity)) {
      emit("cart:stockLimit");
      return { ok: false, reason: "stock", message: message("cart.noMoreStock"), cart };
    }

    const approved = await approveAdd(input);
    if (!approved) return { ok: false, reason: "guard", cart };

    // Checked before the write so a refusal costs no round trip, and so the
    // shopper reads the configured message rather than a Shopify error.
    if (wouldExceedLineLimit(cart, [approved])) {
      // The guard may have reserved stock for this add; it won't land, so that goes back.
      releaseRejected(approved);
      emit("cart:limitExceeded");
      const max = maxLineItems();
      return {
        ok: false,
        reason: "limit",
        message: max !== null ? limitExceededMessage(max) : undefined,
        cart,
      };
    }

    setCartLoad(true);
    try {
      let measured: { before: Cart; after: Cart };
      try {
        // Inside the catch: a cart that can't be created is an add that didn't land.
        await ensureCartId();
        measured = await addMeasured([approved], true);
      } catch (addError) {
        releaseRejected(approved);
        reportCartFailure(addError);
        throw addError;
      }
      const next = measured.after;
      const [landedQuantity] = landedQuantities(measured.before, next, [approved]);
      await persistCart(next);
      await recovery.clearCheckoutMark();
      if (landedQuantity > 0) {
        const landed = { ...approved, quantity: landedQuantity };
        recorder.addInput(next.id, landed);
        emit("cart:add", { cart: next, changedLines: changesForAdds(next, [landed]) });
        announceLanded(landed, next);
      }
      if (landedQuantity < approved.quantity) {
        // Units the guard held for the part Shopify cut go back.
        releaseRejected({ ...approved, quantity: approved.quantity - landedQuantity });
        emit("cart:stockLimit", {
          clamped: [{ merchandiseId: approved.merchandiseId, requestedQuantity: approved.quantity, landedQuantity }],
        });
      }
      if (landedQuantity === 0) {
        return { ok: false, reason: "clamped", message: message("cart.noMoreStock"), cart: next, landedQuantity };
      }
      return { ok: true, cart: next, landedQuantity };
    } finally {
      setCartLoad(false);
    }
  }, [cart, approveAdd, releaseRejected, announceLanded, ensureCartId, persistCart, emit, reportCartFailure, addMeasured, recovery, recorder]);

  const cartAddLinesDetailed = useCallback(async (
    requested: CartLineInput[],
    options?: { quiet?: boolean },
  ): Promise<CartLinesWriteResult> => {
    const outcomes = (landedFor: (index: number) => number): CartAddOutcome[] =>
      requested.map((input, index) => ({
        merchandiseId: input.merchandiseId,
        requestedQuantity: input.quantity,
        landedQuantity: landedFor(index),
      }));
    if (requested.length === 0) return { ok: true, cart, landedQuantity: 0, lines: [] };
    // Vetted up front so a guard's veto does not cost the other lines their fast path.
    const approvals = await Promise.all(requested.map((input) => approveAdd(input, options)));
    const inputs = approvals.filter((input): input is CartLineInput => input !== null);
    if (inputs.length === 0) return { ok: false, reason: "guard", cart, lines: outcomes(() => 0) };

    // The whole batch is judged against the limit, not line by line — landing
    // half a "add these 5" is worse than refusing it with the message.
    if (wouldExceedLineLimit(cart, inputs)) {
      inputs.forEach((input) => releaseRejected(input));
      emit("cart:limitExceeded");
      const max = maxLineItems();
      return {
        ok: false,
        reason: "limit",
        message: max !== null ? limitExceededMessage(max) : undefined,
        cart,
        lines: outcomes(() => 0),
      };
    }

    setCartLoad(true);
    try {
      try {
        await ensureCartId();
      } catch (createError) {
        inputs.forEach((input) => releaseRejected(input));
        reportCartFailure(createError);
        throw createError;
      }
      let next: Cart | null = null;
      // Units each input really added (by its index in `inputs`); null for one Shopify refused.
      const landedQuantity: (number | null)[] = inputs.map(() => null);
      try {
        const measured = await addMeasured(inputs, true);
        next = measured.after;
        landedQuantities(measured.before, next, inputs).forEach((units, i) => { landedQuantity[i] = units; });
      } catch (batchError) {
        // A transport or GraphQL failure would fail all N the same way, so retrying it would turn
        // one dead request into N and still end at null. Only line rejections are worth retrying.
        // A gone cart that couldn't be replaced would fail each line the same way.
        if (!isLineRejection(batchError) || isMissingCartError(batchError)) {
          inputs.forEach((input) => releaseRejected(input));
          reportCartFailure(batchError);
          throw batchError;
        }

        // The batch is all-or-nothing, so retry one line at a time and keep the successes. They
        // accumulate server-side, so `next` ends up holding the whole accepted set.
        let anyOutOfStock = false;
        for (let i = 0; i < inputs.length; i += 1) {
          const input = inputs[i];
          try {
            const measured = await addMeasured([input], false);
            next = measured.after;
            [landedQuantity[i]] = landedQuantities(measured.before, next, [input]);
          } catch (lineError) {
            releaseRejected(input);
            if (isOutOfStockError(lineError)) anyOutOfStock = true;
            // Anything but a rejection means the retry itself is failing, so stop. So does a gone cart:
            // the lines that landed went with it, and the cart is already its replacement.
            if (!isLineRejection(lineError) || isMissingCartError(lineError)) {
              inputs.slice(i + 1).forEach((rest) => releaseRejected(rest));
              reportCartFailure(lineError);
              throw lineError;
            }
          }
        }
        // One alert for the batch: N unsellable lines is one thing that went
        // wrong from the shopper's side, not N toasts. None when quiet: the caller reports it.
        if (anyOutOfStock && !options?.quiet) emit("cart:outOfStock", { error: batchError });
        // Every line individually rejected. Surface the original rather than an empty success,
        // which reads as "nothing to add" instead of "none of this is sellable".
        if (landedQuantity.every((units) => units === null)) throw batchError;
      }
      const landed: CartLineInput[] = [];
      const clamped: CartAddOutcome[] = [];
      inputs.forEach((input, i) => {
        const units = landedQuantity[i];
        if (units === null) return;
        if (units > 0) landed.push({ ...input, quantity: units });
        if (units < input.quantity) {
          // Units the guard held for the part Shopify cut go back.
          releaseRejected({ ...input, quantity: input.quantity - units });
          clamped.push({ merchandiseId: input.merchandiseId, requestedQuantity: input.quantity, landedQuantity: units });
        }
      });
      if (next) {
        await persistCart(next);
        await recovery.clearCheckoutMark();
        const settled = next;
        landed.forEach((input) => recorder.addInput(settled.id, input));
        if (landed.length) emit("cart:add", { cart: settled, changedLines: changesForAdds(settled, landed) });
        landed.forEach((input) => announceLanded(input, settled));
      }
      if (clamped.length && !options?.quiet) emit("cart:stockLimit", { clamped });
      // Back to the caller's inputs: a vetoed one landed nothing.
      let approvedIndex = 0;
      const lines = outcomes((index) => (approvals[index] === null ? 0 : landedQuantity[approvedIndex++] ?? 0));
      const total = lines.reduce((sum, line) => sum + line.landedQuantity, 0);
      if (total === 0) {
        return clamped.length
          ? { ok: false, reason: "clamped", message: message("cart.noMoreStock"), cart: next, landedQuantity: 0, lines }
          : { ok: false, reason: "outOfStock", cart: next, landedQuantity: 0, lines };
      }
      return { ok: true, cart: next, landedQuantity: total, lines };
    } finally {
      setCartLoad(false);
    }
  }, [cart, approveAdd, releaseRejected, announceLanded, ensureCartId, persistCart, emit, reportCartFailure, addMeasured, recovery, recorder]);

  const cartAddLines = useCallback(async (
    requested: CartLineInput[],
    options?: { quiet?: boolean },
  ): Promise<Cart | null> => {
    if (requested.length === 0) return cart;
    const result = await cartAddLinesDetailed(requested, options);
    return result.ok ? result.cart : null;
  }, [cart, cartAddLinesDetailed]);

  const cartSetBuyerIdentity = useCallback(async (identity: {
    email?: string;
    countryCode?: string;
    customerAccessToken?: string;
  }): Promise<boolean> => {
    // Deliberately does NOT create a cart — that would mint an empty one checkout never sees.
    if (!cart?.id) return false;
    setCartLoad(true);
    try {
      const next = await writeCart((current) => shopify.cart.setBuyerIdentity(current.id, identity));
      await persistCart(next);
      emit("cart:buyerIdentity");
      return true;
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, emit, writeCart]);

  const cartUpdateLine = useCallback(async (
    lineId: string,
    quantity: number,
    attributes?: CartLineAttribute[],
    opts?: { source?: AttributionSource },
  ): Promise<boolean> => {
    if (!cart?.id) return false;
    const guard = guardRef.current;
    const previous = cart.lines.find((line) => line.id === lineId) ?? null;
    const delta = previous ? quantity - previous.quantity : 0;

    // Attributes REPLACE the line's set, so the caller's new set keeps the line's private
    // (`_`-prefixed) attributes it didn't mention: those belong to the app's integrations (Cart
    // Hold's expiry stamp is one), not to whoever is editing the visible ones.
    const kept = attributes && previous
      ? previous.attributes.filter((old) => old.key.startsWith("_") && !attributes.some((next) => next.key === old.key))
      : [];
    const nextAttributes = attributes ? [...attributes, ...kept] : undefined;

    // Only an increase can be vetted; a decrease is reported after the fact, once Shopify has
    // actually taken the units back.
    let update: CartLineUpdateInput = { id: lineId, quantity, ...(nextAttributes ? { attributes: nextAttributes } : {}) };
    if (previous && delta > 0 && guard?.beforeIncrease) {
      const approved = await runGuard(() => guard.beforeIncrease!(previous, quantity), update);
      if (!approved) return false;
      // The guard's answer wins, but attributes it didn't return are the caller's, not dropped.
      update = { ...approved, ...(approved.attributes === undefined && nextAttributes ? { attributes: nextAttributes } : {}) };
    }

    // At 0 the shopper is taking the line out: a hold that runs out meanwhile isn't announced.
    const lineLeft = update.quantity <= 0 ? holdWatch.lineLeaving(lineId) : null;
    setCartLoad(true);
    try {
      let next: Cart;
      try {
        next = await writeCart((current) => shopify.cart.updateLines(current.id, [update]));
      } catch (updateError) {
        if (previous && delta > 0) {
          releaseRejected({ merchandiseId: previous.merchandise.id, quantity: delta }, previous);
        }
        reportCartFailure(updateError);
        throw updateError;
      }
      await persistCart(next);
      await recovery.clearCheckoutMark();
      recorder.changeLine(next.id, previous, previous ? update.quantity - previous.quantity : 0, opts?.source);
      // A quantity change is not one of the panel's alerts — emitted as a state
      // signal so a host can refresh a badge, with no copy attached.
      // The line as it is now; gone at 0, so the line as it was.
      const lineNow = next.lines.find((line) => line.id === lineId) ?? previous;
      emit("cart:update", {
        cart: next,
        changedLines: previous && lineNow ? [{ line: lineNow, quantityChange: update.quantity - previous.quantity }] : [],
      });
      if (previous && delta < 0 && guard?.onReleased) {
        void runGuard(
          () =>
            guard.onReleased!({
              variantId: previous.merchandise.id,
              quantity: -delta,
              reason: "decreased",
              line: previous,
              cart: next,
            }),
          undefined,
        );
      }
      return true;
    } finally {
      lineLeft?.();
      setCartLoad(false);
    }
  }, [cart, persistCart, runGuard, releaseRejected, emit, reportCartFailure, writeCart, recovery, recorder, holdWatch]);

  const cartRemoveLine = useCallback(async (lineId: string) => {
    if (!cart?.id) return;
    const guard = guardRef.current;
    const previous = cart.lines.find((line) => line.id === lineId) ?? null;
    // A hold that runs out while the remove is on its way isn't announced: the shopper took it out first.
    const lineLeft = holdWatch.lineLeaving(lineId);
    setCartLoad(true);
    try {
      const next = await writeCart((current) => shopify.cart.removeLines(current.id, [lineId]));
      await persistCart(next);
      await recovery.clearCheckoutMark();
      recorder.changeLine(next.id, previous, -(previous?.quantity ?? 0));
      // The panel's "Removed From Cart" alert. Previously nothing fired here, so
      // the configured copy had no trigger at all.
      emit("cart:remove", {
        cart: next,
        changedLines: previous ? [{ line: previous, quantityChange: -previous.quantity }] : [],
      });
      if (previous && guard?.onReleased) {
        void runGuard(
          () =>
            guard.onReleased!({
              variantId: previous.merchandise.id,
              quantity: previous.quantity,
              reason: "removed",
              line: previous,
              cart: next,
            }),
          undefined,
        );
      }
    } finally {
      lineLeft();
      setCartLoad(false);
    }
  }, [cart, persistCart, runGuard, emit, writeCart, recovery, recorder, holdWatch]);

  const cartApplyDiscounts = useCallback(async (codes: string[]) => {
    if (!cart?.id) return;
    setCartLoad(true);
    try {
      const next = await writeCart((current) => shopify.cart.applyDiscountCodes(current.id, codes));
      await persistCart(next);
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, writeCart]);

  const cartUpdateNote = useCallback(async (note: string | null) => {
    if (!cart?.id) return;
    setCartLoad(true);
    try {
      // Serialized with the line writes: a note landing between an add and its response would be
      // applied to a cart the provider is about to replace, and the note would vanish.
      const next = await writeCart((current) => shopify.cart.updateNote(current.id, note));
      await persistCart(next);
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, writeCart]);

  const cartAddGiftCardCodes = useCallback(async (codes: string[]): Promise<Cart | null> => {
    if (!cart?.id || codes.length === 0) return cart ?? null;
    setCartLoad(true);
    try {
      const { cart: next, notApplied } = await writeCart(async (current) => {
        const signedIn = session.getState().kind !== null;
        return addGiftCardsKeepingBuyer(current, codes, {
          countryCode: async () => config.country || (await shopify.shop.countryCode()) || "US",
          // Signed in: the identity write keeps the cart linked to the shopper (it replaces the identity).
          customerAccessToken: signedIn ? await session.getAccessToken().catch(() => null) : null,
        });
      });
      await persistCart(next);
      if (notApplied.length) {
        const message = `Shopify didn't apply the gift card ending in ${notApplied.map((code) => code.slice(-4)).join(", ")}`;
        throw new ShopifyError(message, [{ field: ["giftCardCodes"], message, code: "GIFT_CARD_NOT_APPLIED" }]);
      }
      return next;
    } finally {
      setCartLoad(false);
    }
  }, [cart, config.country, persistCart, writeCart, session]);

  const cartRemoveGiftCards = useCallback(async (appliedGiftCardIds: string[]): Promise<Cart | null> => {
    if (!cart?.id) return null;
    if (appliedGiftCardIds.length === 0) return cart;
    setCartLoad(true);
    try {
      const next = await writeCart((current) => shopify.cart.removeGiftCardCodes(current.id, appliedGiftCardIds));
      await persistCart(next);
      return next;
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, writeCart]);

  const cartRefresh = useCallback(async (): Promise<Cart | null> => {
    const id = cartRef.current?.id;
    if (!id) return null;
    const next = await shopify.cart.get(id);
    if (next) {
      await persistCart(next, false);
      return next;
    }
    // Queued, so it can't run alongside a write's own replacement of the same cart.
    return serialize(() => recovery.recover(id, { confirm: false }));
  }, [persistCart, serialize, recovery]);
  readCartRef.current = cartRefresh;

  /**
   * Makes the cart's link tags the saved ones that still count: a newer link's replace an older
   * link's, and every other attribute is kept. Nothing when none still count, so tags that ran out stay
   * on a cart that already has them (decided 2026-10-08, Head of Engineering: "Leave them on"). Queued
   * behind pending cart writes; no request when the cart already has them. Never throws: false when
   * the write failed or there's no cart yet.
   */
  const syncLinkTags = useCallback(async (): Promise<boolean> => {
    const tags = currentLinkTags();
    if (!tags) return true;
    try {
      return await writeCart(async (current) => {
        const have = current.attributes ?? [];
        if (cartHasLinkTags(have, tags)) return true;
        await persistCart(await shopify.cart.updateAttributes(current.id, withLinkTags(have, tags)));
        return true;
      }, { noCart: false });
    } catch (syncError) {
      console.warn("[ShopifyProvider] link tags cart write failed", syncError);
      return false;
    }
  }, [currentLinkTags, writeCart, persistCart]);
  const syncLinkTagsRef = useRef(syncLinkTags);
  syncLinkTagsRef.current = syncLinkTags;

  const saveLinkTags = useCallback(async (url: string): Promise<boolean> => {
    if (!((linkTagOptions.current?.keepDays ?? 0) > 0)) return false;
    const tags = linkTagsFrom(url);
    if (!tags) return false;
    const record: SavedLinkTags = { savedAt: Date.now(), tags };
    savedLinkTags.current = record;
    const s = storageRef.current;
    if (s) {
      await Promise.resolve(s.setItem(LINK_TAGS_STORAGE_KEY, JSON.stringify(record))).catch((saveError) =>
        console.warn("[ShopifyProvider] link tags not saved", saveError),
      );
    }
    await syncLinkTags();
    return true;
  }, [syncLinkTags]);
  const saveLinkTagsRef = useRef(saveLinkTags);
  saveLinkTagsRef.current = saveLinkTags;

  // Each link that reaches the running app. The host passes the same `subscribe` every render.
  const subscribeToLinks = linkTags?.subscribe;
  useEffect(() => {
    if (!subscribeToLinks) return;
    return subscribeToLinks((url) => {
      void saveLinkTagsRef.current(url);
    });
  }, [subscribeToLinks]);

  const cartAdopt = useCallback(async (cartId: string): Promise<Cart | null> => {
    // Adopted from the shopper's other device or the web store, so its market is not ours to assume.
    const fetched = await shopify.cart.get(cartId);
    const next = fetched ? await applyCartAttributes(await pinMarket(fetched)) : null;
    if (next) {
      await persistCart(next, next !== fetched);
      // This phone's link tags go with it, as on any cart of this phone's (0.11.0).
      await syncLinkTags();
    }
    return cartRef.current ?? next;
  }, [persistCart, pinMarket, applyCartAttributes, syncLinkTags]);

  const cartFlushAttribution = useCallback(() => recorder.flushPending(), [recorder]);

  const cartEnsureAttributes = useCallback(async (pairs: CartAttribute[]): Promise<boolean> => {
    try {
      return await writeCart(async (current) => {
        const have = current.attributes;
        if (pairs.every((pair) => have.some((a) => a.key === pair.key && a.value === pair.value))) return true;
        const keys = new Set(pairs.map((pair) => pair.key));
        await persistCart(await shopify.cart.updateAttributes(current.id, [...have.filter((a) => !keys.has(a.key)), ...pairs]));
        return true;
      }, { noCart: false });
    } catch (ensureError) {
      console.warn("[ShopifyProvider] cart attribute write failed", ensureError);
      return false;
    }
  }, [writeCart, persistCart]);

  const cartReset = useCallback(async () => {
    const created = await shopify.cart.create({ attributes: newCartAttributes() });
    await persistCart(created);
  }, [persistCart]);

  // The wishlist module owns storage and hydration; these just wrap the mutating methods and
  // rely on onChange to keep React in sync.
  const wlAdd     = useCallback(async (p: Product | string) => {
    await (shopify.wishlist.add as any)(p);
    emit("wishlist:add", { productId: typeof p === "string" ? p : p.id });
  }, [emit]);
  // `remove` emits too. It used not to, so "Removed From Wishlist" only ever
  // fired via `toggle` — a dedicated remove button showed nothing.
  const wlRemove  = useCallback(async (id: string, options?: { silent?: boolean }) => {
    const removed = await shopify.wishlist.remove(id);
    if (removed) emit("wishlist:remove", { productId: id, silent: options?.silent });
  }, [emit]);
  const wlToggle  = useCallback(async (p: Product | string) => {
    const nowSaved = await (shopify.wishlist.toggle as any)(p);
    emit(nowSaved ? "wishlist:add" : "wishlist:remove", { productId: typeof p === "string" ? p : p.id });
    return nowSaved;
  }, [emit]);
  const wlClear   = useCallback(async ()                    => { await shopify.wishlist.clear(); },    []);
  const wlRefresh = useCallback(async ()                    => { await shopify.wishlist.refresh({ keepDeleted: wishlistKeepDeleted }); },  [wishlistKeepDeleted]);
  const wlHas     = useCallback((id: string)                => shopify.wishlist.has(id),               []);
  const wlIds     = useMemo(() => wlItems.map((item) => item.productId), [wlItems]);

  // The waitlist module owns storage and fetching, as the wishlist's does.
  const wtAdd     = useCallback(async (entry: WaitlistEntryInput) => { await shopify.waitlist.add(entry); emit("waitlist:add"); }, [emit]);
  const wtRemove  = useCallback(async (variantId: string) => {
    if (await shopify.waitlist.remove(variantId)) emit("waitlist:remove");
  }, [emit]);
  const wtRefresh = useCallback(async () => { await shopify.waitlist.refresh(); }, []);
  const wtHas     = useCallback((variantId: string) => shopify.waitlist.has(variantId), []);
  const wtIds     = useMemo(() => wtItems.map((item) => item.variantId), [wtItems]);

  // ── Checkout outcome ────────────────────────────────────────────────────────

  const checkoutOrderPlaced = useCallback(async (details?: {
    orderId?: string;
    orderNumber?: string | number;
  }): Promise<void> => {
    // The order's details travel in `error`, where hosts have always read them.
    emit("checkout:orderPlaced", { error: details });
    // The old cart is spent once an order exists; keeping it would show the
    // shopper their purchased items still sitting in the bag.
    try {
      await cartReset();
    } catch (resetError) {
      console.warn("[ShopifyProvider] cart reset after order failed", resetError);
    }
  }, [emit, cartReset]);

  // Read from storage rather than `cart` so the callback keeps one identity across cart changes.
  const checkoutStarted = useCallback(async (): Promise<void> => {
    const s = storageRef.current;
    if (!s) return;
    try {
      const cartId = await Promise.resolve(s.getItem(CART_STORAGE_KEY));
      if (cartId) await Promise.resolve(s.setItem(CHECKOUT_STARTED_KEY, cartId));
    } catch (markError) {
      console.warn("[ShopifyProvider] checkout mark write failed", markError);
    }
  }, []);

  const checkoutPaymentFailed = useCallback((paymentError?: unknown): void => {
    emit("checkout:paymentFailed", { error: paymentError });
  }, [emit]);

  // Every step handed in from here, so `prepareCheckout` is tested without React (test/checkout-prepare).
  const checkoutPrepare = useCallback((options?: PrepareCheckoutOptions): Promise<CheckoutPreparation> =>
    prepareCheckout({
      readCartAgain: cartRefresh,
      // A read that fails carries on with the cart in hand ("Carry on", 2026-10-06).
      cartAlreadyLoaded: () => latestCart.current,
      signedIn: sessionState.kind !== null,
      email: sessionState.customer?.email ?? null,
      getAccessToken: session.getAccessToken,
      setBuyerIdentity: cartSetBuyerIdentity,
      reportCheckoutStarted: checkoutStarted,
      // The cart's attribution lands first, then the provider's own cartAttributes (Freckled Poppy's
      // labelCartForCheckout). Each queued behind pending cart writes.
      flushAttribution: cartFlushAttribution,
      // Then the link tags that still count, a newer link's in place of an older one's (0.11.0).
      ensureCartAttributes: async () => {
        const fixed = cartAttrsRef.current?.length ? await cartEnsureAttributes(cartAttrsRef.current) : true;
        const tagged = await syncLinkTags();
        return fixed && tagged;
      },
    }, {
      ...options,
      // The cart extensions answer when the caller doesn't (0.14.0), so every checkout entry waits for a
      // reservation that ran out, whether or not it knows about Cart Hold.
      hasLapsedHold: options?.hasLapsedHold ?? (cartExtensions.length > 0 ? (lines) => hasLapsedHoldIn(lines, cartExtensions) : undefined),
    }), [cartRefresh, cartSetBuyerIdentity, cartFlushAttribution, cartEnsureAttributes, syncLinkTags, checkoutStarted, sessionState.kind, sessionState.customer?.email, session, cartExtensions]);

  // useCartPage's two events (0.14.0): the analytics SDK reports them (view cart; initiate checkout).
  const reportCartViewed = useCallback((viewedCart: Cart | null) => {
    emit("cart:viewed", viewedCart ? { cart: viewedCart } : undefined);
  }, [emit]);
  const reportCartCheckoutStarted = useCallback((startedCart: Cart | null) => {
    emit("checkout:started", startedCart ? { cart: startedCart, shows: showsInCart(startedCart) } : { shows: showsInCart(null) });
  }, [emit]);
  const cartPage = useMemo(
    () => ({ extensions: cartExtensions, reportViewed: reportCartViewed, reportCheckoutStarted: reportCartCheckoutStarted }),
    [cartExtensions, reportCartViewed, reportCartCheckoutStarted],
  );

  const authMethod: AuthMethod = auth?.method ?? "password";
  // A save that worked says so (`auth:profileUpdated`, 0.15.0): production's sheet said nothing.
  const sessionUpdateProfile = session.updateProfile;
  const profileUpdate = useCallback(async (changes: ProfileChanges): Promise<boolean> => {
    const saved = await sessionUpdateProfile(changes);
    if (saved) emit("auth:profileUpdated");
    return saved;
  }, [sessionUpdateProfile, emit]);
  // By its fields, so a host passing a fresh object each render doesn't rebuild the context.
  const storeCreditOptions = useMemo<StoreCreditOptions | null>(
    () => (storeCredit ? { source: storeCredit.source, tileCreditBaseUrl: storeCredit.tileCreditBaseUrl } : null),
    [storeCredit?.source, storeCredit?.tileCreditBaseUrl],
  );

  const value = useMemo<ShopifyContextType>(() => ({
    ready, error,
    message: filledMessage,
    events,
    report: emit,
    deviceStorage: storageRef.current,
    gridColumnsStorageKey,
    productsPerPage: pageSizeSetting,
    quickAddStraightToCart,
    attributionEnabled: !!attribution?.enabled,
    cart: {
      cart, loading: cartLoading, itemCount: cart?.totalQuantity ?? 0,
      lineCount:          cart?.lines.length ?? 0,
      maxLineItems:       maxLineItems(),
      addLine:            cartAddLine,
      addLines:           cartAddLines,
      addLinesDetailed:   cartAddLinesDetailed,
      updateLine:         cartUpdateLine,
      removeLine:         cartRemoveLine,
      applyDiscountCodes: cartApplyDiscounts,
      updateNote: cartUpdateNote,
      setBuyerIdentity:   cartSetBuyerIdentity,
      addGiftCardCodes:   cartAddGiftCardCodes,
      removeGiftCards:    cartRemoveGiftCards,
      refresh:            cartRefresh,
      adopt:              cartAdopt,
      reset:              cartReset,
      flushAttribution:   cartFlushAttribution,
      ensureCartAttributes: cartEnsureAttributes,
      saveLinkTags,
    },
    wishlist: {
      items:        wlItems,
      ids:          wlIds,
      count:        wlItems.length,
      has:          wlHas,
      isWishlisted: wlHas,
      add:          wlAdd,
      remove:       wlRemove,
      toggle:       wlToggle,
      clear:        wlClear,
      refresh:      wlRefresh,
    },
    waitlist: {
      items:   wtItems,
      ids:     wtIds,
      count:   wtItems.length,
      has:     wtHas,
      add:     wtAdd,
      remove:  wtRemove,
      refresh: wtRefresh,
    },
    customer: {
      customer:    sessionState.customer,
      loggedIn:    sessionState.kind !== null,
      accessToken: sessionState.accessToken,
      loading:     sessionState.loading,
      restoring:   sessionState.restoring,
      method:      authMethod,
      signInSurface: auth?.signInSurface === "webview" ? "webview" : "sheet",
      sessionKind: sessionState.kind,
      login:           session.login,
      signup:          session.signup,
      logout:          session.logout,
      recoverPassword: session.recoverPassword,
      refresh:         session.refresh,
      updateProfile:   profileUpdate,
      signIn:          session.signIn,
      startSignIn:     session.startSignIn,
      getAccessToken:  session.getAccessToken,
      renewAccessToken: session.renewAccessToken,
      request:         session.customerAccountRequest,
    },
    checkout: {
      prepare:             checkoutPrepare,
      reportCheckoutStarted: checkoutStarted,
      reportOrderPlaced:   checkoutOrderPlaced,
      reportPaymentFailed: checkoutPaymentFailed,
    },
    storeCredit: storeCreditOptions,
    cartPage,
  }), [
    ready, error, events, emit, storage, gridColumnsStorageKey, pageSizeSetting,
    // A new policy changes `cart.maxLineItems`, so the memo must see it.
    resolvedPolicy,
    cart, cartLoading, cartAddLine, cartAddLines, cartAddLinesDetailed, cartUpdateLine, cartRemoveLine, cartApplyDiscounts, cartUpdateNote, cartSetBuyerIdentity, cartAddGiftCardCodes, cartRemoveGiftCards, cartRefresh, cartAdopt, cartReset, cartFlushAttribution, cartEnsureAttributes, saveLinkTags,
    wlItems, wlIds, wlHas, wlAdd, wlRemove, wlToggle, wlClear, wlRefresh,
    wtItems, wtIds, wtHas, wtAdd, wtRemove, wtRefresh,
    sessionState, session, authMethod, auth?.signInSurface, profileUpdate, storeCreditOptions,
    checkoutStarted, checkoutOrderPlaced, checkoutPaymentFailed, checkoutPrepare,
    cartPage, quickAddStraightToCart, attribution?.enabled,
  ]);

  return <ShopifyContext.Provider value={value}>{children}</ShopifyContext.Provider>;
}

export function useShopify(): ShopifyContextType {
  const ctx = useContext(ShopifyContext);
  if (!ctx) throw new Error("useShopify must be used within a ShopifyProvider");
  return ctx;
}

export function useCart(): CartState {
  return useShopify().cart;
}

export function useWishlist(): WishlistState {
  return useShopify().wishlist;
}

export function useWaitlist(): WaitlistState {
  return useShopify().waitlist;
}

/** Customer session — the source of the four Login alerts. */
export function useCustomer(): CustomerState {
  return useShopify().customer;
}

/**
 * Where a checkout goes once the cart is ready (0.15.0), for `useCheckout(outcomes).start()`: the app's
 * routes. The SDK never navigates, and the two refusals are its own alerts.
 */
export interface CheckoutOutcomes {
  /** The cart is ready: open the checkout page. */
  onReady?: () => void;
  /** A line's reservation ran out (`lapsedHold`): show the cart, which explains it. */
  onLapsedHold?: () => void;
}

/**
 * Gets the cart ready before checkout opens (`prepare`, with this caller's own `preparing`), and
 * reports a hosted-checkout outcome so the two Checkout alerts can fire. With `outcomes` (0.15.0),
 * `start()` also goes where the answer leads:
 *
 * ```tsx
 * const checkout = useCheckout({ onReady: () => nav.navigate("Checkout"), onLapsedHold: () => nav.navigate("Cart") });
 * <Button onPress={() => void checkout.start()} busy={checkout.preparing} />
 * ```
 */
export function useCheckout(outcomes: CheckoutOutcomes = {}): CheckoutState {
  const { checkout, report } = useShopify();
  // Each caller's own, so only the button that started it shows a spinner.
  const [preparing, setPreparing] = useState(false);
  // Read when called, so `prepare` keeps one identity while the cart changes.
  const latestPrepare = useRef(checkout.prepare);
  latestPrepare.current = checkout.prepare;
  // Read when the answer comes, so routes written inline each render are fine.
  const latestOutcomes = useRef(outcomes);
  latestOutcomes.current = outcomes;
  const prepare = useCallback(async (options?: PrepareCheckoutOptions): Promise<CheckoutPreparation> => {
    setPreparing(true);
    try {
      return await latestPrepare.current(options);
    } finally {
      setPreparing(false);
    }
  }, []);
  const follow = useCallback(async (preparation: Promise<CheckoutPreparation> | CheckoutPreparation): Promise<CheckoutPreparation> => {
    const answer = await preparation;
    try {
      if (answer === "ready") latestOutcomes.current.onReady?.();
      if (answer === "lapsedHold") latestOutcomes.current.onLapsedHold?.();
    } catch (routeError) {
      report("checkout:couldNotStart", { error: routeError });
      return "failed";
    }
    if (answer === "empty") report("checkout:reservationExpired");
    if (answer === "failed") report("checkout:couldNotStart");
    return answer;
  }, [report]);
  const start = useCallback((options?: PrepareCheckoutOptions) => follow(prepare(options)), [follow, prepare]);
  return useMemo(() => ({ ...checkout, prepare, preparing, start, follow }), [checkout, prepare, preparing, start, follow]);
}

/**
 * Hears every event the provider raises, from anywhere inside it (0.10): the same events `onEvent`
 * gets, told right after it, in the order they happen. Cart events carry the cart and the lines they
 * changed, so a listener reports from the event rather than waiting for `useCart()` to catch up. The
 * listener is read when an event fires, so a new function each render is fine. It starts hearing once
 * the component has mounted and stops when it unmounts.
 */
export function useShopifyEvents(listener: (event: ShopifyEvent) => void): void {
  const { events } = useShopify();
  const latestListener = useRef(listener);
  latestListener.current = listener;
  useEffect(() => events.subscribe((event) => latestListener.current(event)), [events]);
}

/**
 * Resolved alert copy, for UI that isn't a toast — the empty-wishlist
 * placeholder (`wishlist.empty`) is configurable but has no event.
 */
export function useShopifyMessage(): (key: AlertMessageKey, fill?: Readonly<Record<string, string>>) => string {
  return useShopify().message;
}

export type { CartState, WishlistState, WaitlistState, CustomerState, CheckoutState };
