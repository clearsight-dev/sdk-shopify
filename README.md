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
| `shopify.products`    | `list`, `byHandle`, `byId`, `byIds`, `search`, `recommended` |
| `shopify.collections` | `list`, `byHandle`, `products` |
| `shopify.cart`        | `create`, `get`, `addLines`, `updateLines`, `removeLines`, `applyDiscountCodes`, `setBuyerIdentity`, `updateNote`, `updateAttributes` |
| `shopify.customer`    | `signup`, `login`, `logout`, `profile`, `updateProfile`, `recoverPassword`, `orders`, `orderById` |
| `shopify.metafields`  | `product`, `variant`, `collection`, `customer`, `order` |
| `shopify.blogs`       | `list`, `byHandle`, `articles`, `articleByHandle` |
| `shopify.wishlist`    | `init`, `add`, `remove`, `toggle`, `has`, `list`, `count`, `clear`, `refresh`, `onChange` |

### Metafields — read-only

Storefront won't enumerate a resource's metafields, so you pass the `{namespace, key}` pairs you want. Identifiers with nothing set are dropped from the result, so the array may be shorter than your input — and empty is a normal answer, not an error.

```ts
const fields = await shopify.metafields.variant(variantId, [
  { namespace: 'auction', key: 'winners' },
  { namespace: 'auction', key: 'allowedQty' },
]);
// value is always a string; `type` tells you how to read it
const winners = fields.find(f => f.key === 'winners');
if (winners?.type === 'json') JSON.parse(winners.value);
```

**Writing metafields is not possible here.** The Storefront API has no `metafieldsSet`; customer metafield writes need the Customer Account API, which is a separate endpoint and OAuth flow and is out of scope for this client.

### Cart note & attributes

Both are full replaces, mirroring the underlying mutations — read `cart.attributes` and spread it if you mean to add one rather than swap the set.

```ts
await shopify.cart.updateNote(cartId, 'Leave at the door');
await shopify.cart.updateNote(cartId, null);            // clears it
await shopify.cart.updateAttributes(cartId, [
  ...cart.attributes,
  { key: 'giftWrap', value: 'true' },
]);
```

### Escape hatch

`request()` runs any Storefront operation the SDK doesn't wrap, reusing the configured client — no second fetch layer, no second token store. `assertNoUserErrors` is exported alongside it so mutation payloads can be handled the way the built-in methods do.

```ts
import { request, assertNoUserErrors } from '@apptile/sdk-shopify';

const data = await request<{ shop: { name: string } }>('query { shop { name } }');
```

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

## Types

```ts
import type {
  Product, ProductVariant, ProductOption,
  Cart, CartLine, CartLineInput, CartLineUpdateInput,
  Collection, Customer, Order, Blog, Article,
  WishlistItem, WishlistStorageAdapter,
  ShopifyConfig, ShopifyIntegration,
  ShopifyError,
} from '@apptile/sdk-shopify';
```

## License

MIT
