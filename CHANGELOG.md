# Changelog

## 0.23.0 (unreleased)

- **`useCustomerTags({ active?, everyMs? })`**: the signed-in customer's tags (`tags`, `known`, `hasTag`,
  `refresh`), for rules a store keys on them. `tags` is null until read; a failed re-read keeps the last known.
  One shared read, re-read on sign-in, account change, focus (`active`), foreground and `everyMs`, at most once
  per 30 s unless forced. Customer Account API for a Shopify sign-in, Storefront for a password session.
- **`ShopifyConfig.variantMetafields`**: like `productMetafields`, read on every product read's variants as
  `variant.metafields`. Unset, nothing changes.
- **Product customisation**: questions a product asks before checkout, as JSON in a product or variant
  metafield (`ShopifyConfig.customisation`). `useProductCustomisation({ productHandle, variantId, cartLineId })`
  (questions, prefilled answers, `save()` onto the line and this device) and `useCartCustomisation()` (the lines
  that still need answers, for holding checkout) and `useSavedCustomisations()` (what this device saved per
  variant, answers and line attributes) with `useItemsCustomisation(items)` (the same gate for items paid on a
  cart made later, such as an auction's wins); the rules are pure exports (`visibleQuestions`,
  `customisationComplete`, `customisationAttributes`, `answersFromAttributes`, `lineNeedsCustomisation`).
- **`DescriptionSpan.href`**: a description link's address (http(s), mailto and tel only).
- **`useWishlist().remove(productId, { silent: true })`**: removes without the `wishlist:remove` event (and its
  toast), for removals the shopper didn't ask for, such as what an order just bought.
- **`queryTemplate`** on `useSearch` and `useSearchPage`: what is sent for the term, `{query}` standing for it
  (`{query}* -tag:hidden` for prefix matches without a store's hidden products); `searchQueryFrom(term, template)`
  is the rule. The page's `query` stays what was typed. Unset, the term is sent as it is.
- **`ShopifyProvider` `wishlistHydrateOnInit` and `wishlistBatchSize`**: the wishlist's `hydrateOnInit` and
  `batchSize`, which only `shopify.wishlist.init` took. False skips the launch re-read of every saved product;
  `useFavoritesPage` re-reads when it opens.
- **`useFavoritesPage({ showGone: true })`**: a saved product the store no longer has stays as a card from what
  the device saved (title, photo, price; not for sale), listed in `goneIds`. Needs `wishlistKeepDeleted`. Unset,
  nothing changes.

## 0.22.0 (2026-10-22)

- **What a card's Add to Cart does, app-wide: `ShopifyProvider`'s `quickAddStraightToCart`** (default
  `true`, as before). False sends every `useQuickAdd` tap under the provider to `onChooseVariant`, a product
  with one variant for sale too: another SDK's quick adds as well (sdk-apptile-live-selling's Live and
  Replay products), with no change to their calls. For the app's Common Buttons "Allow Quick Add to Cart",
  which decides what a card's Add to Cart does rather than whether it shows (decided 2026-10-22, Head of
  Engineering): on, one variant goes straight into the cart and more open the variant page; off, every tap
  opens the variant page. Live-updatable, read at the tap.
- **`useQuickAdd`'s `addStraightToCart`**: the same for one call, over the provider's.
- **The favourites' alerts say "favorites"** (ENG-945): `wishlist.added` "Saved to your favorites",
  `wishlist.removed` "Removed from favorites", `wishlist.empty` "You have no favorites yet". Shoppers know the
  list by the star as their favorites; "wishlist" stays the code's name for it. An app's `messages` still
  override them.

## 0.21.1 (2026-10-21)

- **`BLOG_IMAGE`** (`{ maxWidth: 1080 }`), from the package root: the size every read of a blog's articles asks
  Shopify for, so a blog's list and the article it opens share one download. From the base app's
  `src/core/utils/images.ts`, which its blog tiles' wiring imported; now they import it from here, as
  `CARD_IMAGE` since 0.21.0.
- **`longDate(iso)`**, from the package root: "June 14, 2026", a blog article's day as the blog tiles show it, in
  the phone's time zone; empty for no date or one that can't be read. From the base app's
  `src/core/utils/dates.ts`, for the article page's byline.

## 0.21.0 (2026-10-21)

### New: the base app's tile helpers, from the package root (2026-10-21)

Every Tile app built on amore-v2 (sparkl-v2, k-marie-v2) carried its own copy of three small helpers its
tiles' wiring imports: `src/core/utils/images.ts`, `src/core/utils/auction.ts`, and `openWebPage` from
`src/core/services/storeLinks.ts`. They are in the SDK now, with the same names, values and behaviour, so
the wiring imports them from `@tiledev/sdk-shopify`, beside `sizedImageUrl`.

- **Card and product page image sizes:** `CARD_IMAGE_WIDTH` (660), `CARD_IMAGE` (`{ maxWidth: 660 }`)
  for every list of product cards, `PRODUCT_PAGE_IMAGE` (`{ maxWidth: 1080 }`) for every read of a whole
  product. `cardImageUrl(url)` is the card-sized copy of an image (`sizedImageUrl(url, 660)`);
  `cardPhotoUrl(url)` is the URL a card actually loads: an image Shopify already sized
  (`photo_1080x.jpg`, `photo_330x@2x.jpg`, `…_100x100_crop_center.jpg`) as it is, else the card size.
  Both return `string | null`, null for no URL.
- **The auction tag:** `AUCTION_TAG` (`'SEARCH-BLOCKED'`) and `isAuctioned(product)`, true while the
  product carries it (exact case), for `useProductPage`'s and `useWaitlistPage`'s `isBlocked`. Anything
  with `tags` will do (a product, a waitlist variant's `product`); no tags is false.
- **`openWebPage(url)`:** a page on the store's own website opens in the in-app browser
  (expo-web-browser's `openBrowserAsync`), any other link with the phone (`Linking.openURL`: its browser,
  or the app that owns the link). A plain function, for an `onPress`. Nothing is thrown or rejected: a
  page that can't open just doesn't. On the web (the editor preview, browsers) every link opens in a new
  tab, `window.open(url, '_blank', 'noopener')`, as React Native Web's `Linking` does.
- **`ShopifyConfig.webDomains?: string[]`:** the store's website, as hosts in any case (amore-v2's
  app.json `extra.shopify.webDomains`, which the three apps already spread into their config).
  `ShopifyProvider` sets them on its first render and again when its config brings others;
  `shopify.init` sets them too. **`isStoreWebLink(url)`**: https only, the host in any case, on one of
  them. Unset: no link is the store's, so every link goes to the phone.
- **`expo-web-browser` is a new optional peer** (`>=12.0.0`). The phone's build
  (`openWebPage.native.ts`, which Metro picks on iOS and Android) requires it only when a store page
  opens, inside `try`, so an app without it in its binary opens store pages with `Linking.openURL`
  instead of crashing. React Native is required the same way, as `AppState` already is; the SDK still
  doesn't depend on it. The web build (`openWebPage.ts`) requires neither.
- **What stays in the app:** turning a store link into the app's own link and routing it to a screen
  (`asAppLink`, `openStorePage`, `shopifyPathForApp`) and the link-tag days, which read its route table,
  its scheme and its Live Layer.
- **Upgrading:** import these from `@tiledev/sdk-shopify` instead of `@/core/utils/images`,
  `@/core/utils/auction` and `@/core/services/storeLinks`; nothing else changes while the config handed to
  `ShopifyProvider` carries `webDomains`.

Tests: `test/tile-helpers.test.mjs` (23 checks: the sizes; `cardImageUrl` on an original, one with a
query, a sized URL and none; `cardPhotoUrl` keeping sized URLs and sizing originals, and answering as
amore-v2's did URL for URL; the tag, with other tags, none, null, another case, a filter and a waitlist
variant's product; `isStoreWebLink` with no domains, set by `shopify.init` in any case, http, lookalikes,
the Shopify domain and the app's scheme, and cleared; set by `ShopifyProvider` on its first render, again
for other domains, and none without; on the phone's build, store pages to the in-app browser and the rest
to `Linking`, at once, store pages to `Linking` with no domains or no expo-web-browser, and rejections,
a throwing browser and no React Native swallowed with no unhandled rejection; on the web build, a new tab,
and nothing thrown without a window).

## 0.20.0 (2026-10-20)

### New: star ratings on every product, from Shopify's review metafields (2026-10-20)

Product cards had no way to show stars: no product read asked for a rating. Decided 2026-10-20: cards
show the rating "from metafields", Shopify's standard review metafields that review apps write.

- **`Product.rating: ProductRating | null`**, `{ value, scaleMax, count }`: the average (kept between 0
  and `scaleMax`), the top of its scale (5 for most apps; another is kept as it is) and how many
  reviews (0 when the app wrote no count). Read from `reviews.rating` (a `rating` JSON,
  `{ value, scale_min, scale_max }`) and `reviews.rating_count` (an integer). Null when the product has
  none, when the store hasn't given those definitions Storefront access, or when the value can't be
  read as a rating; reading one never throws.
- **Every product read asks for both**, in `ProductCoreFields` (so `ProductCardFields` and
  `ProductFields`): collection pages, search, recommendations, `byIds` (recently viewed, products from
  past orders, `useProductsById`), the wishlist, `list`, and the product page's `byHandle` / `byId`.
  Selected as `ratingMetafields: metafields(identifiers: …)`, beside the app's own `productMetafields`
  (two unnamed `metafields` selections with different identifiers would be a GraphQL error). On the
  test store's 50-product collection page: query cost 723 to 730, about 30 bytes a product with none.
- **`rating` is a base key** (`PRODUCT_BASE_KEYS`), so a product page opened from a card shows its stars
  in the first frame. The product store's keys move to **`v4`** (a stored product without `rating` is
  never read as "no rating"); `v3` keys are cleared from the device once, after launch, like `v1`/`v2`.
- A wishlist product saved by an earlier SDK reads as `rating: null` until its refresh, never undefined.
- **Upgrading:** `rating` is required on `Product`, so a `Product` an app builds by hand (a module's
  `fixtures.ts`) needs `rating: null` (or a rating) to type-check.
- **Store-side**: the metafield definitions need Storefront access (Settings → Custom data → Products →
  the definition → Storefront access), and a review app must fill them; README, "Star ratings on
  products". On skandi-apparel (the test store), none of its 446 products has either metafield today,
  so `rating` is null on every one.

Tests: `test/product-ratings.test.mjs` (18 checks: a rating and its count, either order, numbers or
text; a scale other than 5; missing (no metafields, Storefront's nulls, a count alone); malformed
(unreadable JSON, a bare number, no value, no scale, a scale of 0 or below, a value that isn't text);
kept on the scale; a count missing, unreadable, fractional or below 0; both fragments carry the
selection inside `ProductCoreFields`, and each read (collection page, search, recommendations,
`byIds`, both product-page reads, `list`, the wishlist refresh) sends it beside the app's own
metafields and returns the rating; the rating in the base keys; a wishlist product saved before it).
`test/product-store.test.mjs`: keys are `v4`, and `v3` keys are cleared.

## 0.19.0 (2026-10-19)

### New: the shopper is told when a reservation runs out, on any screen (ENG-695, 2026-10-19)

Nothing said a cart hold had run out: the Cart's line turned to "Reservation expired" and checkout sent the
shopper back to it, but on Home, a product page or a live show nothing happened, and the line stayed in the
cart (and its badge) until something read the cart again.

- **`cart:reservationExpired`**, raised by `ShopifyProvider` at the moment a hold the `cartExtensions`
  report (`holdExpiresAt`) runs out, wherever the shopper is: words `cart.reservationExpired` ("Your
  reservation expired and the item was released.", production's, as checkout says them; the panel's
  `settings.alerts.cart.reservationExpired`), severity `info`, with the cart. Once per hold, never again
  when the sweep takes the line; holds that run out together are one alert. Not for a hold that had
  already run out when the provider first saw its line (the app was closed), a line the shopper took out
  first (a remove still on its way included), or a swapped cart (Cart Assist adopting another, the fresh
  cart after an order, a replaced cart). The app in the background at that moment: said as it comes back.
- **`reservationExpiredAlert?: { enabled: boolean }`** on the provider: on when unset; `false` turns the
  alert off. Read when a hold ends, so a Live Layer publish applies at once.
- **The cart is read again after each hold ends on every screen** (the extensions' `refreshDelays`: Cart
  Hold's 1, 30, 60, 90, 120 and 150 s), whether the alert is on or off, each time once, until the line
  has gone; a hold that ran out while the app was closed gets the reads still to come. Reads due together
  (the app back from the background) are one read.
- **`cartReadTimesAfterHold(cart, holdEndsAt, extensions)`**: those times, from the extensions asked just
  before the hold ends. `CartExtension.refreshDelays` must answer from its `now` alone (Cart Hold's does).

Tests: `test/hold-end-watch.test.mjs` (23 checks, on a fake clock: one alert at the end and none before,
none on later reads or at the sweep, holds ending together, a late timer, a hold past the longest timer, a
new stamp; none for a hold that ran out while closed but its reads still to come, none after hours; none
for a line removed first or a remove on its way, another line at the same moment still told; a swapped cart
and no cart; the switch off and turned on meanwhile; reads at each time once though each read is a new
cart, stopping once the line has gone, due together as one, two holds, a failed read; stop and start).
`test/hold-end-provider.test.mjs` (10 checks, the real provider on real timers: the alert with its words,
`info` and the cart; none at the sweep, the line gone with no Cart page open; the panel's words; the switch
off and turned off by a new prop, the reads still made; the reads with no Cart page, and not twice with
it; none after a remove, an adopted cart, or at launch after a hold ran out, whose read still comes).
`test/cart-page-hook.test.mjs`: the page reads nothing itself. `test/alerts.test.mjs`: 38 alerts.

### New: an option value says it is a pre-order (ENG-607, 2026-10-19)

A size sold out but sold on its pre-order plan had nothing in its option state to say so: `available`
was false at 0 left, so a chip under it said "Waitlist" (or crossed it out) while the buy bar offered
pre-order; oversold below 0, it was available, and a chip printed the count ("-10 Left"). On the test
store, 294 pre-orderable sizes read "Waitlist" or were crossed out, and 9 showed a count below 0.

- **`OptionValueState.preorder`**: the size the value picks is pre-ordered (`preorderPlanFor`: sold
  out, still for sale, on a plan of its own), at 0 left or oversold below it. Never on a product that
  can't be bought (an auction). `available` and `quantityAvailable` are unchanged.
- **`optionStates(options, variants, selection, isUnavailable, { blocked })`**: a fifth argument, the
  same `PreorderOptions` as `preorderPlanFor`; left out, nothing is blocked.
- **`useVariantSelection({ blocked })`**, and **`useProductPage` passes its `isBlocked`** through, so
  a product under auction has no pre-order value, as its bar already offers none.

Tests: 2 more in `test/product-page.test.mjs` (pure: at 0 and below 0 a pre-order, with stock or with
stock not tracked not, no longer for sale not, blocked never; through `useProductPage`: a sold-out and
an oversold size on a plan, and none with `isBlocked`), and one more assertion in its option-states
check (no plan, no pre-order).

### Fixed: store credit on a flaky network (ENG-674, 2026-10-19)

One blip from Tile Credit (a 502 while Shopify throttled it, a moment offline) ended a store-credit
page's read, and its Retry read the activity again but not the balance, with nothing on screen to say it
was trying.

- **A Tile Credit read that meets a blip is sent once more, a second later** (`TileCreditClient`, so
  `useStoreCredit`, `useStoreCreditHistory`, `useCartStoreCredit`'s balance and `getHistory`'s gift
  cards): a 429, 502, 503 or 504, or no answer at all (offline, or past `timeoutMs`). With the same
  token, once per call: a call is at most three sends (the blip, the try after it, and a 401's renewal,
  which works as before). A second blip's answer is the error. **A write (`redeem`) is never sent
  again**, so a lost answer can't mint a second card, and neither is a request the caller cancelled
  (`signal`). A 500, 400, 402, 403, 404 or 409 says something about the request and stands at once.
- **`useStoreCreditPage()` → `retry()` and `retrying`**: Retry reads the balance and the activity again
  (it was `history.refresh`, the activity alone: offline, the balance had failed too), once at a time
  and only signed in. While it runs, an activity with nothing to show counts as loading
  (`historyLoading`, the list's first-load spinner) and not failed (`historyFailed`), and a missing
  balance as loading (`balanceLoading`, as for any read). `retrying` stays true until both answer.

Tests: 7 more in `test/tile-credit-client.test.mjs` (with fake timers: a 503 sent again at 1,000 ms and not
at 999; 429, 502, 504 and no answer; a blip that stays; 500, 400, 403 and 404 sent once; a redeem sent
once after a 503 or no answer; with a 401, the renewal and one blip try per call; a cancelled read), and
5 more in `test/store-credit-history.test.mjs` (`useStoreCreditPage`'s Retry: both read again and shown
loading meanwhile, one at a time, both shown when they answer, nothing signed out; and a 503 on the
ledger asked once more).

### Changed

- **`OptionValueState` has one more field** (`preorder`): an object built as one by hand (a tile's
  fixture, a screen test's mock) needs it to typecheck.
- **`StoreCreditPage` has two more fields** (`retry`, `retrying`): an object built as one by hand (a
  screen test's mock) needs them to typecheck.
- **`useCartPage` no longer reads the cart after a hold** (it did since 0.14.0): the provider does, so the
  Cart open reads no more than any other screen. Its reads were also cut short: each read is a new cart,
  which started its timers again from the next hold still running, so only the 1 s read happened and Cart
  Hold's sweep (55 to 105 s after) was seen only when something else read the cart.
- **An app that reads after a hold itself** (sdk-apptile-cart-hold's `useRefreshAfterHoldExpiry` on its own
  cart screen) now reads twice: drop it.
- **A host that toasts every event with a message** (`useAlertSettings`) shows the new alert without a
  change; it is silenced like any alert when its panel field is cleared.

## 0.18.0 (2026-10-19)

### New: every blog with its newest articles, and a blog's articles a page at a time

For a base app's Blogs page (every blog, each with its newest posts) and Blog page (all of one blog's
posts, more as the shopper scrolls), decided 2026-10-19.

- **`useBlogs({ articlesPerBlog, imageTransform, enabled, onError })`** → `{ blogs, loading, error,
  refresh, refreshing }`: every blog the store has, in the order the store made them, each a
  `BlogWithArticles` (`id`, `handle`, `title`, its newest `articles` first, `articlesPageInfo`); a blog
  without articles has none. **One request** (`BlogsWithArticles`): `Blog.articles` is a connection, so
  each blog's first articles come in the same answer as the blogs, up to 50 blogs a read (a store with
  more is read on, up to 250). `articlesPerBlog`: default `BLOG_ARTICLES_SHOWN` (6), rounded, 1–50. Read
  once per count and image size a session; `refresh()` reads again from the network, keeping the blogs
  shown (`refreshing` meanwhile). Reused for 10 minutes by the request cache.
- **A blog or an article opened from there draws in the first frame:** each blog's articles count as
  its first page for `useBlogArticles` at the same count and image size (with where its next page
  starts), and each article for `useArticle`.
- **`useBlogArticles` pages:** `loadMore()` reads the next `limit` articles and adds them after the
  ones shown (each once); `hasMore`, `loadingMore`. A failed next page sets `error`, keeps the articles
  and ends `hasMore`, so a list's end can't ask again and again offline; `refresh()` starts over from the
  first page (the next pages dropped, a next page still on its way too), keeping what is shown until it
  lands (`refreshing`). Also `blog` (the blog's `id`, `handle`, `title`, for a page's title) and
  `notFound` (read, and the store has no blog by that handle). Its existing return (`articles`,
  `loading`, `error`, `refresh`) is unchanged, and so is every read before the first `loadMore()`:
  `articles` holds at most `limit` until then.
- **`loading` from the first frame:** with nothing known and a read about to start, `useBlogs` and
  `useBlogArticles` say `loading` in their first frame (`useBlogArticles` said it from the second
  until now), so a page never shows its "no articles" state before the read.
- **`shopify.blogs.listWithArticles({ first, after, articlesPerBlog, imageTransform, fresh })`** →
  `Connection<BlogWithArticles>`, and **`shopify.blogs.articlesWithBlog(blogHandle, opts)`** →
  `{ blog, articles }` (`blog: null` for a blog the store doesn't have). `shopify.blogs.articles` is
  unchanged (its query now also reads the blog's id, handle and title).

Tests: `test/blogs-and-paging.test.mjs` (13 checks: every blog in one request with the count and image
size sent and `loading` from the first frame, a blog without articles, read once and again on refresh
with the blogs kept, the count's default and bounds, 60 blogs in two reads, `enabled`, a failed read and
a failed refresh; a blog and an article opened from the blogs page drawn with no read and the next page
carrying on; pages until there are no more, `loadingMore` and one read for two asks, a failed next page
then a refresh, a next page landing after a refresh dropped, a missing blog, both methods without
React).
`test/blog-articles.test.mjs`'s 13 checks pass unchanged.

## 0.17.0 (2026-10-18)

### New: products by id, and metaobjects

- **`useProductsById(ids, { imageTransform })`:** products by their Shopify ids, in the order given (the
  products a clip shows, a list picked by hand). One batch read (`shopify.products.byIds`), kept for the
  session by id; a product the store no longer has is left out. `{ products, byId, loading, error }`.
- **`useMetaobject(id)` and `shopify.metaobjects.byId(id)`:** a merchant's own content entry (a home page
  hero), each field's value with the picture's URL and the collection's handle. Reused for 10 minutes
  (`MetaobjectById` in the request cache); `refresh()` reads it again.

### New: recently viewed, and products from past orders

For two base-app tiles, "Recently Viewed" and "Repeat Orders" (decided 2026-10-18).

- **`shopify.recentlyViewed`** (`init`, `isReady`, `record({ id, handle })`, `list`, `remove`, `clear`,
  `onChange`): the products a shopper opened, newest first, kept on the device with the wishlist's
  storage rules. An entry is `{ id, handle, viewedAt }`, never the product. Opened again, a product moves
  to the front; past `limit` the oldest goes. Nothing records a view by itself: the product page's
  screen calls `record` (no hidden side effect in `useProductPage`).
- **`ShopifyProvider recentlyViewed={{ storage, storageKey, limit }}`**: default the provider's `storage`,
  `tile:shopify:recentlyViewed:v1` (a new key, nothing to migrate), and 20 products (1–50). Read when the
  provider mounts, without waiting for the shop; a product recorded before the read finishes stays.
- **`useRecentlyViewed({ limit, leaveOut, imageTransform, enabled })`** → `{ products, loading, error,
  record, clear }`: the stored products as the store has them today, through `useProductsById` (its
  batch read and session cache), newest first, at most `limit` (default 10), without `leaveOut` (the open
  product, by id or handle). Every hook shows a change at once, wherever it was recorded. A product the
  store no longer has is left out and taken off the device.
- **`usePastOrderProducts({ orders, limit, imageTransform, enabled })`** → `{ products, items, loading,
  error, signedIn, refresh }`: the products on the signed-in shopper's newest `orders` orders (default 5,
  1–10), each once from its newest order, as `{ product, variantId, orderedAt }` (`variantId` null when the
  product no longer has that size), at most `limit` (default 12, 1–24). Two reads: the orders' line ids
  (`PastOrderProducts` on the Customer Account API for a Shopify sign-in, `CustomerPastOrderProducts` on
  the Storefront API for email and password), then the products in one `nodes(ids:)` batch through
  `useProductsById`. Products the store no longer has are left out. Signed out: empty, `signedIn: false`,
  nothing sent. `refresh()` reads the orders again.
- `useProductsById`'s module also exports `isGoneFromStore(id, imageTransform)` for these two hooks (not
  from the package index): an id this session read and the store had no product for.

Tests: `test/recently-viewed-and-past-orders.test.mjs` (17 checks: recording, order, once each, both
limits, kept across a remount and read back from the device, a product recorded while the device is
read, `leaveOut` by id and handle, a product the store no longer has dropped from the device, two hooks
following one change, `clear`, `enabled`; past orders signed out, both sign-ins, once each from the newest
order, `limit` with a missing product's place taken, the bounds, `refresh`, a failed read, a size gone).

### New: a blog's articles, and one article

For a base-app blog section (`BlogSection01`) and its article page (decided 2026-10-18).

- **`useBlogArticles(blogHandle, { limit, imageTransform, enabled })`** → `{ articles, loading, error,
  refresh }`: the blog's newest articles first (`shopify.blogs.articles` by `PUBLISHED_AT`, reversed), at
  most `limit` (default `BLOG_ARTICLES_SHOWN` = 6, rounded, 1–50). Read once per blog, count and image size
  a session, so a second section on the same blog draws at once; `refresh()` reads again from the
  network. A blog the store doesn't have: no articles. No blog, or `enabled: false`: nothing read.
- **`useArticle(blogHandle, articleHandle, { imageTransform, enabled, parseContent })`** → `{ article,
  content, loading, error, notFound, refresh }`: one article (`shopify.blogs.articleByHandle`), its words
  as `content: { html, blocks }`, the blocks parsed by `parseDescriptionHtml` exactly as
  `useProductPage().description` (paragraphs and bullets with their bold runs), so a screen draws them
  with a product description tile. `parseContent`: `false` for no blocks, or a parser of your own.
  `notFound` once read and the store has no such article (or blog). Read once a session; `refresh()`
  reads again, keeping what is shown.
- **An article opened from a list draws in the first frame:** every article a `useBlogArticles` read is
  kept, so `useArticle` at the same image size reads nothing, and at another size shows the list's copy
  while it reads its own.
- **Fixed:** `shopify.blogs.articles` dropped `ListOptions.fresh`, and `articleByHandle` had no way to
  ask for it, so a pull to refresh got the request cache's answer (blog reads are reused for 10 minutes).
  `articles` passes it on now, and `articleByHandle` takes `{ fresh }`.
- `clearBlogArticles()` forgets this session's reads (tests, or a new store).

Tests: `test/blog-articles.test.mjs` (13 checks: newest first with the count and image size sent, read
once and again on refresh, the count's default and bounds, a missing blog, no blog, `enabled`, a failed
read; an article's blocks, `parseContent` off and your own, drawn from a list's read at the same size
with no read and at another size at once, read once and again on refresh, not found (article and blog),
no handles, `enabled`, a failed read and a failed refresh keeping the article).

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
