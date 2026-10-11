import { shopify } from "../shopify";
import { toLineSnapshot } from "../cart";
import { isUserErrorRejection } from "../errors";
import type { Cart, CartAttribute, CartLineInput, CartLineSnapshot, WishlistStorageAdapter } from "../types";

const CART_LINES_KEY = "shopify:cart-lines:v1";
const CART_ACTIVITY_KEY = "shopify:cart-activity:v1";
export const CHECKOUT_STARTED_KEY = "shopify:checkout-started-cart-id:v1";

/** How long Shopify keeps a cart nobody touches. Only a cart idle longer than this is rebuilt. */
export const CART_EXPIRY_MS = 10 * 24 * 60 * 60 * 1000;
/** Runtime replacements allowed per provider per minute; past that the write's own error surfaces. */
export const RECOVERIES_PER_MINUTE = 3;

/**
 * Why a cart was replaced. `ordered`: it was marked by `reportCheckoutStarted`; the new cart starts
 * empty. `missing`: it was used within `CART_EXPIRY_MS`, so it most likely became an order elsewhere;
 * empty too. `expired`: idle longer than that, so rebuilt from the lines saved on the phone.
 */
export type CartRecoveryReason = "ordered" | "missing" | "expired";

export interface CartRecovery {
  deadCartId: string;
  newCartId: string;
  reason: CartRecoveryReason;
}

type Storage = WishlistStorageAdapter | null;

async function read(s: Storage, key: string): Promise<string | null> {
  if (!s) return null;
  try {
    return await Promise.resolve(s.getItem(key));
  } catch {
    return null;
  }
}

async function loadLineSnapshot(s: Storage): Promise<CartLineSnapshot[]> {
  try {
    const raw = await read(s, CART_LINES_KEY);
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

/** When `cartId` was last written. Null when unknown, which counts as recent. */
async function lastActivity(s: Storage, cartId: string): Promise<number | null> {
  try {
    const raw = await read(s, CART_ACTIVITY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.cartId === cartId && typeof parsed.at === "number" ? parsed.at : null;
  } catch {
    return null;
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
    if (!isUserErrorRejection(createError)) throw createError;
  }
  let next = await shopify.cart.create({ attributes });
  for (const input of inputs) {
    try {
      next = await shopify.cart.addLines(next.id, [input]);
    } catch (lineError) {
      if (isUserErrorRejection(lineError)) continue;
      // A partly restored cart beats failing startup; the snapshot is rewritten from what landed.
      console.warn("[ShopifyProvider] cart restore stopped early", lineError);
      break;
    }
  }
  return next;
}

/**
 * Replacing a cart Shopify no longer has, by one rule for launch and for a cart found gone while the
 * app runs, plus the phone-side records the rule reads: the line snapshot, when the cart was last
 * used, and the checkout mark. Nothing here goes through the provider's write queue, so `recover` can
 * run from inside it.
 */
export function createCartRecovery(deps: {
  storage: () => Storage;
  newCartAttributes: () => CartAttribute[] | undefined;
  restoreAttributes: (base: CartAttribute[] | undefined) => Promise<CartAttribute[] | undefined>;
  current: () => Cart | null;
  persist: (cart: Cart) => Promise<void>;
  onRecovered: (recovery: CartRecovery, cart: Cart) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let recent: number[] = [];

  const clearCheckoutMark = async (): Promise<void> => {
    const s = deps.storage();
    if (!s) return;
    try {
      await Promise.resolve(s.removeItem(CHECKOUT_STARTED_KEY));
    } catch (markError) {
      console.warn("[ShopifyProvider] checkout mark clear failed", markError);
    }
  };

  /** The cart that replaces `deadId` (null: there was none), created and not yet stored. */
  const replace = async (deadId: string | null): Promise<{ cart: Cart; reason: CartRecoveryReason }> => {
    const s = deps.storage();
    if (deadId && deadId === (await read(s, CHECKOUT_STARTED_KEY))) {
      return { cart: await shopify.cart.create({ attributes: deps.newCartAttributes() }), reason: "ordered" };
    }
    const at = deadId ? await lastActivity(s, deadId) : null;
    if (at !== null && now() - at > CART_EXPIRY_MS) {
      const cart = await createFromSnapshot(await loadLineSnapshot(s), await deps.restoreAttributes(deps.newCartAttributes()));
      return { cart, reason: "expired" };
    }
    return { cart: await shopify.cart.create({ attributes: deps.newCartAttributes() }), reason: "missing" };
  };

  const allow = (): boolean => {
    const t = now();
    recent = recent.filter((at) => t - at < 60_000);
    if (recent.length >= RECOVERIES_PER_MINUTE) return false;
    recent.push(t);
    return true;
  };

  /** The current cart when it is no longer `deadId`: something else replaced it meanwhile. */
  const movedOn = (deadId: string): Cart | null => {
    const current = deps.current();
    return current && current.id !== deadId ? current : null;
  };

  return {
    replace,
    clearCheckoutMark,

    /**
     * The lines, for the cart that may replace this one, and with `written` the time: Shopify's
     * expiry runs from the last change, so a read must not make the cart look recently used. A read
     * of a cart with no record yet (an install from before 0.13.0, an adopted cart) records Shopify's
     * own last change, `updatedAt`, so the cart can still be found expired later. Best effort.
     */
    async saveSnapshot(cart: Cart | null, written: boolean): Promise<void> {
      const s = deps.storage();
      if (!s) return;
      try {
        if (cart) {
          await Promise.resolve(s.setItem(CART_LINES_KEY, JSON.stringify(toLineSnapshot(cart))));
          const at = written ? now() : (await lastActivity(s, cart.id)) === null ? Date.parse(cart.updatedAt) : NaN;
          if (Number.isFinite(at)) await Promise.resolve(s.setItem(CART_ACTIVITY_KEY, JSON.stringify({ cartId: cart.id, at })));
        } else {
          await Promise.resolve(s.removeItem(CART_LINES_KEY));
          await Promise.resolve(s.removeItem(CART_ACTIVITY_KEY));
        }
      } catch (snapshotError) {
        console.warn("[ShopifyProvider] cart line snapshot write failed", snapshotError);
      }
    },

    /**
     * Replaces `deadId` while the app runs and returns the cart to carry on with: the new one, or the
     * current one when the cart already moved on (then nothing is stored or announced). Null when it
     * wasn't replaced: `confirm`'s read still finds the cart, the rate limit is spent, or the new cart
     * couldn't be made. Never throws.
     */
    async recover(deadId: string, options: { confirm: boolean }): Promise<Cart | null> {
      const already = movedOn(deadId);
      if (already) return already;
      try {
        if (options.confirm && (await shopify.cart.get(deadId))) return null;
        if (!allow()) {
          console.warn("[ShopifyProvider] cart recovery skipped: too many this minute");
          return null;
        }
        const { cart, reason } = await replace(deadId);
        const meanwhile = movedOn(deadId);
        if (meanwhile) return meanwhile;
        await deps.persist(cart);
        if (reason === "ordered") await clearCheckoutMark();
        deps.onRecovered({ deadCartId: deadId, newCartId: cart.id, reason }, cart);
        return cart;
      } catch (recoverError) {
        console.warn("[ShopifyProvider] dead cart recovery failed", recoverError);
        return null;
      }
    },
  };
}

export type CartRecoveryManager = ReturnType<typeof createCartRecovery>;
