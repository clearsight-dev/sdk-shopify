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
import { ShopifyError } from "../types";
import type {
  Cart,
  CartLine,
  CartLineAttribute,
  CartLineGuard,
  CartLineInput,
  CartLineUpdateInput,
  Product,
  ShopifyConfig,
  WishlistItem,
  WishlistStorageAdapter,
} from "../types";

/**
 * Whether Shopify rejected the *contents* of a mutation rather than failing to answer it.
 *
 * `userErrors` are the store's verdict on specific lines — an unsellable variant, a sold-out one —
 * and are carried on `ShopifyError.errors`. Transport failures, HTTP errors and GraphQL errors all
 * arrive with that array empty, which is what separates "this line is no good" from "the request
 * did not work".
 */
function isLineRejection(error: unknown): boolean {
  return error instanceof ShopifyError && error.errors.length > 0;
}

function sameAttributes(a: CartLineAttribute[], b: CartLineAttribute[]): boolean {
  return (
    a.length === b.length &&
    a.every((one) => b.some((other) => other.key === one.key && other.value === one.value))
  );
}

/**
 * The line a just-sent input became. Shopify merges an add into an existing line only when the
 * attributes match too, so an integration that stamps a per-add attribute produces a *new* line for
 * the same variant — hence matching on attributes first, and falling back to the last line for the
 * variant.
 */
function lineFor(cart: Cart, input: CartLineInput): CartLine | null {
  const candidates = cart.lines.filter((line) => line.merchandise?.id === input.merchandiseId);
  if (candidates.length === 0) return null;
  const exact = candidates.find((line) => sameAttributes(input.attributes ?? [], line.attributes));
  return exact ?? candidates[candidates.length - 1];
}

/**
 * Unified Shopify context — thin React wrapper over the SDK client.
 *
 * Framework-agnostic by design: the storage backend is injected by the
 * consumer, so this works in web (window.localStorage) or React Native
 * (pass an AsyncStorage-compatible adapter). Nothing here imports RN
 * or any other platform-specific module.
 */

interface CartState {
  cart: Cart | null;
  loading: boolean;
  itemCount: number;
  /**
   * Resolves `true` when the line landed. A `false` means a `cartGuard` cancelled the add — the
   * cart is unchanged and no `cart:add` was emitted, so callers must not report success (open a
   * confirmation sheet, announce it to a live room). Shopify refusing the line still throws.
   */
  addLine:            (input: CartLineInput) => Promise<boolean>;
  /**
   * Several lines in one go, for reorder-style flows. Returns the resulting cart so the caller can
   * tell what actually landed — `null` when nothing did.
   *
   * Tolerant by design: one line the store will no longer sell fails the whole `cartLinesAdd`, so a
   * rejected batch is retried line by line and whatever the store still accepts is kept. Lines a
   * `cartGuard` cancels are dropped the same way.
   */
  addLines:           (inputs: CartLineInput[]) => Promise<Cart | null>;
  /**
   * `false` when a `cartGuard` cancelled the increase; the cart is unchanged.
   *
   * `attributes` REPLACE the line's set — Shopify does not merge them — so send the existing ones
   * alongside any change. Omit the argument to leave them untouched, which is the common case.
   */
  updateLine:         (lineId: string, quantity: number, attributes?: CartLineAttribute[]) => Promise<boolean>;
  removeLine:         (lineId: string) => Promise<void>;
  applyDiscountCodes: (codes: string[]) => Promise<void>;
  /**
   * Associates a buyer with the cart, so an order is attributed to them and checkout opens already
   * signed in. Returns false when there is no cart yet — nothing to attach to.
   *
   * For **new customer accounts** the Customer Account API access token goes straight into
   * `customerAccessToken`; no exchange for a classic Storefront token is needed.
   */
  setBuyerIdentity: (identity: {
    email?: string;
    countryCode?: string;
    customerAccessToken?: string;
  }) => Promise<boolean>;
  /**
   * Re-reads the cart from Shopify and returns it, so a caller acting on the result does not have to
   * wait for the re-render to see it. Null when there is no cart or it no longer resolves.
   */
  refresh:            () => Promise<Cart | null>;
  reset:              () => Promise<void>;
}

interface WishlistState {
  items:        WishlistItem[];
  count:        number;
  has:          (productId: string) => boolean;
  /** Alias for `has` — kept as an ergonomic name for wishlist UIs. */
  isWishlisted: (productId: string) => boolean;
  add:          (product: Product | string) => Promise<void>;
  remove:       (productId: string) => Promise<void>;
  toggle:       (product: Product | string) => Promise<boolean>;
  clear:        () => Promise<void>;
  refresh:      () => Promise<void>;
}

interface ShopifyContextType {
  ready:    boolean;
  error:    string | null;
  cart:     CartState;
  wishlist: WishlistState;
}

const ShopifyContext = createContext<ShopifyContextType | undefined>(undefined);

const CART_STORAGE_KEY = "shopify:cart-id:v1";

/**
 * Emitted by the provider on a successful commerce mutation, so the host app
 * can react (e.g. show a toast) without wrapping the hooks. Fires only on the
 * happy path.
 */
export type ShopifyEvent =
  | { type: "cart:add" }
  | { type: "cart:buyerIdentity" }
  | { type: "wishlist:add" }
  | { type: "wishlist:remove" };

export interface ShopifyProviderProps {
  children: ReactNode;
  /** Storefront credentials passed straight through to `shopify.init()`. */
  config: ShopifyConfig;
  /**
   * Storage backend used for the cart id and the wishlist. In the browser
   * this defaults to `window.localStorage`; in React Native (or Node) the
   * consumer passes an AsyncStorage-compatible adapter.
   */
  storage?: WishlistStorageAdapter;
  /** Fired on a successful cart/wishlist mutation. */
  onEvent?: (event: ShopifyEvent) => void;
  /**
   * Vets cart writes and observes what landed — see `CartLineGuard`. Sitting on the provider is
   * what makes it unbypassable: every screen reaches the cart through these hooks.
   */
  cartGuard?: CartLineGuard;
  /**
   * Keep wishlist entries whose product no longer resolves, as `product: null`, rather than
   * pruning them. See `WishlistInitOptions.keepDeleted` — recommended for a shopper-facing
   * wishlist, where an unpublished product should come back rather than disappear.
   */
  wishlistKeepDeleted?: boolean;
}

function defaultStorage(): WishlistStorageAdapter | null {
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).localStorage !== "undefined") {
    return (globalThis as any).localStorage as WishlistStorageAdapter;
  }
  return null;
}

export function ShopifyProvider({ children, config, storage, onEvent, cartGuard, wishlistKeepDeleted }: ShopifyProviderProps) {
  const [ready, setReady]           = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [cart, setCart]             = useState<Cart | null>(null);
  const [cartLoading, setCartLoad]  = useState(false);
  const [wlItems, setWlItems]       = useState<WishlistItem[]>([]);
  const wlUnsubRef                  = useRef<(() => void) | null>(null);

  const storageRef = useRef<WishlistStorageAdapter | null>(null);
  storageRef.current = storage ?? defaultStorage();

  // Held in a ref so the cart callbacks do not change identity when the host passes a new guard
  // object, and so a guard swapped mid-session takes effect on the next write.
  const guardRef = useRef<CartLineGuard | undefined>(cartGuard);
  guardRef.current = cartGuard;


  /**
   * Shopify rejects concurrent writes to one cart — "Could not complete operation. The cart
   * conflicted with another request." — so every mutation goes through this queue and waits for the
   * one before it. Two screens, a background sweep and a stepper tap can all reach the cart at once;
   * ordering them here is the only place that covers all of them.
   *
   * The chain is never poisoned by a failure: the next write runs whether its predecessor resolved or
   * threw, while the caller still sees its own error.
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

  // ─── Init the SDK, cart, and wishlist once ────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await shopify.init(config);

        // Cart: restore by id or create
        setCartLoad(true);
        try {
          const s = storageRef.current;
          const savedId = s ? await Promise.resolve(s.getItem(CART_STORAGE_KEY)) : null;
          let next: Cart | null = null;
          if (savedId) next = await shopify.cart.get(savedId);
          if (!next) {
            next = await shopify.cart.create();
            if (s) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
          }
          if (mounted) setCart(next);
        } finally {
          if (mounted) setCartLoad(false);
        }

        // Wishlist: hydrate from storage, background-refresh from API
        const initialItems = await shopify.wishlist.init({
          storage: storageRef.current ?? undefined,
          keepDeleted: wishlistKeepDeleted,
        });
        if (mounted) setWlItems(initialItems);
        wlUnsubRef.current = shopify.wishlist.onChange((items) => {
          if (mounted) setWlItems(items);
        });

        if (mounted) setReady(true);
      } catch (e) {
        console.error("[ShopifyProvider] init failed", e);
        if (mounted) {
          setError(e instanceof Error ? e.message : String(e));
          // Mark ready so downstream UIs can render an error state
          // instead of an indefinite spinner.
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

  // ─── Cart operations ──────────────────────────────────────────────
  const persistCart = useCallback(async (next: Cart | null) => {
    setCart(next);
    const s = storageRef.current;
    if (!s) return;
    if (next) await Promise.resolve(s.setItem(CART_STORAGE_KEY, next.id));
    else await Promise.resolve(s.removeItem(CART_STORAGE_KEY));
  }, []);

  const ensureCartId = useCallback(async (): Promise<string> => {
    if (cart?.id) return cart.id;
    const created = await shopify.cart.create();
    await persistCart(created);
    return created.id;
  }, [cart, persistCart]);

  const cartAddLine = useCallback(async (input: CartLineInput): Promise<boolean> => {
    const approved = await approveAdd(input);
    if (!approved) return false;
    setCartLoad(true);
    try {
      const id = await ensureCartId();
      let next: Cart;
      try {
        next = await serialize(() => shopify.cart.addLines(id, [approved]));
      } catch (addError) {
        releaseRejected(approved);
        throw addError;
      }
      await persistCart(next);
      onEvent?.({ type: "cart:add" });
      announceLanded(approved, next);
      return true;
    } finally {
      setCartLoad(false);
    }
  }, [approveAdd, releaseRejected, announceLanded, ensureCartId, persistCart, onEvent, serialize]);

  const cartAddLines = useCallback(async (requested: CartLineInput[]): Promise<Cart | null> => {
    if (requested.length === 0) return cart;
    // Vetted up front so a cancelled line never reaches the batch — one unsellable line already
    // fails the whole `cartLinesAdd`, and a guard's veto should not cost the others their fast path.
    const inputs = (await Promise.all(requested.map(approveAdd))).filter(
      (input): input is CartLineInput => input !== null,
    );
    if (inputs.length === 0) return null;
    setCartLoad(true);
    try {
      const id = await ensureCartId();
      let next: Cart | null = null;
      // Which inputs actually landed, so the guard hears about exactly those — and about the units
      // it approved for lines the store then refused.
      let landed: CartLineInput[] = [];
      try {
        next = await serialize(() => shopify.cart.addLines(id, inputs));
        landed = inputs;
      } catch (batchError) {
        // Only Shopify rejecting specific lines is worth retrying one at a time. A transport or
        // GraphQL failure would fail all N the same way, so retrying would turn one dead request
        // into N and still end at null — indistinguishable from "every variant was unsellable".
        if (!isLineRejection(batchError)) {
          inputs.forEach(releaseRejected);
          throw batchError;
        }

        // The batch is all-or-nothing, so fall back to one line at a time and keep the successes.
        // Each result supersedes the last, so `next` ends up as the cart after the final accepted
        // line — which is the whole set of them, since they accumulate server-side.
        for (let i = 0; i < inputs.length; i += 1) {
          const input = inputs[i];
          try {
            next = await serialize(() => shopify.cart.addLines(id, [input]));
            landed.push(input);
          } catch (lineError) {
            releaseRejected(input);
            // A line the store will no longer sell is the expected case and is skipped. Anything
            // else means the retry itself is failing, so stop rather than hammer the remaining ones.
            if (!isLineRejection(lineError)) {
              inputs.slice(i + 1).forEach(releaseRejected);
              throw lineError;
            }
          }
        }
        // Every line individually rejected. Surface the original rather than reporting an empty
        // success, which reads to the caller as "nothing to add" instead of "none of this is sellable".
        if (landed.length === 0) throw batchError;
      }
      if (next) {
        await persistCart(next);
        onEvent?.({ type: "cart:add" });
        const settled = next;
        landed.forEach((input) => announceLanded(input, settled));
      }
      return next;
    } finally {
      setCartLoad(false);
    }
  }, [cart, approveAdd, releaseRejected, announceLanded, ensureCartId, persistCart, onEvent, serialize]);

  const cartSetBuyerIdentity = useCallback(async (identity: {
    email?: string;
    countryCode?: string;
    customerAccessToken?: string;
  }): Promise<boolean> => {
    // Deliberately does NOT create a cart: attaching an identity to a cart that does not exist yet
    // would mint an empty one, and checkout has nothing to do with it.
    if (!cart?.id) return false;
    setCartLoad(true);
    try {
      const next = await serialize(() => shopify.cart.setBuyerIdentity(cart.id, identity));
      await persistCart(next);
      onEvent?.({ type: "cart:buyerIdentity" });
      return true;
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart, onEvent, serialize]);

  const cartUpdateLine = useCallback(async (
    lineId: string,
    quantity: number,
    attributes?: CartLineAttribute[],
  ): Promise<boolean> => {
    if (!cart?.id) return false;
    const guard = guardRef.current;
    const previous = cart.lines.find((line) => line.id === lineId) ?? null;
    const delta = previous ? quantity - previous.quantity : 0;

    // Only an increase can be vetted — a decrease is reported after the fact, since there is
    // nothing to refuse and the units are only really free once Shopify has taken them back.
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
        throw updateError;
      }
      await persistCart(next);
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
  }, [cart, persistCart, runGuard, releaseRejected, serialize]);

  const cartRemoveLine = useCallback(async (lineId: string) => {
    if (!cart?.id) return;
    const guard = guardRef.current;
    const previous = cart.lines.find((line) => line.id === lineId) ?? null;
    setCartLoad(true);
    try {
      const next = await serialize(() => shopify.cart.removeLines(cart.id, [lineId]));
      await persistCart(next);
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
  }, [cart, persistCart, runGuard, serialize]);

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

  const cartRefresh = useCallback(async (): Promise<Cart | null> => {
    if (!cart?.id) return null;
    const next = await shopify.cart.get(cart.id);
    if (next) await persistCart(next);
    return next;
  }, [cart, persistCart]);

  const cartReset = useCallback(async () => {
    const created = await shopify.cart.create();
    await persistCart(created);
  }, [persistCart]);

  // ─── Wishlist operations ──────────────────────────────────────────
  // The SDK's wishlist module owns storage + hydration; we just wrap
  // the mutating methods and rely on onChange to keep React in sync.
  const wlAdd     = useCallback(async (p: Product | string) => { await (shopify.wishlist.add as any)(p); onEvent?.({ type: "wishlist:add" }); }, [onEvent]);
  const wlRemove  = useCallback(async (id: string)          => { await shopify.wishlist.remove(id); }, []);
  const wlToggle  = useCallback(async (p: Product | string) => {
    const nowSaved = await (shopify.wishlist.toggle as any)(p);
    onEvent?.({ type: nowSaved ? "wishlist:add" : "wishlist:remove" });
    return nowSaved;
  }, [onEvent]);
  const wlClear   = useCallback(async ()                    => { await shopify.wishlist.clear(); },    []);
  const wlRefresh = useCallback(async ()                    => { await shopify.wishlist.refresh({ keepDeleted: wishlistKeepDeleted }); },  [wishlistKeepDeleted]);
  const wlHas     = useCallback((id: string)                => shopify.wishlist.has(id),               []);

  const value = useMemo<ShopifyContextType>(() => ({
    ready, error,
    cart: {
      cart, loading: cartLoading, itemCount: cart?.totalQuantity ?? 0,
      addLine:            cartAddLine,
      addLines:           cartAddLines,
      updateLine:         cartUpdateLine,
      removeLine:         cartRemoveLine,
      applyDiscountCodes: cartApplyDiscounts,
      setBuyerIdentity:   cartSetBuyerIdentity,
      refresh:            cartRefresh,
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
  }), [
    ready, error,
    cart, cartLoading, cartAddLine, cartAddLines, cartUpdateLine, cartRemoveLine, cartApplyDiscounts, cartSetBuyerIdentity, cartRefresh, cartReset,
    wlItems, wlHas, wlAdd, wlRemove, wlToggle, wlClear, wlRefresh,
  ]);

  return <ShopifyContext.Provider value={value}>{children}</ShopifyContext.Provider>;
}

/** Full Shopify context — SDK readiness plus cart and wishlist state. */
export function useShopify(): ShopifyContextType {
  const ctx = useContext(ShopifyContext);
  if (!ctx) throw new Error("useShopify must be used within a ShopifyProvider");
  return ctx;
}

/** Cart-only shortcut. Same object as `useShopify().cart`. */
export function useCart(): CartState {
  return useShopify().cart;
}

/** Wishlist-only shortcut. Same object as `useShopify().wishlist`. */
export function useWishlist(): WishlistState {
  return useShopify().wishlist;
}
