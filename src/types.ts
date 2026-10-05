import type { RequestCacheOptions } from './requestCache';
// Setup

export interface ShopifyConfig {
  /** e.g. `mystore.myshopify.com`, without protocol. */
  storeDomain: string;
  /** Public Storefront API token — safe to ship in client code. */
  storefrontAccessToken: string;
  /** e.g. `2024-10`. */
  apiVersion?: string;
  /** For IP-localized prices. Default `US`. */
  country?: string;
  /** BCP-47. Default `EN`. */
  language?: string;
  /**
   * Copy for the alerts the editor's Settings panel configures. Unset keys fall
   * back to `translate`, then to the SDK defaults — see `messages.ts`.
   */
  messages?: AlertMessages;
  /**
   * Resolves an i18n key, e.g. the Translations workspace's
   * `toast.added_to_cart`. Consulted only for keys `messages` does not set.
   */
  translate?: MessageResolver;
  /** Cart rules the SDK enforces before it writes. */
  cart?: CartPolicy;
  /**
   * Product metafields to fetch alongside every product, read back as `product.metafields`.
   * Each needs a Shopify metafield definition with storefront read access, or it comes back empty.
   */
  productMetafields?: MetafieldIdentifier[];
  /**
   * Reuse of recent catalogue answers (memory only). Identical requests in flight are always shared.
   * `false` turns reuse off; `{ ttl: { CollectionProducts: 0 } }` changes one operation's time.
   * Defaults: `DEFAULT_CACHE_TTL_MS`.
   */
  cache?: false | RequestCacheOptions;
  /**
   * Image transforms for the reads `ShopifyProvider` makes itself, which no app call can pass one to:
   * the cart it keeps (line thumbnails) and the wishlist it rehydrates. Omitted: original URLs.
   * A transform passed to a call directly (`cart.get(id, { imageTransform })`) wins.
   */
  imageTransforms?: { cart?: ImageTransform; wishlist?: ImageTransform; waitlist?: ImageTransform };
}

/**
 * Shopify's server-side image transform (`Image.url(transform:)`): resize, crop and convert on the
 * CDN, so a grid downloads the size it shows. Every call that returns images takes one as
 * `imageTransform`; omitted, URLs are the originals, exactly as before. `width`/`height` on an image
 * stay the original's dimensions either way.
 */
export interface ImageTransform {
  /** Largest width in px. Never upscales past the original. */
  maxWidth?: number;
  /** Largest height in px. Never upscales past the original. */
  maxHeight?: number;
  /** Where to crop when both bounds are set and the aspect differs. */
  crop?: 'CENTER' | 'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT';
  /** Pixel-density multiplier, 1–3: `{ maxWidth: 330, scale: 2 }` is 660 px for a 330 pt slot. */
  scale?: number;
  /** Convert, e.g. `'WEBP'` for smaller files. Shopify falls back if it can't. */
  preferredContentType?: 'WEBP' | 'JPG' | 'PNG';
}

/** The `imageTransform` option, for calls without a `ListOptions`. */
export interface ImageOptions {
  imageTransform?: ImageTransform;
}

export interface MetafieldIdentifier {
  namespace: string;
  key: string;
}

// Alerts — the Settings panel's "Alerts & Toasts"

/**
 * One key per configurable alert. These are the contract with the editor: the
 * Settings panel writes this shape, so the field order here mirrors the panel's
 * Cart / Wishlist / Login / Checkout groups.
 */
export type AlertMessageKey =
  | 'cart.added'
  | 'cart.removed'
  | 'cart.limitExceeded'
  | 'cart.noMoreStock'
  | 'cart.outOfStock'
  | 'wishlist.added'
  | 'wishlist.removed'
  | 'wishlist.empty'
  | 'waitlist.added'
  | 'auth.loginSuccess'
  | 'auth.loginFailed'
  | 'auth.loggedOut'
  | 'auth.resetLinkSent'
  | 'checkout.orderPlaced'
  | 'checkout.paymentFailed';

export type AlertMessages = Partial<Record<AlertMessageKey, string>>;

/** `(key, fallback) => string`. Returning `''` or throwing keeps the fallback. */
export type MessageResolver = (key: string, fallback: string) => string;

export interface CartPolicy {
  /**
   * Most DISTINCT lines a cart may hold — the panel's "Cart Line Item Maximum
   * Limit". Counts lines, not units, so quantity 30 of one variant is one line.
   * Omit for no limit.
   */
  maxLineItems?: number;
}

// Money / images

export interface Money {
  /** Decimal string, e.g. `"19.99"`. */
  amount: string;
  /** ISO 4217 code, e.g. `USD`. */
  currencyCode: string;
}

export interface Image {
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

export type ProductMediaKind = 'image' | 'video' | 'external-video' | 'model-3d';

/**
 * One media item with its URLs resolved, so a gallery does not have to know Shopify's
 * `MediaImage | Video | ExternalVideo | Model3d` union.
 */
export interface ProductMedia {
  id: string;
  kind: ProductMediaKind;
  alt: string | null;
  /** Still frame — Shopify provides one for videos too, so it doubles as a poster. */
  posterUrl: string | null;
  /**
   * The still's original size in px (its shape, whatever `imageTransform` asked for). Null when
   * Shopify has none, or the product came from a cache written before these were stored.
   */
  width: number | null;
  height: number | null;
  /** Playable file for `Video`; null for images and external video. */
  videoUrl: string | null;
  /** YouTube/Vimeo embed for `ExternalVideo`; null otherwise. */
  embeddedUrl: string | null;
}

// Products & variants

export interface ProductOption {
  id: string;
  name: string;          // e.g. "Size"
  values: string[];      // e.g. ["S", "M", "L"]
}

export interface ProductSelectedOption {
  name: string;
  value: string;
}

export interface ProductVariant {
  id: string;            // GID, e.g. `gid://shopify/ProductVariant/123`
  title: string;
  sku: string | null;
  availableForSale: boolean;
  quantityAvailable: number | null;
  price: Money;
  compareAtPrice: Money | null;
  selectedOptions: ProductSelectedOption[];
  image: Image | null;
  /**
   * The pre-order plan the store enrolled this variant in (its first selling-plan allocation), or
   * null when it has none. Add with `sellingPlanId: sellingPlan.id` to pre-order it. Set by every
   * product read (products, collections, search, recommendations, `byIds`) and by `variants.byIds`;
   * absent on a cart line's `merchandise` (the line has `sellingPlanId`), hence optional.
   */
  sellingPlan?: Pick<SellingPlan, 'id' | 'name'> | null;
}

/** A pre-order/deferred-payment plan the store has enrolled a variant in. */
export interface SellingPlan {
  id: string;
  name: string;
  /** What is still owed after the deposit, when the plan defers part of the payment. */
  remainingBalance: string | null;
  currencyCode: string | null;
}

/** A variant resolved on its own, carrying enough of its parent product to render a card. */
export interface StandaloneVariant extends ProductVariant {
  product: {
    id: string;
    title: string;
    handle: string;
    featuredImage: Image | null;
    hasVideo: boolean;
    /**
     * The product's tags, e.g. for an app's `isBlocked` rule (an auction's `SEARCH-BLOCKED`) on a waitlist
     * card (`waitlistActionFor`; SDK move 6). Missing on a variant stored before 0.10 read it, until the
     * list reads it again.
     */
    tags?: string[];
  };
  /** Present only when the store has enrolled this variant for pre-order. */
  sellingPlan: SellingPlan | null;
}

export interface ShopifyVariantsAPI {
  /** Anything unreadable — deleted, or invisible to the token — is dropped, not returned as a hole. */
  byIds(ids: string[], opts?: { batchSize?: number } & ImageOptions): Promise<StandaloneVariant[]>;
}

export interface Product {
  id: string;            // GID
  handle: string;        // url-safe slug
  title: string;
  description: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  totalInventory: number | null;
  availableForSale: boolean;
  priceRange: { min: Money; max: Money };
  compareAtPriceRange: { min: Money; max: Money } | null;
  options: ProductOption[];
  variants: ProductVariant[];
  images: Image[];
  featuredImage: Image | null;
  /** Null unless the product is published to the Online Store channel, so needs a fallback. */
  onlineStoreUrl: string | null;
  /** Every media item's `mediaContentType`, in Shopify's order. The media itself is not fetched. */
  mediaContentTypes: string[];
  hasVideo: boolean;
  /**
   * Media with URLs resolved, in gallery order (videos → images → 3D models) rather than Shopify's.
   * **Populated only by `products.list`, `byHandle` and `byId`** — the card paths fetch content
   * types without the URLs, so this is `[]` there while `hasVideo` still holds.
   */
  media: ProductMedia[];
  /**
   * The metafields named by `ShopifyConfig.productMetafields`, keyed `namespace.key` — e.g.
   * `product.metafields['custom.badge_text']`. Empty when none are configured, and a metafield the
   * product doesn't carry (or whose definition denies storefront access) is simply absent.
   */
  metafields: Record<string, string>;
  /** ISO 8601. */
  updatedAt: string;
  createdAt: string;
}

// Collections

export interface Collection {
  id: string;
  handle: string;
  title: string;
  description: string;
  descriptionHtml: string;
  image: Image | null;
  /** Number of products. Populated when listing collections. */
  productsCount?: number;
}

// Cart

export interface CartCost {
  subtotalAmount: Money;
  totalAmount: Money;
  totalTaxAmount: Money | null;
  /**
   * What checkout will actually charge NOW, which is not always the total: a deferred-payment
   * product (a pre-order deposit, a subscription's first charge) leaves the rest due later. Equal to
   * `totalAmount` on an ordinary cart.
   *
   * Optional rather than required even though Shopify declares it non-null, so a caller that reads
   * it is forced to handle the cart that was fetched before this field was added to the fragment.
   */
  checkoutChargeAmount?: Money | null;
}

export interface CartLine {
  id: string;            // line GID
  quantity: number;
  merchandise: ProductVariant;
  attributes: CartLineAttribute[];
  /** SellingPlan GID the line was added under; null for a one-off purchase. */
  sellingPlanId: string | null;
  /**
   * The plan the line was bought on (a pre-order), with what checkout takes now and what is left to
   * pay later, for the whole line; null for a one-off purchase. Optional, as a cart read before the
   * SDK asked for it has none: treat a missing amount as unknown, never as zero.
   */
  sellingPlan?: CartLineSellingPlan | null;
  /** Needed to render a name and link back to the PDP — `merchandise.title` is only the option value. */
  product: { id: string; title: string; handle: string } | null;
  cost: {
    totalAmount: Money;
    amountPerQuantity: Money;
    compareAtAmountPerQuantity: Money | null;
  };
}

/**
 * A cart line's selling plan and how its payment splits. For a pre-authorize plan, checkout takes
 * nothing (`checkoutCharge` is 0) and the whole price is charged later (`remainingBalance`).
 *
 * Both amounts are for the whole line. Shopify answers them per unit (checked 2026-10-05 on a line
 * of 2 at $250 on a pre-authorize plan: $0 and $250), so the SDK multiplies them by the quantity.
 */
export interface CartLineSellingPlan {
  id: string;
  name: string;
  /** What checkout charges for the line now. Null when Shopify didn't say. */
  checkoutCharge: Money | null;
  /** What is charged for the line later (when it ships, for a pre-order). Null when Shopify didn't say. */
  remainingBalance: Money | null;
}

export interface CartDiscountCode {
  code: string;
  applicable: boolean;
}

/** One gift card applied to a cart. Pass `.id` to `cartGiftCardCodesRemove`
 *  when removing (NOT the raw code). */
export interface AppliedGiftCard {
  id: string;
  lastCharacters: string;
  /** Amount deducted from THIS cart's total by this card. */
  presentmentAmountUsed: Money;
  /** Card's remaining balance after this apply. */
  balance: Money;
  /** Historical total consumed across all applies. */
  amountUsed: Money;
}

export interface Cart {
  id: string;            // cart GID
  /** Shopify-hosted checkout URL — open in a webview to complete purchase. */
  checkoutUrl: string;
  totalQuantity: number;
  /**
   * The shopper's order note, carried through to the order. Null when none has been set — Shopify
   * reports that as `''`, normalized here so "no note" is one value rather than two.
   */
  note: string | null;
  /**
   * Cart-level metadata, carried onto the order as `customAttributes`. Distinct from a line's
   * `attributes`: these describe the cart rather than one item, and are what a discount function
   * or an order webhook can key on. Empty when none have been set.
   */
  attributes: CartAttribute[];
  /**
   * The market and contact this cart is priced for. **`countryCode` is what fixes its currency**, and
   * it is set when the cart is created — `@inContext` on a later read does not move it.
   */
  buyerIdentity: { countryCode: string | null; email: string | null; phone: string | null };
  lines: CartLine[];
  cost: CartCost;
  discountCodes: CartDiscountCode[];
  /** Gift cards applied to this cart. Empty when none. Populated by
   *  cartGiftCardCodesUpdate/Remove; also included on plain `cart.get`. */
  appliedGiftCards: AppliedGiftCard[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A key/value pair on a cart or on one of its lines.
 *
 * Cart-level pairs ride through to the order as its `customAttributes`, which is where a Shopify
 * Function or an order webhook reads them. That makes them load-bearing rather than decorative:
 * an app-only discount that gates on one is simply not applied when it is missing, and the
 * shopper sees the code rejected with no indication why.
 */
export interface CartAttribute {
  key: string;
  value: string;
}

/** The same pair, named for its line-scoped use. Kept so existing imports keep resolving. */
export type CartLineAttribute = CartAttribute;

export interface CartLineInput {
  merchandiseId: string; // ProductVariant GID
  quantity: number;
  attributes?: CartLineAttribute[];
  /** SellingPlan GID. Passing it is what makes checkout authorise rather than capture. */
  sellingPlanId?: string | null;
  /**
   * The most of this variant the cart may hold, usually its stock (`stockCeiling(variant)`). Checked
   * before the write, because Shopify answers 200 to an add past the stock level and clamps it
   * silently. A refusal is `reason: 'stock'` with the `cart.noMoreStock` alert. Never sent to Shopify.
   * Omitted or null: no ceiling.
   */
  maxQuantity?: number | null;
}

/** What a cart line needs to be re-created on a new cart — see `toLineSnapshot`. */
export type CartLineSnapshot = {
  merchandiseId: string;
  quantity: number;
  sellingPlanId: string | null;
  attributes: { key: string; value: string }[];
};

export interface CartLineUpdateInput {
  /** Existing CartLine.id */
  id: string;
  quantity: number;
  attributes?: CartLineAttribute[];
}

/**
 * A policy layer over cart writes — vetoes or decorates a line before it is sent, and hears what
 * landed and what left. Written for stock reservation, but a gift-with-purchase or bundling rule
 * fits the same shape. Advisory only: a `before*` hook that throws counts as approval.
 */
export interface CartLineGuard {
  /**
   * Return the input, optionally decorated, to proceed; `null` to cancel. A decorated add is not
   * merged into an existing line for the same variant, so it yields a line per add. The returned
   * `quantity` is what is added (a guard may lower it to the stock it could reserve).
   *
   * `options.quiet`: the caller reports the outcome itself (Buy again's one summary), so the guard
   * should say nothing about a refusal. It still decides as usual. Set by `addLines(inputs, { quiet })`.
   */
  beforeAdd?(input: CartLineInput, options?: { quiet?: boolean }): MaybePromise<CartLineInput | null>;
  /** Only increases are offered — a decrease is reported through `onReleased` instead. */
  beforeIncrease?(line: CartLine, nextQuantity: number): MaybePromise<CartLineUpdateInput | null>;
  /** Reporting only; cannot affect the cart. */
  onLanded?(event: CartLineLandedEvent): void;
  /** Units the cart no longer holds — one place for a guard to give reserved stock back. */
  onReleased?(event: CartLineReleasedEvent): void;
}

export interface CartLineLandedEvent {
  variantId: string;
  quantity: number;
  /** Null when the line could not be identified in the returned cart. */
  line: CartLine | null;
  cart: Cart;
}

export interface CartLineReleasedEvent {
  variantId: string;
  /** How many units left the cart. For a removal, the whole line. */
  quantity: number;
  /**
   * `rejected`: the guard approved the write and it didn't land (Shopify refused it, the cart limit
   * refused it, or the cart couldn't be created), so whatever the guard reserved for it goes back.
   */
  reason: 'decreased' | 'removed' | 'rejected';
  /**
   * The line as it was before the write. For a rejected increase, the line that was to grow; null
   * for a rejected add, which never became one.
   */
  line: CartLine | null;
  /** A rejected add: the input as the guard approved it, with any attributes it added (its receipt). */
  input?: CartLineInput;
  cart: Cart | null;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * Why a cart write did not land. `guard` is a `cartGuard` veto, `limit` the
 * `maxLineItems` policy, `outOfStock` Shopify refusing an unsellable line.
 * `no-cart` means there was nothing to write to.
 */
/** `stock`: the add would pass the variant's stock (`CartLineInput.maxQuantity`), checked before the write. */
export type CartRejectionReason = 'guard' | 'limit' | 'stock' | 'outOfStock' | 'no-cart';

/**
 * The outcome of a cart write. Returned instead of a bare boolean so a caller
 * can tell a guard veto from a limit refusal — both used to read as `false` —
 * and can show `message` without owning a copy table.
 *
 * BREAKING from 0.1.x: `addLine` returned `boolean`. An object is always truthy,
 * so `if (await addLine(...))` no longer detects a refusal — check `.ok`.
 */
export interface CartWriteResult {
  ok: boolean;
  /** Absent when `ok`. */
  reason?: CartRejectionReason;
  /** Resolved alert copy for the outcome. Absent for a silent guard veto. */
  message?: string;
  /** The cart as it stands after the write — unchanged on a refusal. */
  cart: Cart | null;
}

// Customer

/**
 * Why a customer mutation failed, mapped from `customerUserErrors[].code`.
 * `unknown` covers transport failures and codes with no alert of their own.
 */
export type AuthFailureReason =
  | 'invalid-credentials'
  | 'email-taken'
  | 'invalid-input'
  | 'account-disabled'
  | 'unknown';

export interface Address {
  id?: string;
  firstName?: string;
  lastName?: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  country: string;
  zip: string;
  phone?: string;
}

export interface Customer {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  defaultAddress: Address | null;
  acceptsMarketing: boolean;
}

export interface CustomerAccessToken {
  accessToken: string;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

// Auth — the two ways a shopper signs in

/**
 * - `password`: email and password, Shopify's classic customer accounts (Storefront
 *   `customerAccessToken`). Also what an App Store reviewer signs in with: a review account needs a
 *   password, and Shopify's web sign-in sends a one-time code to an inbox the reviewer can't read.
 * - `shopify`: Shopify's hosted web sign-in, new customer accounts (Customer Account API, OAuth 2
 *   with PKCE, passwordless).
 */
export type AuthMethod = 'password' | 'shopify';

/** The app's Customer Account API client (Shopify admin → Settings → Customer accounts → Headless or Hydrogen). */
export interface CustomerAccountConfig {
  /** The number in `shopify.com/<shopId>/account`. */
  shopId: string;
  /** The client's id. Register the client as Public (mobile app): there is no secret, PKCE stands in for it. */
  clientId: string;
  /** Default `shop.<shopId>.app://callback`, the form Shopify allows for a mobile client. The app registers the scheme. */
  redirectUri?: string;
  /** Customer Account API version. Default: `ShopifyConfig.apiVersion`, else `2025-07`. */
  apiVersion?: string;
  /** Default `openid email customer-account-api:full`. */
  scopes?: string[];
  /** Language of Shopify's sign-in page (`ui_locales`), e.g. `fr`. */
  locale?: string;
}

/**
 * Where session tokens are kept. On a device, pass the keychain (expo-secure-store); AsyncStorage
 * is plain text on disk. Without one, the provider's `storage` is used.
 */
export interface SecureStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/**
 * Opens Shopify's sign-in page in the system browser sheet and resolves with the URL it redirected
 * to. expo-web-browser's `openAuthSessionAsync` fits as is:
 * `(url, redirectUri) => WebBrowser.openAuthSessionAsync(url, redirectUri, { preferEphemeralSession: true })`.
 * Any result but `success` with a `url` is the shopper backing out.
 */
export type OpenAuthSession = (url: string, redirectUri: string) => Promise<{ type: string; url?: string }>;

/** `n` cryptographically secure random bytes, e.g. expo-crypto's `getRandomBytes`. */
export type RandomBytes = (byteCount: number) => Uint8Array;

export interface AuthOptions {
  /**
   * Which sign-in the app offers now. It can change while the app runs (a Live Layer publish):
   * `password` while the app is in App Store review, `shopify` for shoppers. A shopper already
   * signed in stays signed in when it changes; `CustomerState.sessionKind` says which kind they have.
   */
  method: AuthMethod;
  /** Required for `shopify`. */
  customerAccount?: CustomerAccountConfig;
  secureStorage?: SecureStorageAdapter;
  /** Required for `customer.signIn()`, the system sheet. An in-app web view uses `customer.startSignIn()` instead. */
  openAuthSession?: OpenAuthSession;
  /** Required for `shopify`. Defaults to `crypto.getRandomValues` where the engine has it (web); Hermes doesn't. */
  random?: RandomBytes;
}

/**
 * A Shopify web sign-in in progress, for an app that shows the page in its own web view rather than
 * the system sheet: load `url`, and when the web view is about to load a URL for which
 * `isCallback(url)` is true, stop it and pass that URL to `finish`.
 */
export interface SignInAttempt {
  url: string;
  redirectUri: string;
  isCallback(url: string): boolean;
  /** Signs in. `false` when Shopify refused it (`auth:loginFailed` fires) or this attempt is stale. Throws when the store can't be reached. */
  finish(callbackUrl: string): Promise<boolean>;
  /** The shopper closed the web view. Later `finish` calls return false. */
  cancel(): void;
}

/** Where the shopper's store credit comes from: chosen per app on `ShopifyProvider`. */
export interface StoreCreditOptions {
  /**
   * - `shopify`: Shopify's own store credit (`storeCreditAccounts`). Readable only through the
   *   Customer Account API, so only for a `shopify` sign-in.
   * - `tile`: Tile Credit, the tile-credit service's wallet. Works with either sign-in.
   */
  source: 'shopify' | 'tile';
  /** Tile Credit service URL. Default `https://tile-credit.apptile.io`. */
  tileCreditBaseUrl?: string;
}

/**
 * Where store credit stands on the cart (`useCartStoreCredit().status`):
 * - `hidden`: nothing to show: no store credit chosen, signed out, or a source this session can't read.
 * - `loading`: the balance is being read for the first time.
 * - `ready`: the balance is known and none of it is on the cart: `apply` can run.
 * - `applying`: an `apply` is on its way.
 * - `applied`: the app's card is on the cart: `remove` can run.
 * - `removing`: a `remove` is on its way.
 * - `atCheckout`: Shopify's store credit, which only Shopify's checkout can take: no actions.
 * - `error`: the balance couldn't be read (`error` says why); `refresh` tries again.
 */
export type CartStoreCreditStatus =
  | 'hidden'
  | 'loading'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'removing'
  | 'atCheckout'
  | 'error';

/**
 * What a line of store-credit history was, the same words for either source, so a screen words each
 * one itself (`useStoreCreditHistory`).
 *
 * - `signupBonus`, `liveShowReward`, `orderReward`: Tile Credit's own grants.
 * - `addedByStore`, `removedByStore`: the store changed the balance by hand.
 * - `spent`: used at checkout. `refunded`: given back (a refund to store credit, or a payment that
 *   was voided). `expired`: credit that ran out.
 * - `added`, `removed`: anything else, by which way it moved the balance.
 */
export type StoreCreditEntryKind =
  | 'signupBonus'
  | 'liveShowReward'
  | 'orderReward'
  | 'addedByStore'
  | 'removedByStore'
  | 'spent'
  | 'refunded'
  | 'expired'
  | 'added'
  | 'removed';

/** One line of the shopper's store-credit history, from either source. */
export interface StoreCreditEntry {
  /** Unique within the history. */
  id: string;
  kind: StoreCreditEntryKind;
  /** True when it added to the balance; false when it took from it. */
  isCredit: boolean;
  /** How much, never negative: `isCredit` says which way it went. */
  amount: Money;
  /** ISO 8601. */
  createdAt: string;
  /** When this credit runs out; null when it doesn't, or for a line that took credit away. */
  expiresAt: string | null;
  /**
   * The store's own words for a change it made by hand (Tile Credit's `reason`), when they read as a
   * sentence; null for everything else, and always for Shopify's store credit, which has none.
   */
  note: string | null;
  /** The order it came from, as the shopper knows it (`#1043`), when the source names it. */
  orderName: string | null;
}

// Orders

export interface OrderLineItem {
  title: string;
  quantity: number;
  variant: ProductVariant | null;
  originalTotalPrice: Money;
  discountedTotalPrice: Money;
}

export interface Order {
  id: string;             // GID
  orderNumber: number;
  name: string;           // e.g. "#1001"
  processedAt: string;    // ISO 8601
  fulfillmentStatus: string | null;
  financialStatus: string | null;
  statusUrl: string;
  totalPrice: Money;
  subtotalPrice: Money | null;
  totalShippingPrice: Money;
  totalTax: Money | null;
  totalRefunded: Money;
  currencyCode: string;
  email: string | null;
  phone: string | null;
  shippingAddress: Address | null;
  lineItems: OrderLineItem[];
}

/**
 * Where an order has got to, for a status badge. Cancelled wins over everything; otherwise it follows
 * Shopify's fulfilment status: `FULFILLED`, `PARTIALLY_FULFILLED`, and every other value (unfulfilled,
 * on hold, scheduled, …) reads as `confirmed`.
 */
export type OrderProgress = 'confirmed' | 'partiallyFulfilled' | 'fulfilled' | 'cancelled';

/**
 * One past order, as `useOrders` lists it, the same for both sign-ins: Shopify's sign-in reads the
 * Customer Account API, email and password the Storefront API.
 */
export interface OrderSummary {
  /** GID. Pass it to `useOrder`. */
  id: string;
  /** As the shopper knows it, e.g. `#1001`. */
  name: string;
  /** ISO 8601. */
  processedAt: string;
  progress: OrderProgress;
  /** ISO 8601; null unless cancelled. */
  cancelledAt: string | null;
  totalPrice: Money;
  /** Units ordered (the quantities added up). A list row counts the first 30 lines of an order. */
  itemCount: number;
  /** Shopify's order status page: tracking, addresses and returns. */
  statusPageUrl: string | null;
}

/** One line of an order, as bought. */
export interface OrderLine {
  title: string;
  /** e.g. `S / Blush`; null for a product with one variant. */
  variantTitle: string | null;
  quantity: number;
  imageUrl: string | null;
  /** The price of one, before discounts. */
  unitPrice: Money | null;
  /** The line's total before discounts (`unitPrice` × `quantity`). */
  totalPrice: Money | null;
  /** For Buy again; null when the variant no longer exists. */
  variantId: string | null;
}

/**
 * One order in full, as `useOrder` reads it. Tracking, addresses and returns are on Shopify's status
 * page (`statusPageUrl`).
 *
 * The totals read like a receipt: `subtotal` is the items before discounts, and `subtotal` minus
 * `totalDiscount` is what Shopify charged for them. `totalDiscount`, `totalTax` and `totalRefunded`
 * are null when there is none, so a screen shows those rows only when they say something;
 * `totalShipping` keeps a zero, which is free shipping.
 */
export interface OrderDetails extends OrderSummary {
  lineItems: OrderLine[];
  /** The lines' totals before discounts. */
  subtotal: Money | null;
  totalShipping: Money | null;
  totalTax: Money | null;
  /** Every discount on the items, line and order level together. */
  totalDiscount: Money | null;
  totalRefunded: Money | null;
  /** The codes the shopper entered, e.g. `["WELCOME10"]`; automatic discounts have none. */
  discountCodes: string[];
}

// Blogs / Articles

export interface Blog {
  id: string;
  handle: string;
  title: string;
}

export interface ArticleAuthor {
  name: string;
  email: string | null;
  bio: string | null;
}

export interface Article {
  id: string;
  handle: string;
  title: string;
  content: string;
  contentHtml: string;
  excerpt: string | null;
  excerptHtml: string | null;
  publishedAt: string;
  tags: string[];
  image: Image | null;
  author: ArticleAuthor | null;
  blog: Blog;
}

// Pagination

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
  /** Facets valid for the current query. Populated ONLY by `collections.products`. */
  filters?: Filter[];
  /** Populated ONLY by `collections.products`, so a screen can title itself from the same request. */
  collection?: { handle: string; title: string };
  /** Every match, not just the loaded window. Populated ONLY by `products.search`. */
  totalCount?: number;
}

/** Never built by hand: `JSON.parse` a `FilterValue.input` string and pass the object here. */
export type ProductFilter = Record<string, unknown>;

/** One value inside a facet, e.g. "In stock", "$0–$50", "Color: Blue". */
export interface FilterValue {
  id: string;
  label: string;
  count: number;
  /** JSON string — `JSON.parse` it into a ProductFilter and pass it back. */
  input: string;
}

/** A facet returned by Storefront: Availability, Price, Product type, … */
export interface Filter {
  id: string;
  label: string;
  /** e.g. "LIST" (checkbox values) or "PRICE_RANGE". */
  type: string;
  values: FilterValue[];
}

export interface ListOptions {
  first?: number;        // default 20, max 250
  after?: string;        // pagination cursor
  query?: string;        // Storefront search syntax
  sortKey?: string;      // e.g. 'TITLE', 'PRICE', 'CREATED'
  reverse?: boolean;
  /** Honoured by `collections.products` and `products.search`; ignored by `products.list`. */
  filters?: ProductFilter[];
  /** Skip a recent cached answer and read from the network (pull-to-refresh). */
  fresh?: boolean;
  /** Resize/convert every image in the answer on Shopify's CDN. Omitted: original URLs. */
  imageTransform?: ImageTransform;
}

// ---------------------------------------------------------------------------
// Tile Credit — customer wallet + gift-card mint + cart apply
// ---------------------------------------------------------------------------

/** Summary of a customer's wallet. `expiringCents` is the amount that will
 *  expire within the tile-credit service's configured horizon. */
export interface TileCreditWallet {
  appId: string;
  customer: {
    shopifyCustomerGid: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  balanceCents: number;
  lifetimeEarnedCents: number;
  lifetimeRedeemedCents: number;
  expiringCents: number;
}

export type TileCreditLedgerType = 'earn' | 'redeem' | 'adjust' | 'expire';
export type TileCreditLedgerSource =
  | 'signup' | 'live-join' | 'order-fulfilled' | 'manual-grant'
  | 'manual-deduct' | 'redemption' | 'expiry-sweep';

export interface TileCreditLedgerEntry {
  id: string;
  type: TileCreditLedgerType;
  amountCents: number;
  currencyCode: string;
  reason: string | null;
  source: TileCreditLedgerSource;
  sourceRef: string | null;
  createdAt: string;
  expiresAt: string | null;
  giftCardGid: string | null;
  idempotencyKey: string | null;
}

export interface TileCreditLedgerPage {
  entries: TileCreditLedgerEntry[];
  /** Pass as `before` on the next call. `null` means end of history. */
  nextCursor: string | null;
}

export type TileCreditGiftCardStatus = 'active' | 'depleted' | 'expired' | 'disabled';

export interface TileCreditIssuedGiftCard {
  id: string;
  shopifyGiftCardGid: string;
  /** Last four of the card code — the full code is never stored server-side. */
  last4: string;
  initialAmountCents: number;
  currencyCode: string;
  createdAt: string;
  expiresAt: string | null;
  status: TileCreditGiftCardStatus;
  ledgerEntryId: string;
  redemptionAmountCents: number;
}

export interface TileCreditPublicConfig {
  currency: string;
  redemptionMinCents: number;
  /** `null` → no cap besides the wallet balance. */
  redemptionMaxCents: number | null;
}

export interface TileCreditRedeemInput {
  amountCents: number;
  /** Persist BEFORE the call so a retry after a network error returns the
   *  same code with `duplicate: true`. Auto-generated if omitted, but then
   *  you lose crash-safety. */
  idempotencyKey?: string;
  reason?: string;
}

export interface TileCreditRedeemResult {
  giftCardGid: string;
  /** Full code — returned exactly once per idempotencyKey. Show + copy
   *  immediately, or persist briefly if you need to retry a cart-apply. */
  code: string;
  last4: string;
  amountCents: number;
  currencyCode: string;
  expiresOn: string | null;
  ledgerEntryId: string;
  duplicate: boolean;
  balanceCents: number;
}

/**
 * What went wrong, from the service's HTTP status, plus one the cart adds:
 * - `unauthorized` (401): no token, a token the service refused even after one renewal, or a shop the
 *   service doesn't know. The SDK never signs the shopper out over it.
 * - `validation` (400): an amount under the store's minimum or over its maximum (`details.min`/`max`).
 * - `insufficient_balance` (402): more than the shopper has.
 * - `cart_refused`: the card was made, but Shopify didn't put it on the cart (it refused it, or
 *   answered without applying it). Nothing was charged: a card only reserves the credit.
 * - `network`: the service couldn't be reached, or took longer than `timeoutMs`.
 */
export type TileCreditErrorCode =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'validation'
  | 'conflict' | 'insufficient_balance' | 'shopify_upstream'
  | 'rate_limited' | 'internal' | 'network' | 'cart_refused';

/** Normalized error class. Branch on `.code`, not `.message`: the codes are on `TileCreditErrorCode`. */
export class TileCreditError extends Error {
  public readonly code: TileCreditErrorCode;
  public readonly status?: number;
  public readonly details?: Record<string, unknown>;
  constructor(code: TileCreditErrorCode, message: string, status?: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TileCreditError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface TileCreditConfig {
  /** The service, no trailing slash. Default `https://tile-credit.apptile.io`. */
  baseUrl?: string;
  /**
   * Called before every request for the shopper's token: `shcat_…` (Customer Account API) or a
   * classic Storefront customer token. Null means signed out: the call fails `unauthorized` without
   * reaching the service. `ShopifyProvider`'s `customer.getAccessToken` is one (it refreshes an
   * expiring token first).
   */
  getAccessToken?: () => Promise<string | null>;
  /**
   * Called once when the service answers 401, for a token renewed now even if the old one looked
   * valid; the request is then sent again with it. Null, or left out: no second try. It never signs
   * anyone out, as a 401 can also mean the service doesn't know the shop. `customer.renewAccessToken`
   * is one.
   */
  renewAccessToken?: () => Promise<string | null>;
  /**
   * A fixed token, for a caller that holds one itself. It goes stale and is never renewed: prefer
   * `getAccessToken`. One of the two is required.
   */
  customerAccessToken?: string;
  /** `{shop}.myshopify.com` — case-insensitive; lower-cased internally. */
  shopDomain: string;
  /** Cancels every in-flight request when aborted. */
  signal?: AbortSignal;
  /** Per-request timeout. Default 20_000ms. */
  timeoutMs?: number;
}

/** Ledger entry enriched with the masked gift-card info it links to (redeem
 *  rows only). Everything else — earn / adjust / expire — passes through
 *  with `card: null`. Produced by `TileCreditClient.getHistory()`, which
 *  fans-out ledger + list-gift-cards and joins by `giftCardGid`. */
export interface TileCreditHistoryEntry extends TileCreditLedgerEntry {
  card: {
    last4: string;
    status: TileCreditGiftCardStatus;
    expiresAt: string | null;
    initialAmountCents: number;
  } | null;
}

export interface TileCreditHistoryPage {
  entries: TileCreditHistoryEntry[];
  nextCursor: string | null;
}

export interface TileCreditAPI {
  getWallet(): Promise<TileCreditWallet>;
  getLedger(opts?: { limit?: number; before?: string }): Promise<TileCreditLedgerPage>;
  listGiftCards(): Promise<{ giftCards: TileCreditIssuedGiftCard[] }>;
  getConfig(): Promise<TileCreditPublicConfig>;
  redeem(input: TileCreditRedeemInput): Promise<TileCreditRedeemResult>;
  /** Ledger + gift-cards joined into one history feed.
   *  Note: this issues TWO requests (ledger + list-gift-cards) in parallel;
   *  use `getLedger` on its own if you don't need the card metadata. */
  getHistory(opts?: { limit?: number; before?: string }): Promise<TileCreditHistoryPage>;
}

// ---------------------------------------------------------------------------
// Errors

export interface UserError {
  field: string[] | null;
  message: string;
  code?: string;
}

export class ShopifyError extends Error {
  public readonly errors: UserError[];
  constructor(message: string, errors: UserError[] = []) {
    super(message);
    this.name = 'ShopifyError';
    this.errors = errors;
  }
}

// Top-level facade — namespace-shaped API surface

export interface ShopifyProductsAPI {
  list(opts?: ListOptions): Promise<Connection<Product>>;
  /** `fresh` skips a recent cached answer (the product page's background read). */
  byHandle(handle: string, opts?: { fresh?: boolean } & ImageOptions): Promise<Product | null>;
  byId(id: string, opts?: { fresh?: boolean } & ImageOptions): Promise<Product | null>;
  /**
   * Resolves product GIDs in the order given, batched to stay under Shopify's query cost cap.
   * Anything that does not resolve is dropped rather than returned as a hole.
   */
  byIds(ids: string[], opts?: { batchSize?: number; keepMissing?: false } & ImageOptions): Promise<Product[]>;
  /** As above, but keeps a positional `null` so the result lines up index-for-index with `ids`. */
  byIds(
    ids: string[],
    opts: { batchSize?: number; keepMissing: true } & ImageOptions
  ): Promise<(Product | null)[]>;
  /**
   * Uses the `search` root rather than `products(query:)`, so the result also carries `totalCount`
   * and `filters`. `sortKey` is `SearchSortKeys` — only `RELEVANCE` or `PRICE`, anything else
   * throws; use `list({ query })` for the full `ProductSortKeys` set.
   */
  search(query: string, opts?: Omit<ListOptions, 'query'>): Promise<Connection<Product>>;
  recommended(productId: string, opts?: ImageOptions): Promise<Product[]>;
}

export interface ShopifyCollectionsAPI {
  list(opts?: ListOptions): Promise<Connection<Collection>>;
  byHandle(handle: string, opts?: ImageOptions): Promise<Collection | null>;
  products(handle: string, opts?: ListOptions): Promise<Connection<Product>>;
}

export interface ShopifyCartAPI {
  /**
   * `attributes` and `buyerIdentity` are accepted HERE and not only afterwards because both are
   * read at moments a later write cannot reach: a discount function runs against the cart as it
   * stands, and `buyerIdentity.countryCode` fixes the cart's currency at creation and does not
   * move again.
   */
  create(input?: {
    lines?: CartLineInput[];
    discountCodes?: string[];
    attributes?: CartAttribute[];
    buyerIdentity?: {
      email?: string;
      phone?: string;
      countryCode?: string;
      customerAccessToken?: string;
    };
  }, opts?: ImageOptions): Promise<Cart>;
  /** Null if the cart expired. */
  get(cartId: string, opts?: ImageOptions): Promise<Cart | null>;
  addLines(cartId: string, lines: CartLineInput[], opts?: ImageOptions): Promise<Cart>;
  updateLines(cartId: string, lines: CartLineUpdateInput[], opts?: ImageOptions): Promise<Cart>;
  removeLines(cartId: string, lineIds: string[], opts?: ImageOptions): Promise<Cart>;
  applyDiscountCodes(cartId: string, codes: string[], opts?: ImageOptions): Promise<Cart>;
  setBuyerIdentity(
    cartId: string,
    identity: { email?: string; countryCode?: string; customerAccessToken?: string },
    opts?: ImageOptions
  ): Promise<Cart>;
  /**
   * REPLACES the cart's gift cards with `codes` (`cartGiftCardCodesUpdate`): any card already on the
   * cart and not in `codes` comes off. To add a card and keep the others, use `addGiftCardCodes`.
   * Needs `buyerIdentity.countryCode` on the cart.
   */
  applyGiftCardCodes(cartId: string, codes: string[], opts?: ImageOptions): Promise<Cart>;
  /**
   * Adds gift-card codes, keeping the cards already on the cart (`cartGiftCardCodesAdd`). Needs
   * `buyerIdentity.countryCode` on the cart.
   *
   * **Shopify can answer without applying a code, and without an error** (a code it doesn't know came
   * back with no `userErrors` and no warnings, checked on the Storefront API 2026-07): look for each
   * code's last characters in `appliedGiftCards` afterwards. `useCart().addGiftCardCodes` does, and
   * throws when one is missing.
   *
   * The mutation exists in every Storefront API version Shopify still serves: a request for an older
   * version than the oldest supported one is answered as that one (2024-01 to 2025-07 were all served
   * as 2025-10 on 2026-10-05, `x-shopify-api-version`), so no version check is needed.
   */
  addGiftCardCodes(cartId: string, codes: string[], opts?: ImageOptions): Promise<Cart>;
  /** Remove gift cards by their AppliedGiftCard.id (NOT the raw code). */
  removeGiftCardCodes(cartId: string, appliedGiftCardIds: string[], opts?: ImageOptions): Promise<Cart>;
  /**
   * Set the shopper's order note. `null` clears it — on the wire that is `''`, because Shopify's
   * argument is non-null and a cart with no note reads back as `''` rather than null.
   */
  updateNote(cartId: string, note: string | null, opts?: ImageOptions): Promise<Cart>;
  /**
   * Set the cart's attributes. Shopify REPLACES the whole set rather than merging, so pass every
   * pair that should survive, not just the one being changed.
   */
  updateAttributes(cartId: string, attributes: CartAttribute[], opts?: ImageOptions): Promise<Cart>;
}

export interface ShopifyCustomerAPI {
  signup(input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    acceptsMarketing?: boolean;
  }): Promise<{ customer: Customer; accessToken: CustomerAccessToken }>;
  login(input: { email: string; password: string }): Promise<CustomerAccessToken>;
  /** A fresh token for one that hasn't expired yet. Throws when Shopify won't renew it. */
  renew(accessToken: string): Promise<CustomerAccessToken>;
  logout(accessToken: string): Promise<void>;
  profile(accessToken: string): Promise<Customer | null>;
  recoverPassword(email: string): Promise<void>;
  updateProfile(
    accessToken: string,
    patch: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone' | 'acceptsMarketing'>>
  ): Promise<Customer>;
  orders(accessToken: string, opts?: ListOptions): Promise<Connection<Order>>;
  orderById(accessToken: string, orderId: string, opts?: ImageOptions): Promise<Order | null>;
}

export interface ShopifyBlogsAPI {
  list(opts?: ListOptions): Promise<Connection<Blog>>;
  byHandle(handle: string): Promise<Blog | null>;
  articles(blogHandle: string, opts?: ListOptions): Promise<Connection<Article>>;
  articleByHandle(blogHandle: string, articleHandle: string, opts?: ImageOptions): Promise<Article | null>;
}

// Wishlist (local-storage backed)

/**
 * Matches `window.localStorage` so web works out of the box; RN passes AsyncStorage. Async
 * implementations are fine — every call site awaits.
 */
export interface WishlistStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface WishlistItem {
  productId: string;
  /** Snapshot stored so the UI can render before the network round-trip. */
  basic: {
    handle?: string;
    title?: string;
    image?: string;
    price?: Money;
  };
  /** ms epoch. */
  addedAt: number;
  /**
   * The product as last fetched, stored with the entry so the list draws offline (images past the
   * first and the media list are not kept; `hasVideo` is). Updated by `add(product)` and `refresh()`.
   * `undefined` = never fetched (an entry saved by id, or one past the storage budget), `null` = no
   * longer resolves upstream (the entry is purged unless `keepDeleted` is set).
   */
  product?: Product | null;
}

export interface WishlistInitOptions {
  /** Defaults to `window.localStorage` on web, no-op elsewhere. */
  storage?: WishlistStorageAdapter;
  /**
   * Defaults to `tile:shopify:wishlist:v1`. An app moving from Apptile's engine passes its old key
   * (`<apptile app id>_WishlistProducts`): entries are read in either shape and written in one both
   * understand.
   */
  storageKey?: string;
  /**
   * Keys an earlier app kept its wishlist under, merged into `storageKey` once each and left as they
   * were. Entries not saved yet are added, newest first. Reads sdk-shopify's `{ productId, basic,
   * addedAt }` and Apptile's `{ id, handle }` (a numeric product id).
   */
  migrateFrom?: string[];
  /** Product IDs per hydration request. Default 100, near Shopify's query cost ceiling. */
  batchSize?: number;
  /** Default `true`. False for lazy hydration — call `refresh()` on your own schedule. */
  hydrateOnInit?: boolean;
  /**
   * Forwarded to the hydration `refresh()`. Worth setting for a shopper-facing wishlist: `null`
   * covers a merely *temporarily* unpublished product, which the default loses forever.
   */
  keepDeleted?: boolean;
}

export interface WishlistRefreshOptions {
  /**
   * Keeps entries whose product no longer resolves, as `product: null`, so the UI can show a "no
   * longer available" state. Default `false`: they are dropped from storage.
   */
  keepDeleted?: boolean;
}

/**
 * One size or colour a shopper is waiting on (sold out, or held in other carts), kept on the device
 * like the wishlist. Keyed by variant: you wait on a size, and pre-order is decided per variant.
 */
export interface WaitlistItem {
  /** The variant's GID: the list's key. */
  variantId: string;
  /** Known once the variant has been fetched: Apptile's engine stored only the product's handle. */
  productId?: string;
  productHandle?: string;
  /** ms epoch; 0 for an entry an earlier app stored without a date. */
  addedAt: number;
  /**
   * The variant as last fetched (stock, price, pre-order plan, its product's card fields), stored
   * with the entry so the list draws offline. `undefined` = never fetched, `null` = the store no
   * longer has it: kept, in case it comes back, for the screen to leave out.
   */
  variant?: StandaloneVariant | null;
}

/** Joining: a variant by id, with its fetched details when the caller has them. */
export interface WaitlistEntryInput {
  variantId: string;
  productId?: string;
  productHandle?: string;
  variant?: StandaloneVariant;
}

export interface WaitlistInitOptions {
  /** Defaults to `window.localStorage` on web, no-op elsewhere. */
  storage?: WishlistStorageAdapter;
  /**
   * Defaults to `tile:shopify:waitlist:v1`. An app moving from Apptile's engine passes its old key
   * (`<apptile app id>_WaitlistProducts`, entries `{ id, handle }`: the numeric variant id and the
   * product's handle).
   */
  storageKey?: string;
  /**
   * Keys an earlier app kept its waitlist under, merged into `storageKey` once each and left as they
   * were. Also reads `{ variantId, productId, addedAt }` (an ISO date or ms).
   */
  migrateFrom?: string[];
  /** Variant IDs per request. Default 100. */
  batchSize?: number;
  /** Default `true`. False for lazy fetching — call `refresh()` on your own schedule. */
  hydrateOnInit?: boolean;
}

export type WaitlistChangeListener = (items: WaitlistItem[]) => void;

export interface ShopifyWaitlistAPI {
  init(opts?: WaitlistInitOptions): Promise<WaitlistItem[]>;
  isReady(): boolean;
  /** Joins. Joining a variant already on the list moves it to the front, dated now. */
  add(entry: WaitlistEntryInput): Promise<WaitlistItem>;
  remove(variantId: string): Promise<boolean>;
  has(variantId: string): boolean;
  list(): WaitlistItem[];
  count(): number;
  clear(): Promise<void>;
  /** Fetches every variant again (stock, price, pre-order plan). Rejects, changing nothing, when it can't. */
  refresh(): Promise<WaitlistItem[]>;
  onChange(listener: WaitlistChangeListener): () => void;
}

export type WishlistChangeListener = (items: WishlistItem[]) => void;

export interface ShopifyWishlistAPI {
  init(opts?: WishlistInitOptions): Promise<WishlistItem[]>;
  isReady(): boolean;
  /** A `Product` has its snapshot extracted automatically; a raw id can carry one. */
  add(product: Product): Promise<WishlistItem>;
  add(productId: string, basic?: WishlistItem['basic']): Promise<WishlistItem>;
  /** True if the item was present. */
  remove(productId: string): Promise<boolean>;
  /** Returns the resulting membership. */
  toggle(product: Product): Promise<boolean>;
  toggle(productId: string, basic?: WishlistItem['basic']): Promise<boolean>;
  has(productId: string): boolean;
  /** Newest first. */
  list(): WishlistItem[];
  count(): number;
  clear(): Promise<void>;
  /** Re-fetches every product in `batchSize` chunks, so any count is fine. */
  refresh(opts?: WishlistRefreshOptions): Promise<WishlistItem[]>;
  /** Returns an unsubscribe function. */
  onChange(listener: WishlistChangeListener): () => void;
}

export interface ShopifyIntegration {
  /** Must be called before any other method. */
  init(config: ShopifyConfig): Promise<void>;
  isReady(): boolean;
  /** True for the mock build, false for the real Storefront-API one. */
  readonly isMock: boolean;

  products: ShopifyProductsAPI;
  variants: ShopifyVariantsAPI;
  collections: ShopifyCollectionsAPI;
  cart: ShopifyCartAPI;
  customer: ShopifyCustomerAPI;
  blogs: ShopifyBlogsAPI;
  wishlist: ShopifyWishlistAPI;
  waitlist: ShopifyWaitlistAPI;
  /** Money format and currency, loaded at init. */
  shop: {
    load(): Promise<{ moneyFormat: string | null; currencyCode: string | null }>;
    moneyFormat(): string | null;
    /** ISO country code from Storefront `localization.country.isoCode`
     *  (e.g. `"US"`). Cached after first call. Used as the country
     *  fallback when applying gift cards. */
    countryCode(): Promise<string | null>;
  };
  formatMoney(money: Money | null | undefined): string;
  /**
   * Alert copy + cart rules from the editor's Settings panel. `message()` is
   * what the SDK itself resolves with, exposed so a screen can label its own
   * UI (an empty-wishlist placeholder, say) from the same source.
   */
  alerts: {
    message(key: AlertMessageKey): string;
    /** Full swap — a cleared panel field falls back to the default. */
    setMessages(messages?: AlertMessages | null): void;
    /** Merge, for a Live Layer publish of a single field. */
    patchMessages(messages: AlertMessages): void;
    setPolicy(policy?: CartPolicy | null): void;
  };
  /**
   * Tile Credit without React: one client shared by whoever configures it. A React app uses
   * `useCartStoreCredit` and `useStoreCredit` instead, which build their own client from the
   * provider's session.
   */
  tileCredit: {
    /** Bind a customer session to Tile Credit. Pass `getAccessToken` (and `renewAccessToken`) so the
     *  token stays fresh; a fixed `customerAccessToken` needs a new `configure` for each token. Safe to
     *  call multiple times — it replaces the underlying client instance. */
    configure(config: TileCreditConfig): TileCreditAPI;
    /** The active client, or `null` when `configure` hasn't been called. */
    client(): TileCreditAPI | null;
    /**
     * @deprecated Use `useCartStoreCredit()`: it keeps one Apply at a time, finds its card on the cart
     * and writes through the provider's cart queue. Kept for callers without React.
     *
     * Mints a gift card and adds it to the cart, keeping the cart's other gift cards. The cart's
     * country is set only when it has none, with its email kept (and the shopper linked again when
     * `customerAccessToken` is passed). Throws `TileCreditError('cart_refused')` when Shopify didn't put
     * the card on the cart.
     */
    redeemAndApplyToCart(opts: {
      cartId: string;
      amountCents: number;
      /** The same key returns the same card, so a retry of one attempt never mints a second.
       *  Auto-generated if omitted. */
      idempotencyKey?: string;
      reason?: string;
      /** ISO country to set on the cart if it has none. Defaults to the
       *  shop's `localization.country.isoCode`. */
      countryFallback?: string;
      /** The signed-in shopper's token, so setting the country keeps the cart linked to them. */
      customerAccessToken?: string;
    }): Promise<{ redeemed: TileCreditRedeemResult; cart: Cart }>;
  };
}
