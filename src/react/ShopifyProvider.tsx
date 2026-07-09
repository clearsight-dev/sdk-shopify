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
import { shopify } from "../index";
import type {
  Cart,
  CartLineInput,
  Product,
  ShopifyConfig,
  WishlistItem,
  WishlistStorageAdapter,
} from "../index";

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
  updateLine:         (lineId: string, quantity: number) => Promise<void>;
  removeLine:         (lineId: string) => Promise<void>;
  applyDiscountCodes: (codes: string[]) => Promise<void>;
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
}

function defaultStorage(): WishlistStorageAdapter | null {
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).localStorage !== "undefined") {
    return (globalThis as any).localStorage as WishlistStorageAdapter;
  }
  return null;
}

export function ShopifyProvider({ children, config, storage }: ShopifyProviderProps) {
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
    } finally {
      setCartLoad(false);
    }
  }, [ensureCartId, persistCart]);

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
  const wlAdd     = useCallback(async (p: Product | string) => { await (shopify.wishlist.add as any)(p); }, []);
  const wlRemove  = useCallback(async (id: string)          => { await shopify.wishlist.remove(id); }, []);
  const wlToggle  = useCallback(async (p: Product | string) => (shopify.wishlist.toggle as any)(p),    []);
  const wlClear   = useCallback(async ()                    => { await shopify.wishlist.clear(); },    []);
  const wlRefresh = useCallback(async ()                    => { await shopify.wishlist.refresh(); },  []);
  const wlHas     = useCallback((id: string)                => shopify.wishlist.has(id),               []);

  const value = useMemo<ShopifyContextType>(() => ({
    ready, error,
    cart: {
      cart, loading: cartLoading, itemCount: cart?.totalQuantity ?? 0,
      addLine:            cartAddLine,
      updateLine:         cartUpdateLine,
      removeLine:         cartRemoveLine,
      applyDiscountCodes: cartApplyDiscounts,
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
    cart, cartLoading, cartAddLine, cartUpdateLine, cartRemoveLine, cartApplyDiscounts, cartRefresh, cartReset,
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
