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
import { addGiftCardsKeepingBuyer, toLineSnapshot } from "../cart";
import { prepareCheckout, type CheckoutPreparation, type PrepareCheckoutOptions } from "../checkout";
import { wouldExceedLineLimit, maxLineItems } from "../cartPolicy";
import { quantityInCart, withinCeiling } from "../productPage";
import { isOutOfStockError, isUserErrorRejection } from "../errors";
import { limitExceededMessage, message, setMessageResolver } from "../messages";
import { ShopifyError } from "../types";
import { createCustomerSession, type CustomerSession, type ProfileChanges, type SessionState, type SignupInput } from "../auth/session";
import type {
  AlertMessageKey,
  AuthMethod,
  AuthOptions,
  AlertMessages,
  Cart,
  CartLine,
  CartAttribute,
  CartLineAttribute,
  CartLineGuard,
  CartLineInput,
  CartLineSnapshot,
  CartLineUpdateInput,
  CartPolicy,
  CartWriteResult,
  Customer,
  MessageResolver,
  Product,
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
   * Returns the resulting cart, `null` when nothing landed. One unsellable line fails the whole
   * `cartLinesAdd`, so a rejected batch is retried line by line and the successes are kept.
   *
   * `options.quiet`: the caller reports the outcome itself. Every `cartGuard.beforeAdd` is passed it
   * (so the guard says nothing about a refusal), and the one `cart:outOfStock` the line-by-line retry
   * raises for the lines Shopify refused is not emitted. `cart:add` (something landed) and
   * `cart:limitExceeded` (the line limit refused the whole batch) still are.
   */
  addLines:           (inputs: CartLineInput[], options?: { quiet?: boolean }) => Promise<Cart | null>;
  /**
   * `false` when a `cartGuard` cancelled the increase. `attributes` REPLACE the line's set —
   * Shopify does not merge them — so omit the argument to leave them untouched.
   */
  updateLine:         (lineId: string, quantity: number, attributes?: CartLineAttribute[]) => Promise<boolean>;
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
  remove:       (productId: string) => Promise<void>;
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
  /** `useCheckout()` adds `preparing`, which is each caller's own. */
  checkout: Omit<CheckoutState, "preparing">;
  /** The app's store-credit choice, read by `useStoreCredit`. */
  storeCredit: StoreCreditOptions | null;
  /** Resolved alert copy, for labelling UI that isn't a toast — e.g. the
   *  empty-wishlist placeholder (`wishlist.empty`), which has no event. */
  message:  (key: AlertMessageKey) => string;
  /** Every event the provider raises, for `useShopifyEvents` (0.10). */
  events: { subscribe: (listener: (event: ShopifyEvent) => void) => () => void };
}

const ShopifyContext = createContext<ShopifyContextType | undefined>(undefined);

const CART_STORAGE_KEY = "shopify:cart-id:v1";
const CART_LINES_KEY = "shopify:cart-lines:v1";
const CHECKOUT_STARTED_KEY = "shopify:checkout-started-cart-id:v1";

// Best-effort: the cart write that triggered it has already landed.
async function saveLineSnapshot(s: WishlistStorageAdapter | null, next: Cart | null): Promise<void> {
  if (!s) return;
  try {
    if (next) await Promise.resolve(s.setItem(CART_LINES_KEY, JSON.stringify(toLineSnapshot(next))));
    else await Promise.resolve(s.removeItem(CART_LINES_KEY));
  } catch (snapshotError) {
    console.warn("[ShopifyProvider] cart line snapshot write failed", snapshotError);
  }
}

async function readCheckoutStarted(s: WishlistStorageAdapter | null): Promise<string | null> {
  if (!s) return null;
  try {
    return await Promise.resolve(s.getItem(CHECKOUT_STARTED_KEY));
  } catch {
    return null;
  }
}

async function clearCheckoutStarted(s: WishlistStorageAdapter | null): Promise<void> {
  if (!s) return;
  try {
    await Promise.resolve(s.removeItem(CHECKOUT_STARTED_KEY));
  } catch (markError) {
    console.warn("[ShopifyProvider] checkout mark clear failed", markError);
  }
}

async function loadLineSnapshot(s: WishlistStorageAdapter | null): Promise<CartLineSnapshot[]> {
  if (!s) return [];
  try {
    const raw = await Promise.resolve(s.getItem(CART_LINES_KEY));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (line): line is CartLineSnapshot =>
        typeof line?.merchandiseId === "string" && typeof line?.quantity === "number" && line.quantity > 0,
    );
  } catch {
    return [];
  }
}

/**
 * A new cart holding the lines of one that expired. One `cartCreate` when every line is still
 * sellable; a single refusal fails that whole create, so it is redone as an empty cart plus one add
 * per line, skipping the refused ones. Not a shopper add, so no guard runs and nothing is toasted.
 */
async function createFromSnapshot(lines: CartLineSnapshot[], attributes?: CartAttribute[]): Promise<Cart> {
  const inputs: CartLineInput[] = lines.map((line) => ({
    merchandiseId: line.merchandiseId,
    quantity: line.quantity,
    attributes: line.attributes ?? [],
    ...(line.sellingPlanId ? { sellingPlanId: line.sellingPlanId } : {}),
  }));
  if (inputs.length === 0) return shopify.cart.create({ attributes });
  try {
    return await shopify.cart.create({ attributes, lines: inputs });
  } catch (createError) {
    if (!isLineRejection(createError)) throw createError;
  }
  let next = await shopify.cart.create({ attributes });
  for (const input of inputs) {
    try {
      next = await shopify.cart.addLines(next.id, [input]);
    } catch (lineError) {
      if (isLineRejection(lineError)) continue;
      // A partly restored cart beats failing startup; the snapshot is rewritten from what landed.
      console.warn("[ShopifyProvider] cart restore stopped early", lineError);
      break;
    }
  }
  return next;
}

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
  | "checkout:paymentFailed";

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
  /**
   * The signed-in customer, on `auth:loginSuccess` (0.10). Null when their profile hadn't loaded when
   * the sign-in finished: `useCustomer().customer` has it once it does.
   */
  customer?: Customer | null;
  /** How that session signed in (`useCustomer().sessionKind`), on `auth:loginSuccess` (0.10). */
  sessionKind?: AuthMethod | null;
}

/** One cart line a write changed, on `ShopifyEvent.changedLines`. */
export interface CartLineChange {
  /** The line after the write. For a line the write took out of the cart, the line as it was. */
  line: CartLine;
  /** Units added (above 0) or taken away (below 0). 0 when only the line's attributes changed. */
  quantityChange: number;
}

/** What `emit` attaches to an event besides its type. */
interface EventDetails {
  error?: unknown;
  cart?: Cart;
  changedLines?: CartLineChange[];
  productId?: string;
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
};

const ERROR_EVENTS: ReadonlySet<ShopifyEventType> = new Set<ShopifyEventType>([
  "cart:limitExceeded",
  "cart:stockLimit",
  "cart:outOfStock",
  "auth:loginFailed",
  "checkout:paymentFailed",
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
  /** See `WaitlistInitOptions.storageKey`: an app moving from Apptile's engine passes its old key. */
  waitlistStorageKey?: string;
  /** See `WaitlistInitOptions.migrateFrom`: keys an earlier app kept its waitlist under. */
  waitlistMigrateFrom?: string[];
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
  waitlistStorageKey,
  waitlistMigrateFrom,
  messages,
  translate,
  cartPolicy,
  cartAttributes,
  auth,
  storeCredit,
}: ShopifyProviderProps) {
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
    const key = EVENT_MESSAGE[type];
    // The session has already taken the new customer when it announces the sign-in.
    const signedIn = type === "auth:loginSuccess" ? sessionRef.current?.getState() : undefined;
    const max = maxLineItems();
    const event: ShopifyEvent = {
      type,
      severity: ERROR_EVENTS.has(type) ? "error" : key ? "success" : "info",
      ...(key
        ? {
            messageKey: key,
            message:
              type === "cart:limitExceeded" && max !== null
                ? limitExceededMessage(max)
                : message(key),
          }
        : {}),
      ...(details?.error === undefined ? {} : { error: details.error }),
      ...(details?.cart ? { cart: details.cart } : {}),
      ...(details?.changedLines ? { changedLines: details.changedLines } : {}),
      ...(details?.productId ? { productId: details.productId } : {}),
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
    return runGuard(() => guard.beforeAdd!(input, options), input);
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

        setCartLoad(true);
        try {
          const s = storageRef.current;
          const savedId = s ? await Promise.resolve(s.getItem(CART_STORAGE_KEY)) : null;
          let next: Cart | null = null;
          if (savedId) next = await shopify.cart.get(savedId);
          // A stored cart predates this session, so it may have been created in another market.
          if (next) next = await applyCartAttributes(await pinMarket(next));
          if (!next) {
            const checkedOut = !!savedId && savedId === (await readCheckoutStarted(s));
            // A cart created now is already in the configured market — `@inContext` saw to that.
            next = checkedOut
              ? await shopify.cart.create({ attributes: cartAttrsRef.current })
              : await createFromSnapshot(await loadLineSnapshot(s), cartAttrsRef.current);
            if (s) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
          }
          await saveLineSnapshot(s, next);
          if (mounted) setCart(next);
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

  const persistCart = useCallback(async (next: Cart | null) => {
    latestCart.current = next;
    setCart(next);
    const s = storageRef.current;
    if (!s) return;
    if (next) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
    else await Promise.resolve(s.removeItem(CART_STORAGE_KEY));
    await saveLineSnapshot(s, next);
  }, []);

  const ensureCartId = useCallback(async (): Promise<string> => {
    if (cart?.id) return cart.id;
    const created = await shopify.cart.create({ attributes: cartAttrsRef.current });
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
      let next: Cart;
      try {
        // Inside the catch: a cart that can't be created is an add that didn't land.
        const id = await ensureCartId();
        next = await serialize(() => shopify.cart.addLines(id, [approved]));
      } catch (addError) {
        releaseRejected(approved);
        reportCartFailure(addError);
        throw addError;
      }
      await persistCart(next);
      await clearCheckoutStarted(storageRef.current);
      emit("cart:add", { cart: next, changedLines: changesForAdds(next, [approved]) });
      announceLanded(approved, next);
      return { ok: true, cart: next };
    } finally {
      setCartLoad(false);
    }
  }, [cart, approveAdd, releaseRejected, announceLanded, ensureCartId, persistCart, emit, reportCartFailure, serialize]);

  const cartAddLines = useCallback(async (
    requested: CartLineInput[],
    options?: { quiet?: boolean },
  ): Promise<Cart | null> => {
    if (requested.length === 0) return cart;
    // Vetted up front so a guard's veto does not cost the other lines their fast path.
    const inputs = (await Promise.all(requested.map((input) => approveAdd(input, options)))).filter(
      (input): input is CartLineInput => input !== null,
    );
    if (inputs.length === 0) return null;

    // The whole batch is judged against the limit, not line by line — landing
    // half a "add these 5" is worse than refusing it with the message.
    if (wouldExceedLineLimit(cart, inputs)) {
      inputs.forEach((input) => releaseRejected(input));
      emit("cart:limitExceeded");
      return null;
    }

    setCartLoad(true);
    try {
      let id: string;
      try {
        id = await ensureCartId();
      } catch (createError) {
        inputs.forEach((input) => releaseRejected(input));
        reportCartFailure(createError);
        throw createError;
      }
      let next: Cart | null = null;
      // Which inputs landed, so the guard hears about exactly those.
      let landed: CartLineInput[] = [];
      try {
        next = await serialize(() => shopify.cart.addLines(id, inputs));
        landed = inputs;
      } catch (batchError) {
        // A transport or GraphQL failure would fail all N the same way, so retrying it would turn
        // one dead request into N and still end at null. Only line rejections are worth retrying.
        if (!isLineRejection(batchError)) {
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
            next = await serialize(() => shopify.cart.addLines(id, [input]));
            landed.push(input);
          } catch (lineError) {
            releaseRejected(input);
            if (isOutOfStockError(lineError)) anyOutOfStock = true;
            // Anything but a rejection means the retry itself is failing, so stop.
            if (!isLineRejection(lineError)) {
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
        if (landed.length === 0) throw batchError;
      }
      if (next) {
        await persistCart(next);
        await clearCheckoutStarted(storageRef.current);
        const settled = next;
        emit("cart:add", { cart: settled, changedLines: changesForAdds(settled, landed) });
        landed.forEach((input) => announceLanded(input, settled));
      }
      return next;
    } finally {
      setCartLoad(false);
    }
  }, [cart, approveAdd, releaseRejected, announceLanded, ensureCartId, persistCart, emit, reportCartFailure, serialize]);

  const cartSetBuyerIdentity = useCallback(async (identity: {
    email?: string;
    countryCode?: string;
    customerAccessToken?: string;
  }): Promise<boolean> => {
    // Deliberately does NOT create a cart — that would mint an empty one checkout never sees.
    if (!cart?.id) return false;
    setCartLoad(true);
    try {
      const next = await serialize(() => shopify.cart.setBuyerIdentity(cart.id, identity));
      await persistCart(next);
      emit("cart:buyerIdentity");
      return true;
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, emit, serialize]);

  const cartUpdateLine = useCallback(async (
    lineId: string,
    quantity: number,
    attributes?: CartLineAttribute[],
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

    setCartLoad(true);
    try {
      let next: Cart;
      try {
        next = await serialize(() => shopify.cart.updateLines(cart.id, [update]));
      } catch (updateError) {
        if (previous && delta > 0) {
          releaseRejected({ merchandiseId: previous.merchandise.id, quantity: delta }, previous);
        }
        reportCartFailure(updateError);
        throw updateError;
      }
      await persistCart(next);
      await clearCheckoutStarted(storageRef.current);
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
      setCartLoad(false);
    }
  }, [cart, persistCart, runGuard, releaseRejected, emit, reportCartFailure, serialize]);

  const cartRemoveLine = useCallback(async (lineId: string) => {
    if (!cart?.id) return;
    const guard = guardRef.current;
    const previous = cart.lines.find((line) => line.id === lineId) ?? null;
    setCartLoad(true);
    try {
      const next = await serialize(() => shopify.cart.removeLines(cart.id, [lineId]));
      await persistCart(next);
      await clearCheckoutStarted(storageRef.current);
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
      setCartLoad(false);
    }
  }, [cart, persistCart, runGuard, emit, serialize]);

  const cartApplyDiscounts = useCallback(async (codes: string[]) => {
    if (!cart?.id) return;
    setCartLoad(true);
    try {
      const next = await serialize(() => shopify.cart.applyDiscountCodes(cart.id, codes));
      await persistCart(next);
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, serialize]);

  const cartUpdateNote = useCallback(async (note: string | null) => {
    if (!cart?.id) return;
    setCartLoad(true);
    try {
      // Serialized with the line writes: a note landing between an add and its response would be
      // applied to a cart the provider is about to replace, and the note would vanish.
      const next = await serialize(() => shopify.cart.updateNote(cart.id, note));
      await persistCart(next);
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, serialize]);

  const cartAddGiftCardCodes = useCallback(async (codes: string[]): Promise<Cart | null> => {
    if (!cart?.id || codes.length === 0) return cart ?? null;
    setCartLoad(true);
    try {
      const { cart: next, notApplied } = await serialize(async () => {
        const current = latestCart.current ?? cart;
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
  }, [cart, config.country, persistCart, serialize, session]);

  const cartRemoveGiftCards = useCallback(async (appliedGiftCardIds: string[]): Promise<Cart | null> => {
    if (!cart?.id) return null;
    if (appliedGiftCardIds.length === 0) return cart;
    setCartLoad(true);
    try {
      const next = await serialize(() => shopify.cart.removeGiftCardCodes(cart.id, appliedGiftCardIds));
      await persistCart(next);
      return next;
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, serialize]);

  const cartRefresh = useCallback(async (): Promise<Cart | null> => {
    if (!cart?.id) return null;
    const next = await shopify.cart.get(cart.id);
    if (next) await persistCart(next);
    return next;
  }, [cart, persistCart]);

  const cartAdopt = useCallback(async (cartId: string): Promise<Cart | null> => {
    // Adopted from the shopper's other device or the web store, so its market is not ours to assume.
    const fetched = await shopify.cart.get(cartId);
    const next = fetched ? await applyCartAttributes(await pinMarket(fetched)) : null;
    if (next) await persistCart(next);
    return next;
  }, [persistCart, pinMarket, applyCartAttributes]);

  const cartReset = useCallback(async () => {
    const created = await shopify.cart.create({ attributes: cartAttrsRef.current });
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
  const wlRemove  = useCallback(async (id: string)          => {
    const removed = await shopify.wishlist.remove(id);
    if (removed) emit("wishlist:remove", { productId: id });
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
      // No attribution in this build (it comes with 0.9.1's flushAttribution and ensureCartAttributes),
      // so the cart isn't labelled here. When merging onto origin/main, pass both as the trial merge does.
    }, options), [cartRefresh, cartSetBuyerIdentity, checkoutStarted, sessionState.kind, sessionState.customer?.email, session]);

  const authMethod: AuthMethod = auth?.method ?? "password";
  // By its fields, so a host passing a fresh object each render doesn't rebuild the context.
  const storeCreditOptions = useMemo<StoreCreditOptions | null>(
    () => (storeCredit ? { source: storeCredit.source, tileCreditBaseUrl: storeCredit.tileCreditBaseUrl } : null),
    [storeCredit?.source, storeCredit?.tileCreditBaseUrl],
  );

  const value = useMemo<ShopifyContextType>(() => ({
    ready, error,
    message,
    events,
    cart: {
      cart, loading: cartLoading, itemCount: cart?.totalQuantity ?? 0,
      lineCount:          cart?.lines.length ?? 0,
      maxLineItems:       maxLineItems(),
      addLine:            cartAddLine,
      addLines:           cartAddLines,
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
      sessionKind: sessionState.kind,
      login:           session.login,
      signup:          session.signup,
      logout:          session.logout,
      recoverPassword: session.recoverPassword,
      refresh:         session.refresh,
      updateProfile:   session.updateProfile,
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
  }), [
    ready, error, events,
    // A new policy changes `cart.maxLineItems`, so the memo must see it.
    resolvedPolicy,
    cart, cartLoading, cartAddLine, cartAddLines, cartUpdateLine, cartRemoveLine, cartApplyDiscounts, cartUpdateNote, cartSetBuyerIdentity, cartAddGiftCardCodes, cartRemoveGiftCards, cartRefresh, cartAdopt, cartReset,
    wlItems, wlIds, wlHas, wlAdd, wlRemove, wlToggle, wlClear, wlRefresh,
    wtItems, wtIds, wtHas, wtAdd, wtRemove, wtRefresh,
    sessionState, session, authMethod, storeCreditOptions,
    checkoutStarted, checkoutOrderPlaced, checkoutPaymentFailed, checkoutPrepare,
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
 * Gets the cart ready before checkout opens (`prepare`, with this caller's own `preparing`), and
 * reports a hosted-checkout outcome so the two Checkout alerts can fire.
 */
export function useCheckout(): CheckoutState {
  const checkout = useShopify().checkout;
  // Each caller's own, so only the button that started it shows a spinner.
  const [preparing, setPreparing] = useState(false);
  // Read when called, so `prepare` keeps one identity while the cart changes.
  const latestPrepare = useRef(checkout.prepare);
  latestPrepare.current = checkout.prepare;
  const prepare = useCallback(async (options?: PrepareCheckoutOptions): Promise<CheckoutPreparation> => {
    setPreparing(true);
    try {
      return await latestPrepare.current(options);
    } finally {
      setPreparing(false);
    }
  }, []);
  return useMemo(() => ({ ...checkout, prepare, preparing }), [checkout, prepare, preparing]);
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
export function useShopifyMessage(): (key: AlertMessageKey) => string {
  return useShopify().message;
}

export type { CartState, WishlistState, WaitlistState, CustomerState, CheckoutState };
