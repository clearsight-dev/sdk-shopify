# Changelog

## 0.17.0 (2026-10-18)

### New: products by id, and metaobjects

- **`useProductsById(ids, { imageTransform })`:** products by their Shopify ids, in the order given (the
  products a clip shows, a list picked by hand). One batch read (`shopify.products.byIds`), kept for the
  session by id; a product the store no longer has is left out. `{ products, byId, loading, error }`.
- **`useMetaobject(id)` and `shopify.metaobjects.byId(id)`:** a merchant's own content entry (a home page
  hero), each field's value with the picture's URL and the collection's handle. Reused for 10 minutes
  (`MetaobjectById` in the request cache); `refresh()` reads it again.

## 0.16.0 (2026-10-17)

### New: three more collection orders, and the order a collection opens on

K-Marie's sort sheet (its old app's) offers eight orders and opens every collection on "Date, new to old".
0.15.0 had five, always opened on `featured`, and a screen that set the order after opening read the
collection twice.

- **`CollectionSortId`** adds `title-ascending` (Storefront `TITLE`), `title-descending` (`TITLE`,
  reversed) and `created-ascending` (`CREATED`, oldest first), in `COLLECTION_SORTS` after 0.15.0's five.
  The SDK still has no words for any order: a sort sheet's labels are the app's.
- **`useCollectionPage({ initialSortId })`**: the order the page opens on, read when it opens. Default
  `featured`, as before. The first page is read once, in that order; the shopper's choice (`setSortId`)
  wins after that, and a later value is ignored. An id that isn't in `COLLECTION_SORTS` opens on
  `featured`. As in 0.15.0, a new `handle` on the same page keeps the order on screen.

### Fixed

- **A new filter set keeps the feed's filters while its first page loads** (`useProductFeed`, so
  `useCollectionPage`, `useSearchPage` and every feed). 0.15.0 emptied `availableFilters` until the filtered
  page arrived, so a chip for the filter just applied had no name to show for a moment and read as its
  input, `{"available":true}`. They stay now: the same collection or query has the same filters, with the
  same names. Another collection or query still starts with none.

### Changed

- **`CollectionSortId` has three more members**: a `Record<CollectionSortId, …>` (a sort sheet's words for
  every order) needs them to typecheck.

Tests: 10 more in `test/page-models.test.mjs` (the three orders' sorts; the first read in the starting
order, once, for each new id and for `created-descending`; the default unchanged; an unknown id; the
shopper's choice winning; a later `initialSortId` ignored; a new handle keeping the order); 3 more in
`test/collection-filters.test.mjs` (the filters kept while a filtered page loads, replaced by the page's,
and none carried to another collection).

## 0.15.0 (2026-10-13)

### New: a page model for every page, so an app's screens need no hooks of their own

amore-v2's page hooks, moved here with their rules and tests (decided 2026-10-13, Head of Engineering:
"34 hooks are tooo much"; screens call these and pass their fields to the tiles). Each is headless: no
words of its own, no formatting, no navigation. An app with other rules builds its own from the same
exported pieces.

- **Checkout**: `useCheckout({ onReady, onLapsedHold })` adds `start()` (prepare, then where the answer
  leads) and `follow(preparation)` (for `useCartPage().checkout.start()`). An empty cart raises
  `checkout:reservationExpired`, a failure `checkout:couldNotStart`.
- **`useCheckoutPage({ checkoutUrl, source, onOrderPlaced })`**: the web view's `url` (null once the cart
  emptied), `orderPlaced()` (once: `checkout:completed` with the cart as placed and its `shows`, or a link's
  `source`; then `onOrderPlaced`; then `reportOrderPlaced`, for the cart's own checkout only), and
  `checkout:reservationExpired` when the cart empties under an open checkout.
- **`useOrderConfirmation(checkoutOpenedAt)`**: the new order's number and the confirmation email, signed
  in only.
- **Orders**: `useOrders()` adds `status` (`signedOut`, `loading`, `failed`, `empty`, `ready`), `refreshing`
  with `pullToRefresh()`, and `viewed()`. `useOrder(id, { onBoughtAgain })` adds `status` (`ready`, `loading`,
  `notFound`, `failed`, `none`), `buyingAgain` and `viewed()`; `buyAgain()` raises one summary (`orders:boughtAgain`, `orders:boughtAgainPartly` with both
  counts, `orders:nothingToBuyAgain`), calls `onBoughtAgain` once anything went in, and skips a size the
  cart extensions say is held out when no `skipVariant` is given.
- **`useStoreCreditPage()`**: the balance and the activity, read again on `viewed()` and a pull, with the
  signed-out, loading and failed states as amore-v2's page drew them.
- **`useCartStoreCredit()`** adds `blockedBy: 'preOrder'` (a cart holding a pre-order line: `apply` refuses),
  `blockedMessage`, `errorMessage` (by the error's code), `suggestedAmount` and `viewed()`. Apply raises
  `storeCredit:applied` ("$20.00 store credit applied", what the new card takes off) and Remove
  `storeCredit:removed`. Pure: `suggestedStoreCreditAmount`, `cartHoldsPreOrder`.
- **Buying on a product page**: `useProductPage().purchase` (`useProductPurchase`, also on its own):
  `mode` (`purchaseModeFor`), `inCartCount` (a pre-order counts its plan's lines; never a prize),
  `updating`, `add`, `preorder`, `increase`, `removeOne` (`cart:updateFailed` when refused) and
  `joinWaitlist` (`onSignInNeeded` signed out, then `onJoinedWaitlist` with `added` and `waitingFor`).
- **`useProductPage({ onAdded })`** hands over what the add was of, `onAdded(result, { product, variant })`
  (`ProductPageAdd`), for a show's analytics or a live room's announcement.
- **Held out**: `CartExtension.isHeldOut` / `subscribeHeldOut`, `isVariantHeldOut` and
  `useVariantHeldOut(variantId)`, so Cart Hold's "every unit is in other carts" reaches the product page
  and Buy again without the app wiring it.
- **`useQuickAdd({ credit, onChooseVariant, onAdded })`**: a card's Add to Cart (one size for sale goes
  straight in, its stock the ceiling; anything else `onChooseVariant`) and `addingProductIds`.
- **`useCollectionPage({ handle, pageSize, imageTransform, onView })`**: `useCollectionProducts` with the
  shopper's sort (`CollectionSortId`, `COLLECTION_SORTS`), `removeFilter`, and the view reported once per
  collection. `ShopifyProvider productsPerPage` sets every page's size.
- **`useSearchPage({ query, imageTransform, recommendedCollection, onSearched })`**: the field's term, the
  search in the shopper's order (`SearchSortId`, `SEARCH_SORTS`), `hasResults`, `resultsShown`, `noMatch`
  with the store's products under it, the start page's row, `removeFilter`, and the search reported once
  per settled term.
- **`useWaitlistPage({ isBlocked })`**: every size (its card's `action`), ready ones first, the Status and
  Price filters (`WAITLIST_READY_FILTER`, `WAITLIST_WAITING_FILTER`, `filterWaitlist`, `readyFirst`,
  `isWaitlistReady`), the counts and price range, `addToCart`/`preorder` (one card at a time),
  `justAdded`/`dismissAdded`, `remove`, `retry`, `viewed()`.
- **`useFavoritesPage()`**: the saved products, `status`, `retry`, and `viewed()` filling in any missing.
- **Sign-in**: `useSignIn({ onOpenSignInPage, alertOnFailure })` chooses where it happens (`auth.method`,
  and `auth.signInSurface`, new: `sheet` or `webview`); `useSignInPage({ method, onDone })` runs the
  page's password form (remembering the email and names for the app's session) or Shopify's page in a web
  view. A sign-in that can't reach the store raises `auth:couldNotReachStore` where asked.
- **`useGridColumns(fallback)`**: the shopper's products per row, kept in the provider's `storage` under
  `gridColumnsStorageKey` (new provider prop, default `shopify:grid-columns:v1`).
- **`updateProfile`** raises `auth:profileUpdated` when the save worked.

### New: alerts for the words those hooks had of their own

22 alerts, each a Settings panel field under `settings.alerts` (`ALERT_SETTING_FIELDS`), with amore-v2's
words as the defaults: `checkout.reservationExpired`, `checkout.couldNotStart`, `cart.updateFailed`,
`orders.boughtAgain`, `orders.boughtAgainPartly`, `orders.nothingToBuyAgain`, `auth.profileUpdated`,
`auth.couldNotReachStore`, and `storeCredit.*` (the two toasts, the pre-order note and each error code's
words, at the paths amore-v2 already published them). A message's `{name}` placeholders are filled
(`fillMessage`; `useShopifyMessage()(key, fill)`). `useShopify().report(type, details)` raises an event as
the provider's own writes do, for the page models. `currencySymbolOf(currencyCode)` is new in the money
helpers.

### Changed

- **`useCartStoreCredit().apply` refuses a cart holding a pre-order line**, and Apply and Remove now raise
  their toasts' events: an app that toasted them itself shows them twice.
- **`useOrder().buyAgain()` raises its summary**: an app that toasted its own shows two.

Tests: `test/page-models.test.mjs` (35), 6 more in `test/orders.test.mjs`, 1 in `test/alerts.test.mjs`,
1 in `test/auth-provider.test.mjs`.

## 0.14.0 (2026-10-12)

### New: `useCartPage`, and `cartExtensions` so other SDKs add to the cart

A whole cart page from the SDK, in the style of `useProductPage`, moved from amore-v2's `useCartPage`
with its tests. An app can use it as it is, or write its own cart hook from the same pieces.

- **`useCartPage({ lineOrder, appDiscountCode, onError })`**: `status` (`loading`, `empty`, `ready`),
  `lines` (`CartPageLine`: the line, `unitPrice`, `canIncrease`, `preOrder` amounts, `busy`, and the
  facts below), `amounts`, `justAddedLineId`, `increase`/`decrease`/`remove`, `note.save`,
  `checkout.start()`/`starting`, `viewed()`, `refresh`. No words, formatting or navigation.
- **`ShopifyProvider cartExtensions`** (`CartExtension`): what other SDKs know about a line
  (`holdExpiresAt`, `prize`, `isServiceLine`), whether + adds a new line, when to read the cart again,
  and whether a reservation ran out. Cart Hold's `cartHoldExtension()` and live selling's
  `giveawayPrizeExtension()` implement it; an app can add its own. A throwing extension is skipped
  with a warning.
- **`useCheckout().prepare()`** asks the extensions about a lapsed reservation when the caller passes no
  `hasLapsedHold`, so every checkout entry waits for one.
- **Two events**: `cart:viewed` (`viewed()`) and `checkout:started` (`checkout.start()`, with the cart and
  `shows`, the live shows and replays it holds units from). sdk-analytics-core 0.3.1 reports them.
- **The rules, without React**: `cartLineFacts`, `increaseAddsLine`, `cartRefreshDelays`,
  `hasLapsedHoldIn`, `orderCartLines`, `canIncreaseLine`, `preorderAmounts`, `amountChargedWhenShipped`,
  `cartAmountsDueNow` (`src/cartPage.ts`).
- Tests: `test/cart-page.test.mjs` (23), `test/cart-page-hook.test.mjs` (7).

### New: the gallery can follow each variant pick

- **`useVariantSelection` / `useProductPage().selection`** add `mediaIndex` (the gallery slide showing the
  chosen variant's photo, or null) and `pickCount` (each `setOption` / `selectVariant`, the same one again
  included; 0 at the start, after `reset` and for a new product). A gallery moves to `mediaIndex` on each
  new `pickCount`: never on the page's opening, a size whose photo is already showing included.
- **`mediaIndexOf(media, imageUrl)`**: an image's slide, matched by its file whatever size either address
  asks for; only stills. Tests: 2 more in `test/product-page.test.mjs`.

## 0.13.1 (2026-10-12)

### Fix: an add Shopify clamped to nothing no longer reads as added

Shopify doesn't refuse an add past the stock: it answers ok and adds what is left, or nothing. The add
said `ok: true` either way, so every app had to count units itself (Freckled Poppy's `addLanded` at
each call site). The SDK now counts them.

- **Every add is measured**: the variant's units across all lines of the cart Shopify returned, against
  the cart it was written to (after a dead-cart replacement, the new cart before the retried add, so a
  rebuilt cart that already holds the item counts right).
- **`addLine`**: nothing landed is `ok: false`, `reason: 'clamped'` (new in `CartRejectionReason`), the
  `cart.noMoreStock` copy, and the cart. Some landed is `ok: true` with `landedQuantity` below the
  quantity asked. `CartWriteResult.landedQuantity` is new and set on every written add.
- **`addLinesDetailed(inputs, { quiet })`** (new): `CartLinesWriteResult`, `addLines`'s outcome with
  `lines: CartAddOutcome[]` (`{ merchandiseId, requestedQuantity, landedQuantity }`) per input.
  **`addLines` now returns `null` when nothing landed**, including a batch Shopify clamped to nothing;
  0.13.0 returned the unchanged cart.
- **Events**: a clamp raises `cart:stockLimit` (the `cart.noMoreStock` alert, as for `maxQuantity`)
  with `clamped: CartAddOutcome[]`; not for a `quiet` `addLines`. `cart:add` fires only when units
  landed, and its `changedLines` count what landed, not what was asked.
- **Guard and attribution**: `onLanded` and the `_apptile_attribution` count only landed units; the
  units cut go back through `onReleased` (`reason: 'rejected'`).
- Tests: `test/add-landed.test.mjs` (19).

## 0.13.0 (2026-10-12)

### Fix: a cart that is gone in Shopify no longer breaks every cart write

Found on Freckled Poppy (2026-10-11), during a live show: the stored cart had become an order (the app
missed the order page) and every add failed until the app was relaunched. Shopify answers a write to a
converted or expired cart with HTTP 200, a `cartId` userError (code `INVALID`) and a brand-new cart,
which is never used. 0.12.0 handled this only at launch. Minor, not a patch: `refresh()` and the cart
writes behave differently on a gone cart, and the launch rule changed (below).

- **`isMissingCartError(error)`**: a userError on `cartId` with code `INVALID`. By field and code, not
  the message, which Shopify localises. Exported from the root.
- **One rule for the replacement cart, at launch and while the app runs** (`react/cartRecovery.ts`):
  - the cart marked by `reportCheckoutStarted`: empty (`reason: 'ordered'`);
  - last used more than 10 days ago (Shopify's cart expiry): rebuilt from the phone's line snapshot
    (`'expired'`);
  - otherwise: **empty** (`'missing'`). A cart used recently and gone was most likely bought, on
    another device or the web, or after the checkout mark was cleared; rebuilding it would put bought
    items back. **Changed at launch too**: 0.12.0 rebuilt every unmarked gone cart.
  - "Last used" is a new record, `shopify:cart-activity:v1` (`{ cartId, at }`), written with the
    line snapshot on every cart write that lands (a new cart counts). Reads (`refresh()`, launch,
    `adopt` without a change) don't move it: Shopify's expiry runs from the cart's last change. A read
    of a cart with no record yet (an install from before 0.13.0, an adopted cart) records Shopify's own
    last change, `Cart.updatedAt`, so a cart that is then left alone past ten days is still rebuilt.
    A cart gone before any record was made (never read since the upgrade) counts as recent: empty.
- **While the app runs**, a write that Shopify refuses for its `cartId` reads the cart once to confirm
  it is gone, then replaces it inside the cart's write queue, before the next write runs. Every write
  now takes the cart id when its turn comes, not from the render it was called in, so a callback
  captured before a replacement writes to the new cart (a signed-in shopper's `setBuyerIdentity` from
  `prepare()` used to go to the old one).
  - `addLine` / `addLines` write once more on the new cart. Every other write (update, remove, buyer
    identity, discount codes, note, gift cards) throws the original error; `ensureCartAttributes`
    answers false. `refresh()` reading the cart as gone returns the new cart (null if it couldn't be
    made).
  - When the cart changed meanwhile (`reset`, `adopt`), the replacement is dropped and the write uses
    the current cart. At most 3 replacements a minute; past that, and when the
    new cart can't be made, the write throws its original error and nothing retries by itself.
  - The checkout mark is cleared after the new cart is stored, not before.
- **New event `cart:recovered`**: `recovery: { deadCartId, newCartId, reason: 'ordered' | 'missing' |
  'expired' }` and the new `cart`. Not raised at launch. Types `CartRecovery`, `CartRecoveryReason`.
- Tests: `test/cart-recovery.test.mjs` (33); `cart-snapshot` and `attribution-provider` updated for the
  new launch rule. Every test file now sets `navigator` with `Object.defineProperty`, so the suite runs
  on Node 22.

## 0.12.0 (2026-10-08)

### New: each cart line's discounts (`line.discounts`) and the whole cart's (`cart.discounts`)

Found on Amore (2026-10-08): a giveaway prize is made free with a discount code for its size, and when
the cart holds a second line of that size Shopify spreads the code over both ($10 and $10 for a $20
prize), so the prize line alone looked half-paid. Telling that apart needs each line's share of each
discount, which the cart didn't ask for. Additive: nothing changes for an app that doesn't read it.

- **`CartLine.discounts`**: `{ amount, code, title, onShipping }[]`, each discount's share of the line,
  from Shopify's `discountAllocations` (`code` for a code, `title` for an automatic or custom discount).
  Empty when nothing is taken off; optional, as a cart read before this release has none.
- **`Cart.discounts`**: the same, for discounts on the whole cart (an order discount). A line's own are
  already off the subtotal; these come off after it.
- **`onShipping`**: the discount is off shipping (Shopify's `targetType` `SHIPPING_LINE`). Amore's
  automatic FREESHIP sits on every cart as $9.80 off shipping, before any shipping is charged.
- Asked for on every cart read and write (the shared cart fragment).
- Tests: `test/cart-line-discounts.test.mjs` (5). 600 checks.

## 0.11.0 (2026-10-08)

### New: link tags on the cart (`linkTags`)

Decided 2026-10-08 by the Head of Engineering, for order attribution: a link that opens the app with
`ref` or `utm…` tags (`?ref=brandi10&utm_source=instagram&utm_medium=influencer&utm_campaign=fall_drop`)
has them saved on the phone for a set number of days and put on the cart, so the order's attributes
say which link the shopper came from. Additive and off by default: nothing changes for an app that
doesn't pass `linkTags`.

- **`ShopifyProvider`'s `linkTags={{ keepDays, getInitialUrl, subscribe }}`**: the app hands in its
  links (React Native's `Linking`); the SDK imports nothing from React Native. `keepDays` 0 is off.
- **The last link wins** (decided the same day): its tags replace the saved ones, and every older tag on
  the cart. **Tags that ran out stay on a cart that already has them** ("Leave them on"); new carts
  don't get them.
- On new carts, the current cart, a stored cart once it loads, an adopted cart, and again in
  `useCheckout().prepare()`'s labelling step. `useCart().saveLinkTags(url)` for links the app routes
  itself.
- `links.trackingTags.v1` in the provider's storage. Pure helpers exported: `linkTagsFrom`,
  `isLinkTagKey`, `liveLinkTags`, `withLinkTags`, `cartHasLinkTags`, `readSavedLinkTags`.
- `useCart().adopt` now returns the cart as it is after the tags went on (the same cart otherwise).
- Tests: `test/link-tags.test.mjs` (12) and `test/link-tags-provider.test.mjs` (16). 595 checks.

## 0.10.1 (2026-10-08)

### Fix: applying another filter after a price filter removed the price filter

Found on Amore (2026-10-08): on a collection, set a price range, apply, then tick "In stock" and apply
again: the price filter was gone. Once a price filter is applied, Shopify answers the `PRICE_RANGE`
facet with the applied range itself (`{min:20,max:40}` for a 20–40 filter, read from the store). The
filter sheet took that for the collection's whole range, so on the next Apply both bounds sat at the
range's ends and `priceFilterInput` read them as "no bound".

`useProductFeed` now remembers the feed's whole `PRICE_RANGE` facet from its last read made without a
price filter, and while a price filter is selected `availableFilters` offers that one instead (added
when Shopify leaves the facet out). A feed opened with a price filter already selected has nothing to
remember and offers Shopify's facet, as before. No API change.

`test/collection-filters.test.mjs`: 4 checks (567 in all).

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
