# @apptile/sdk-shopify

Type-safe Shopify Storefront API client. Zero deps beyond `fetch`.

Works in any JavaScript runtime — Node, browsers, React Native, Cloudflare Workers, Deno, Bun.

Optional React helpers (provider + hooks) ship under a subpath so you only pay for `react` if you use them.

```bash
npm i @apptile/sdk-shopify
```

## Pure SDK (framework-agnostic)

```ts
import { shopify } from '@apptile/sdk-shopify';

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
| `shopify.cart`        | `create`, `get`, `addLines`, `updateLines`, `removeLines`, `applyDiscountCodes`, `setBuyerIdentity` |
| `shopify.customer`    | `signup`, `login`, `logout`, `profile`, `updateProfile`, `recoverPassword`, `orders`, `orderById` |
| `shopify.blogs`       | `list`, `byHandle`, `articles`, `articleByHandle` |
| `shopify.wishlist`    | `init`, `add`, `remove`, `toggle`, `has`, `list`, `count`, `clear`, `refresh`, `onChange` |
| `shopify.alerts`      | `message`, `setMessages`, `patchMessages`, `setPolicy` — see [Alerts & Toasts](#alerts--toasts) |

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
import { ShopifyProvider, useShopify, useCart, useWishlist } from '@apptile/sdk-shopify/react';
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
const { items, count, toggle, has } = useWishlist();
const { loggedIn, login, logout } = useCustomer();
```

`react` is an **optional** peer dep — install it only if you use the `/react` subpath.

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
import {shopify, centsToMoney} from '@apptile/sdk-shopify';

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
import {useTileCredit} from '@apptile/sdk-shopify/react';

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
} from '@apptile/sdk-shopify';
```

## License

MIT
