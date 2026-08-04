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
 * Shopify rejecting the *contents* of a mutation rather than failing to answer it: only
 * `userErrors` populate `ShopifyError.errors`, so transport and GraphQL failures arrive empty.
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
  /** `false` means a `cartGuard` cancelled the add and no `cart:add` fired, so do not report
   *  success. Shopify refusing the line still throws. */
  addLine:            (input: CartLineInput) => Promise<boolean>;
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

interface ShopifyContextType {
  ready:    boolean;
  error:    string | null;
  cart:     CartState;
  wishlist: WishlistState;
}

const ShopifyContext = createContext<ShopifyContextType | undefined>(undefined);

const CART_STORAGE_KEY = "shopify:cart-id:v1";

/** Emitted only on a successful mutation, so the host app can react without wrapping the hooks. */
export type ShopifyEvent =
  | { type: "cart:add" }
  | { type: "cart:buyerIdentity" }
  | { type: "wishlist:add" }
  | { type: "wishlist:remove" };

export interface ShopifyProviderProps {
  children: ReactNode;
  config: ShopifyConfig;
  /**
   * Backs the cart id and the wishlist. Defaults to `window.localStorage`; React Native and Node
   * consumers pass an AsyncStorage-compatible adapter.
   */
  storage?: WishlistStorageAdapter;
  onEvent?: (event: ShopifyEvent) => void;
  /** Vets cart writes — see `CartLineGuard`. On the provider so no screen can bypass it. */
  cartGuard?: CartLineGuard;
  /** See `WishlistInitOptions.keepDeleted`. Recommended for a shopper-facing wishlist. */
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

  // In a ref so the cart callbacks keep their identity when the host passes a new guard object.
  const guardRef = useRef<CartLineGuard | undefined>(cartGuard);
  guardRef.current = cartGuard;


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
    // Vetted up front so a guard's veto does not cost the other lines their fast path.
    const inputs = (await Promise.all(requested.map(approveAdd))).filter(
      (input): input is CartLineInput => input !== null,
    );
    if (inputs.length === 0) return null;
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
          throw batchError;
        }

        // The batch is all-or-nothing, so retry one line at a time and keep the successes. They
        // accumulate server-side, so `next` ends up holding the whole accepted set.
        for (let i = 0; i < inputs.length; i += 1) {
          const input = inputs[i];
          try {
            next = await serialize(() => shopify.cart.addLines(id, [input]));
            landed.push(input);
          } catch (lineError) {
            releaseRejected(input);
            // Anything but a rejection means the retry itself is failing, so stop.
            if (!isLineRejection(lineError)) {
              inputs.slice(i + 1).forEach(releaseRejected);
              throw lineError;
            }
          }
        }
        // Every line individually rejected. Surface the original rather than an empty success,
        // which reads as "nothing to add" instead of "none of this is sellable".
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
    // Deliberately does NOT create a cart — that would mint an empty one checkout never sees.
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

  const cartAdopt = useCallback(async (cartId: string): Promise<Cart | null> => {
    const next = await shopify.cart.get(cartId);
    if (next) await persistCart(next);
    return next;
  }, [persistCart]);

  const cartReset = useCallback(async () => {
    const created = await shopify.cart.create();
    await persistCart(created);
  }, [persistCart]);

  // The wishlist module owns storage and hydration; these just wrap the mutating methods and
  // rely on onChange to keep React in sync.
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
  }), [
    ready, error,
    cart, cartLoading, cartAddLine, cartAddLines, cartUpdateLine, cartRemoveLine, cartApplyDiscounts, cartSetBuyerIdentity, cartRefresh, cartAdopt, cartReset,
    wlItems, wlHas, wlAdd, wlRemove, wlToggle, wlClear, wlRefresh,
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
