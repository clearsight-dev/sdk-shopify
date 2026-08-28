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
import { wouldExceedLineLimit, maxLineItems } from "../cartPolicy";
import { classifyAuthFailure, isOutOfStockError, isUserErrorRejection } from "../errors";
import { limitExceededMessage, message, setMessageResolver } from "../messages";
import { ShopifyError } from "../types";
import type {
  AlertMessageKey,
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
  CustomerAccessToken,
  MessageResolver,
  Product,
  ShopifyConfig,
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
   */
  addLines:           (inputs: CartLineInput[]) => Promise<Cart | null>;
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

/**
 * The customer session, so the four Login alerts have somewhere to originate.
 * `shopify.customer.*` stays available for everything else; this owns only what
 * a session needs — the token, who it belongs to, and the events.
 */
interface CustomerState {
  customer: Customer | null;
  /** True once a stored token has been exchanged for a profile. */
  loggedIn: boolean;
  /** The stored access token, for callers that need it (Tile Credit, checkout). */
  accessToken: string | null;
  loading: boolean;
  /** Restoring a stored token on mount — distinct from "logged out". */
  restoring: boolean;
  /** `false` on bad credentials, which emits `auth:loginFailed`. Everything else throws. */
  login:  (email: string, password: string) => Promise<boolean>;
  signup: (input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    acceptsMarketing?: boolean;
  }) => Promise<boolean>;
  /** Always resolves — Shopify refusing the token delete still ends the local session. */
  logout: () => Promise<void>;
  /** Emits `auth:recoverSent`. Shopify does not reveal whether the email exists. */
  recoverPassword: (email: string) => Promise<void>;
  /** Re-reads the profile for the stored token. Null if the token no longer resolves. */
  refresh: () => Promise<Customer | null>;
}

/**
 * Checkout is Shopify-hosted, so the SDK cannot see the outcome itself. The host
 * webview reports it here and gets the configured copy on the event, rather than
 * every app hard-coding "Your order has been placed".
 *
 * A `checkout.observe(url)` helper that classifies the return URL is the next
 * piece of work; this is the seam it will emit through.
 */
interface CheckoutState {
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
  customer: CustomerState;
  checkout: CheckoutState;
  /** Resolved alert copy, for labelling UI that isn't a toast — e.g. the
   *  empty-wishlist placeholder (`wishlist.empty`), which has no event. */
  message:  (key: AlertMessageKey) => string;
}

const ShopifyContext = createContext<ShopifyContextType | undefined>(undefined);

const CART_STORAGE_KEY = "shopify:cart-id:v1";
const CUSTOMER_TOKEN_KEY = "shopify:customer-token:v1";

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
  | "cart:outOfStock"
  | "cart:buyerIdentity"
  | "wishlist:add"
  | "wishlist:remove"
  | "auth:loginSuccess"
  | "auth:loginFailed"
  | "auth:signup"
  | "auth:logout"
  | "auth:recoverSent"
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
}

/** Alert-carrying events and the message key each resolves. */
const EVENT_MESSAGE: Partial<Record<ShopifyEventType, AlertMessageKey>> = {
  "cart:add": "cart.added",
  "cart:remove": "cart.removed",
  "cart:limitExceeded": "cart.limitExceeded",
  "cart:outOfStock": "cart.outOfStock",
  "wishlist:add": "wishlist.added",
  "wishlist:remove": "wishlist.removed",
  "auth:loginSuccess": "auth.loginSuccess",
  "auth:loginFailed": "auth.loginFailed",
  "auth:logout": "auth.loggedOut",
  "auth:recoverSent": "auth.resetLinkSent",
  "checkout:orderPlaced": "checkout.orderPlaced",
  "checkout:paymentFailed": "checkout.paymentFailed",
};

const ERROR_EVENTS: ReadonlySet<ShopifyEventType> = new Set<ShopifyEventType>([
  "cart:limitExceeded",
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
  messages,
  translate,
  cartPolicy,
  cartAttributes,
}: ShopifyProviderProps) {
  const [ready, setReady]           = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [cart, setCart]             = useState<Cart | null>(null);
  const [cartLoading, setCartLoad]  = useState(false);
  const [wlItems, setWlItems]       = useState<WishlistItem[]>([]);
  const [customer, setCustomer]     = useState<Customer | null>(null);
  const [token, setToken]           = useState<string | null>(null);
  const [authLoading, setAuthLoad]  = useState(false);
  const [restoring, setRestoring]   = useState(true);
  const wlUnsubRef                  = useRef<(() => void) | null>(null);

  const storageRef = useRef<WishlistStorageAdapter | null>(null);
  storageRef.current = storage ?? defaultStorage();

  // In a ref so the cart callbacks keep their identity when the host passes a new guard object.
  const guardRef = useRef<CartLineGuard | undefined>(cartGuard);
  guardRef.current = cartGuard;

  // Same for onEvent: a host that passes an inline arrow would otherwise rebuild
  // every cart callback on each render.
  const onEventRef = useRef<((event: ShopifyEvent) => void) | undefined>(onEvent);
  onEventRef.current = onEvent;

  /**
   * Resolves the copy for `type` and hands the event to the host. A throwing
   * listener must not fail the write that triggered it — the mutation already
   * landed, so swallowing here is the only honest option.
   */
  const emit = useCallback((type: ShopifyEventType, error?: unknown) => {
    const listener = onEventRef.current;
    if (!listener) return;
    const key = EVENT_MESSAGE[type];
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
      ...(error === undefined ? {} : { error }),
    };
    try {
      listener(event);
    } catch (listenerError) {
      console.warn("[ShopifyProvider] onEvent threw", listenerError);
    }
  }, []);

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

  const approveAdd = useCallback(async (input: CartLineInput): Promise<CartLineInput | null> => {
    const guard = guardRef.current;
    if (!guard?.beforeAdd) return input;
    return runGuard(() => guard.beforeAdd!(input), input);
  }, [runGuard]);

  /** Hands back units the guard approved for a write that then failed. */
  const releaseRejected = useCallback((input: CartLineInput) => {
    const guard = guardRef.current;
    if (!guard?.onReleased) return;
    void runGuard(
      () =>
        guard.onReleased!({
          variantId: input.merchandiseId,
          quantity: input.quantity,
          reason: "rejected",
          line: null,
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

        setCartLoad(true);
        try {
          const s = storageRef.current;
          const savedId = s ? await Promise.resolve(s.getItem(CART_STORAGE_KEY)) : null;
          let next: Cart | null = null;
          if (savedId) next = await shopify.cart.get(savedId);
          // A stored cart predates this session, so it may have been created in another market.
          if (next) next = await applyCartAttributes(await pinMarket(next));
          if (!next) {
            // A cart created now is already in the configured market — `@inContext` saw to that.
            next = await shopify.cart.create({ attributes: cartAttrsRef.current });
            if (s) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
          }
          if (mounted) setCart(next);
        } finally {
          if (mounted) setCartLoad(false);
        }

        const initialItems = await shopify.wishlist.init({
          storage: storageRef.current ?? undefined,
          keepDeleted: wishlistKeepDeleted,
        });
        if (mounted) setWlItems(initialItems);
        wlUnsubRef.current = shopify.wishlist.onChange((items) => {
          if (mounted) setWlItems(items);
        });

        // Restore a stored session. A token that no longer resolves is dropped
        // silently — an expired login is not a failed one, and firing
        // `auth:loginFailed` on app open would toast at a shopper who did nothing.
        try {
          const s = storageRef.current;
          const savedToken = s ? await Promise.resolve(s.getItem(CUSTOMER_TOKEN_KEY)) : null;
          if (savedToken) {
            const profile = await shopify.customer.profile(savedToken);
            if (mounted && profile) {
              setCustomer(profile);
              setToken(savedToken);
            } else if (s && !profile) {
              await Promise.resolve(s.removeItem(CUSTOMER_TOKEN_KEY));
            }
          }
        } catch (sessionError) {
          console.warn("[ShopifyProvider] session restore failed", sessionError);
        } finally {
          if (mounted) setRestoring(false);
        }

        if (mounted) setReady(true);
      } catch (e) {
        console.error("[ShopifyProvider] init failed", e);
        if (mounted) {
          setError(e instanceof Error ? e.message : String(e));
          setRestoring(false);
          // Ready so downstream UIs render an error state rather than an indefinite spinner.
          setReady(true);
        }
      }
    })();
    return () => {
      mounted = false;
      wlUnsubRef.current?.();
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
    setCart(next);
    const s = storageRef.current;
    if (!s) return;
    if (next) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
    else await Promise.resolve(s.removeItem(CART_STORAGE_KEY));
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
      emit("cart:outOfStock", failure);
      return true;
    }
    return false;
  }, [emit]);

  const cartAddLine = useCallback(async (input: CartLineInput): Promise<CartWriteResult> => {
    const approved = await approveAdd(input);
    if (!approved) return { ok: false, reason: "guard", cart };

    // Checked before the write so a refusal costs no round trip, and so the
    // shopper reads the configured message rather than a Shopify error.
    if (wouldExceedLineLimit(cart, [approved])) {
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
      const id = await ensureCartId();
      let next: Cart;
      try {
        next = await serialize(() => shopify.cart.addLines(id, [approved]));
      } catch (addError) {
        releaseRejected(approved);
        reportCartFailure(addError);
        throw addError;
      }
      await persistCart(next);
      emit("cart:add");
      announceLanded(approved, next);
      return { ok: true, cart: next };
    } finally {
      setCartLoad(false);
    }
  }, [cart, approveAdd, releaseRejected, announceLanded, ensureCartId, persistCart, emit, reportCartFailure, serialize]);

  const cartAddLines = useCallback(async (requested: CartLineInput[]): Promise<Cart | null> => {
    if (requested.length === 0) return cart;
    // Vetted up front so a guard's veto does not cost the other lines their fast path.
    const inputs = (await Promise.all(requested.map(approveAdd))).filter(
      (input): input is CartLineInput => input !== null,
    );
    if (inputs.length === 0) return null;

    // The whole batch is judged against the limit, not line by line — landing
    // half a "add these 5" is worse than refusing it with the message.
    if (wouldExceedLineLimit(cart, inputs)) {
      emit("cart:limitExceeded");
      return null;
    }

    setCartLoad(true);
    try {
      const id = await ensureCartId();
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
          inputs.forEach(releaseRejected);
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
              inputs.slice(i + 1).forEach(releaseRejected);
              reportCartFailure(lineError);
              throw lineError;
            }
          }
        }
        // One alert for the batch: N unsellable lines is one thing that went
        // wrong from the shopper's side, not N toasts.
        if (anyOutOfStock) emit("cart:outOfStock", batchError);
        // Every line individually rejected. Surface the original rather than an empty success,
        // which reads as "nothing to add" instead of "none of this is sellable".
        if (landed.length === 0) throw batchError;
      }
      if (next) {
        await persistCart(next);
        emit("cart:add");
        const settled = next;
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

    // Only an increase can be vetted; a decrease is reported after the fact, once Shopify has
    // actually taken the units back.
    let update: CartLineUpdateInput = { id: lineId, quantity, ...(attributes ? { attributes } : {}) };
    if (previous && delta > 0 && guard?.beforeIncrease) {
      const approved = await runGuard(() => guard.beforeIncrease!(previous, quantity), update);
      if (!approved) return false;
      update = approved;
    }

    setCartLoad(true);
    try {
      let next: Cart;
      try {
        next = await serialize(() => shopify.cart.updateLines(cart.id, [update]));
      } catch (updateError) {
        if (previous && delta > 0) {
          releaseRejected({ merchandiseId: previous.merchandise.id, quantity: delta });
        }
        reportCartFailure(updateError);
        throw updateError;
      }
      await persistCart(next);
      // A quantity change is not one of the panel's alerts — emitted as a state
      // signal so a host can refresh a badge, with no copy attached.
      emit("cart:update");
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
      // The panel's "Removed From Cart" alert. Previously nothing fired here, so
      // the configured copy had no trigger at all.
      emit("cart:remove");
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
  const wlAdd     = useCallback(async (p: Product | string) => { await (shopify.wishlist.add as any)(p); emit("wishlist:add"); }, [emit]);
  // `remove` emits too. It used not to, so "Removed From Wishlist" only ever
  // fired via `toggle` — a dedicated remove button showed nothing.
  const wlRemove  = useCallback(async (id: string)          => {
    const removed = await shopify.wishlist.remove(id);
    if (removed) emit("wishlist:remove");
  }, [emit]);
  const wlToggle  = useCallback(async (p: Product | string) => {
    const nowSaved = await (shopify.wishlist.toggle as any)(p);
    emit(nowSaved ? "wishlist:add" : "wishlist:remove");
    return nowSaved;
  }, [emit]);
  const wlClear   = useCallback(async ()                    => { await shopify.wishlist.clear(); },    []);
  const wlRefresh = useCallback(async ()                    => { await shopify.wishlist.refresh({ keepDeleted: wishlistKeepDeleted }); },  [wishlistKeepDeleted]);
  const wlHas     = useCallback((id: string)                => shopify.wishlist.has(id),               []);

  // ── Customer session ────────────────────────────────────────────────────────
  // Wraps `shopify.customer` with token persistence and the four Login alerts.
  // Bad credentials resolve `false` rather than throwing: it is an expected
  // answer to a login form, and every caller would otherwise need a try/catch to
  // tell it apart from the store being unreachable (which still throws).

  const persistToken = useCallback(async (next: string | null) => {
    setToken(next);
    const s = storageRef.current;
    if (!s) return;
    if (next) await Promise.resolve(s.setItem(CUSTOMER_TOKEN_KEY, next));
    else await Promise.resolve(s.removeItem(CUSTOMER_TOKEN_KEY));
  }, []);

  const authLogin = useCallback(async (email: string, password: string): Promise<boolean> => {
    setAuthLoad(true);
    try {
      let accessToken: string;
      try {
        const minted = await shopify.customer.login({ email, password });
        accessToken = minted.accessToken;
      } catch (loginError) {
        // Only a credential problem is a "Login Failed" toast; a network failure
        // is not the shopper's mistake, so it propagates instead.
        if (classifyAuthFailure(loginError) === "unknown") throw loginError;
        emit("auth:loginFailed", loginError);
        return false;
      }
      const profile = await shopify.customer.profile(accessToken);
      await persistToken(accessToken);
      setCustomer(profile);
      emit("auth:loginSuccess");
      return true;
    } finally {
      setAuthLoad(false);
    }
  }, [emit, persistToken]);

  const authSignup = useCallback(async (input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    acceptsMarketing?: boolean;
  }): Promise<boolean> => {
    setAuthLoad(true);
    try {
      let created: { customer: Customer; accessToken: CustomerAccessToken };
      try {
        created = await shopify.customer.signup(input);
      } catch (signupError) {
        if (classifyAuthFailure(signupError) === "unknown") throw signupError;
        emit("auth:loginFailed", signupError);
        return false;
      }
      await persistToken(created.accessToken.accessToken);
      setCustomer(created.customer);
      // Signup mints a token, so the shopper IS logged in — both events fire, and
      // a host that only toasts on `auth:loginSuccess` still says the right thing.
      emit("auth:signup");
      emit("auth:loginSuccess");
      return true;
    } finally {
      setAuthLoad(false);
    }
  }, [emit, persistToken]);

  const authLogout = useCallback(async (): Promise<void> => {
    const current = token;
    setAuthLoad(true);
    try {
      if (current) {
        try {
          await shopify.customer.logout(current);
        } catch (logoutError) {
          // The local session ends regardless — leaving a shopper "logged in"
          // because Shopify was unreachable is the worse failure.
          console.warn("[ShopifyProvider] token delete failed; clearing locally", logoutError);
        }
      }
      await persistToken(null);
      setCustomer(null);
      emit("auth:logout");
    } finally {
      setAuthLoad(false);
    }
  }, [token, emit, persistToken]);

  const authRecover = useCallback(async (email: string): Promise<void> => {
    setAuthLoad(true);
    try {
      await shopify.customer.recoverPassword(email);
      emit("auth:recoverSent");
    } finally {
      setAuthLoad(false);
    }
  }, [emit]);

  const authRefresh = useCallback(async (): Promise<Customer | null> => {
    if (!token) return null;
    const profile = await shopify.customer.profile(token);
    if (!profile) {
      // Token expired or revoked. Clear it silently — see the mount restore.
      await persistToken(null);
      setCustomer(null);
      return null;
    }
    setCustomer(profile);
    return profile;
  }, [token, persistToken]);

  // ── Checkout outcome ────────────────────────────────────────────────────────

  const checkoutOrderPlaced = useCallback(async (details?: {
    orderId?: string;
    orderNumber?: string | number;
  }): Promise<void> => {
    emit("checkout:orderPlaced", details);
    // The old cart is spent once an order exists; keeping it would show the
    // shopper their purchased items still sitting in the bag.
    try {
      await cartReset();
    } catch (resetError) {
      console.warn("[ShopifyProvider] cart reset after order failed", resetError);
    }
  }, [emit, cartReset]);

  const checkoutPaymentFailed = useCallback((paymentError?: unknown): void => {
    emit("checkout:paymentFailed", paymentError);
  }, [emit]);

  const value = useMemo<ShopifyContextType>(() => ({
    ready, error,
    message,
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
      refresh:            cartRefresh,
      adopt:              cartAdopt,
      reset:              cartReset,
    },
    wishlist: {
      items:        wlItems,
      count:        wlItems.length,
      has:          wlHas,
      isWishlisted: wlHas,
      add:          wlAdd,
      remove:       wlRemove,
      toggle:       wlToggle,
      clear:        wlClear,
      refresh:      wlRefresh,
    },
    customer: {
      customer,
      loggedIn:    !!customer,
      accessToken: token,
      loading:     authLoading,
      restoring,
      login:           authLogin,
      signup:          authSignup,
      logout:          authLogout,
      recoverPassword: authRecover,
      refresh:         authRefresh,
    },
    checkout: {
      reportOrderPlaced:   checkoutOrderPlaced,
      reportPaymentFailed: checkoutPaymentFailed,
    },
  }), [
    ready, error,
    // A new policy changes `cart.maxLineItems`, so the memo must see it.
    resolvedPolicy,
    cart, cartLoading, cartAddLine, cartAddLines, cartUpdateLine, cartRemoveLine, cartApplyDiscounts, cartUpdateNote, cartSetBuyerIdentity, cartRefresh, cartAdopt, cartReset,
    wlItems, wlHas, wlAdd, wlRemove, wlToggle, wlClear, wlRefresh,
    customer, token, authLoading, restoring, authLogin, authSignup, authLogout, authRecover, authRefresh,
    checkoutOrderPlaced, checkoutPaymentFailed,
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

/** Customer session — the source of the four Login alerts. */
export function useCustomer(): CustomerState {
  return useShopify().customer;
}

/** Reports a hosted-checkout outcome so the two Checkout alerts can fire. */
export function useCheckout(): CheckoutState {
  return useShopify().checkout;
}

/**
 * Resolved alert copy, for UI that isn't a toast — the empty-wishlist
 * placeholder (`wishlist.empty`) is configurable but has no event.
 */
export function useShopifyMessage(): (key: AlertMessageKey) => string {
  return useShopify().message;
}

export type { CartState, WishlistState, CustomerState, CheckoutState };
