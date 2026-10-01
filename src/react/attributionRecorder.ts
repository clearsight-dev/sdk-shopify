import {
  ATTRIBUTION_ATTRIBUTE_KEY,
  lineTypeOf,
  parseAttribution,
  recordAdd,
  recordRemove,
  serializeAttribution,
  withAttributionAttribute,
  type Attribution,
  type AttributionSource,
} from "../attribution";
import type { Cart, CartAttribute, CartLine, CartLineInput, WishlistStorageAdapter } from "../types";

const CART_ATTRIBUTION_KEY = "shopify:cart-attribution:v1";
const APP_SOURCE: AttributionSource = { type: "app" };

type Storage = WishlistStorageAdapter | null;

async function saveAttributionSnapshot(s: Storage, value: Attribution | null): Promise<void> {
  if (!s) return;
  try {
    if (value) await Promise.resolve(s.setItem(CART_ATTRIBUTION_KEY, serializeAttribution(value)));
    else await Promise.resolve(s.removeItem(CART_ATTRIBUTION_KEY));
  } catch (snapshotError) {
    console.warn("[ShopifyProvider] cart attribution snapshot write failed", snapshotError);
  }
}

async function loadAttributionSnapshot(s: Storage): Promise<Attribution | null> {
  if (!s) return null;
  try {
    return parseAttribution(await Promise.resolve(s.getItem(CART_ATTRIBUTION_KEY)));
  } catch {
    return null;
  }
}

/** `base` plus the saved value, for the cart that replaces an expired one. */
async function restoredCartAttributes(s: Storage, base: CartAttribute[] | undefined): Promise<CartAttribute[] | undefined> {
  const saved = await loadAttributionSnapshot(s);
  return saved ? withAttributionAttribute(base, saved) : base;
}

function attributionOf(cart: Cart | null): Attribution {
  const raw = cart?.attributes.find((attr) => attr.key === ATTRIBUTION_ATTRIBUTE_KEY)?.value;
  return parseAttribution(raw) ?? { v: 1 };
}

export interface AttributionRecorder {
  /** Takes the value on `cart` as the base, unless this device holds a newer one not yet written. */
  sync(cart: Cart | null): Promise<void>;
  /** An add that landed: source defaults to `app`, line type from the input's attributes. */
  addInput(cartId: string, input: CartLineInput): void;
  /** A quantity change on an existing line: positive adds under `source`, negative removes. */
  changeLine(cartId: string, line: CartLine | null, delta: number, source?: AttributionSource): void;
  /** `base` plus the saved value when enabled, for restoring an expired cart. */
  restoreAttributes(base: CartAttribute[] | undefined): Promise<CartAttribute[] | undefined>;
  /** After every queued write, retries an unsent value once. True when the cart holds the device's value. */
  flushPending(): Promise<boolean>;
}

/**
 * Changes apply to the device's copy at once and are written as one whole value through the
 * provider's write queue. A failed write leaves the copy ahead of the cart, so the next change's
 * write carries it too. Every method is a no-op while `enabled()` is false, and none throws.
 */
export function createAttributionRecorder(deps: {
  enabled: () => boolean;
  serialize: <T>(write: () => Promise<T>) => Promise<T>;
  storage: () => Storage;
  write: (cartId: string, attributes: CartAttribute[]) => Promise<Cart>;
  onWritten: (cart: Cart) => Promise<void>;
}): AttributionRecorder {
  let latest: Cart | null = null;
  let cartId: string | null = null;
  let value: Attribution | null = null;
  let version = 0;
  let written = 0;

  const resetFor = (forCart: string | null, base: Attribution | null) => {
    cartId = forCart;
    value = base;
    version = written = 0;
  };

  const flush = async (forCart: string) => {
    if (cartId !== forCart || version === written || !value) return;
    if (!latest || latest.id !== forCart) return;
    const target = version;
    try {
      const next = await deps.write(forCart, withAttributionAttribute(latest.attributes, value));
      if (cartId === forCart) written = Math.max(written, target);
      await deps.onWritten(next);
    } catch (writeError) {
      console.warn("[ShopifyProvider] attribution write failed; retried with the next change", writeError);
    }
  };

  const change = (forCart: string, apply: (current: Attribution) => Attribution) => {
    if (!deps.enabled()) return;
    try {
      if (cartId !== forCart) resetFor(forCart, attributionOf(latest?.id === forCart ? latest : null));
      value = apply(value ?? { v: 1 });
      version += 1;
      void saveAttributionSnapshot(deps.storage(), value);
      void deps.serialize(() => flush(forCart));
    } catch (recordError) {
      console.warn("[ShopifyProvider] attribution record failed", recordError);
    }
  };

  return {
    async sync(cart) {
      if (!deps.enabled()) return;
      latest = cart;
      if (!cart) resetFor(null, null);
      else if (cart.id !== cartId) resetFor(cart.id, attributionOf(cart));
      else if (version === written) value = attributionOf(cart);
      await saveAttributionSnapshot(deps.storage(), value);
    },
    addInput(forCart, input) {
      const now = Math.floor(Date.now() / 1000);
      change(forCart, (current) =>
        recordAdd(current, input.source ?? APP_SOURCE, input.merchandiseId, lineTypeOf(input.attributes), input.quantity, now));
    },
    changeLine(forCart, line, delta, source) {
      if (!line || delta === 0) return;
      const lineType = lineTypeOf(line.attributes);
      const now = Math.floor(Date.now() / 1000);
      change(forCart, (current) =>
        delta > 0
          ? recordAdd(current, source ?? APP_SOURCE, line.merchandise.id, lineType, delta, now)
          : recordRemove(current, line.merchandise.id, lineType, -delta));
    },
    async restoreAttributes(base) {
      return deps.enabled() ? restoredCartAttributes(deps.storage(), base) : base;
    },
    flushPending() {
      if (!deps.enabled()) return Promise.resolve(true);
      const target = version;
      const forCart = cartId;
      return deps
        .serialize(async () => {
          if (!forCart || cartId !== forCart) return version === written;
          if (written < target) await flush(forCart);
          return written >= target;
        })
        .catch(() => false);
    },
  };
}
