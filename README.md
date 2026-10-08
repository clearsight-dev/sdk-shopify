# @tiledev/sdk-shopify

Type-safe Shopify Storefront API client. Zero deps beyond `fetch`.

Works in any JavaScript runtime — Node, browsers, React Native, Cloudflare Workers, Deno, Bun.

Optional React helpers (provider + hooks) ship under a subpath so you only pay for `react` if you use them.

```bash
npm i @tiledev/sdk-shopify
```

## Pure SDK (framework-agnostic)

```ts
import { shopify } from '@tiledev/sdk-shopify';

await shopify.init({
  storeDomain: 'my-store.myshopify.com',
  storefrontAccessToken: '...',
  apiVersion: '2024-10',
});

const { nodes: products } = await shopify.products.list({ first: 20 });
const cart = await shopify.cart.create({ lines: [{ merchandiseId: 'gid://…', quantity: 1 }] });
```

## Surface

| API | Methods |
|---|---|
| `shopify.products`    | `list`, `byHandle`, `byId`, `search`, `recommended` |
| `shopify.collections` | `list`, `byHandle`, `products` |
| `shopify.cart`        | `create`, `get`, `addLines`, `updateLines`, `removeLines`, `applyDiscountCodes`, `setBuyerIdentity`, `updateNote`, `addGiftCardCodes`, `applyGiftCardCodes` (replaces), `removeGiftCardCodes` |
| `shopify.customer`    | `signup`, `login`, `logout`, `profile`, `updateProfile`, `recoverPassword`, `orders`, `orderById` |
| `shopify.blogs`       | `list`, `byHandle`, `articles`, `articleByHandle` |
| `shopify.wishlist`    | `init`, `add`, `remove`, `toggle`, `has`, `list`, `count`, `clear`, `refresh`, `onChange` |
| `shopify.waitlist`    | `init`, `add`, `remove`, `has`, `list`, `count`, `clear`, `refresh`, `onChange` |
| `shopify.alerts`      | `message`, `setMessages`, `patchMessages`, `setPolicy` — see [Alerts & Toasts](#alerts--toasts) |

### Cart note

The shopper's order note — the free-text box on the cart, which the merchant reads beside the order. Distinct from cart *attributes*: attributes are the app's own bookkeeping, the note is content the shopper wrote.

```ts
const cart = await shopify.cart.updateNote(cartId, 'Leave at the back door');
cart.note;                                           // 'Leave at the back door'
(await shopify.cart.updateNote(cartId, null)).note;  // null — cleared
```

`cart.note` is `string | null` and never `''`. Shopify reports "no note" as an empty string, normalized here so there is one falsy value to test rather than two. Passing `null` clears it — on the wire that is `''`, because Shopify's `note` argument is `String!` and declaring the variable nullable is rejected outright.

`cart.create()` takes no note; set it in a follow-up call once the cart exists.

From React:

```tsx
const { cart, updateNote } = useCart();
<TextInput
  defaultValue={cart?.note ?? ''}
  onBlur={e => updateNote(e.nativeEvent.text || null)}
/>
```

The hook's `updateNote` is **not** debounced — a note is typed and then committed, so write it on blur or a Save, not per keystroke. It is serialized against the line writes (a note landing mid-`addLine` would be applied to a cart the provider is about to replace, and would vanish), no-ops when there is no cart yet, and emits no alert event.

### Gift cards on the cart

`useCart().addGiftCardCodes(codes)` adds gift cards and keeps the ones already on the cart (`cartGiftCardCodesAdd`); `removeGiftCards(appliedGiftCardIds)` takes off only the cards named (by `AppliedGiftCard.id`, not the code). Both wait in the cart's write queue like every other write, never create a cart (null when there is none), and resolve the new cart.

- **A country, only when missing.** Shopify takes a gift card only on a cart with `buyerIdentity.countryCode`. A cart without one gets `config.country` (else the shop's) first; `cartBuyerIdentityUpdate` replaces the identity, so the cart's email is sent again and, when signed in, the shopper's token keeps the cart theirs. A cart with a country is left alone.
- **A code Shopify skips is an error.** Shopify can answer `cartGiftCardCodesAdd` without applying a code and without any error (checked 2026-10-05 on the Storefront API 2026-07). `addGiftCardCodes` looks for each code's last characters on the cart and throws a `ShopifyError` (`code: 'GIFT_CARD_NOT_APPLIED'`) when one is missing.
- `shopify.cart.applyGiftCardCodes` is `cartGiftCardCodesUpdate`: it **replaces** every card on the cart. To add one, use `addGiftCardCodes`. Every Storefront version Shopify still serves has `cartGiftCardCodesAdd` (an older version is answered as the oldest supported one, 2025-10 today).
- `giftCardsEndingIn(cart, endings)` finds cards by a code or its last four; `giftCardCodesNotOnCart(cart, codes)` lists the codes Shopify skipped.

Tested in `test/cart-gift-cards.test.mjs` (8 checks).

### The app's own discount code

A code the store keeps for orders from the app (an app-only discount), set in the app's settings
rather than typed by the shopper (0.10, SDK move 6):

```tsx
useAppDiscountCode(settings.cart.appDiscountCode, { onError: (error) => report(error) });
```

- Put on the cart once per cart and code, keeping the codes already on it (`applyDiscountCodes`
  replaces the whole set).
- A code already on the cart, in any letter case, is left alone. Spaces around it are ignored. An
  empty code, or no cart yet, does nothing.
- A write that fails goes to `onError`, and that code isn't tried again on that cart while the hook
  stays mounted.
- It runs only while the screen calling it is mounted (amore-v2 calls it from the Cart).
- Tested in `test/app-discount-code.test.mjs` (6 checks).

### Wishlist — local-storage backed

Stores each saved product with its entry, to whatever storage you give it (browser: `localStorage` by default; RN: pass AsyncStorage; server: pass any in-memory shim), so the list draws **offline**: `init()` shows what was stored at once, then refreshes the products with a batched Storefront `nodes(ids:)` query (chunked for any size). A refresh that fails keeps the stored products. What is kept is everything a card and a product page's instant view use: images past the first and the media list are not (`hasVideo` is), and details stop at about 1 MB per list, newest first, because Android's AsyncStorage can't read back a value over about 2 MB. Older entries past that keep their id and handle and load online. Stored products also seed the product store, so a saved product's page opens with its instant view offline.

Deleted products (Storefront returns `null`) are pruned automatically. Pass `refresh({ keepDeleted: true })` to keep them with `product: null` for a "no longer available" UI.

**Moving from Apptile's engine, or an older key.** Pass the key the old app used as `storageKey` (Apptile: `<apptile app id>_WishlistProducts`, entries `{ id, handle }` with a numeric id) and any other earlier key as `migrateFrom` (e.g. `tile:shopify:wishlist:v1`). Both shapes are read; entries are written as a superset of all of them (`productId`, `basic`, `addedAt` as sdk-shopify ≤0.8 reads them, plus `id`, `handle` and the stored `product`), so an older bundle after an OTA rollback still reads the list. Each `migrateFrom` key is merged once (recorded under `<storageKey>:merged`) and left as it was, so an un-starred product never comes back. A stored value that isn't a list is copied to `<storageKey>:unreadable` before anything replaces it, and a list that fails to read is never written that session. On `ShopifyProvider`: `wishlistStorageKey` and `wishlistMigrateFrom`. The provider loads the wishlist before the cart, so a cart that can't load (offline) doesn't take it down.

```ts
await shopify.wishlist.init();          // rehydrates from storage, background-refreshes from API
await shopify.wishlist.add(product);
shopify.wishlist.has(product.id);       // O(1)
await shopify.wishlist.toggle(product);
shopify.wishlist.onChange(items => …);  // subscribe
```

### Waitlist — sizes a shopper waits on, offline like the wishlist

Keyed by **variant** (you wait on a size or colour; pre-order is per variant), newest first, stored with the same rules as the wishlist (one shared module, `storedList`): each entry carries the variant as last fetched (`variants.byIds`: stock, price, pre-order plan, and its product's title, handle, image and `hasVideo`), so the list draws offline, and a refresh that fails keeps it. A variant the store no longer has is kept as `variant: null` for the screen to leave out, in case it comes back. Joining a variant already on the list moves it to the front, dated now.

```ts
await shopify.waitlist.init({ storage: AsyncStorage });
await shopify.waitlist.add({ variantId, productId, productHandle });   // or `variant` when you have it
shopify.waitlist.has(variantId);
await shopify.waitlist.refresh();                                       // stock, price, pre-order plan
```

`<ShopifyProvider>` loads it before the cart, like the wishlist, and `useWaitlist()` gives `{ items, ids, count, has, add, remove, refresh }`. `add` emits `waitlist:add` ("Added to waitlist", Settings panel `waitlist.added`); `remove` emits `waitlist:remove` with no message, so no toast. Moving from Apptile's engine: `waitlistStorageKey` = `<apptile app id>_WaitlistProducts` (entries `{ id, handle }`: the numeric **variant** id and the product's handle), and `waitlistMigrateFrom` for any earlier key (`{ variantId, productId, addedAt }` with an ISO date reads too). Image size: `imageTransforms.waitlist`.

The waitlist records interest on the device. A back-in-stock push is the app's to request: the platform's automation selects on an analytics event that needs the signed-in customer.

## Optional React helper

```ts
import { ShopifyProvider, useShopify, useCart, useWishlist } from '@tiledev/sdk-shopify/react';
```

Wrap your app once — one provider gives you SDK readiness + cart state + wishlist state:

```tsx
<ShopifyProvider config={{ storeDomain, storefrontAccessToken }}>
  <App />
</ShopifyProvider>
```

Storage is passed at the provider:

```tsx
// Web: defaults to window.localStorage — nothing to configure
<ShopifyProvider config={...}>...</ShopifyProvider>

// React Native / Node / anywhere without localStorage:
import AsyncStorage from '@react-native-async-storage/async-storage';
<ShopifyProvider config={...} storage={AsyncStorage}>...</ShopifyProvider>
```

Then read from the context:

```tsx
const { ready, error, cart, wishlist, customer, checkout } = useShopify();
const { addLine, itemCount, cart } = useCart();
const { items, ids, count, toggle, has } = useWishlist(); // ids: product ids, e.g. a grid's favourites
const { loggedIn, login, logout } = useCustomer();
```

`react` is an **optional** peer dep — install it only if you use the `/react` subpath.

### Collection feed with filters

`useCollectionProducts` pages one collection by cursor and holds the shopper's filter selection:

```tsx
const feed = useCollectionProducts({ handle: 'new-arrivals', pageSize: 12 });

feed.products;          // appended page by page; feed.loadMore() when the list nears its end
feed.availableFilters;  // Shopify's facets for this collection, values carry an `input` string
feed.setFilters(inputs); // the `input` strings the shopper picked; the hook parses and refetches
feed.selectedFilters;   // those inputs, for the sheet's checkboxes
feed.filterActive;      // at least one selected
feed.clearFilters();
feed.refresh();         // pull-to-refresh (retry is the same call, for an error state)
```

- Pass `filters` for anything the app always applies (e.g. in stock only). The shopper's selection
  goes on top.
- A selection belongs to its collection: a new `handle` starts with none, and its first read never
  carries the old filters.
- An input that isn't a Shopify filter (unparseable JSON) is dropped rather than sent.
- **Price** is the one facet whose input the app builds. `priceRange(facet)` reads a
  `PRICE_RANGE` facet's bounds, and `priceFilterInput(min, max, range)` encodes the shopper's range
  (`{"price":{"min":20,"max":100}}`), or returns null when it wouldn't narrow anything. Pass it to
  `setFilters` with the other inputs; `parsePriceFilterInput` reads one back to pre-fill fields.
  While a price filter is selected, `availableFilters`' `PRICE_RANGE` facet is the feed's whole range,
  from its last read without one (0.10.1): Shopify answers it with the applied range itself, and a sheet
  that took that for the whole range dropped the price filter on its next Apply.
- Scrolling, navigation and the sheet's open state stay in the app; the hook only knows Shopify.

### One network call per identical read

Every Storefront read goes through one `request()`, which now shares work:

- **In flight:** identical queries fired together share one call. Six grids on the same collection
  make one request, not six. This covers every query, including cart and customer ones.
  Mutations are never shared.
- **Recent answers:** catalogue reads are reused from memory for a short time (`DEFAULT_CACHE_TTL_MS`):
  shop info 30 min, collections and blogs 10 min, recommendations 5 min, collection pages, products
  and wishlist items 1 min, search 30 s. Cart, customer, orders and variant stock are never reused.
- Each caller gets its own parsed copy, so mutating a result can't change another caller's.
  Failed calls and GraphQL errors are never kept.
- The key includes the store, token, market (`@inContext`), metafields and variables, so markets
  and stores never mix. Memory only: nothing is persisted, and `init` starts it empty.

```ts
shopify.init({ ...config, cache: { ttl: { CollectionProducts: 0 }, maxEntries: 50 } }); // tune
shopify.init({ ...config, cache: false });  // no reuse; in-flight sharing stays
shopify.collections.products(handle, { fresh: true }); // skip a recent answer
clearRequestCache();                                     // forget everything
```

`useCollectionProducts`' `refresh()` and `retry()` read fresh; other grids on the same collection
keep what they have.

### Image transforms

Every call that returns images takes an optional `imageTransform`, Shopify's server-side
`Image.url(transform:)`: the CDN resizes, crops and converts, so each screen downloads the size it
shows. **Omitted, URLs are the originals, exactly as before.**

```ts
shopify.collections.products(handle, { first: 12, imageTransform: { maxWidth: 330, scale: 2, preferredContentType: 'WEBP' } });
shopify.products.byHandle(handle, { imageTransform: { maxWidth: 1080 } });
useCollectionProducts({ handle, imageTransform: { maxWidth: 330, scale: 2 } });
useSearch(term, { imageTransform: { maxWidth: 200, scale: 2 } });
useProduct(handle, { imageTransform: { maxWidth: 1080 } });
// e.g. …/photo_330x@2x.jpg.webp, …/photo_100x100_crop_center.jpg
```

- Fields: `maxWidth`, `maxHeight`, `crop` (`CENTER` | `TOP` | `BOTTOM` | `LEFT` | `RIGHT`),
  `scale` (1–3), `preferredContentType` (`WEBP` | `JPG` | `PNG`). Never upscales past the original.
  `width`/`height` on an image stay the original's.
- Applies to every image in the answer: product images, featured image, media, variant images,
  collection images, cart line images, order line images, article images.
- **Provider-run reads** (the cart `ShopifyProvider` keeps, the wishlist it rehydrates) take a default
  from the config: `imageTransforms: { cart: { maxWidth: 160, scale: 2 }, wishlist: … }`. A
  transform passed to a call directly wins.
- Each transform is its own cache entry. A product page's first-render `preview` uses the image the
  grid fetched, so the image on screen is already in the image cache.

### Cache-first pages: `useProduct`, `useCollectionProducts`, `useSearch`

Each hook renders what this device already knows **on its first render**, then reads the network in
the background and updates in place (`refreshing` is true meanwhile; no spinner needed). A copy
younger than a minute (`REVALIDATE_AFTER_MS`) isn't re-read. `refresh()` always goes to the network.

```tsx
// Product page: opens with title, image, price, the variant picker and the description from
// whichever grid or search showed it.
const { preview, product, level, loading, refreshing, notFound, refresh } = useProduct(handle);
// preview: the base keys, render now (variants included). product: full (adds the gallery media).

// Listing page / search page: the last first page paints immediately, even after a cold start.
const feed = useCollectionProducts({ handle, pageSize: 12 });
const results = useSearch(term, { debounceMs: 300 }); // results.query is the debounced term
```

- **Every product read records its base keys** (`PRODUCT_BASE_KEYS`): `id`, `handle`, `title`,
  `featuredImage`, `priceRange`, `compareAtPriceRange`, and since 0.9 also `options`, `variants`,
  `description`, `descriptionHtml`, `availableForSale`, `totalInventory`, `tags`, `vendor` and
  `productType`. Collections, search, recommendations, lists, `byIds` and the wishlist already fetch
  all of these, so keeping them costs no request. `byHandle`/`byId` record the full product (which
  adds the gallery's media). So a product tapped anywhere opens with its picker, stock state and
  description in the first frame, and a product page seen before opens complete.
- **Kept on the device** across cold starts, one key per product, read only when something asks
  (nothing is loaded in bulk at launch). Caps: 2,500 base entries (3-10 KB each with variants and
  description, so roughly 10-25 MB at the cap), 30 full products, 20 first pages; anything older
  than 7 days is dropped. A schema change bumps the key version (now `v3`, since each variant
  carries `sellingPlan`), and the old versions' keys are cleared from the device once, after launch. Keys carry a schema version and the store, market,
  API version and metafields, so nothing mismatched is ever shown. Catalogue data only: never cart,
  customer, orders or wallet.
- **Storage:** on iOS/Android, **MMKV 3** (synchronous, read in microseconds inside a render). List
  it in the app so its native code is compiled in: `npm i react-native-mmkv@^3` (needs the New
  Architecture, on by default from RN 0.76 / Expo 52). Without it in the binary the SDK keeps
  everything in memory only and nothing breaks. On web and the editor preview: `localStorage`.
- `peekProduct(handleOrId)` reads the store directly (e.g. to prefetch on `onPressIn`);
  `forgetProduct(id)` drops one (e.g. after `cart:outOfStock`); `clearProductStore()` drops all.
- `cache: false` in the config turns all of this off, along with the request cache.
- The provider sets the config on its first render, so these reads start at once instead of waiting
  for its own startup (cart, wishlist, customer).

## Product page: `useProductPage`

Everything a product page decides, in one hook, on `useProduct`'s cache-first product. The screen
keeps only what is the app's: layout, navigation, its own rules (passed as options) and side effects.

```tsx
const page = useProductPage(handle, {
  imageTransform: { maxWidth: 1080 },
  playVideo: params.playVideo === '1',
  isBlocked: (p) => p.tags.includes('SEARCH-BLOCKED'),       // e.g. live in an auction
  parseDescription: afterTransition,                          // false to wait; or your own parser
  onView: (p) => analytics.track('productView', params(p)),   // once per product, full product
  onAdded: () => setSheetVisible(true),
});

page.shown;                      // product ?? preview: render now (variants included since 0.9)
page.status;                     // 'loading' | 'unknown' | 'available' | 'unavailable' | 'blocked'
page.selection.optionStates;     // each option, each value: selected, available, units left, its variant
page.selection.setOption(name, value);   page.selection.selectVariant(id);
page.selection.variant;  page.selection.label;  page.selection.price;   // { price, compareAtPrice, onSale }
page.selection.lowStock;
page.selection.variant.sellingPlan;      // its pre-order plan { id, name }, or null (see below)
page.cart.add();                 // stock ceiling first; never throws; { ok, reason, message }
page.cart.adding;  page.cart.inCart;  page.cart.canAddMore;
page.media.items;  page.media.initialIndex;  page.media.previewImageUrl;  page.media.firstImageUrl;
                                 // each item: kind, posterUrl, videoUrl, alt, width/height (original px)
page.description.blocks;         // paragraphs and bullets with bold runs, from descriptionHtml
page.favorite.isFavorite;  page.favorite.toggle();
page.shareUrl;
page.recommendations.products;   // "You may also like", when asked: { products, loading, error }
```

The same list on its own, for any page (a cart's "you may also like"):

```tsx
const { products, loading } = useProductRecommendations(product.id, { limit: 8, imageTransform: { maxWidth: 660 } });
```

Read once per product and kept for the session, so a reopened product has them on its first render.
Every product read lands in the product store with its variants, so a tapped recommendation opens like
a grid's card.

**Pre-order plans.** Every product read (`products.*`, collections, search, recommendations, `byIds`)
asks for each variant's first selling-plan allocation, `variant.sellingPlan`: `{ id, name }` when the
store enrolled that variant in a plan (a pre-order), else `null` (about 0.1 KB per variant before
gzip; 2-4% more on the wire for a page of cards). It is the variant's own allocation, so it names the
plan to add with even when the product is in several groups. When a size is pre-ordered is
`preorderPlanFor` (below; until SDK move 6 each app had its own rule). A pre-order add is `page.cart.add({ sellingPlanId: variant.sellingPlan.id })`, which a sold-out but
still-for-sale size passes with no stock ceiling (`stockCeiling` is null there). A cart line's
`merchandise` has no `sellingPlan`: the line's own `sellingPlanId` says how it was bought.

**A cart line on a plan** carries `line.sellingPlan`: `{ id, name, checkoutCharge, remainingBalance }`,
or null for a line bought outright. The two amounts are for the whole line: what checkout takes now
and what is charged later (for a pre-authorize plan, `$0.00` now and the full price when it ships).
Shopify answers them per unit, so the SDK multiplies them by the line's quantity (checked 2026-10-05:
a line of 2 at $250 said $0 and $250). An amount Shopify leaves out is `null`: unknown, not zero.
The cart's own `cost.checkoutChargeAmount` is what checkout takes now for the whole cart, while
`subtotalAmount` and `totalAmount` still count a pre-order line at its full price.

```tsx
const plan = line.sellingPlan;
plan && `Pre-authorized at ${formatMoney(plan.checkoutCharge)}, pay ${formatMoney(plan.remainingBalance)} when it ships`;
```

**A cart line's discounts** are `line.discounts`: `{ amount, code, title }` for each discount's share of
the line (Shopify's `discountAllocations`), `code` for a discount code and `title` for an automatic or
custom discount. One code's value can be spread over several lines: on Amore's store (2026-10-08) a $20
giveaway code for one size was split $10 and $10 over two lines of that size, so a line can carry part
of a code meant for another. Empty when nothing is taken off; missing on a cart read before 0.12.

```ts
const giveawayOff = line.discounts?.filter((d) => d.code?.startsWith('GIVEAWAY-')).reduce((sum, d) => sum + Number(d.amount.amount), 0);
```

**Customise any rule** with an option; every default is the production behaviour:

| Option | Default |
| --- | --- |
| `optionOrder` | Color, Colour, Size, then the store's order |
| `includeOption(option)` | all but Shopify's "Default Title" placeholder |
| `initialSelection(variants)` / `initialVariantId` | the first purchasable variant |
| `isUnavailable(variant)` | missing, not for sale, or 0 left (the waitlist case) |
| `lowStockThreshold` | 10 units across the product; `null` turns it off |
| `isBlocked(product)` | none |
| `maxQuantity(variant)` | its stock (`stockCeiling`); `null` for no ceiling |
| `quantity`, `attributes`, `sellingPlanId` | 1, none, none (each `add()` can override) |
| `source` | the app's own. Where the page's adds came from (`{ type: 'live' \| 'replay', showId }`) for the provider's `attribution`; never sent to Shopify. Each `add({ source })` can override. Needs 0.9.1's attribution (SDK move 6) |
| `recommendations` | none read. `true` or `{ enabled, limit, imageTransform, exclude }` reads Shopify's related products (`productRecommendations`), without the product itself or anything `isBlocked` marks, at most 10. Below the fold: pass `enabled: false` until the page has settled |
| `parseDescription` | `true`; `false` to wait, or `(html) => blocks` |
| `onView`, `onAdded`, `onRefused`, `onError` | none |
| `separator`, `storeDomain`, `resetKey` | `" / "`, the configured store, the handle |

**Pre-order and buy: one rule (0.10, SDK move 6).** What a shopper can do with a size, the same on a
product page and a waitlist card (from main, pure):

```tsx
const blocked = page.status === 'blocked';                       // e.g. an auction (isBlocked)
const plan = preorderPlanFor(page.selection.variant, { blocked }); // → page.cart.add({ sellingPlanId: plan.id })
const mode = purchaseModeFor({ status: page.status, variant: page.selection.variant, canAddMore: page.cart.canAddMore, heldInOtherCarts });
// 'blocked' | 'preorder' | 'soldOut' | 'heldInOtherCarts' | 'allInCart' | 'buy'
const action = waitlistActionFor(item.variant, cart, { blocked: isAuctioned(item.variant.product) });
// 'blocked' | 'preorder' | 'addToCart' | 'inCart' | 'waiting'
```

- **A pre-order** is a size sold out (Shopify's count known and 0 or less), still for sale, with a plan
  of its own (`variant.sellingPlan`), on a product that isn't blocked.
- **Stock not tracked** (`quantityAvailable` null) isn't sold out: that size is bought, never
  pre-ordered. Decided 2026-10-06, Head of Engineering: "Add to Cart" (untracked means always
  available).
- **A blocked product** (an auction) can't be pre-ordered or bought anywhere: the page's mode and a
  waitlist card's action are both `'blocked'`. Decided 2026-10-06, Head of Engineering: "Auction notice
  wins".
- The page's mode, the first that applies: blocked, pre-order, sold out, held in other carts (a
  reservation service's refusal), every unit already in this cart, buy.
- A waitlist card: blocked, pre-order, add to cart (back in stock with a unit to spare), in cart, else
  waiting. `StandaloneVariant.product.tags` (0.10) is there for the card's `blocked` rule.
- Tested in `test/purchase-rules.test.mjs` (16 checks).

**Use only the part you need.** `useVariantSelection(product, options)` is the selection, states,
price and stock for any surface that sells a variant (a buy sheet, a quick add); `useAddToCart(variant,
options)` is the add with the ceiling. The pure helpers behind them are exported too: `selectableOptions`,
`findVariant`, `initialSelection`, `optionStates`, `selectionLabel`, `variantPrice`, `isLowStock`,
`stockCeiling`, `quantityInCart`, `initialMediaIndex`, `firstImageUrl`, `sizedImageUrl`,
`parseDescriptionHtml`, `productShareUrl`.

**The stock ceiling.** Shopify answers 200 to an add past the stock level and clamps it silently, so
the shopper would be told it worked. `addLine({ …, maxQuantity })` checks before the write, and
before any `cartGuard` (so Cart Hold never reserves for an add that is then refused). A refusal is
`reason: 'stock'` with the new `cart.noMoreStock` alert ("No more stock available", a Settings panel
field at `settings.alerts.cart.noMoreStock`) and a `cart:stockLimit` event, so the app's toast shows
it like every other alert. `maxQuantity` is never sent to Shopify.

## Alerts & Toasts

The editor's Settings panel configures the copy for 14 shopper-facing alerts. The
SDK never renders anything — it resolves the right string and hands it to you on
an event, so a screen can toast without keeping its own copy table or mapping
Shopify error shapes to sentences.

```tsx
<ShopifyProvider
  config={{ storeDomain, storefrontAccessToken }}
  cartPolicy={{ maxLineItems: 25 }}
  messages={{ 'cart.added': 'Added to bag' }}   // ← what the Settings panel writes
  translate={(key, fallback) => i18n.t(key, fallback)}
  onEvent={(e) => toast.show(e.message, { type: e.severity })}
>
```

Every event carries the resolved copy, so that one-liner is the whole integration:

| Event | Message key | Panel group |
| --- | --- | --- |
| `cart:add` | `cart.added` | Cart |
| `cart:remove` | `cart.removed` | Cart |
| `cart:limitExceeded` | `cart.limitExceeded` | Cart |
| `cart:stockLimit` | `cart.noMoreStock` | Cart |
| `cart:outOfStock` | `cart.outOfStock` | Checkout |
| `wishlist:add` / `wishlist:remove` | `wishlist.added` / `wishlist.removed` | Wishlist |
| `waitlist:add` / `waitlist:remove` | `waitlist.added` / none (no toast) | Waitlist |
| `auth:loginSuccess` / `auth:loginFailed` | `auth.loginSuccess` / `auth.loginFailed` | Login |
| `auth:logout` / `auth:recoverSent` | `auth.loggedOut` / `auth.resetLinkSent` | Login |
| `checkout:orderPlaced` / `checkout:paymentFailed` | `checkout.orderPlaced` / `checkout.paymentFailed` | Checkout |

`cart:update`, `cart:buyerIdentity` and `auth:sessionExpired` are state signals and carry no message.
`wishlist.empty` has no event — read it directly for a placeholder:

```tsx
const message = useShopifyMessage();
{count === 0 && <Text>{message('wishlist.empty')}</Text>}
```

Resolution order per key: `messages` prop → `config.messages` → `translate(key)`
→ built-in default. A cleared panel field (empty string) falls through rather than
rendering blank. `translate` is called with the i18n key where one exists
(`cart.added` → `toast.added_to_cart`), otherwise the message key itself.

### What changed, on the event, and `useShopifyEvents` (0.10, SDK move 7)

The cart, wishlist and sign-in events say what changed, so a listener can act on the event itself.
Until 0.10 they carried only `type`, `severity` and the copy, and React's `useCart().cart` hadn't
caught up when they arrived; every app's analytics waited 50 ms and diffed the cart to find the
line.

| Event | Also carries |
| --- | --- |
| `cart:add`, `cart:update`, `cart:remove` | `cart`: the cart the write returned. `changedLines: CartLineChange[]`: each line the write changed, once |
| `wishlist:add`, `wishlist:remove` | `productId` |
| `auth:loginSuccess` | `customer` (null while the profile hasn't loaded; `useCustomer().customer` has it once it does) and `sessionKind` |

```ts
interface CartLineChange {
  line: CartLine;          // the line after the write; for a line the write took out, the line as it was
  quantityChange: number;  // units added (above 0) or taken away (below 0); 0 when only its attributes changed
}
```

- An add onto a line already in the cart reports that line with its new quantity, and
  `quantityChange` is what was added. An `addLines` that landed several lines lists each line once:
  two inputs that landed on one line (same variant and attributes) are counted together.
- `cart:update` to 0 and `cart:remove` report the line as it was.
- Failures carry their `error` as before, and `checkout:orderPlaced` still carries its details as
  `error`.

**`useShopifyEvents(listener)`** hears every event from anywhere inside the provider: the same events
`onEvent` gets, told right after it, in order. It needs no `onEvent`. The listener is read when an
event fires, so a new function each render is fine; it starts once the component has mounted and
stops when it unmounts. A listener that throws is warned about and costs nothing else.

```tsx
function CartAnalytics() {
  const { track } = useAnalytics();
  useShopifyEvents((event) => {
    for (const sent of cartAndWishlistEvents(event)) track(sent.name, sent.properties);  // @tiledev/sdk-analytics-core
  });
  return null;
}
```

This replaces the one-hop event bus each app kept so a listener inside the provider could hear
`onEvent`, which is written above it.

### Reading the panel from the Live Layer

The editor publishes these fields into the app's Live Layer tree. The SDK owns
where each one lives, so an app only reads two values and passes its toast:

```tsx
import { ALERT_SETTINGS_PATH, MAX_LINE_ITEMS_SETTING_PATH, useAlertSettings } from '@tiledev/sdk-shopify';

const alerts = useLL(ALERT_SETTINGS_PATH);                 // settings.alerts
const maxLineItems = useLL(MAX_LINE_ITEMS_SETTING_PATH);   // settings.cart.maxLineItems
const props = useAlertSettings({ alerts, maxLineItems, show: showToast });

<ShopifyProvider config={config} {...props}>               // messages, cartPolicy, onEvent
```

| Published value | Result |
| --- | --- |
| A string | That alert's copy, cut to 200 characters |
| `''` (the merchant cleared the field) | That alert is **silenced**: `onEvent` shows nothing |
| Absent, or not a string | The default copy |
| `maxLineItems` 1–100 (number or numeric string) | The cart limit |
| `maxLineItems` anything else | No limit |

Note the one difference from the `messages` prop: there an empty string falls
back to the default, here it silences. The panel publishes `''` only when the
merchant clears a field on purpose. Without React, `readAlertSettings(tree)`
and `readCartPolicy(value)` return the same values, and
`ALERT_SETTING_FIELDS` is the path table (`cart.outOfStock` sits in the
Checkout group, where the panel shows it).

### Cart line limit

`cartPolicy.maxLineItems` is the panel's "Cart Line Item Maximum Limit". It counts
**distinct lines, not units** — quantity 30 of one variant is one line — and is
checked before the mutation, so a refusal costs no round trip:

```tsx
const result = await cart.addLine({ merchandiseId, quantity: 1 });
if (!result.ok && result.reason === 'limit') { /* result.message is ready to show */ }
```

`reason` is `'guard'` (a `cartGuard` veto), `'limit'`, or `'no-cart'`. An
unsellable line still throws — `cart:outOfStock` fires on the way out.

> **Breaking from 0.1.x:** `addLine` used to return `boolean`. An object is always
> truthy, so `if (await addLine(...))` no longer detects a refusal — read `.ok`.

### Cart guard (`cartGuard`)

A `CartLineGuard` on the provider runs around every cart write: `beforeAdd` / `beforeIncrease` can
change or veto it, `onLanded` / `onReleased` hear what happened. Cart Hold
(`@tiledev/sdk-apptile-cart-hold`) is one. The provider keeps two promises to it (0.9):

- **Every unit a guard approves either lands or comes back.** An add the line limit then refuses, an
  add Shopify refuses, and an add whose cart can't be created all fire `onReleased` with
  `reason: 'rejected'`. A rejected add carries `input`, as the guard approved it (with any attributes
  it added: Cart Hold's receipt); a rejected increase carries the `line` it was to grow. Before 0.9 the
  line-limit and cart-creation paths released nothing.
- **Attributes aren't lost to a guard.** A guard that approves an increase without returning
  attributes keeps the caller's; and since attributes replace a line's set, an update keeps the line's
  private (`_`-prefixed) attributes the caller didn't mention, so editing a note can't wipe a hold.

Two more things a guard can rely on:

- **The quantity it returns is the one added.** `beforeAdd` may lower it: Cart Hold approves only the
  units still free. `onLanded` and a `rejected` release carry that quantity too.
- **A quiet add.** `addLines(inputs, { quiet: true })` is for a caller that reports the outcome
  itself (Buy again's one summary). Every `beforeAdd(input, options)` gets `{ quiet: true }`, so the
  guard says nothing about a refusal (Cart Hold shows no toast) but still decides as usual. And the
  `cart:outOfStock` the line-by-line retry raises for the lines Shopify refused is not emitted. That is
  the only out-of-stock alert `addLines` raises, so a quiet `addLines` raises none. Still emitted:
  `cart:add` when something lands (analytics reads it too) and `cart:limitExceeded` when the line
  limit refuses the whole batch. `addLine` and `beforeIncrease` have no quiet.

`test/cart-guard.test.mjs` covers all of it (10 checks).

### Customer session: two ways to sign in

`useCustomer()` owns the session, so the Login alerts have somewhere to originate. Every app gets
both sign-ins, and `auth.method` says which one it offers now:

| `auth.method` | Login | Shopify feature | Calls |
| --- | --- | --- | --- |
| `password` (the default) | Email and password | Classic customer accounts, Storefront `customerAccessToken` | `login`, `signup`, `recoverPassword` |
| `shopify` | Shopify's web sign-in (passwordless) | New customer accounts, Customer Account API, OAuth 2 + PKCE | `signIn` (system sheet), `startSignIn` (in-app web view) |

`method` can change while the app runs, e.g. from a Live Layer field: `password` while a build is
in App Store review (the reviewer needs a demo email and password; Shopify's sign-in mails a
one-time code to an inbox they can't read), `shopify` for shoppers. A shopper already signed in
stays signed in when it flips; `sessionKind` says which kind of session they have.

```tsx
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

<ShopifyProvider
  config={config}
  storage={AsyncStorage}
  auth={{
    method: reviewMode ? 'password' : 'shopify',
    customerAccount: { shopId, clientId },        // a Public (mobile) Customer Account API client
    secureStorage: {                              // tokens go to the keychain, never AsyncStorage
      getItem: SecureStore.getItemAsync,
      setItem: SecureStore.setItemAsync,
      removeItem: SecureStore.deleteItemAsync,
    },
    openAuthSession: (url, redirectUri) =>
      WebBrowser.openAuthSessionAsync(url, redirectUri, { preferEphemeralSession: true }),
    random: Crypto.getRandomBytes,                // PKCE needs secure random bytes; Hermes has none
  }}
  storeCredit={{ source: 'shopify' }}             // or { source: 'tile' }
>
```

```tsx
const { method, loggedIn, sessionKind, customer, restoring, login, signIn, logout, getAccessToken, renewAccessToken, updateProfile } = useCustomer();

// password: false on bad credentials (auth:loginFailed fires). Offline throws.
await login(email, password);

// shopify, system sheet: false when the shopper backs out (no event) or Shopify refuses
// (auth:loginFailed). Offline throws.
await signIn();

// shopify, the app's own web view: load attempt.url, stop the web view at the redirect, finish.
const attempt = startSignIn();
<WebView source={{ uri: attempt.url }} incognito
  originWhitelist={['https://*', 'shop.<shopId>.app://*']}
  onShouldStartLoadWithRequest={(r) => attempt.isCallback(r.url) ? (void attempt.finish(r.url), false) : true} />

// Either kind: a usable token for checkout or another SDK, refreshed when needed.
const token = await getAccessToken();

// A service just answered 401 with it: a token renewed now (Shopify sign-in: the session's one shared
// refresh; a password session can't renew, so null). Never signs the shopper out.
const renewed = await renewAccessToken();

// Either kind: change the name and email marketing consent. false on failure; never throws.
const saved = await updateProfile({ firstName, lastName, acceptsMarketing });
```

Working examples of each piece, typechecked against the Expo modules they use, are in
[`examples/auth`](examples/auth): `AppProviders.tsx`, `PasswordSignIn.tsx`,
`ShopifySignInSheet.tsx`, `ShopifySignInWebView.tsx`, and `AccountScreen.tsx`, which picks the
sign-in by `method`.

**Which surface for Shopify sign-in.** The system sheet is the default: Shopify's social sign-ins
work there (Google refuses embedded web views), and on iOS `preferEphemeralSession` means no
consent alert and no silent resume of another shopper. The in-app web view keeps the page inside
the app's design, and `incognito` stops it resuming the last shopper on Android, where Custom Tabs
share Chrome's cookies.

**The rules, the same for both sign-ins:**

- The shopper's own answer (a wrong password, a taken email, a refused sign-in) resolves `false`
  and fires `auth:loginFailed`. Backing out of the sign-in page resolves `false` and fires nothing.
- The store being unreachable throws, and never ends a session: being offline is not being signed out.
- On app open a stored session is restored without a toast. Offline it stays signed in
  (`loggedIn` true, `customer` null until `refresh()`).
- A session Shopify no longer accepts ends: silently on app open, and with `auth:sessionExpired`
  (no message; route to sign-in if you like) while the app is in use.
- `logout()` clears the device first, then tells Shopify, and always resolves.
- Shopify sign-in: state, nonce and the PKCE verifier are checked; a redirect the app didn't start
  is never exchanged. Refresh tokens rotate, so concurrent callers share one refresh, and a refresh
  that lands after sign-out is discarded. A 401 refreshes once and retries.
- Password sign-in: a token with under 7 days left is renewed on app open (`customerAccessTokenRenew`).

Each rule is a test: `test/auth-password.test.mjs` (20 checks), `test/auth-shopify.test.mjs` (39,
including SHA-256 against node:crypto and RFC 7636's PKCE vector), `test/auth-provider.test.mjs`
(11: the review-mode switch, store credit and `updateProfile` through the provider), and
`test/auth-profile.test.mjs` (21: `updateProfile` for both kinds of session).

**Editing the profile.** `updateProfile({ firstName?, lastName?, acceptsMarketing? })` sends only
the fields that differ from `customer`. An unset name counts as `''`, and when nothing differs it
resolves `true` without a request. Each kind of session uses its own API:

| `sessionKind` | Names | Email marketing consent |
| --- | --- | --- |
| `password` | Storefront `customerUpdate` | the same call (`acceptsMarketing`) |
| `shopify` | Customer Account API `customerUpdate(input: { firstName, lastName })` | `customerEmailMarketingSubscribe` or `customerEmailMarketingUnsubscribe` |

- `true` once Shopify accepted every change. `customer` already shows the new values: for a
  password session it is the customer `customerUpdate` returns; for a Shopify session the profile
  is read again.
- `false` when signed out, when Shopify refuses a value (its `userErrors`), or when the store can't
  be reached. It never throws. The reason goes to `console.warn('[sdk-shopify] profile update
  failed', …)`, and no event fires, so the screen shows its own message. A session Shopify stops
  accepting mid-save still ends with `auth:sessionExpired`.
- A Shopify session writes the names first, then the consent, and stops at the first refusal.
  Whatever Shopify accepted before that is read back, so `customer` never shows a value Shopify
  doesn't hold. If that read fails (offline straight after saving), `customer` shows the accepted
  values.
- `CUSTOMER_ALREADY_SUBSCRIBED` counts as success: it is the state the shopper asked for, and it
  only comes back when `customer` was out of date.
- Phone and email can't be changed here. The Customer Account API's `CustomerUpdateInput` has only
  the two names, and an email change goes through Shopify's own verification.
- `customer.loading` is true while it runs.

**Storage keys.** The Shopify session uses production Amber's keychain keys (`auth.token`,
`auth.refreshToken`, `auth.expiresAt`, `auth.idToken`), so its signed-in shoppers stay signed in
after updating to a Tile build. The password session uses `auth.storefrontToken` and
`auth.storefrontExpiresAt`; a token stored by 0.8 (`shopify:customer-token:v1` in `storage`) moves
there on first read. Every key is one expo-secure-store accepts (letters, digits, `.`, `-`, `_`):
it throws on a `:`, which is why 0.8's key can't go to the keychain as it was. The tests' keychain
refuses the same keys. Without `secureStorage`, both go to `storage` (the web preview).

**Changed from 0.8:** `loggedIn` means a session exists (it was "a profile loaded"), and the
session is restored even when the shop fails to load.

### Store credit

`storeCredit` on the provider picks the source per app; `useStoreCredit()` reads it either way:

```tsx
const { source, available, balance, loading, error, refresh } = useStoreCredit();
{available && <Text>Store credit: {formatMoney(balance)}</Text>}
```

| `storeCredit.source` | Reads | Works with |
| --- | --- | --- |
| `shopify` | Shopify's store credit (`storeCreditAccounts`, summed across currencies' accounts) | Shopify sign-in only: the Storefront API has no store credit, so `available` is false for a password session |
| `tile` | The Tile Credit wallet (`/public/me`) | Either sign-in |

`useStoreCreditHistory()` reads the lines behind the balance, from the same source, newest first, a
page at a time:

```tsx
const { entries, loading, loadingMore, hasMore, error, loadMore, refresh } = useStoreCreditHistory(); // { pageSize?: 25 }
// entries: StoreCreditEntry[] — { id, kind, isCredit, amount, createdAt, expiresAt, note, orderName }
```

| `storeCredit.source` | Reads | Pages by |
| --- | --- | --- |
| `shopify` | The Customer Account API's store-credit transactions (every account, merged by date) | Each account's own cursor |
| `tile` | Tile Credit's ledger (`/public/me/ledger`), with the balance's service, token and shop | The ledger's cursor |

Each line comes with a `kind` (`signupBonus`, `liveShowReward`, `orderReward`, `addedByStore`,
`removedByStore`, `spent`, `refunded`, `expired`, `added`, `removed`) so the app words it; `amount` is
never negative and `isCredit` says which way it went. `note` is the store's own words for a change made
by hand (Tile Credit only, and only when they read as a sentence); `orderName` is the order it came
from (`#1043`) when the source names it. A refresh starts the list over from the newest page and keeps
what is shown if it fails. Tested in `test/store-credit-history.test.mjs` (20 checks: each source's
lines and pages, and the hook through the provider).

### Store credit on the cart: `useCartStoreCredit`

```tsx
const { source, status, balance, applied, error, apply, remove, refresh } = useCartStoreCredit();
// status: 'hidden' | 'loading' | 'ready' | 'applying' | 'applied' | 'removing' | 'atCheckout' | 'error'
await apply(typedAmountToCents('$25.00')!); // true once the credit is on the cart; never rejects
await remove();                              // takes off only the app's card
```

| `storeCredit.source` | Apply | Remove |
| --- | --- | --- |
| `tile` | Mints a gift card for the amount (`/public/me/redeem`) and adds it to the cart (`addGiftCardCodes`) | The app's card comes off; other gift cards stay |
| `shopify` | Nothing: `status` is `atCheckout`, as only Shopify's checkout takes it | Nothing |

- **One Apply or Remove at a time**: a second call while one runs gets the running one's promise. Two redeems at once with different keys would mint two cards; the service's idempotency isn't atomic.
- **A new card on every Apply**, with a new idempotency key. The key is reused only to retry the same attempt (same shopper, same amount, right after it failed), so a retry after a lost answer gets back the card already minted. A new card disables the previous one, so an earlier card of the app's still on the cart comes off.
- **The app's card** is the one whose last characters match the card it minted, or after a restart the shopper's active card (`/public/me/gift-cards`). `applied` is what it takes off this cart (`presentmentAmountUsed`).
- **Read again** on mount, for each new shopper (another shopper's balance never shows, not for one render), when the app comes back to the foreground (`AppState` on a phone, the page's visibility on the web), after each Apply and Remove, and on `refresh()`.
- **No upper limit in the app**: an amount over the balance comes back `insufficient_balance`, outside the store's limits `validation`. `error` is a `TileCreditError`; the app words its `code`.
- `typedAmountToCents(text)` reads a typed amount: `1500`, `1,500`, `1500.5`, `$1,500.00` and a decimal comma (`12,50`); null for letters, a minus or two decimal points.

Tested in `test/cart-store-credit.test.mjs` (19 checks) and `test/tile-credit-client.test.mjs` (16 checks: the parser, the token, the provider's session).

### Orders

`useOrders()` lists the signed-in shopper's orders and `useOrder(id)` reads one, with Buy again. They
work for either sign-in and answer in the same shapes (`OrderSummary`, `OrderDetails`):

```tsx
const { orders, loading, loadingMore, error, hasMore, loadMore, refresh } = useOrders(); // { pageSize?: 25 }
const { order, loading, error, notFound, refresh, buyAgain } = useOrder(orderId);        // an id from `orders`
const { added, skipped } = await buyAgain();                                            // lines, not units
await buyAgain({ skipVariant: (variantId) => cartHold.isHeldOut(variantId) });         // leave some variants out
```

| `sessionKind` | API | The list | One order |
| --- | --- | --- | --- |
| `shopify` | Customer Account API | `customer { orders }` (`OrderHistory`) | `order(id:)` (`OrderDetail`) |
| `password` | Storefront API, with the session's token | `customer(customerAccessToken:) { orders }` (`CustomerOrderHistory`) | Its place in the list (`CustomerOrderIds`, ids only, 250 a page), then that one order (`CustomerOrderDetail`): the Storefront API has no order-by-id query |

- **Signed out**, both are empty, with no error, and nothing is sent. While a stored session is read
  on app open, `loading` is true, so a returning shopper doesn't see "sign in" or "no orders" first.
- **`loading` is true only before the first answer.** A `refresh()` keeps what is on screen, and a
  failed one keeps it and sets `error`; the next read that works clears it.
- **A refresh joins a read already on its way**, so a screen that refreshes on focus reads once on
  mount, not twice. It re-reads the first page and keeps the pages loaded after it, so a list scrolled
  down stays where it was (those pages aren't re-read; the first page is laid over them).
- **Paging is by cursor**: `hasMore`, `loadMore()` (it does nothing while another read is on its way),
  `loadingMore`. A page is `pageSize` orders (default `ORDERS_PAGE_SIZE`, 25), newest first by
  `processedAt`, the date the screens show.
- **Another shopper's orders don't stay**: signing out empties both at once, and so does a session
  of the other kind or a different customer's profile arriving, before reading again. The profile
  arriving after the session began (app open, sign-in) is the same shopper and reads nothing again.
- `progress`: `cancelled` when the order was cancelled, whatever its fulfilment; else `fulfilled`,
  `partiallyFulfilled`, or `confirmed` for every other fulfilment status.
- `itemCount` adds up the quantities. A list row counts an order's first 30 lines (enough for a
  list, and it keeps a page of 25 near 850 Customer Account API cost points); `useOrder` reads up to
  100 lines.
- Totals: `subtotal` is the lines before discounts and `totalDiscount` the gap between that and
  Shopify's subtotal, so a whole-order code is counted too. `totalDiscount`, `totalTax` and
  `totalRefunded` are null when there is none; `totalShipping` keeps a zero (free shipping).
  `discountCodes` are the codes entered; automatic discounts have none.
- Tracking, addresses and returns are on Shopify's status page: `statusPageUrl` (the Storefront API's
  `statusUrl`).

**Buy again** puts the order's lines back in the cart through the cart's own add (`addLines`: the
`cartGuard`, the line limit judged on the whole batch, one `cart:add`):

- Stock is read fresh first (`variants.byIds`). A line whose variant is gone or not for sale is
  skipped. A quantity over what is left is cut to it, counting what the cart already holds and what
  earlier lines of the order take (`stockCeiling`, the rule `useAddToCart` checks). Untracked stock,
  or overselling allowed, has no ceiling.
- `skipVariant(variantId)`: a line whose variant it returns true for is skipped before anything is
  added or claimed. Pass Cart Hold's held out, as above, so a size whose every unit was just found
  held in other carts isn't tried again. Wrap it in an arrow: `isHeldOut` is a method of the client.
- **One summary, no message per line.** The add is quiet (`addLines(inputs, { quiet: true })`, see
  Cart guard): the guard says nothing about a line it refuses (no Cart Hold toast), and a line Shopify
  refuses is dropped and the rest kept without a `cart:outOfStock`. The screen shows one message
  built from `added` and `skipped`. `cart:add` still fires when something lands.
- It never throws. `added` and `skipped` count order lines. A line cut short still counts as added:
  cut to the stock left, or by the guard (Cart Hold takes only the units still free: 3 ordered and 2
  free adds 2). **A cut isn't reported**: `added` can't tell 2 of 3 from 3 of 3. Offline, every line
  counts as skipped.
- A variant still sold out and enrolled in pre-order goes back on its selling plan, at the ordered quantity (the Waitlist's pre-order rule); everything else goes back as an ordinary line by the stock rule. Production sent no selling plan.

Tested in `test/orders.test.mjs` (44 checks: both sign-ins, paging, the refresh keeping the list, a
failed refresh, the progress rule, not found and signed out, and Buy again with an unavailable line,
a cut quantity, everything added, pre-orders, `skipVariant`, and through a guard: told quiet, a line
it cuts, a line it refuses).

**The order just placed (0.10, SDK move 6).** For an Order Confirmed page:

```tsx
const { order } = useLatestOrderSince(checkoutOpenedAt); // ms, when checkout opened on the phone
order?.name; // "#1043", or no order yet
```

- `order` is the shopper's newest order, but only once it was placed at or after `since`, less 2
  minutes (`ORDER_CLOCK_LEEWAY_MS`) for the phone's clock running ahead of Shopify's. Until Shopify
  lists it, the newest is the order before, so `order` stays null: no number rather than a wrong one.
- While it isn't listed, the newest is read again after 3 and 8 seconds
  (`LATEST_ORDER_READ_AGAIN_SECONDS`; `{ readAgainAfterSeconds }` to change). Then it stops.
- Signed out, nothing is read and `order` is null (a guest's order isn't known in the app).
- `since` left out takes the newest order, whatever its date. It reads a page of one order.
- Tested in `test/latest-order.test.mjs` (10 checks).

### Checkout

**Getting the cart ready (0.10, SDK move 6).** Every way into checkout (the cart, a product page's
Buy now, a waitlist) runs the same steps first:

```tsx
const { prepare, preparing } = useCheckout();
const result = await prepare({ hasLapsedHold }); // Cart Hold's, when the app has reservations
if (result === 'ready') navigation.navigate('Checkout');
else if (result === 'lapsedHold') navigation.navigate('Cart', { expired: true });
else if (result === 'empty') showToast('Your reservation expired and the item was released.');
else showToast("Couldn't open checkout. Try again."); // 'failed'
```

1. **The cart is read again.** No cart, or no lines (a reservation that ran out took them), is
   `'empty'`. A read that fails (offline) carries on with the cart already loaded: Shopify's checkout
   checks it again itself (decided 2026-10-06, Head of Engineering: "Carry on").
2. **A reservation that ran out** (`hasLapsedHold(lines)`, asked about the lines just read) is
   `'lapsedHold'`, and nothing else happens: Shopify would empty that line during checkout.
3. **Together, neither able to stop checkout:**
   - the signed-in shopper is attached (`setBuyerIdentity`): their token, the profile's email when it
     has loaded, and the cart's country, sent again because the write replaces the whole identity and
     a gift card stays only on a cart with a country. A failure leaves a guest checkout.
   - the cart is labelled: `flushAttribution()`, then `ensureCartAttributes` with the provider's
     `cartAttributes` (no request when they're already there). Each gets 3 seconds
     (`CHECKOUT_LABEL_STEP_TIMEOUT_MS`); one that fails or runs out of time is warned about. (Both
     need 0.9.1's attribution; a build without them skips this.)
4. **The start is reported** (`reportCheckoutStarted`), so a cart gone to checkout isn't refilled on
   the next launch.
5. `'ready'`. Anything else that throws is `'failed'`. `prepare` never throws.

`preparing` is true while this hook's own `prepare` runs, so only the button that started it shows a
spinner. `prepare` keeps one identity. Tested in `test/checkout-prepare.test.mjs` (28 checks).

**The outcome.** Checkout is Shopify-hosted, so the SDK cannot see the outcome. Report it from the
webview and the configured copy comes back on the event:

```tsx
const { reportOrderPlaced, reportPaymentFailed } = useCheckout();
// reportOrderPlaced also resets the cart — the old one is spent.
```

**Noticing the order (0.10).** The checkout's address is the only sign a web view gets that the order
was placed. Two pure helpers from the main entry (no React) read it:

- `isOrderPlacedUrl(url: string | null | undefined): boolean` is true for a page Shopify shows once the
  order is placed: `/thank-you` or `/thank_you`, `/confirmation` (where one-page checkout lands) and
  the order status page under `/orders/` (`/<shop id>/orders/<token>`).
  - **Nothing under `/account/` counts.** A signed-in checkout shows an account menu, and an order
    opened from it (`/account/orders/<id>`, or `/<shop id>/account/orders/<id>`) is an old order.
    Counting it would send `purchase` and clear the cart the moment a shopper looked at a past
    order. The order history list (`/account/orders`) doesn't count either.
  - Only the path is read: a query or fragment that names one of these pages (`?return=/orders/1`)
    never counts. Letter case doesn't matter.
  - Each name must be a whole part of the path: `/pages/thank-you-for-subscribing` and
    `/confirmations` don't count.
  - It keeps nothing between calls, so asking twice gives the same answer.
- `REPORT_ADDRESS_CHANGES_SCRIPT` is the script for the web view's `injectedJavaScript`. It posts
  `{ kind, url }` as JSON each time the page's address changes. `kind` is `load`, `pushState`,
  `replaceState`, `popstate` or `hashchange`.
  - The web view's own navigation event reports whole-page loads only. Shopify can reach the thank-you
    page through `history.replaceState`, which only the script sees.
  - It installs once per page, and does nothing where there's no web view to post to.

```tsx
import { isOrderPlacedUrl, REPORT_ADDRESS_CHANGES_SCRIPT, useCheckout } from '@tiledev/sdk-shopify';

const { reportOrderPlaced } = useCheckout();
const reported = useRef(false);
const pageMovedTo = (url: string) => {
  if (reported.current || !isOrderPlacedUrl(url)) return;
  reported.current = true; // the page arrives several times: a replaceState, a pushState, late loads
  void reportOrderPlaced();
};

<WebView
  source={{ uri: cart.checkoutUrl }}
  injectedJavaScript={REPORT_ADDRESS_CHANGES_SCRIPT}
  onNavigationStateChange={(event) => pageMovedTo(event.url)}
  onMessage={(event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      if (typeof message?.url === 'string') pageMovedTo(message.url);
    } catch {}
  }}
/>;
```

Report the order **once per checkout**: the same page arrives several times. Tested in
`test/checkout.test.mjs` (20 checks; the script runs in jsdom).

### Where cart units came from (0.9.0)

Off by default. With `attribution={{ enabled: true }}` the provider counts, per variant, how many
units were added from a live show, a replay, or the rest of the app, in one cart attribute,
`_apptile_attribution`. The order carries it in `note_attributes`.

```tsx
<ShopifyProvider config={config} attribution={{ enabled: true }}>
// Live sheet:
addLine({ merchandiseId, quantity: 1, source: { type: 'live', showId: streamingId } });
// Stepper with a source:
updateLine(lineId, 3, undefined, { source: { type: 'replay', showId: streamingId } });
```

- No `source` means `{ type: 'app' }`. Decreases and removals take units off app first, then
  replays, then live shows, oldest first.
- A product page or variant sheet passes it once: `useProductPage(handle, { source })` (or
  `useAddToCart`) gives it to every add from the page, the stepper's + included (0.10, SDK move 6).
- `useCheckout().prepare()` runs `flushAttribution()` and `ensureCartAttributes(cartAttributes)`
  before checkout (0.10, SDK move 6), so an app needn't.
- It is written after the line write lands, one write at a time. A failed write never fails the
  line write; the next change writes the missed counts too. Every other cart attribute is kept.
- Before opening checkout, `await flushAttribution()` (from `useCart()`) so a last failed write is
  retried. `false` means the cart still lacks the device's value; it never throws.
- `ensureCartAttributes(pairs)` (from `useCart()`) sets cart attributes without wiping the rest,
  `_apptile_attribution` included, queued behind pending writes. Works with attribution off too.
- An expired cart restored from the device snapshot is created with the value; `adopt` takes the
  adopted cart's value.
- `parseAttribution`, `serializeAttribution`, `recordAdd`, `recordRemove` and `mergeAttribution`
  are exported for code that rebuilds carts itself (Cart Assist merges two carts' values).
- **`showsInCart(cart): { live: string[]; replay: string[] }`** (0.10, SDK move 7): the shows a cart
  holds units from, both by the show's streaming id (a replay is counted under the show it records).
  A show whose units all left the cart isn't listed. For the analytics events `streamCheckout` and
  `streamPurchase` (`@tiledev/sdk-analytics-core`'s `streamCheckoutParams`), sent beside
  `initiateCheckout` and `purchase` when either list has a show (Freckled Poppy's `streamAttribution`).
- `shopify.cart.updateAttributes` still replaces the whole set: send the cart's current attributes,
  `_apptile_attribution` included.

### Which link the shopper came from: link tags (0.11.0)

Off by default. With `linkTags`, the provider saves the `ref` and `utm…` tags of each link that opens
the app (an influencer's `https://store.com/collections/new-drops?ref=brandi10&utm_source=instagram`)
and puts them on the cart, so the order's attributes say where the shopper came from. The app hands it
its links; the SDK doesn't import React Native.

```tsx
import { Linking } from 'react-native';

const getInitialUrl = () => Linking.getInitialURL();
// The same function every render: a new one subscribes again.
const subscribe = (onLink: (url: string) => void) => {
  const subscription = Linking.addEventListener('url', ({ url }) => onLink(url));
  return () => subscription.remove();
};

<ShopifyProvider config={config} linkTags={{ keepDays: 7, getInitialUrl, subscribe }}>
```

- **Tags:** every query parameter whose name starts with `utm` or `ref`, in any case (`ref`,
  `ref_code`, `referrer`, `utm_source`, …), decoded, as the link spells them; not `fbclid`, `gclid`
  or a product's `variant`. At most 20, each value cut to 255 characters. A link with none changes
  nothing.
- **The last link wins:** a newer link's tags replace the saved ones and restart the clock, and on the
  cart replace every older tag (an older link's `utm_content` goes too). Other attributes are kept.
- **Kept `keepDays` from the link:** new carts get them for that long, a cart that already has them keeps
  them afterwards, through checkout (decided 2026-10-08, Head of Engineering: "Leave them on"). The days
  are read when the tags are used, so a changed setting applies to tags already saved. 0 is off.
- **Where:** on a cart created after the link; on the current cart at once; on a stored cart once it
  loads; on an adopted cart; and again at `useCheckout().prepare()`, so a write that failed lands then.
  Each queued behind pending cart writes; no request when the cart already has them.
- **On the phone:** `links.trackingTags.v1` in the provider's `storage`, `{ savedAt, tags }`.
- **`useCart().saveLinkTags(url)`** for a link the app routes itself: true when the tags were saved.
- Pure helpers: `linkTagsFrom(url)`, `isLinkTagKey`, `liveLinkTags`, `withLinkTags`, `cartHasLinkTags`,
  `readSavedLinkTags`. Tests: `test/link-tags.test.mjs` (12 checks) and
  `test/link-tags-provider.test.mjs` (16, the real provider).

## Tile Credit

Tile Credit is Apptile's store-credit wallet: a service (`https://tile-credit.apptile.io`) that holds each
customer's balance and turns it into Shopify gift cards. In a React app, use `useStoreCredit`,
`useStoreCreditHistory` and `useCartStoreCredit` (above) with `storeCredit={{ source: 'tile' }}` on the
provider: they build their client from the provider's session. Without React:

```ts
import {shopify, centsToMoney} from '@tiledev/sdk-shopify';

shopify.tileCredit.configure({
  // baseUrl is optional: https://tile-credit.apptile.io by default.
  shopDomain: 'yourshop.myshopify.com',
  getAccessToken: () => session.getAccessToken(),     // read before every request
  renewAccessToken: () => session.renewAccessToken(), // called once on a 401, then the request is sent again
});

const client = shopify.tileCredit.client()!;
const wallet = await client.getWallet();
console.log('balance:', centsToMoney(wallet.balanceCents));
```

**How the money moves.** Redeeming reserves, it doesn't charge: `redeem` mints a Shopify gift card and
reserves its amount, and the wallet is charged only for what an order uses, so the balance doesn't change
on a redeem. One card is active per customer, and a new redeem disables the previous one. The same
`idempotencyKey` returns the same card (`duplicate: true`), but two redeems at once with different keys
mint two cards: allow one at a time.

**Auth.** `Authorization: Customer <token>` (a `shcat_…` Customer Account API token or a classic
Storefront one) and `x-shopify-shop-domain`. A 401 means the token was refused, or the service doesn't
know the shop or has no credentials for it; the client renews the token once and never signs anyone out.

**Errors.** Every method rejects with a `TileCreditError`; branch on `.code`, not `.message`:
`unauthorized` (401), `forbidden` (403), `not_found` (404), `validation` (400: under the store's minimum
or over its maximum, `details.min`/`max`), `insufficient_balance` (402), `conflict` (409),
`rate_limited` (429), `shopify_upstream` (502), `internal` (other 5xx), `network` (unreachable or past
`timeoutMs`), and `cart_refused` (the card was made but didn't go on the cart).

`shopify.tileCredit.redeemAndApplyToCart` and `useTileCredit` are **deprecated** in favour of
`useCartStoreCredit`. Both were fixed on 2026-10-05: the card is added beside the cart's other gift cards
(they used to replace them), the cart's country is set only when it has none, keeping its email and the
shopper's link (they used to replace the identity with the country alone), and `useTileCredit` no longer
shows one shopper's wallet to the next.

## Types

```ts
import type {
  Product, ProductVariant, ProductOption,
  Cart, CartLine, CartLineInput, CartLineUpdateInput,
  Collection, Customer, Order, Blog, Article,
  OrderSummary, OrderDetails, OrderLine, OrderProgress,
  WishlistItem, WishlistStorageAdapter,
  ShopifyConfig, ShopifyIntegration,
  ShopifyError,
  // Tile Credit
  TileCreditConfig, TileCreditAPI,
  TileCreditWallet, TileCreditLedgerEntry, TileCreditLedgerPage,
  TileCreditIssuedGiftCard, TileCreditPublicConfig,
  TileCreditRedeemInput, TileCreditRedeemResult,
  TileCreditError, TileCreditErrorCode,
  AppliedGiftCard,
} from '@tiledev/sdk-shopify';
```

## License

MIT
