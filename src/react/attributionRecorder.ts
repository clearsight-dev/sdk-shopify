import {
  ATTRIBUTION_ATTRIBUTE_KEY,
  lineTypeOf,
  parseAttribution,
  recordAdd,
  recordRemove,
  serializeAttribution,
  trimAttributionToLines,
  variantKey,
  withAttributionAttribute,
  type Attribution,
  type AttributionCartLine,
  type AttributionLineType,
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

/**
 * A line write the cart Shopify returned already holds: an add (`input.quantity` = the units that
 * landed) or a quantity change on an existing line (`delta` < 0 removes).
 */
export type AttributionChange =
  | { type: "add"; input: CartLineInput }
  | { type: "line"; line: CartLine; delta: number; source?: AttributionSource };

export interface AttributionRecorder {
  /**
   * Takes the value on `cart` as the base, unless this device holds a newer one not yet written; trims
   * it to the units `cart` held before `changes` (`trimAttributionToLines`), so a removal made where the
   * attribute isn't kept (the web store) stops being credited; then records `changes` (source defaults
   * to `app`). Writes the value when that changed it. A cart older than one already seen is ignored,
   * but for the units its `changes` added.
   */
  sync(cart: Cart | null, options?: { changes?: AttributionChange[] }): Promise<void>;
  /** `base` plus the saved value when enabled, for restoring an expired cart. */
  restoreAttributes(base: CartAttribute[] | undefined): Promise<CartAttribute[] | undefined>;
  /** After every queued write, retries an unsent value once. True when the cart holds the device's value. */
  flushPending(): Promise<boolean>;
}

type Units = { variantId: string; lineType: AttributionLineType; units: number; source?: AttributionSource };

/**
 * The device's copy is written as one whole value through the provider's write queue. A failed write
 * leaves the copy ahead of the cart, so the next change's write carries it too. Every method is a
 * no-op while `enabled()` is false, and none throws.
 */
export function createAttributionRecorder(deps: {
  enabled: () => boolean;
  serialize: <T>(write: () => Promise<T>) => Promise<T>;
  storage: () => Storage;
  write: (cartId: string, attributes: CartAttribute[]) => Promise<Cart>;
  onWritten: (cart: Cart) => Promise<void>;
  lineType: () => ((attributes: CartAttribute[]) => AttributionLineType) | undefined;
  trimLineTypes: () => readonly AttributionLineType[] | "all" | undefined;
}): AttributionRecorder {
  let latest: Cart | null = null;
  let cartId: string | null = null;
  let value: Attribution | null = null;
  let version = 0;
  let written = 0;
  // The newest `updatedAt` synced for `cartId`: a read that started before a write can land after it.
  let seenAt = 0;

  const resetFor = (forCart: string | null, base: Attribution | null) => {
    cartId = forCart;
    value = base;
    version = written = seenAt = 0;
  };

  const lineTypeFor = (attributes: CartAttribute[] | undefined) => (deps.lineType() ?? lineTypeOf)(attributes ?? []);

  const unitsOf = (change: AttributionChange): Units => {
    if (change.type === "add") {
      const { input } = change;
      return { variantId: input.merchandiseId, lineType: lineTypeFor(input.attributes), units: input.quantity, source: input.source };
    }
    const { line, delta, source } = change;
    return { variantId: line.merchandise.id, lineType: lineTypeFor(line.attributes), units: delta, source };
  };

  /** The cart's units per variant and line type as they were before `changes` landed. */
  const linesBefore = (cart: Cart, changes: Units[]): AttributionCartLine[] => {
    const byKey = new Map<string, AttributionCartLine>();
    const bump = (merchandiseId: string, lineType: AttributionLineType, quantity: number) => {
      const key = `${variantKey(merchandiseId)}/${lineType}`;
      const line = byKey.get(key) ?? { merchandiseId, lineType, quantity: 0 };
      line.quantity += quantity;
      byKey.set(key, line);
    };
    for (const line of cart.lines) bump(line.merchandise.id, lineTypeFor(line.attributes), line.quantity);
    for (const change of changes) bump(change.variantId, change.lineType, -change.units);
    return [...byKey.values()].filter((line) => line.quantity > 0);
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

  return {
    async sync(cart, options) {
      if (!deps.enabled()) return;
      if (!cart) {
        latest = null;
        resetFor(null, null);
        await saveAttributionSnapshot(deps.storage(), value);
        return;
      }
      try {
        if (cart.id !== cartId) resetFor(cart.id, attributionOf(cart));
        const changes = (options?.changes ?? []).map(unitsOf).filter((change) => change.units !== 0);
        const at = Date.parse(cart.updatedAt);
        const stale = at < seenAt;
        // A read that landed first already trimmed this cart's removals off.
        const seen = at <= seenAt;
        if (at > seenAt) seenAt = at;
        if (stale && changes.length === 0) return;
        if (!stale) {
          latest = cart;
          if (version === written) value = attributionOf(cart);
        }
        const current = value ?? { v: 1 };
        let next = stale ? current : trimAttributionToLines(current, linesBefore(cart, changes), deps.trimLineTypes());
        const now = Math.floor(Date.now() / 1000);
        for (const change of changes) {
          if (change.units > 0) next = recordAdd(next, change.source ?? APP_SOURCE, change.variantId, change.lineType, change.units, now);
          else if (!seen) next = recordRemove(next, change.variantId, change.lineType, -change.units);
        }
        if (serializeAttribution(next) !== serializeAttribution(current)) {
          value = next;
          version += 1;
          void deps.serialize(() => flush(cart.id));
        }
      } catch (recordError) {
        console.warn("[ShopifyProvider] attribution record failed", recordError);
      }
      await saveAttributionSnapshot(deps.storage(), value);
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
