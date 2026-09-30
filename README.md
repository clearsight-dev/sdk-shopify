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
| `shopify.cart`        | `create`, `get`, `addLines`, `updateLines`, `removeLines`, `applyDiscountCodes`, `setBuyerIdentity`, `updateNote` |
| `shopify.customer`    | `signup`, `login`, `logout`, `profile`, `updateProfile`, `recoverPassword`, `orders`, `orderById` |
| `shopify.blogs`       | `list`, `byHandle`, `articles`, `articleByHandle` |
| `shopify.wishlist`    | `init`, `add`, `remove`, `toggle`, `has`, `list`, `count`, `clear`, `refresh`, `onChange` |
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

### Wishlist — local-storage backed

Stores a lightweight snapshot per product to whatever storage you give it (browser: `localStorage` by default; RN: pass AsyncStorage; server: pass any in-memory shim). Hydrates the full `Product` via a batched Storefront `nodes(ids:)` query on init and on demand, chunking arbitrarily large lists.

Deleted products (Storefront returns `null`) are pruned automatically. Pass `refresh({ keepDeleted: true })` to keep them with `product: null` for a "no longer available" UI.

```ts
await shopify.wishlist.init();          // rehydrates from storage, background-refreshes from API
await shopify.wishlist.add(product);
shopify.wishlist.has(product.id);       // O(1)
await shopify.wishlist.toggle(product);
shopify.wishlist.onChange(items => …);  // subscribe
```

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
// Product page: opens with title, image and price from whichever grid or search showed it.
const { preview, product, level, loading, refreshing, notFound, refresh } = useProduct(handle);
// preview: the base keys, render now. product: full (variants, media), render the picker when set.

// Listing page / search page: the last first page paints immediately, even after a cold start.
const feed = useCollectionProducts({ handle, pageSize: 12 });
const results = useSearch(term, { debounceMs: 300 }); // results.query is the debounced term
```

- **Every product read records its base keys** (`PRODUCT_BASE_KEYS`: `id`, `handle`, `title`,
  `featuredImage`, `priceRange`, `compareAtPriceRange`): collections, search, recommendations, lists,
  `byIds`, the wishlist. `byHandle`/`byId` record the full product. So a product tapped anywhere
  opens instantly, and a product page seen before opens complete.
- **Kept on the device** across cold starts, one small key per product, read only when something
  asks (nothing is loaded in bulk at launch). Caps: 2,500 base entries, 30 full products, 20 first
  pages; anything older than 7 days is dropped. Keys carry a schema version and the store, market,
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

## Alerts & Toasts

The editor's Settings panel configures the copy for 13 shopper-facing alerts. The
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
| `cart:outOfStock` | `cart.outOfStock` | Checkout |
| `wishlist:add` / `wishlist:remove` | `wishlist.added` / `wishlist.removed` | Wishlist |
| `auth:loginSuccess` / `auth:loginFailed` | `auth.loginSuccess` / `auth.loginFailed` | Login |
| `auth:logout` / `auth:recoverSent` | `auth.loggedOut` / `auth.resetLinkSent` | Login |
| `checkout:orderPlaced` / `checkout:paymentFailed` | `checkout.orderPlaced` / `checkout.paymentFailed` | Checkout |

`cart:update` and `cart:buyerIdentity` are state signals and carry no message.
`wishlist.empty` has no event — read it directly for a placeholder:

```tsx
const message = useShopifyMessage();
{count === 0 && <Text>{message('wishlist.empty')}</Text>}
```

Resolution order per key: `messages` prop → `config.messages` → `translate(key)`
→ built-in default. A cleared panel field (empty string) falls through rather than
rendering blank. `translate` is called with the i18n key where one exists
(`cart.added` → `toast.added_to_cart`), otherwise the message key itself.

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

### Customer session

`useCustomer()` owns the token so the Login alerts have somewhere to originate. It
persists to the same storage as the cart and restores on mount; an expired token
is dropped silently, because reopening the app is not a failed login.

```tsx
const { loggedIn, customer, login, logout, recoverPassword, restoring } = useCustomer();
// `login` resolves false on bad credentials (and emits auth:loginFailed).
// Anything else — network, store down — throws.
```

### Checkout

Checkout is Shopify-hosted, so the SDK cannot see the outcome. Report it from the
webview and the configured copy comes back on the event:

```tsx
const { reportOrderPlaced, reportPaymentFailed } = useCheckout();
// reportOrderPlaced also resets the cart — the old one is spent.
```

> A `checkout.observe(url)` helper that classifies the return URL itself is the
> next piece of work; this is the seam it will emit through.

## Tile Credit

Customer wallet + gift-card mint + one-shot apply to a Shopify cart.

```ts
import {shopify, centsToMoney} from '@tiledev/sdk-shopify';

// Configure once per signed-in customer (rebuild on logout / new customer).
shopify.tileCredit.configure({
  baseUrl: 'https://tile-credit-1097788179850.us-central1.run.app',
  customerAccessToken,     // shcat_… or classic Storefront customer token
  shopDomain: 'yourshop.myshopify.com',
});

const client = shopify.tileCredit.client()!;
const wallet = await client.getWallet();
console.log('balance:', centsToMoney(wallet.balanceCents));

// Redeem 15.00 AND apply the minted gift card to the current cart in one call.
const {redeemed, cart} = await shopify.tileCredit.redeemAndApplyToCart({
  cartId,
  amountCents: 1500,
});
```

React hook:

```tsx
import {useTileCredit} from '@tiledev/sdk-shopify/react';

function WalletScreen() {
  const {wallet, config, redeemAndApply, refresh, loading, error} = useTileCredit({
    baseUrl: TILE_CREDIT_URL,
    customerAccessToken: session.token,
    shopDomain: SHOP_DOMAIN,
  });
  // …
}
```

Full integration guide (idempotency, error taxonomy, recovery playbook)
lives in the mobile app repo alongside the wallet screen — this SDK ships
the client + types only. Every method rejects with a `TileCreditError`
(`.code`: `'unauthorized' | 'insufficient_balance' | 'shopify_upstream'
| 'network' | …`). Branch on `.code`, not `.message`.

## Types

```ts
import type {
  Product, ProductVariant, ProductOption,
  Cart, CartLine, CartLineInput, CartLineUpdateInput,
  Collection, Customer, Order, Blog, Article,
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
