# Using @tiledev/sdk-shopify 0.8, with sdk-app-monitoring 0.1 and sdk-tile-notification 0.3

How to wire the latest SDK into a Tile app so the product page opens instantly, listing and search pages paint from the device on a cold start, identical reads cost one network call, and images arrive at the size each screen shows. §9 adds crash reporting and session replay with `@tiledev/sdk-app-monitoring`, including the sdk-shopify hooks' errors and the signed-in customer. §10 adds push, in-app messages, the unread badge and live cards with `@tiledev/sdk-tile-notification`, fed by the same commerce events.

The [README](../README.md) is the full API reference; this is the setup and the reasoning.

---

## 1. Install

```sh
npm i @tiledev/sdk-shopify@0.8.0 --save-exact
npx expo install react-native-mmkv@^3     # native device cache (see §5.2)
```

- **Pin the exact version.** The Tile preview fetches each package by the version in `package.json`.
- **Import from the package root**, never `@tiledev/sdk-shopify/react`. The Tile bundler builds one bundle per package, so the `/react` subpath has no bundle in the web preview. The root re-exports every hook.
- `react-native-mmkv` is an optional peer. Without it the SDK still works, but its device cache lives in memory only and is lost on every cold start. It needs the New Architecture (on by default from RN 0.76 / Expo 52), and adding it changes the native binary, so it ships in a store build, not an OTA.

---

## 2. Provider

One `ShopifyProvider` at the root, inside the Live Layer provider if you read alert settings from it (§6).

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ShopifyProvider } from '@tiledev/sdk-shopify';

<ShopifyProvider
  config={{
    storeDomain,
    storefrontAccessToken,
    apiVersion: '2025-01',
    country, language,                        // part of every cache key, so markets never mix
    imageTransforms: {                        // for the reads the provider runs itself
      cart: { maxWidth: 160, scale: 2 },
      wishlist: { maxWidth: 480 },
    },
    // cache: { ttl: { CollectionProducts: 0 }, maxEntries: 50 },   // tune (§5.1)
    // cache: false,                                               // turn all caching off
  }}
  storage={AsyncStorage}                      // cart id + wishlist across launches; web defaults to localStorage
  // wishlistStorageKey={`${APPTILE_APP_ID}_WishlistProducts`}   // moving from Apptile's engine: its key, read as is
  // wishlistMigrateFrom={["tile:shopify:wishlist:v1"]}          // earlier keys, merged once
  // waitlistStorageKey={`${APPTILE_APP_ID}_WaitlistProducts`}   // the waitlist the same way (`useWaitlist`)
  // waitlistMigrateFrom={["waitlist.entries"]}
  {...alertProps}                             // messages, cartPolicy, onEvent (§6)
>
  <App />
</ShopifyProvider>
```

The provider sets the config **on its first render**, so a hook below it can read on its own first render without waiting for the provider's startup (cart, wishlist, customer). Apps on 0.4–0.6 logged "`shopify.init() must be called before any other method`" at launch; that is gone from 0.7.

---

## 3. The three pages

All three hooks follow the same rule: **render what the device already knows on the first render, read the network in the background, update in place.** `refreshing` is true while that read runs; you don't need a spinner for it. A copy younger than `REVALIDATE_AFTER_MS` (1 minute) isn't re-read. `refresh()` always goes to the network.

### Product page: `useProductPage` (or `useProduct` underneath)

`useProductPage(handle, options)` is the whole page's logic on top of `useProduct`: selection, option
states, price, stock and the stock ceiling, media, description, favourite and share link, each rule an
option (README, "Product page"). Use it unless a page needs something it doesn't do; then use
`useVariantSelection` / `useAddToCart` or the pure helpers for the parts you keep. Underneath:


```tsx
const { preview, product, level, loading, refreshing, notFound, error, refresh } =
  useProduct(handle, { imageTransform: { maxWidth: 1080 } });

if (notFound) return <NotFound />;
// preview: title, image, price, options, variants, stock, tags and description. Render it all now.
// product: the full product, which adds the gallery's media (videos, every image).
// level: 'base' (only preview so far) | 'full' | null (nothing known: show the skeleton)
```

- Every product read anywhere in the SDK records the product's **base keys** (`PRODUCT_BASE_KEYS`): collections, search, recommendations, `byIds`, the wishlist. Since 0.9 they include the options, variants, stock state and description, which those reads fetch anyway. So a product tapped on any grid, search result or rail opens with its title, image, price, **variant picker, Add to Cart and description in the same frame**; only the gallery's other media waits for the product's own read. A product page seen before opens complete.
- To warm a page before the tap lands, read the store on `onPressIn`: `peekProduct(handle)`.

### Listing page: `useCollectionProducts`

```tsx
const feed = useCollectionProducts({
  handle,
  pageSize: 12,
  sort: { key: 'CREATED', reverse: true },
  filters: [{ available: true }],               // always applied; the shopper's picks go on top
  imageTransform: { maxWidth: 480 },
});

feed.products;            // first page paints from the device even after a cold start
feed.loadMore();          // next cursor page (feed.hasMore, feed.loadingMore)
feed.refresh();           // pull-to-refresh: reads fresh
feed.availableFilters;    // Shopify's facets for this collection
feed.setFilters(inputs);  // the facet `input` strings the shopper picked
feed.selectedFilters; feed.filterActive; feed.clearFilters();
```

- **Render every facet Shopify returns.** Facets come from the store's Search & Discovery settings, not from the app.
- **Price** is the one facet whose input the app builds:

  ```ts
  import { priceRange, priceFilterInput, parsePriceFilterInput } from '@tiledev/sdk-shopify';

  const range = priceRange(priceFacet);                // { min, max } of the collection
  const input = priceFilterInput(min, max, range);     // '{"price":{"min":20,"max":100}}', or null if it narrows nothing
  feed.setFilters([...otherInputs, ...(input ? [input] : [])]);
  const current = parsePriceFilterInput(selected);     // pre-fill the min/max fields
  ```

- A selection belongs to its collection: a new `handle` starts with none.
- Six grids on the same collection make **one** request (§5.1).

### Search page: `useSearch`

```tsx
const results = useSearch(term, { debounceMs: 300, pageSize: 12, imageTransform: { maxWidth: 200, scale: 2 } });
results.query;     // the debounced term actually searched
results.products;  // a repeated search paints its first page from the device
```

Search answers are reused for 30 seconds, the shortest of any read.

### Favourites on a grid

```tsx
const { ids, toggle, has } = useWishlist();
<ProductGrid products={feed.products} favoriteIds={ids} onToggleFavorite={toggle} />
```

`ids` is a stable list of product ids, cheaper to pass to a grid than the full `items`.

---

## 4. Images

Every call that returns images takes an optional `imageTransform`: Shopify's server-side `Image.url(transform:)`. The CDN resizes and crops, so each screen downloads the size it draws. **Omitted, URLs are the originals**, so nothing changes until you opt in.

| Where | Suggested transform | Why |
| --- | --- | --- |
| Two-column product grid | `{ maxWidth: 480 }` | A tile is ~half the screen; 480 covers 2–3× density |
| Product page gallery, hero banners | `{ maxWidth: 1080 }` | Full width at phone density |
| Search rows, mini cart, rails of small cards | `{ maxWidth: 200, scale: 2 }` | Thumbnails |
| Cart lines (provider) | `config.imageTransforms.cart: { maxWidth: 160, scale: 2 }` | The provider runs the cart read itself |
| Square thumbnails | `{ maxWidth: 100, maxHeight: 100, crop: 'CENTER' }` | Gives `…_100x100_crop_center.jpg` |

- Fields: `maxWidth`, `maxHeight`, `crop` (`CENTER` | `TOP` | `BOTTOM` | `LEFT` | `RIGHT`), `scale` (1–3). It never upscales past the original. `width`/`height` on the image stay the original's, so aspect ratios still work.
- It applies to every image in the answer: product, featured, media, variants, collection, cart lines, orders, articles.
- **Don't rely on `preferredContentType`.** Shopify's CDN picks the format from the device's `Accept` header (`Vary: Accept`), so asking for WEBP made no difference in our tests. Devices that accept WEBP or AVIF get it anyway.
- Each transform is its own cache entry. Use the **same** transform for the same surface across screens, or the image cache can't reuse the download.
- The product page's first-render `preview` uses the image the grid fetched, so the picture on screen is already in the image cache when the page opens.

---

## 5. What is cached, and where

### 5.1 In memory: one call per identical read

Every Storefront read goes through one `request()`:

- **In flight:** identical queries fired together share one call. This applies to every query, cart and customer included. Mutations are never shared.
- **Recent answers** are reused for a while (`DEFAULT_CACHE_TTL_MS`):

  | Read | Reused for |
  | --- | --- |
  | Shop info, localization | 30 min |
  | Collections, collection by handle, blogs, articles | 10 min |
  | Recommendations | 5 min |
  | Collection pages, products, product by handle/id, wishlist items | 1 min |
  | Search | 30 s |
  | Cart, customer, orders, variant stock | never |

- Every caller gets its own parsed copy, so mutating a result can't leak into another screen. Failed calls and GraphQL errors are never kept.
- The key includes store, token, market (`@inContext`), metafields and variables.

**If you call `shopify.*` directly** (not through a hook) for something that must be current, such as your own pull-to-refresh, pass `{ fresh: true }`. Otherwise a second call within the TTL returns the first answer:

```ts
await shopify.collections.products(handle, { first: 12, fresh: true });
clearRequestCache();   // forget every answer (e.g. after switching market)
```

The hooks' `refresh()` and `retry()` already read fresh.

### 5.2 On the device: survives a cold start

| What | Cap | Read |
| --- | --- | --- |
| Product base keys (incl. variants, description) | 2,500 products, ~10-25 MB | By the hooks, one key per product, on demand |
| Full products (opened product pages) | 30 | `useProduct` |
| First pages of collections and searches | 20 | `useCollectionProducts`, `useSearch` |

- Anything older than 7 days is dropped. Keys carry a schema version plus store, market, API version and metafields, so a mismatched entry is never shown.
- Catalogue data only: never cart, customer, orders or wallet.
- **Storage:** MMKV 3 on iOS/Android (synchronous, microseconds, readable inside a render, which is what makes the first-frame product page possible). `localStorage` on web and in the editor preview. Memory if MMKV isn't in the binary.
- Nothing is loaded in bulk at launch; entries are read only when a screen asks.
- `forgetProduct(id)` drops one (e.g. on `cart:outOfStock`). `clearProductStore()` drops all.
- `cache: false` in the config turns this off along with the request cache.

---

## 6. Alerts and the cart limit from the Live Layer (0.8)

The editor's Settings panel publishes alert copy and the cart line limit into the app's Live Layer. The SDK owns the paths and rules; the app reads two values and passes its toast:

```tsx
import { ALERT_SETTINGS_PATH, MAX_LINE_ITEMS_SETTING_PATH, useAlertSettings } from '@tiledev/sdk-shopify';

function ShopifyWithAlerts({ children }) {
  const alerts = useLL(ALERT_SETTINGS_PATH);                // settings.alerts
  const maxLineItems = useLL(MAX_LINE_ITEMS_SETTING_PATH);  // settings.cart.maxLineItems
  const alertProps = useAlertSettings({ alerts, maxLineItems, show: showToast });
  return <ShopifyProvider config={config} storage={AsyncStorage} {...alertProps}>{children}</ShopifyProvider>;
}
```

| Published value | Result |
| --- | --- |
| A string | That alert's copy (cut to 200 characters) |
| `''` (merchant cleared the field) | That alert is **silenced** |
| Absent / not a string | The SDK's default copy |
| `maxLineItems` 1–100 | The cart limit (distinct lines, not units) |
| Anything else | No limit |

`onEvent` keeps one identity, so passing a new `show` arrow each render rebuilds nothing. Without React: `readAlertSettings(tree)`, `readCartPolicy(value)`.

---

## 6b. Sign-in, both ways (0.9)

Every app gets both logins: email and password (Shopify's classic customer accounts) and Shopify's web sign-in (new customer accounts). `auth.method` picks the one the app offers now, and it can change while the app runs. The README's "Customer session" section is the reference; [`examples/auth`](../examples/auth) has a working screen for each.

**Why both.** Shoppers get Shopify's passwordless web sign-in. An App Store reviewer can't use it: it emails a one-time code to an inbox the reviewer can't read. So the app is in `password` mode while a build is in review, with a demo account, and in `shopify` mode the rest of the time. Put `method` in the Live Layer (app level) so it flips without a release; the path is the app's choice, for example:

```tsx
const reviewMode = useLL('settings.auth.reviewMode') === true;
<ShopifyProvider auth={{ method: reviewMode ? 'password' : 'shopify', ... }} storeCredit={{ source: 'shopify' }}>
```

**Set up once per app:**

1. Shopify admin → Settings → Customer accounts → Headless (or the Hydrogen channel): create a **Public** client for mobile. Note its client id and the shop id (the number in `shopify.com/<shopId>/account`). Callback URI: `shop.<shopId>.app://callback`.
2. `app.json`: add `shop.<shopId>.app` to `scheme`.
3. `npx expo install expo-secure-store expo-web-browser expo-crypto` (and `react-native-webview` for the in-app surface). These are native modules: a store build, not an OTA.
4. Pass `auth` and `storeCredit` on `ShopifyProvider` (README).
5. For review: the demo login is a real customer with a password, signing in through Storefront `customerAccessTokenCreate`. Create it, and sign in with it on a device, before submitting: a store on new customer accounts may not accept password sign-in, and then review needs another way in (Amore's was a local demo session that reaches no Shopify data).

**Store credit** is per app too: `storeCredit: { source: 'shopify' }` reads Shopify's own balance, which only the Customer Account API exposes, so it is unavailable during review mode; `{ source: 'tile' }` reads the Tile Credit wallet with either sign-in. `useStoreCredit()` reads whichever it is, and `useCartStoreCredit()` puts Tile Credit on the cart (Apply / Remove; Shopify's store credit is taken at its checkout) — README, "Store credit on the cart".

**Other SDKs** that act for the signed-in shopper (cart-sync, live-selling wins, checkout's buyer identity) take `await useCustomer().getAccessToken()`, which refreshes when needed, rather than reading tokens themselves.

---

## 7. Checklist

- [ ] `@tiledev/sdk-shopify` pinned to `0.8.0`; imports from the package root.
- [ ] `react-native-mmkv@^3` in the app, shipped in a store build.
- [ ] One `ShopifyProvider` with `storage`, and `imageTransforms.cart` / `.wishlist` set.
- [ ] An app moving from Apptile's engine passes its old wishlist and waitlist keys (`wishlistStorageKey`, `waitlistStorageKey`) and any earlier ones (`…MigrateFrom`), so shoppers keep what they saved. Both lists then work offline (README, "Wishlist", "Waitlist").
- [ ] `imageTransforms.waitlist` set, if the app shows a waitlist.
- [ ] Product page on `useProduct`: render `preview` at once, the picker when `product` arrives.
- [ ] Listing pages on `useCollectionProducts`; the filter sheet renders every facet, price via `priceFilterInput`.
- [ ] Search on `useSearch`.
- [ ] An `imageTransform` on every grid, rail, gallery and thumbnail, one transform per surface.
- [ ] Any direct `shopify.*` refresh passes `{ fresh: true }`.
- [ ] Alerts via `useAlertSettings` (no app-side path table).
- [ ] Sign-in: `auth` on the provider with `secureStorage`, `openAuthSession`, `random`, and `method` from the Live Layer; `storeCredit` set; the review demo account tested (§6b).
- [ ] Monitoring: `initMonitoring` at module scope, `withMonitoring` outermost, `<ErrorBoundary>` at the root, `identifyUser`/`resetUser` from `useCustomer`, hook `onError` → `captureError` (§9).
- [ ] Notifications: `@tiledev/sdk-tile-notification` pinned to `0.3.0`; `onesignal.init` once after launch permissions; `createOneSignalAnalyticsAdapter()` in the analytics adapters; cart count and purchases tracked; bell badge on `useUnreadNotificationCount` (§10).

---

## 8. Upgrading from 0.4–0.7

Nothing was removed or renamed. Amore (77 files on the SDK) type-checked against 0.8.0 with zero errors, and its preview behaved identically screen for screen. What changes behaviour:

| From | Change | Do |
| --- | --- | --- |
| < 0.7 | Identical reads within the TTL return the cached answer | Add `{ fresh: true }` to direct calls that must be current |
| < 0.7 | `useCollectionProducts` / `useSearch` paint cached first pages, then refresh | Show `refreshing` subtly, not as a blocking spinner |
| < 0.7 | The provider configures the SDK on first render | Remove any workaround for the `shopify.init()` launch error |
| < 0.7 | Device cache via the optional `react-native-mmkv` peer | Add it for persistence, in a store build |
| < 0.6 | `useCollectionProducts` holds filter state; `useWishlist().ids` | Move app-side filter state into the hook |
| < 0.8 | `useAlertSettings` | Delete the app's alert path table and silence logic |

`addLine` has returned `{ ok, reason, message }` (not a boolean) since 0.2. Check `.ok`, because an object is always truthy.

---

## 9. Crash reporting and session replay: @tiledev/sdk-app-monitoring 0.1

One package for Sentry (crashes), LogRocket (session replay), the app's `captureError` / `captureWarning` seam, and a root `ErrorBoundary`. Source: [clearsight-dev/sdk-app-monitoring](https://github.com/clearsight-dev/sdk-app-monitoring).

| Where | What runs |
| --- | --- |
| iOS/Android **release** builds | Sentry and LogRocket, each on when its key is set |
| Development builds | Console only (the error is already on screen) |
| Web and the Tile preview | Console only; the web build never requires either native module |

Every call is safe before init, twice, or with the tools off, so callers never guard. A missing module, an empty DSN or a throwing SDK is a `console.warn` and that tool stays off; reporting can never be why the app fails.

### 9.1 Install

```sh
npm i @tiledev/sdk-app-monitoring@0.1.0 --save-exact
npx expo install @sentry/react-native @logrocket/react-native   # optional peers, native only
```

Add Sentry's config plugin (`@sentry/react-native/expo` in `app.json`) for source maps; that part stays the app's.

### 9.2 Wire it in `App.tsx`

```tsx
import { ErrorBoundary, initMonitoring, withMonitoring } from '@tiledev/sdk-app-monitoring';
import { SENTRY, LOGROCKET } from '@/config';

// 1. Module scope, before any provider's module runs: Sentry only sees what happens after init.
initMonitoring({
  sentry: {
    dsn: SENTRY.dsn,                        // empty → off
    environment: 'ambermarie-production',
    tracesSampleRate: 0.2,
    tags: { app: 'ambermarie' },            // shared Sentry project: the tag is what dashboards filter by
    // sendDefaultPii stays false (on, Sentry attaches IPs and request headers)
  },
  logRocket: { appId: LOGROCKET.appId },    // empty → off
  // enableInDev: true,                     // only to test reporting from a dev build
  // linkReplayToCrashes: false,            // default true: the replay URL goes on every Sentry event
});

function App() {
  return (
    // 2. Outermost render catch. It sits above the theme, so give it base colours.
    <ErrorBoundary colors={{ background, text, muted, primary, onPrimary }}>
      <LiveLayerProvider>
        <ShopifyWithAlerts>{/* … */}</ShopifyWithAlerts>
      </LiveLayerProvider>
    </ErrorBoundary>
  );
}

// 3. OUTERMOST wrap, outside the OTA updater: a crash in anything it doesn't wrap goes unreported,
//    and the OTA layer is the one that can ship a broken bundle to every device at once.
export default withMonitoring(TileUpdater.wrap(updaterOptions)(App));
```

`ErrorBoundary` reports what it catches through `captureError` (a caught render error never reaches Sentry's global handler) and shows "Try again". Props: `colors`, `title`, `message`, `retryLabel`, `showDetails` (default: dev builds only), `onError`, or `fallback({ error, componentStack, reset })` to replace the screen.

### 9.3 Report errors through one seam

Keep the app's import path stable and point it at the SDK, so tiles never import Sentry:

```ts
// src/core/utils/log.ts
export { captureError, captureWarning } from '@tiledev/sdk-app-monitoring';
```

- `captureError(error, context?)`: something failed. `console.error` plus Sentry; a non-`Error` is wrapped in one.
- `captureWarning(warning, context?)`: something the app handled that someone should know. `console.warn` plus Sentry at **warning** level, so a recovered condition never reads as a crash, and no red box in development.

### 9.4 With sdk-shopify

**The signed-in customer** on the replay and on crash reports:

```tsx
import { useCustomer } from '@tiledev/sdk-shopify';
import { identifyUser, resetUser } from '@tiledev/sdk-app-monitoring';

function SessionIdentity() {
  const { customer, loggedIn } = useCustomer();
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (loggedIn && customer) {
      wasSignedIn.current = true;
      identifyUser(customer.id, {           // traits go to LogRocket; Sentry gets the id only
        email: customer.email,
        firstName: customer.firstName,     // null/undefined traits are dropped, never written blank
        lastName: customer.lastName,
      });
    } else if (!loggedIn && wasSignedIn.current) {
      wasSignedIn.current = false;
      resetUser();                         // new replay session (same config), no Sentry user
    }
  }, [loggedIn, customer]);
  return null;
}
```

Mount it inside `ShopifyProvider`. `resetUser` starts a fresh replay so a following guest isn't recorded as the last customer.

**Hook failures with context.** Every page hook takes `onError(error, context)`; the context says where (`at`) and what (`handle` / `query`):

```ts
useProduct(handle, { onError: captureError });
useCollectionProducts({ handle, onError: captureError });
useSearch(term, { onError: (e, ctx) => captureWarning(e, ctx) });   // a failed search is handled: warning
```

A failed background refresh keeps the cached page on screen, so most of these are warnings, not crashes. Pick the level by what the shopper saw.

**SDK events.** `ShopifyProvider`'s `onEvent` carries `error` on failures. To report the unexpected ones without double-toasting, wrap the alert handler:

```tsx
const { onEvent, ...alertProps } = useAlertSettings({ alerts, maxLineItems, show: showToast });
<ShopifyProvider {...alertProps} onEvent={(e) => {
  onEvent(e);
  if (e.type === 'checkout:paymentFailed') captureWarning(e.error ?? e.type, { event: e.type });
}} />
```

### 9.5 Known limits (0.1)

- `captureError` / `captureWarning` take `extra` context only, not a Sentry `level` or `tags`. A handler that needs `level: 'fatal'` or tags (e.g. the OTA updater's `onError`, which tags `ota_code` / `ota_stage`) still calls Sentry directly for now. Optional `level` and `tags` are proposed for 0.1.1.
- On the web preview everything is console-only, so a preview can't show that Sentry or LogRocket received anything. Confirm on a release build on a device.

---

## 10. Push, in-app messages and live cards: @tiledev/sdk-tile-notification 0.3

The device half of Tile's notification center. The dashboard sends through the app's own OneSignal app; this package makes the device a subscriber and sets the tags, outcomes and triggers its automations select on.

| Where | What runs |
| --- | --- |
| iOS/Android with `react-native-onesignal` linked | Real push, in-app messages, Live Activities (iOS) and Live Notifications (Android) |
| Web | A no-op build (`onesignal.isNoop` is true); every call is safe |
| **The Tile web preview** | **None of the package.** The preview player replaces it with its own no-op, so every named export is `undefined` there (§10.7) |

### 10.1 Install

```sh
npm i @tiledev/sdk-tile-notification@0.3.0 --save-exact
npm i react-native-onesignal@^5          # 5.2+ for custom events; optional peer, native only
npx expo install onesignal-expo-plugin expo-file-system
```

```json
"plugins": [
  ["onesignal-expo-plugin", { "mode": "production",
    "liveActivities": { "widgetFilePath": "./node_modules/@tiledev/sdk-tile-notification/ios/TileLiveActivity.swift" } }],
  ["@tiledev/sdk-tile-notification", { "liveNotifications": true, "liveActivityImages": true }]
]
```

The package's plugin goes **after** `onesignal-expo-plugin`. Both are native changes, so they ship in a store build. Skip the live-card options if you don't use them.

### 10.2 Initialise once

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { onesignal } from '@tiledev/sdk-tile-notification';

useEffect(() => {
  if (!PUSH.enabled) return;                       // native builds with an app id only
  onesignal.init({
    appId: PUSH.oneSignalAppId,                    // the app's OWN OneSignal app, not the platform's
    storage: AsyncStorage,                         // keeps the re-ask throttle
    reOptInPeriodDays: 7,                          // don't re-ask a shopper who declined, for 7 days
    onDeeplink: (url) => { Linking.openURL(url).catch(() => {}); },
    onNotification: (e) => analytics.track(
      e.type === 'opened' ? 'apptile_notification_open' : 'apptile_notification_foreground',
      { messageId: e.notificationId, messageName: e.title, launchUrl: e.launchUrl, messageDeviceTime: e.at },
    ),
    // liveActivities: true, inAppMessages: { … }, logLevel: 'none' | 'error' | 'warn' | 'info' | 'verbose'
  }).catch((error) => captureWarning(error, { at: 'onesignal.init' }));
}, []);
```

- **`init` is the permission ask.** It prompts (subject to `reOptInPeriodDays`), so mount it where the ask belongs in your launch flow, after any tracking prompt. It is idempotent and safe on every boot.
- `onNotification` gets every notification **opened** and every one that arrives while the app is **in the foreground**: `{ type, notificationId, title, body, launchUrl, data, at }`. Links still go to `onDeeplink`.
- Foreground notifications are **shown**. The SDK calls `display()` itself, because react-native-onesignal holds them back once JS listens. `showForegroundNotifications: false` keeps them silent. With neither option set, no listener is added and the OS shows them as always.

### 10.3 Every event to OneSignal: one adapter

```ts
import { createOneSignalAnalyticsAdapter } from '@tiledev/sdk-tile-notification';

createAnalytics([createApptileAnalyticsAdapter({ … }), createOneSignalAnalyticsAdapter()]);
```

Every `analytics.track` becomes a OneSignal **custom event**, so Journeys and segments can use any event the app tracks. The named ones also drive the automations:

| Event | Effect | Automation |
| --- | --- | --- |
| `updateCartQuantity` `{ totalQuantity }` | `cart_update` tag (removed when the cart empties); `cart_items` trigger | **Abandoned Cart**; "show while the cart has items" |
| `purchase` `{ totalValue }` | `Purchase` outcome with revenue, and clears `cart_update` | **Order Success** |
| `login` / `signup` | `external_id`, email/SMS subscriptions, name tags | **New User Welcome** |
| `logout` | detaches the device from the customer | |
| `pageView` `{ pageId }` | `screen` trigger on every page; `store` tag on Home | screen-based in-app messages |

- `identify` sets `external_id` to the customer's **email**, else their customer id (the same rule as `login`, so a customer is never split). A bare install id is ignored.
- Properties are made JSON-safe and trimmed, and **keys that look like credentials are dropped** (`password`, `token`, `secret`, `authorization`, `cvv`, card numbers).
- `init({ customEvents: false })` keeps only the named mapping; `{ exclude: ['scroll'] }` skips noisy events. Custom events must be on the OneSignal app's plan to show in its dashboard.

**Fed from sdk-shopify.** The cart count is what Abandoned Cart runs on:

```tsx
const { itemCount } = useCart();
useEffect(() => { analytics.track('updateCartQuantity', { totalQuantity: itemCount }); }, [itemCount]);
// on order completion: analytics.track('purchase', { totalValue })
// on sign-in: analytics.identify(installId, { customerId: customer.id, email: customer.email, firstName, lastName })
```

### 10.4 The bell badge

```tsx
import { useUnreadNotificationCount, markNotificationsSeen } from '@tiledev/sdk-tile-notification';

const unread = useUnreadNotificationCount({ historyUrl: NOTIFICATION_HISTORY_URL, storage: AsyncStorage });
// on the notification history screen:
useEffect(() => { markNotificationsSeen(AsyncStorage); }, []);
```

- `historyUrl` is the store's sent-push history file (`[{ id, sentAt }]`), e.g. `<historyCdnUrl><storeDomain>.json`. A store that has never sent one (404) shows 0.
- The count is pushes sent after the stored seen time (key `notifications.seenAt.v1`, the production apps' key, so upgraded devices keep their read state). It refreshes on mount and on return to the foreground; `markNotificationsSeen` resets every mounted badge at once.

### 10.5 In-App Messages

The popups and banners a marketer designs in OneSignal show **with no app code** once `init` runs. Control them only if you need to:

```ts
onesignal.init({ …, inAppMessages: { paused: true, onEvent: (e) => analytics.track(`in_app_message_${e.type}`, { id: e.messageId }) } });
onesignal.setInAppMessagesPaused(false);                 // e.g. after onboarding
onesignal.setInAppTriggers({ viewed_collection: 'sale' });
```

- `screen` and `cart_items` triggers are set for free by `pageView` and `updateCartQuantity`.
- Messages are fetched when a **session starts** (cold start, or back after 30 s+). A new message shows from the next session.
- **To test, target the trigger `tile_test` = `iam`** and set it from a test build. A message with no trigger goes to real customers.

### 10.6 The live card (lock screen and Dynamic Island)

A card for a live or upcoming show, on the iOS lock screen and in the Dynamic Island (a Live Activity), and as an ongoing notification on Android (a Live Notification). The package ships the design, so the app only sets it up and, on iOS, can start it.

**What it shows** (`ios/TileLiveActivity.swift`):

| Layout | When | Shows |
| --- | --- | --- |
| Upcoming | `startsAt` in the future and `status` not `LIVE` | UPCOMING pill, title, and a countdown such as "Starting in 4 hrs, 25 min · 7:30 PM". iOS draws the countdown, so it keeps ticking with no app work |
| Live | `status: 'LIVE'` | Rounded thumbnail with a red ring and LIVE badge, host, title, viewers pill, and a product chip with its price |

Both layouts cover the lock screen and the Dynamic Island (compact, expanded and minimal), in the brand colours you pass. Tapping the card opens its `url`, which arrives in the app as a normal deep link.

**One-time setup** (native, so it ships in a store build):

1. The plugins from §10.1: `liveActivities.widgetFilePath` points at the package's widget, and `liveActivityImages: true` lets it show thumbnails (needs `expo-file-system`). Android needs only `liveNotifications: true`.
2. Register the widget's App ID once, before the first cloud build: `<bundleId>.OneSignalWidget`, with App Groups on and the app's `group.<bundleId>.onesignal` ticked (Apple Developer portal → Identifiers). Cloud signing can't create this ID with its group. One local Xcode build signed with an Apple ID on the team also registers it.
3. Opt in at `init`: `onesignal.init({ …, liveActivities: true })`.

**Using it in the app (iOS):**

```ts
// Whenever the app learns about a show (home rail, live screen, upcoming list), cache its
// thumbnail where the widget can read it. The widget has no network access.
await onesignal.prepareLiveActivityImage(show.image);

// Start the card from the app: iOS 16.1+, app in the foreground.
if (onesignal.liveActivitiesEnabled()) {
  const started = onesignal.startLiveActivity(
    show.id,                                        // the stream id: one card per show
    {                                               // attributes: fixed for the card's life
      title: show.title,
      host: 'Amber Marie',
      url: `ambermarie://live/${show.id}`,          // opened on tap
      image: show.image,
      primary: theme.primary, accent: theme.accent, // '#RRGGBB'
    },
    {                                               // content: what changes
      status: 'UPCOMING',                           // or 'LIVE'
      startsAt: Math.floor(show.startsAt / 1000),   // unix SECONDS, for the countdown
      message: 'Fall drop: live try-on',
      viewers: 0,
      ...(show.product ? { product: show.product.title, price: show.product.price } : {}),   // values can't be undefined
    },
  );
}
```

| Key | Kind | Notes |
| --- | --- | --- |
| `title`, `host` | attribute | Text |
| `url` | attribute | Opened on tap |
| `image` | attribute | https URL; call `prepareLiveActivityImage` with the same URL first, or a brand-gradient tile stands in |
| `primary`, `accent` | attribute | `#RRGGBB`; default to neutral brand tones |
| `status` | content | `'UPCOMING'` or `'LIVE'` |
| `startsAt` | content | Unix **seconds**, not milliseconds |
| `message`, `product`, `price` | content | Display strings |
| `viewers` | content | A number |

- **No value may be `undefined`**: leave a key out instead (the type rejects it).
- **Use the stream id as the activity id**, so the same show never shows two cards.
- `startLiveActivity` returns `false` when Live Activities aren't enabled, the id is empty, or attributes plus content exceed **4 KB**. `true` means OneSignal accepted it; iOS can still decline.
- **The first card asks the shopper.** iOS shows "Allow Live Activities from <App>?" under it, and the card stays dimmed until they answer.
- A card stays live for up to 8 hours, then stays on the lock screen for up to 4 more.
- **Custom design:** point `widgetFilePath` at your own Swift file, and give every `Text` an explicit colour. Dark-mode lock screens turn default text white, and on a light card background that text disappears.

**Android:** there is nothing to call. The card appears and updates on its own once `liveNotifications: true` is in the build; `startLiveActivity` returns `false` and `liveActivitiesEnabled()` is `false` there. To see the card on a **debug** build without sending anything:

```sh
adb shell am broadcast -n <package>/.tilelive.TileLiveDebugReceiver \
  --es payload '{"key":"show-42","event":"start","event_attributes":{"title":"Live"},"event_updates":{"status":"LIVE","viewers":12}}'
```

**Testing on iOS:**
- A simulator build must be signed (`CODE_SIGN_IDENTITY=-`). An unsigned one (`CODE_SIGNING_ALLOWED=NO`) loses its entitlements, and iOS silently refuses the card even though `startLiveActivity` returned `true`.
- The simulator can show an app-started card but never receives card updates; use a real iPhone for those.

### 10.7 Known limits (0.3)

- **The Tile web preview never loads this package.** Its player registers a built-in no-op under this name before any download, so `onesignal`, `useUnreadNotificationCount`, `createOneSignalAnalyticsAdapter` and every other named export are `undefined` there, whatever version is pinned. A hook call throws "…is not a function" and the screen fails. The npm web build itself is fine. This was proven on 2026-10-01: the bundler's 0.3.0 bundle exports all 18 names, while a runtime probe saw only the player's no-op keys. Until the player passes the package through, a preview needs a local copy of the web build (amber-v2 uses `src/__local__/sdk-tile-notification`). **Never ship that copy:** a native build with it has no push.
- On the preview and web, nothing reaches OneSignal; confirm on a device.
- react-native-onesignal's Android bridge drops an in-app button's `urlTarget`.
- In our test, cards that weren't started by the app didn't reach a **development** build (app-started cards worked); still open. Test the live card on a TestFlight build.
