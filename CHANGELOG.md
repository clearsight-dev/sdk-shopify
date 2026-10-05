# Changelog

## 0.10.0 (2026-10-06)

This file starts with 0.10. It lists the logic moved here from the apps (SDK moves 1, 6 and 7); the
rest of 0.10's work (Tile Credit and gift cards on the cart, store-credit history, selling plans on
variants and cart lines) is described in the README.

### Checkout: noticing a placed order

Shopify's checkout runs in a web view, and its address is the only sign the app gets that the order
was placed. Each app kept its own check, and they had drifted apart. Freckled Poppy's missed a real
order: one-page checkout landed on `/confirmation`, which it didn't look for. The check and the script
that reports address changes now live here, from the main entry. Both are pure (no React).

- **New: `isOrderPlacedUrl(url: string | null | undefined): boolean`.** True for `/thank-you`,
  `/thank_you`, `/confirmation` and the order status page under `/orders/`
  (`/<shop id>/orders/<token>`). Decided 2026-10-06, Head of Engineering.
  - **Nothing under `/account/` counts** ("Skip /account/orders/"). A signed-in checkout shows an
    account menu, and an order opened from it (`/account/orders/<id>`) is an old order. Counting it
    would send `purchase` and clear the cart the moment a shopper looked at a past order. The order
    history list (`/account/orders`) doesn't count either.
  - Only the path is read: a query or fragment that names one of these pages never counts.
  - Each name must be a whole part of the path. Letter case doesn't matter.
  - It keeps nothing between calls. The `/orders/` test is a regex without the `g` flag, which would
    make the same address answer `true`, then `false`.
  - The same page arrives several times, so report the order once per checkout.
- **New: `REPORT_ADDRESS_CHANGES_SCRIPT`**, for the web view's `injectedJavaScript`. It posts
  `{ kind, url }` to the app each time the page's address changes, including the
  `history.replaceState` that brings the thank-you page, which the web view's own event misses. This is
  Amber's production script, the same one amore-v2's `CheckoutWebView01` tile injects today.
- `test/checkout.test.mjs`: 20 checks, with the script run in jsdom.

### Moving an app over

Replace the app's own address check and injected script with these two imports. An app that left
`/orders/` out on purpose, as Freckled Poppy did, now matches the order status page too, but still
never an order opened from the account menu.

### Checkout: getting the cart ready (SDK move 6)

Every app opened checkout with its own copy of the same steps, and the copies had drifted apart:
amore-v2 sent the cart's country with the shopper, amber-v2 didn't, and Freckled Poppy landed the
cart's attribution first. The steps live here now. Going to the checkout page stays the app's.

- **New: `useCheckout().prepare(options?)`**, answering
  `Promise<CheckoutPreparation>` = `'ready' | 'empty' | 'lapsedHold' | 'failed'`. It never throws.
  1. The cart is read again (`refresh`). No cart, or no lines, is `'empty'`. **A read that fails
     carries on** with the cart already loaded (`useCart().cart`): Shopify's checkout checks the cart
     again itself. Decided 2026-10-06 by the Head of Engineering: "Carry on". amore-v2 had counted a
     failed read as no cart, so offline the shopper was told their reservation had run out; Freckled
     Poppy already carried on. With nothing loaded either, it is `'empty'`.
  2. `options.hasLapsedHold(lines)` (pass Cart Hold's `hasLapsedHold`), asked about the lines just
     read: true is `'lapsedHold'`, and nothing else happens.
  3. Together:
     - **The signed-in shopper is attached** (`setBuyerIdentity`): their token, the profile's email
       when it has loaded, and the cart's country. The write replaces the whole buyer identity, and a
       gift card (store credit) stays only on a cart with a country. A failure leaves a guest checkout.
       Signed out, nothing is sent.
     - **The cart is labelled** (Freckled Poppy's `labelCartForCheckout`): `flushAttribution()`, then
       `ensureCartAttributes` with the provider's own `cartAttributes` (no request when the cart already
       has them). Each step gets `CHECKOUT_LABEL_STEP_TIMEOUT_MS` (3 seconds). A step that fails or
       runs out of time is warned about, and checkout goes on.
  4. `reportCheckoutStarted()`, awaited. A failure is warned about.
  5. `'ready'`. Anything else that throws is `'failed'`.
- **New: `useCheckout().preparing`**: true while this hook's own `prepare` runs, for the spinner on the
  button that started it. Each caller has its own (`useShopify().checkout` has no `preparing`).
- `prepare` keeps one identity while the cart changes.
- The rule is `prepareCheckout(steps, options)` in `src/checkout.ts`, with every step handed in, so it
  is tested without React (`test/checkout-prepare.test.mjs`, 28 checks: 20 on the rule, 8 through the
  provider). Not exported.
- **New exports:** `CHECKOUT_LABEL_STEP_TIMEOUT_MS`, `type CheckoutPreparation`,
  `type PrepareCheckoutOptions`.

### Orders: the order just placed (SDK move 6)

- **New: `useLatestOrderSince(since, options?)`** → `{ order: OrderSummary | null }`. For an Order
  Confirmed page: the shopper's newest order, but only once it was placed at or after `since` (ms,
  when checkout opened on the phone), less 2 minutes for the phone's clock running ahead of Shopify's.
  Until then the newest is the order before, which production showed; here `order` stays null (no
  number rather than a wrong one). While it isn't listed, the newest is read again after 3 and 8
  seconds (`readAgainAfterSeconds`). Signed out, nothing is read and `order` is null. `since` left out
  takes the newest order, whatever its date. Reads a page of one (`useOrders({ pageSize: 1 })`).
- **New exports:** `LATEST_ORDER_READ_AGAIN_SECONDS` (`[3, 8]`), `ORDER_CLOCK_LEEWAY_MS` (2 minutes),
  `type UseLatestOrderSinceOptions`, `type LatestOrderSince`. The rule is `placedSince(order, since,
  clockLeewayMs)` in `src/orders.ts` (not exported).
- From amore-v2's and amber-v2's `useOrderConfirmedPage` (the same lines in both).
  `test/latest-order.test.mjs` (10 checks).

### The app's own discount code (SDK move 6)

- **New: `useAppDiscountCode(code, { onError? })`.** Puts a code the store keeps for orders from the
  app (an app-only discount, set in the app's settings, not typed by the shopper) on the cart, once per
  cart and code. The codes already on the cart are kept (`applyDiscountCodes` replaces the set). A code
  already there, in any letter case, is left alone; spaces around the code are ignored; an empty code
  or no cart does nothing. A write that fails goes to `onError` and isn't tried again on that cart
  while the hook stays mounted.
- It runs only while the screen that calls it is mounted. amore-v2 and amber-v2 call it from the Cart,
  as before, so the code goes on when the shopper opens the cart.
- From amore-v2's and amber-v2's `useCartPage` (the same lines in both). `test/app-discount-code.test.mjs`
  (6 checks).

### Where a product page's add came from (SDK move 6, needs 0.9.1's attribution)

- **New: `AddToCartInput.source`** (an `AttributionSource`), passed on to `addLine` for the
  provider's `attribution`, never to Shopify. Given to `useProductPage(handle, { source })` or
  `useAddToCart(variant, { source })` it goes with every add from that page, the stepper's + included;
  `page.cart.add({ source })` names one add's. Left out, an add is the app's own, as before.
- Until now only a direct `addLine({ source })` could carry it, so an app whose variant sheet adds
  through `useProductPage` (amore-v2's) couldn't credit a live show or a replay there.

### One rule for pre-ordering and buying a size (SDK move 6)

amore-v2 had two rules for "Preauthorize Now", and they disagreed: the product page's
(`preorderPlanFor` and its buy bar's mode) and the Waitlist's (`canPreOrder`). The Head of Engineering
decided both cases on 2026-10-06, each for the product page's rule, and the one rule is here now, in
`src/purchaseRules.ts`, from the main entry (pure):

- **Stock not tracked** (`quantityAvailable` null), for sale, with a plan: **"Add to Cart"**. Untracked
  stock is always available; pre-order applies only when Shopify says the size is sold out. The
  Waitlist had counted null as 0 and offered Preauthorize Now. (None of Amore's 3,411 variants was
  untracked on 2026-10-05.)
- **A sold-out size with a plan on a blocked product** (an auction, `SEARCH-BLOCKED`): **"Auction
  notice wins"**. It can't be pre-ordered anywhere, and a waitlist card shows it as not buyable too.
  The Waitlist hadn't known about auctions and offered Preauthorize Now. (9 of the 302 sizes that
  qualified on 2026-10-05.)

The API:

- **New: `preorderPlanFor(variant, { blocked? })`** → the variant's `sellingPlan`, or null: sold out
  (a known count of 0 or less), still for sale, a plan of its own, and not `blocked`.
- **New: `purchaseModeFor({ status, variant, canAddMore, heldInOtherCarts? })`** → `PurchaseMode`, the
  first that applies: `'blocked'`, `'preorder'`, `'soldOut'` (status `unavailable`),
  `'heldInOtherCarts'` (Cart Hold's held out), `'allInCart'` (a chosen size on a loaded page, and
  `canAddMore` false), `'buy'`. Takes `useProductPage()`'s `status`, `selection.variant` and
  `cart.canAddMore`.
- **New: `waitlistActionFor(variant, cart, { blocked? })`** → `WaitlistAction`: `'blocked'` (whatever
  the stock or plan), `'preorder'`, `'addToCart'` (back in stock, with a unit beyond what the cart
  holds; an untracked count has no ceiling), `'inCart'` (back in stock, every unit in the cart),
  `'waiting'`.
  - `'blocked'` is new for a waitlist card: an in-stock size of a blocked product was `addToCart`
    before. An app whose card has no "not buyable" footer of its own can show `'blocked'` as
    `'waiting'` (amore-v2 does).
- **New: `StandaloneVariant.product.tags`** (`variants.byIds`, so the waitlist and Buy again), read
  for a card's `blocked` rule. Optional in the type: a variant stored before this build has none until
  the list reads it again.
- Types: `PreorderVariant`, `PreorderOptions`, `PurchaseMode`, `PurchaseModeInput`, `WaitlistAction`.
- `test/purchase-rules.test.mjs` (16 checks, both decisions among them).

### Moving an app over (SDK move 6)

- **Checkout:** replace the app's own re-read, lapsed-hold check, buyer identity, attribution flush
  and `reportCheckoutStarted` with `const { prepare, preparing } = useCheckout()` and
  `await prepare({ hasLapsedHold })`; keep the toast and the navigation for each answer.
- **Order Confirmed:** replace `useOrders({ pageSize: 1 })`, the date check and the 3 and 8 second
  reads with `useLatestOrderSince(checkoutOpenedAt).order`.
- **Cart:** replace the discount code effect with `useAppDiscountCode(code, { onError })`.
- **Variant sheet:** pass the show's attribution source to `useProductPage(handle, { source })`.
- **Product page and waitlist:** replace the app's pre-order rules with `preorderPlanFor`,
  `purchaseModeFor` and `waitlistActionFor`, passing the app's auction rule as `blocked`.
- **Freckled Poppy** has two rules of its own, which these replace, and the shopper would see the
  difference:
  - its product page offers pre-authorise only at a count of exactly 0 (`isWaitlist`:
    `quantityAvailable === 0`), so an oversold size (below 0) wasn't offered it; here it is;
  - its Waitlist's `canPreOrder` is `availableForSale && sellingPlan`, with no stock check, so an
    in-stock size with a plan showed pre-authorise; here it is `addToCart`.

### Events that say what changed, and `useShopifyEvents` (SDK move 7)

Every app's analytics (amore-v2, amber-v2, Freckled Poppy, k-marie, krushkandy) heard the provider's
events through a one-hop bus of its own (`onEvent` is written above the provider, where there is no
cart), then waited 50 ms and diffed the cart to find which line an event was about, because the
event carried no cart. The event now says what changed, and a hook hears it from inside.

- **New on `ShopifyEvent`:** `cart` and `changedLines: CartLineChange[]` on `cart:add`,
  `cart:update` and `cart:remove`; `productId` on `wishlist:add` and `wishlist:remove`; `customer`
  (null while the profile hasn't loaded) and `sessionKind` on `auth:loginSuccess`.
  - `CartLineChange` = `{ line: CartLine; quantityChange: number }`: the line after the write (for a
    line the write took out, the line as it was), and the units added (above 0) or taken away
    (below 0).
  - An `addLines` that landed several lines lists each line once; two inputs on one line are
    counted together.
  - Every other field is as it was. `checkout:orderPlaced` still carries its details as `error`.
- **New: `useShopifyEvents(listener: (event: ShopifyEvent) => void): void`**: every event, from
  anywhere inside the provider, told right after `onEvent` (which is now optional for it). The
  listener is read when an event fires; it starts once mounted and stops on unmount. A throwing
  listener is warned about (`[ShopifyProvider] a useShopifyEvents listener threw`) and costs nothing.
- **New: `showsInCart(cart): ShowsInCart`**
  = `{ live: string[]; replay: string[] }`, the shows a cart holds units from, read off
  `_apptile_attribution`, both by the show's streaming id. For `streamCheckout` and
  `streamPurchase` (Freckled Poppy's `streamAttribution`).
- New exports: `useShopifyEvents`, `type CartLineChange`, `showsInCart`, `type ShowsInCart`.
- `test/shopify-events.test.mjs`: 22 checks.

### Moving an app over (SDK move 7)

- Delete the app's event bus (`shopifyEventBus.ts`) and App.tsx's republishing; the analytics
  listener calls `useShopifyEvents` instead.
- Delete the 50 ms wait and the cart and wishlist diffs; report from `event.cart`,
  `event.changedLines` and `event.productId` (`@tiledev/sdk-analytics-core` 0.3's
  `cartAndWishlistEvents(event)` does the cart and wishlist events).
- A sign-in: report from `event.customer` and `event.sessionKind`; when `customer` is null, from
  `useCustomer().customer` once it loads.
