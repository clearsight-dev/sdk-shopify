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
const { ready, error, cart, wishlist } = useShopify();
const { addLine, itemCount, cart } = useCart();
const { items, count, toggle, has } = useWishlist();
```

`react` is an **optional** peer dep — install it only if you use the `/react` subpath.

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
