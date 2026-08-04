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
import type {
  Cart,
  CartLineInput,
  Product,
  ShopifyConfig,
  WishlistItem,
  WishlistStorageAdapter,
} from "../types";

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
  addLine:            (input: CartLineInput) => Promise<void>;
  /**
   * Several lines in one go, for reorder-style flows. Returns the resulting cart so the caller can
   * tell what actually landed — `null` when nothing did.
   *
   * Tolerant by design: one line the store will no longer sell fails the whole `cartLinesAdd`, so a
   * rejected batch is retried line by line and whatever the store still accepts is kept.
   */
  addLines:           (inputs: CartLineInput[]) => Promise<Cart | null>;
  updateLine:         (lineId: string, quantity: number) => Promise<void>;
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
  refresh:            () => Promise<void>;
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

export function ShopifyProvider({ children, config, storage, onEvent, wishlistKeepDeleted }: ShopifyProviderProps) {
  const [ready, setReady]           = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [cart, setCart]             = useState<Cart | null>(null);
  const [cartLoading, setCartLoad]  = useState(false);
  const [wlItems, setWlItems]       = useState<WishlistItem[]>([]);
  const wlUnsubRef                  = useRef<(() => void) | null>(null);

  const storageRef = useRef<WishlistStorageAdapter | null>(null);
  storageRef.current = storage ?? defaultStorage();

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

  const cartAddLine = useCallback(async (input: CartLineInput) => {
    setCartLoad(true);
    try {
      const id = await ensureCartId();
      const next = await shopify.cart.addLines(id, [input]);
      await persistCart(next);
      onEvent?.({ type: "cart:add" });
    } finally {
      setCartLoad(false);
    }
  }, [ensureCartId, persistCart, onEvent]);

  const cartAddLines = useCallback(async (inputs: CartLineInput[]): Promise<Cart | null> => {
    if (inputs.length === 0) return cart;
    setCartLoad(true);
    try {
      const id = await ensureCartId();
      let next: Cart | null = null;
      try {
        next = await shopify.cart.addLines(id, inputs);
      } catch {
        // The batch is all-or-nothing, so fall back to one line at a time and keep the successes.
        // Each result supersedes the last, so `next` ends up as the cart after the final accepted
        // line — which is the whole set of them, since they accumulate server-side.
        for (const input of inputs) {
          try {
            next = await shopify.cart.addLines(id, [input]);
          } catch {
            // Skipped: this variant is gone or unsellable. The caller compares quantities to see.
          }
        }
      }
      if (next) {
        await persistCart(next);
        onEvent?.({ type: "cart:add" });
      }
      return next;
    } finally {
      setCartLoad(false);
    }
  }, [cart, ensureCartId, persistCart, onEvent]);

  const cartSetBuyerIdentity = useCallback(async (identity: {
    email?: string;
    countryCode?: string;
    customerAccessToken?: string;
  }): Promise<boolean> => {
    // Deliberately does NOT create a cart: attaching an identity to a cart that does not exist yet
    // would mint an empty one, and checkout has nothing to do with it.
    if (!cart?.id) return false;
    const next = await shopify.cart.setBuyerIdentity(cart.id, identity);
    await persistCart(next);
    return true;
  }, [cart, persistCart]);

  const cartUpdateLine = useCallback(async (lineId: string, quantity: number) => {
    if (!cart?.id) return;
    setCartLoad(true);
    try {
      const next = await shopify.cart.updateLines(cart.id, [{ id: lineId, quantity }]);
      await persistCart(next);
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart]);

  const cartRemoveLine = useCallback(async (lineId: string) => {
    if (!cart?.id) return;
    setCartLoad(true);
    try {
      const next = await shopify.cart.removeLines(cart.id, [lineId]);
      await persistCart(next);
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart]);

  const cartApplyDiscounts = useCallback(async (codes: string[]) => {
    if (!cart?.id) return;
    setCartLoad(true);
    try {
      const next = await shopify.cart.applyDiscountCodes(cart.id, codes);
      await persistCart(next);
    } finally {
      setCartLoad(false);
    }
  }, [cart, persistCart]);

  const cartRefresh = useCallback(async () => {
    if (!cart?.id) return;
    const next = await shopify.cart.get(cart.id);
    if (next) await persistCart(next);
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
