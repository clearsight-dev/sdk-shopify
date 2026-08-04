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
  };
  /** Present only when the store has enrolled this variant for pre-order. */
  sellingPlan: SellingPlan | null;
}

export interface ShopifyVariantsAPI {
  /** Anything unreadable — deleted, or invisible to the token — is dropped, not returned as a hole. */
  byIds(ids: string[], opts?: { batchSize?: number }): Promise<StandaloneVariant[]>;
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
}

export interface CartLine {
  id: string;            // line GID
  quantity: number;
  merchandise: ProductVariant;
  attributes: CartLineAttribute[];
  /** Needed to render a name and link back to the PDP — `merchandise.title` is only the option value. */
  product: { id: string; title: string; handle: string } | null;
  cost: {
    totalAmount: Money;
    amountPerQuantity: Money;
    compareAtAmountPerQuantity: Money | null;
  };
}

export interface CartDiscountCode {
  code: string;
  applicable: boolean;
}

/** One gift card applied to a cart. Pass `.id` to `cartGiftCardCodesRemove`
 *  when removing (NOT the raw code). See docs section 5.5. */
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
  lines: CartLine[];
  cost: CartCost;
  discountCodes: CartDiscountCode[];
  /** Gift cards applied to this cart. Empty when none. Populated by
   *  cartGiftCardCodesUpdate/Remove; also included on plain `cart.get`. */
  appliedGiftCards: AppliedGiftCard[];
  createdAt: string;
  updatedAt: string;
}

export interface CartLineAttribute {
  key: string;
  value: string;
}

export interface CartLineInput {
  merchandiseId: string; // ProductVariant GID
  quantity: number;
  attributes?: CartLineAttribute[];
  /** SellingPlan GID. Passing it is what makes checkout authorise rather than capture. */
  sellingPlanId?: string;
}

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
   * merged into an existing line for the same variant, so it yields a line per add.
   */
  beforeAdd?(input: CartLineInput): MaybePromise<CartLineInput | null>;
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
  /** `rejected` means the guard approved the write and Shopify refused it, so nothing was held. */
  reason: 'decreased' | 'removed' | 'rejected';
  /** The line as it was before the write. Null for a rejected add, which never became one. */
  line: CartLine | null;
  cart: Cart | null;
}

export type MaybePromise<T> = T | Promise<T>;

// Customer

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

export type TileCreditErrorCode =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'validation'
  | 'conflict' | 'insufficient_balance' | 'shopify_upstream'
  | 'rate_limited' | 'internal' | 'network';

/** Normalized error class. Branch on `.code`, not `.message`.
 *  See docs section 7.1 for the taxonomy and UX guidance. */
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
  /** Cloud Run URL, no trailing slash. */
  baseUrl: string;
  /** `shcat_…` (Customer Accounts API) OR classic Storefront customer token. */
  customerAccessToken: string;
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
  /** Ledger + gift-cards joined into one history feed. See docs §4.6.
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
  byHandle(handle: string): Promise<Product | null>;
  byId(id: string): Promise<Product | null>;
  /**
   * Resolves product GIDs in the order given, batched to stay under Shopify's query cost cap.
   * Anything that does not resolve is dropped rather than returned as a hole.
   */
  byIds(ids: string[], opts?: { batchSize?: number; keepMissing?: false }): Promise<Product[]>;
  /** As above, but keeps a positional `null` so the result lines up index-for-index with `ids`. */
  byIds(
    ids: string[],
    opts: { batchSize?: number; keepMissing: true }
  ): Promise<(Product | null)[]>;
  /**
   * Uses the `search` root rather than `products(query:)`, so the result also carries `totalCount`
   * and `filters`. `sortKey` is `SearchSortKeys` — only `RELEVANCE` or `PRICE`, anything else
   * throws; use `list({ query })` for the full `ProductSortKeys` set.
   */
  search(query: string, opts?: Omit<ListOptions, 'query'>): Promise<Connection<Product>>;
  recommended(productId: string): Promise<Product[]>;
}

export interface ShopifyCollectionsAPI {
  list(opts?: ListOptions): Promise<Connection<Collection>>;
  byHandle(handle: string): Promise<Collection | null>;
  products(handle: string, opts?: ListOptions): Promise<Connection<Product>>;
}

export interface ShopifyCartAPI {
  create(input?: { lines?: CartLineInput[]; discountCodes?: string[] }): Promise<Cart>;
  /** Null if the cart expired. */
  get(cartId: string): Promise<Cart | null>;
  addLines(cartId: string, lines: CartLineInput[]): Promise<Cart>;
  updateLines(cartId: string, lines: CartLineUpdateInput[]): Promise<Cart>;
  removeLines(cartId: string, lineIds: string[]): Promise<Cart>;
  applyDiscountCodes(cartId: string, codes: string[]): Promise<Cart>;
  setBuyerIdentity(
    cartId: string,
    identity: { email?: string; countryCode?: string; customerAccessToken?: string }
  ): Promise<Cart>;
  /** Apply one or more gift-card codes to a cart. Idempotent per code.
   *  Requires `buyerIdentity.countryCode` on the cart — Shopify rejects
   *  gift cards with `INVALID_PAYMENT` otherwise. Callers should set the
   *  country first (see `setBuyerIdentity` / shop default via `shop.load`). */
  applyGiftCardCodes(cartId: string, codes: string[]): Promise<Cart>;
  /** Remove gift cards by their AppliedGiftCard.id (NOT the raw code). */
  removeGiftCardCodes(cartId: string, appliedGiftCardIds: string[]): Promise<Cart>;
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
  logout(accessToken: string): Promise<void>;
  profile(accessToken: string): Promise<Customer | null>;
  recoverPassword(email: string): Promise<void>;
  updateProfile(
    accessToken: string,
    patch: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone' | 'acceptsMarketing'>>
  ): Promise<Customer>;
  orders(accessToken: string, opts?: ListOptions): Promise<Connection<Order>>;
  orderById(accessToken: string, orderId: string): Promise<Order | null>;
}

export interface ShopifyBlogsAPI {
  list(opts?: ListOptions): Promise<Connection<Blog>>;
  byHandle(handle: string): Promise<Blog | null>;
  articles(blogHandle: string, opts?: ListOptions): Promise<Connection<Article>>;
  articleByHandle(blogHandle: string, articleHandle: string): Promise<Article | null>;
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
   * Hydrated by `init()` / `refresh()`. `undefined` = not fetched yet, `null` = no longer resolves
   * upstream (the entry is purged unless `keepDeleted` is set).
   */
  product?: Product | null;
}

export interface WishlistInitOptions {
  /** Defaults to `window.localStorage` on web, no-op elsewhere. */
  storage?: WishlistStorageAdapter;
  /** Defaults to `tile:shopify:wishlist:v1`. */
  storageKey?: string;
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
   * Tile Credit — customer wallet + gift-card mint + cart apply.
   * Configure once per customer session; see `TileCreditClient` docs
   * for the full flow. `null` until `shopify.tileCredit.configure(...)`.
   */
  tileCredit: {
    /** Bind a customer session to Tile Credit. Rebuild the client on
     *  logout / new customer. Safe to call multiple times — it replaces
     *  the underlying client instance. */
    configure(config: TileCreditConfig): TileCreditAPI;
    /** The active client, or `null` when `configure` hasn't been called. */
    client(): TileCreditAPI | null;
    /**
     * Redeem then apply to a Shopify cart in one call — mints a gift card,
     * ensures the cart has a `buyerIdentity.countryCode` (belt + suspenders
     * even if already set), and applies the code. Returns the mint result
     * AND the updated cart. Docs section 5.7.
     */
    redeemAndApplyToCart(opts: {
      cartId: string;
      amountCents: number;
      /** Persist BEFORE the call for crash-safe retries. Auto-generated
       *  if omitted (loses that guarantee — see docs section 8). */
      idempotencyKey?: string;
      reason?: string;
      /** ISO country to set on the cart if missing. Defaults to the
       *  shop's `localization.country.isoCode`. */
      countryFallback?: string;
    }): Promise<{ redeemed: TileCreditRedeemResult; cart: Cart }>;
  };
}
