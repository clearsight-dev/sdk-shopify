# Changelog

## 0.9.2 (2026-10-12)

### Fix: a cart that is gone in Shopify no longer breaks every cart write

Backported from 0.13.0 for apps on 0.9 (Freckled Poppy hit it during a live show on 2026-10-11: the
stored cart had become an order, the app missed the order page, and every add failed until a
relaunch). Only the recovery comes over; nothing else from 0.10–0.13. No code change is needed to
upgrade from 0.9.1.

- **`isMissingCartError(error)`**: a userError on `cartId` with code `INVALID`. Exported from the root.
- **One rule for the replacement cart, at launch and while the app runs**: the cart marked by
  `reportCheckoutStarted` comes back empty (`ordered`); one last written more than 10 days ago is
  rebuilt from the phone's line snapshot (`expired`); anything else comes back empty (`missing`).
  **Changed at launch**: 0.9.1 rebuilt every gone cart that wasn't marked. "Last written" is a new
  record, `shopify:cart-activity:v1`, written on every cart write that lands; a read of a cart with no
  record yet records Shopify's `updatedAt`.
- **While the app runs**, a write refused for its `cartId` reads the cart once to confirm, then the
  cart is replaced inside the write queue. Writes take the cart id when their turn comes, not from the
  render they were called in. `addLine` / `addLines` write once more on the new cart; other writes
  throw the original error; `ensureCartAttributes` answers false; `refresh()` returns the new cart
  (null when it couldn't be made). A cart changed meanwhile (`reset`, `adopt`) is left alone. At most
  3 replacements a minute. The checkout mark is cleared after the new cart is stored.
- **New event `cart:recovered`** with `recovery: { deadCartId, newCartId, reason }` and the new `cart`
  (`ShopifyEvent` gains the optional `cart` and `recovery`). Types `CartRecovery`, `CartRecoveryReason`.
- Tests: `test/cart-recovery.test.mjs` (31); `cart-snapshot` and `attribution-provider` updated for the
  new launch rule. Every test file sets `navigator` with `Object.defineProperty`, so the suite runs on
  Node 22.
