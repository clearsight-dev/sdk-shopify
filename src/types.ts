/**
 * Shopify integration — public types.
 *
 * Mirror Shopify's Storefront API GraphQL types but with the bits we
 * actually use (and friendlier names).
 *
 * Storefront API reference:
 *   https://shopify.dev/docs/api/storefront
 */

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface ShopifyConfig {
  /** e.g. `mystore.myshopify.com` (without protocol). */
  storeDomain: string;
  /** Public Storefront API token (safe to ship in client code). */
  storefrontAccessToken: string;
  /** API version, e.g. `2024-10`. Defaults to a sane recent version. */
  apiVersion?: string;
  /** Country code for IP-localized prices (default `US`). */
  country?: string;
  /** BCP-47 language for localized product copy (default `EN`). */
  language?: string;
}

// ---------------------------------------------------------------------------
// Money / images
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Products & variants
// ---------------------------------------------------------------------------

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
  /** Updated/published timestamps as ISO 8601. */
  updatedAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export interface CartCost {
  subtotalAmount: Money;
  totalAmount: Money;
  totalTaxAmount: Money | null;
}

export interface CartLine {
  id: string;            // line GID
  quantity: number;
  merchandise: ProductVariant;
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

export interface Cart {
  id: string;            // cart GID
  /** Shopify-hosted checkout URL — open in a webview to complete purchase. */
  checkoutUrl: string;
  totalQuantity: number;
  lines: CartLine[];
  cost: CartCost;
  discountCodes: CartDiscountCode[];
  createdAt: string;
  updatedAt: string;
}

export interface CartLineInput {
  merchandiseId: string; // ProductVariant GID
  quantity: number;
  attributes?: { key: string; value: string }[];
}

export interface CartLineUpdateInput {
  /** Existing CartLine.id */
  id: string;
  quantity: number;
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Blogs / Articles
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
  /**
   * Available filter facets for the current query — populated ONLY by
   * `collections.products` (Storefront returns the facets valid for the
   * collection given the applied `filters`). Each value's `input` is a JSON
   * string you pass straight back in `ListOptions.filters`.
   */
  filters?: Filter[];
}

/**
 * A Storefront `ProductFilter` input. In practice you never build this by hand:
 * take a `FilterValue.input` string, `JSON.parse` it, and pass the objects here.
 */
export type ProductFilter = Record<string, unknown>;

/** One value inside a filter facet (e.g. "In stock", "$0–$50", "Color: Blue"). */
export interface FilterValue {
  id: string;
  label: string;
  count: number;
  /** JSON string — `JSON.parse` it into a ProductFilter and pass it back. */
  input: string;
}

/** A filter facet returned by Storefront (Availability, Price, Product type, …). */
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
  /** Storefront ProductFilter inputs (from FilterValue.input). Collection only. */
  filters?: ProductFilter[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Top-level facade — namespace-shaped API surface
// ---------------------------------------------------------------------------

export interface ShopifyProductsAPI {
  list(opts?: ListOptions): Promise<Connection<Product>>;
  byHandle(handle: string): Promise<Product | null>;
  byId(id: string): Promise<Product | null>;
  search(query: string, opts?: Omit<ListOptions, 'query'>): Promise<Connection<Product>>;
  recommended(productId: string): Promise<Product[]>;
}

export interface ShopifyCollectionsAPI {
  list(opts?: ListOptions): Promise<Connection<Collection>>;
  byHandle(handle: string): Promise<Collection | null>;
  products(handle: string, opts?: ListOptions): Promise<Connection<Product>>;
}

export interface ShopifyCartAPI {
  /** Create a new cart. Returns it with a fresh checkoutUrl. */
  create(input?: { lines?: CartLineInput[]; discountCodes?: string[] }): Promise<Cart>;
  /** Fetch an existing cart by id. Returns null if it expired. */
  get(cartId: string): Promise<Cart | null>;
  addLines(cartId: string, lines: CartLineInput[]): Promise<Cart>;
  updateLines(cartId: string, lines: CartLineUpdateInput[]): Promise<Cart>;
  removeLines(cartId: string, lineIds: string[]): Promise<Cart>;
  applyDiscountCodes(cartId: string, codes: string[]): Promise<Cart>;
  /** Persist buyer identity (email, country, customerAccessToken). */
  setBuyerIdentity(
    cartId: string,
    identity: { email?: string; countryCode?: string; customerAccessToken?: string }
  ): Promise<Cart>;
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

// ---------------------------------------------------------------------------
// Wishlist (local-storage backed)
// ---------------------------------------------------------------------------

/**
 * Minimal storage contract the wishlist uses. Matches `window.localStorage`
 * signatures so it works on web out of the box. RN consumers pass
 * AsyncStorage; server-side consumers pass an in-memory shim.
 *
 * Async methods are supported — `refresh()` awaits `getItem`/`setItem`.
 */
export interface WishlistStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/**
 * A single wishlist entry. Persisted to storage with the small `basic`
 * snapshot for offline-first rendering; `product` is hydrated by
 * `refresh()` and is `null` if the product was deleted upstream.
 */
export interface WishlistItem {
  /** Shopify product GID (e.g. `gid://shopify/Product/123`). */
  productId: string;
  /** Snapshot stored so the UI can render before the network round-trip. */
  basic: {
    handle?: string;
    title?: string;
    image?: string;
    price?: Money;
  };
  /** ms epoch — when the user added this item. */
  addedAt: number;
  /**
   * Hydrated product from the Storefront API. Populated by `init()` /
   * `refresh()`. `undefined` = not fetched yet, `null` = product was
   * deleted upstream (the wishlist entry is auto-purged unless
   * `keepDeleted: true` is passed to `refresh()`).
   */
  product?: Product | null;
}

export interface WishlistInitOptions {
  /** Persistence backend. Defaults to `window.localStorage` on web, no-op elsewhere. */
  storage?: WishlistStorageAdapter;
  /** Storage key. Defaults to `tile:shopify:wishlist:v1`. */
  storageKey?: string;
  /**
   * Max product IDs per Storefront `nodes` request when hydrating.
   * Default 100 — Shopify's query cost ceiling per call caps in this range.
   */
  batchSize?: number;
  /**
   * Whether to fetch products immediately on init. Default `true`.
   * Set false for lazy hydration (call `refresh()` on your own schedule).
   */
  hydrateOnInit?: boolean;
}

export interface WishlistRefreshOptions {
  /**
   * If true, deleted products stay in the list with `product: null` — the
   * UI can then show a "no longer available" state. Default `false`:
   * deleted entries are removed from storage.
   */
  keepDeleted?: boolean;
}

export type WishlistChangeListener = (items: WishlistItem[]) => void;

export interface ShopifyWishlistAPI {
  /** Initialize the wishlist from storage; optionally hydrates products. */
  init(opts?: WishlistInitOptions): Promise<WishlistItem[]>;
  /** Whether `init()` has completed. */
  isReady(): boolean;
  /** Add an entry. Accepts a `Product` (snapshot extracted automatically) or a raw id + optional snapshot. */
  add(product: Product): Promise<WishlistItem>;
  add(productId: string, basic?: WishlistItem['basic']): Promise<WishlistItem>;
  /** Remove by product id. Returns true if the item was present. */
  remove(productId: string): Promise<boolean>;
  /** Add if absent, remove if present. Returns the resulting membership. */
  toggle(product: Product): Promise<boolean>;
  toggle(productId: string, basic?: WishlistItem['basic']): Promise<boolean>;
  /** O(1) membership check. */
  has(productId: string): boolean;
  /** Current items — newest first. */
  list(): WishlistItem[];
  /** Item count. */
  count(): number;
  /** Empty the wishlist. */
  clear(): Promise<void>;
  /**
   * Re-fetch every product from the Storefront API in batches, updating
   * each entry's `product` field. Deleted products (null upstream) are
   * either purged or kept depending on `opts.keepDeleted`. Handles any
   * count — 250, 1000, more — by chunking to `batchSize`.
   */
  refresh(opts?: WishlistRefreshOptions): Promise<WishlistItem[]>;
  /** Subscribe to list changes. Returns an unsubscribe function. */
  onChange(listener: WishlistChangeListener): () => void;
}

export interface ShopifyIntegration {
  /** Initialize with store credentials. Must be called before any other method. */
  init(config: ShopifyConfig): Promise<void>;
  isReady(): boolean;
  /** Whether this is the mock build (true) or real Storefront-API build (false). */
  readonly isMock: boolean;

  products: ShopifyProductsAPI;
  collections: ShopifyCollectionsAPI;
  cart: ShopifyCartAPI;
  customer: ShopifyCustomerAPI;
  blogs: ShopifyBlogsAPI;
  wishlist: ShopifyWishlistAPI;
  /** Shop-level settings (money format / currency), loaded at init. */
  shop: {
    load(): Promise<{ moneyFormat: string | null; currencyCode: string | null }>;
    moneyFormat(): string | null;
  };
  /** Format a Money value using the shop's `moneyFormat` (with symbol fallback). */
  formatMoney(money: Money | null | undefined): string;
}
