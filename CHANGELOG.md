# Changelog

## 0.9.3 (2026-10-12)

### Fix: an add Shopify clamped to nothing no longer reads as added

The same change as 0.13.1, for apps on 0.9. Shopify doesn't refuse an add past the stock: it answers ok
and adds what is left, or nothing, and the add said `ok: true` either way (Freckled Poppy counted units
itself with `addLanded` at each call site). Upgrading from 0.9.2 needs no code change; an app that
toasts `result.message` for every `ok: false` except `'limit'` should skip `'clamped'` too (below).

- **Every add is measured**: the variant's units across all lines of the cart Shopify returned, against
  the cart it was written to (after a dead-cart replacement, the new cart before the retried add).
- **`addLine`**: nothing landed is `ok: false`, `reason: 'clamped'` (new in `CartRejectionReason`), the
  `cart.noMoreStock` copy, and the cart. Some landed is `ok: true` with `landedQuantity` below the
  quantity asked. `CartWriteResult.landedQuantity` is new and set on every written add.
- **`addLinesDetailed(inputs)`** (new): `CartLinesWriteResult` with `lines: CartAddOutcome[]` per input.
  **`addLines` now returns `null` when nothing landed**, including a batch Shopify clamped to nothing;
  0.9.2 returned the unchanged cart.
- **New alert and event, as on 0.13**: `cart.noMoreStock` ("No more stock available", Settings panel
  field `settings.alerts.cart.noMoreStock`) and `cart:stockLimit`, raised by a clamp with
  `clamped: CartAddOutcome[]`. The clamped result carries the same copy, so an app that also toasts the
  result's message would show it twice.
- `cart:add` fires only when units landed. The guard's `onLanded` and the `_apptile_attribution` count
  only landed units; the units cut go back through `onReleased` (`reason: 'rejected'`).
- Tests: `test/add-landed.test.mjs` (19).

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
