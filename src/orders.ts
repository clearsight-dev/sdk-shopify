/**
 * The signed-in shopper's orders, for `useOrders` and `useOrder` (react/useOrders.ts), from the API
 * their session reads (`CustomerState.sessionKind`):
 *
 * - `shopify`: the Customer Account API (`customer.orders`, `order(id:)`), as production Amber did.
 * - `password`: the Storefront API (`customer(customerAccessToken:) { orders }`).
 *
 * Both answer in the same shapes (`OrderSummary`, `OrderDetails`), so a screen doesn't care which
 * sign-in it was. Newest first on both, by `processedAt`: the date the screens show. (Production
 * sorted by ID; an imported order's `processedAt` can be older than its ID suggests.)
 *
 * Framework-free. Tested in test/orders.test.mjs.
 */
import { request } from './client';
import { quantityInCart, stockCeiling } from './productPage';
import { ShopifyError } from './types';
import type {
  Cart,
  CartLineInput,
  Money,
  OrderDetails,
  OrderLine,
  OrderProgress,
  OrderSummary,
  ProductVariant,
} from './types';

/**
 * Lines counted per order in a list, for `itemCount`. A list needs only the quantities, and this keeps
 * a page of 25 near 850 Customer Account API cost points by Shopify's published cost rules (that API
 * charges per field read, from 7,500 points per shopper and store).
 */
export const LIST_LINES_COUNTED = 30;
/** Lines read for one order. */
export const ORDER_LINES_READ = 100;

// ── Customer Account API (Shopify sign-in) ─────────────────────────────────

export const ACCOUNT_ORDER_HISTORY_QUERY = /* GraphQL */ `
  query OrderHistory($first: Int!, $after: String) {
    customer {
      orders(first: $first, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          name
          processedAt
          cancelledAt
          fulfillmentStatus
          statusPageUrl
          totalPrice { amount currencyCode }
          lineItems(first: ${LIST_LINES_COUNTED}) { nodes { quantity } }
        }
      }
    }
  }
`;

export const ACCOUNT_ORDER_DETAIL_QUERY = /* GraphQL */ `
  query OrderDetail($id: ID!) {
    order(id: $id) {
      id
      name
      processedAt
      cancelledAt
      fulfillmentStatus
      statusPageUrl
      totalPrice { amount currencyCode }
      subtotal { amount currencyCode }
      totalShipping { amount currencyCode }
      totalTax { amount currencyCode }
      totalRefunded { amount currencyCode }
      discountApplications(first: 10) { nodes { ... on DiscountCodeApplication { code } } }
      lineItems(first: ${ORDER_LINES_READ}) {
        nodes {
          title
          variantTitle
          quantity
          variantId
          image { url }
          price { amount currencyCode }
          totalPrice { amount currencyCode }
        }
      }
    }
  }
`;

// ── Storefront API (email and password) ────────────────────────────────────

export const STOREFRONT_ORDER_HISTORY_QUERY = /* GraphQL */ `
  query CustomerOrderHistory($accessToken: String!, $first: Int!, $after: String) {
    customer(customerAccessToken: $accessToken) {
      orders(first: $first, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          name
          processedAt
          canceledAt
          fulfillmentStatus
          statusUrl
          totalPrice { amount currencyCode }
          lineItems(first: ${LIST_LINES_COUNTED}) { nodes { quantity } }
        }
      }
    }
  }
`;

/**
 * The Storefront API has no order-by-id query, so one order is found in two cheap reads: its place in
 * the list (ids only, 250 a page), then that one order, read after the cursor of the one before it.
 */
export const STOREFRONT_ORDER_IDS_QUERY = /* GraphQL */ `
  query CustomerOrderIds($accessToken: String!, $after: String) {
    customer(customerAccessToken: $accessToken) {
      orders(first: 250, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges { cursor node { id } }
      }
    }
  }
`;

export const STOREFRONT_ORDER_DETAIL_QUERY = /* GraphQL */ `
  query CustomerOrderDetail($accessToken: String!, $after: String) {
    customer(customerAccessToken: $accessToken) {
      orders(first: 1, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id
          name
          processedAt
          canceledAt
          fulfillmentStatus
          statusUrl
          totalPrice { amount currencyCode }
          subtotalPrice { amount currencyCode }
          totalShippingPrice { amount currencyCode }
          totalTax { amount currencyCode }
          totalRefunded { amount currencyCode }
          discountApplications(first: 10) { nodes { ... on DiscountCodeApplication { code } } }
          lineItems(first: ${ORDER_LINES_READ}) {
            nodes {
              title
              quantity
              originalTotalPrice { amount currencyCode }
              variant { id title image { url } }
            }
          }
        }
      }
    }
  }
`;

// ── What the APIs return ───────────────────────────────────────────────────

type RawMoney = { amount: string; currencyCode: string } | null | undefined;
type Nodes<T> = { nodes?: (T | null)[] | null } | null | undefined;

interface RawAccountOrder {
  id: string;
  name?: string | null;
  processedAt?: string | null;
  cancelledAt?: string | null;
  fulfillmentStatus?: string | null;
  statusPageUrl?: string | null;
  totalPrice?: RawMoney;
  subtotal?: RawMoney;
  totalShipping?: RawMoney;
  totalTax?: RawMoney;
  totalRefunded?: RawMoney;
  discountApplications?: Nodes<{ code?: string | null }>;
  lineItems?: Nodes<{
    title?: string | null;
    variantTitle?: string | null;
    quantity?: number | null;
    variantId?: string | null;
    image?: { url?: string | null } | null;
    price?: RawMoney;
    totalPrice?: RawMoney;
  }>;
}

interface RawStorefrontOrder {
  id: string;
  name?: string | null;
  processedAt?: string | null;
  canceledAt?: string | null;
  fulfillmentStatus?: string | null;
  statusUrl?: string | null;
  totalPrice?: RawMoney;
  subtotalPrice?: RawMoney;
  totalShippingPrice?: RawMoney;
  totalTax?: RawMoney;
  totalRefunded?: RawMoney;
  discountApplications?: Nodes<{ code?: string | null }>;
  lineItems?: Nodes<{
    title?: string | null;
    quantity?: number | null;
    originalTotalPrice?: RawMoney;
    variant?: { id?: string | null; title?: string | null; image?: { url?: string | null } | null } | null;
  }>;
}

interface RawPage<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: (T | null)[] | null;
}

/** One order from either API, in one shape, before it becomes a summary or the full order. */
interface ReadOrder {
  id: string;
  name: string;
  processedAt: string;
  cancelledAt: string | null;
  fulfillmentStatus: string | null;
  statusPageUrl: string | null;
  totalPrice: RawMoney;
  lines: OrderLine[];
  /** Shopify's subtotal, which is after discounts. */
  netSubtotal: RawMoney;
  totalShipping: RawMoney;
  totalTax: RawMoney;
  totalRefunded: RawMoney;
  discountCodes: string[];
}

// ── Mapping ────────────────────────────────────────────────────────────────

/** Production Amber's status card rule: cancelled wins, then the fulfilment status. */
export function orderProgress(cancelledAt: string | null | undefined, fulfillmentStatus: string | null | undefined): OrderProgress {
  if (cancelledAt) return 'cancelled';
  if (fulfillmentStatus === 'FULFILLED') return 'fulfilled';
  if (fulfillmentStatus === 'PARTIALLY_FULFILLED') return 'partiallyFulfilled';
  return 'confirmed';
}

const nodesOf = <T>(list: Nodes<T>): T[] => (list?.nodes ?? []).filter((node): node is T => !!node);
const toCents = (m: RawMoney) => Math.round((Number.parseFloat(m?.amount ?? '0') || 0) * 100);
const fromCents = (cents: number, currencyCode: string): Money => ({ amount: (cents / 100).toFixed(2), currencyCode });
const copyMoney = (m: RawMoney): Money | null => (m ? { amount: m.amount, currencyCode: m.currencyCode } : null);
/** For the rows a screen shows only when they say something: a zero is null. */
const unlessZero = (m: RawMoney): Money | null => (m && toCents(m) !== 0 ? copyMoney(m) : null);
/** Shopify's name for the only variant of a product with one. */
const variantTitleOf = (title: string | null | undefined) => (title && title !== 'Default Title' ? title : null);
const codesOf = (list: Nodes<{ code?: string | null }>) =>
  nodesOf(list).map((node) => node.code).filter((code): code is string => !!code);

function fromAccount(raw: RawAccountOrder): ReadOrder {
  return {
    id: raw.id,
    name: raw.name ?? '',
    processedAt: raw.processedAt ?? '',
    cancelledAt: raw.cancelledAt ?? null,
    fulfillmentStatus: raw.fulfillmentStatus ?? null,
    statusPageUrl: raw.statusPageUrl ?? null,
    totalPrice: raw.totalPrice,
    lines: nodesOf(raw.lineItems).map((line) => ({
      title: line.title ?? '',
      variantTitle: variantTitleOf(line.variantTitle),
      quantity: line.quantity ?? 0,
      imageUrl: line.image?.url ?? null,
      unitPrice: copyMoney(line.price),
      totalPrice: copyMoney(line.totalPrice),
      variantId: line.variantId ?? null,
    })),
    netSubtotal: raw.subtotal,
    totalShipping: raw.totalShipping,
    totalTax: raw.totalTax,
    totalRefunded: raw.totalRefunded,
    discountCodes: codesOf(raw.discountApplications),
  };
}

function fromStorefront(raw: RawStorefrontOrder): ReadOrder {
  return {
    id: raw.id,
    name: raw.name ?? '',
    processedAt: raw.processedAt ?? '',
    cancelledAt: raw.canceledAt ?? null,
    fulfillmentStatus: raw.fulfillmentStatus ?? null,
    statusPageUrl: raw.statusUrl ?? null,
    totalPrice: raw.totalPrice,
    lines: nodesOf(raw.lineItems).map((line) => {
      const quantity = line.quantity ?? 0;
      const total = line.originalTotalPrice;
      return {
        title: line.title ?? '',
        variantTitle: variantTitleOf(line.variant?.title),
        quantity,
        imageUrl: line.variant?.image?.url ?? null,
        // The Storefront API has no unit price on an order line; its pre-discount total is one times quantity.
        unitPrice: total && quantity > 0 ? fromCents(Math.round(toCents(total) / quantity), total.currencyCode) : null,
        totalPrice: copyMoney(total),
        variantId: line.variant?.id ?? null,
      };
    }),
    netSubtotal: raw.subtotalPrice,
    totalShipping: raw.totalShippingPrice,
    totalTax: raw.totalTax,
    totalRefunded: raw.totalRefunded,
    discountCodes: codesOf(raw.discountApplications),
  };
}

function toSummary(order: ReadOrder): OrderSummary {
  return {
    id: order.id,
    name: order.name,
    processedAt: order.processedAt,
    progress: orderProgress(order.cancelledAt, order.fulfillmentStatus),
    cancelledAt: order.cancelledAt,
    totalPrice: copyMoney(order.totalPrice) ?? { amount: '0.00', currencyCode: '' },
    itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
    statusPageUrl: order.statusPageUrl,
  };
}

/**
 * Production Amber's totals: the subtotal shown is the lines before discounts, and the discount is the
 * gap between that and Shopify's subtotal (which is after every discount, line or order level), so a
 * whole-order code that lands on no single line is counted too.
 */
function toDetails(order: ReadOrder): OrderDetails {
  const currencyCode = order.totalPrice?.currencyCode ?? order.netSubtotal?.currencyCode ?? '';
  const lineTotals = order.lines.map((line) => line.totalPrice).filter((total): total is Money => !!total);
  const itemsCents = lineTotals.reduce((sum, total) => sum + toCents(total), 0);
  const netCents = order.netSubtotal ? toCents(order.netSubtotal) : itemsCents;
  const discountCents = Math.max(0, itemsCents - netCents);
  return {
    ...toSummary(order),
    lineItems: order.lines,
    subtotal: itemsCents > 0 ? fromCents(itemsCents, currencyCode) : copyMoney(order.netSubtotal),
    totalShipping: copyMoney(order.totalShipping),
    totalTax: unlessZero(order.totalTax),
    totalDiscount: discountCents > 0 ? fromCents(discountCents, currencyCode) : null,
    totalRefunded: unlessZero(order.totalRefunded),
    discountCodes: order.discountCodes,
  };
}

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * Leeway for the phone's clock against Shopify's when telling a new order from the one before it: an
 * order placed up to this long before `since` still counts (`useLatestOrderSince`). 2 minutes.
 */
export const ORDER_CLOCK_LEEWAY_MS = 2 * 60 * 1000;

/**
 * Whether an order was placed at or after `since` (ms since 1970), less `clockLeewayMs`. Every order
 * counts when `since` is null or undefined. An order whose date can't be read never counts.
 */
export function placedSince(
  order: Pick<OrderSummary, 'processedAt'>,
  since: number | null | undefined,
  clockLeewayMs: number = ORDER_CLOCK_LEEWAY_MS,
): boolean {
  if (since == null) return true;
  return Date.parse(order.processedAt) >= since - clockLeewayMs;
}

export interface OrdersPage {
  orders: OrderSummary[];
  /** Pass to the next `list` call; null on the last page. */
  endCursor: string | null;
  hasNextPage: boolean;
}

/** The orders of whoever is signed in, from the API their session reads. */
export interface OrderSource {
  /** A page of orders, newest first. `after`: the previous page's `endCursor`; null for the first. */
  list(first: number, after: string | null): Promise<OrdersPage>;
  /** One order in full. Null when this shopper has no order with that id. */
  get(id: string): Promise<OrderDetails | null>;
}

/** `CustomerState.request`: one Customer Account API call for the signed-in shopper. */
export type AccountRequest = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const sessionEnded = () => new ShopifyError('The customer session has ended');

function toPage<T>(raw: RawPage<T> | null | undefined, read: (node: T) => ReadOrder): OrdersPage {
  return {
    orders: (raw?.nodes ?? []).filter((node): node is T => !!node).map((node) => toSummary(read(node))),
    endCursor: raw?.pageInfo?.endCursor ?? null,
    hasNextPage: !!raw?.pageInfo?.hasNextPage && !!raw?.pageInfo?.endCursor,
  };
}

/** Shopify sign-in: the Customer Account API. */
export function customerAccountOrders(accountRequest: AccountRequest): OrderSource {
  return {
    async list(first, after) {
      const data = await accountRequest<{ customer: { orders: RawPage<RawAccountOrder> | null } | null }>(
        ACCOUNT_ORDER_HISTORY_QUERY,
        { first, after },
      );
      return toPage(data.customer?.orders, fromAccount);
    },
    async get(id) {
      const data = await accountRequest<{ order: RawAccountOrder | null }>(ACCOUNT_ORDER_DETAIL_QUERY, { id });
      return data.order ? toDetails(fromAccount(data.order)) : null;
    },
  };
}

type StorefrontCustomer<T> = { customer: { orders: T } | null };

/**
 * Email and password: the Storefront API, with the session's token. A token Shopify no longer accepts
 * reads `customer: null`, which is the session ending, not an empty history.
 */
export function storefrontOrders(getAccessToken: () => Promise<string | null>): OrderSource {
  async function token(): Promise<string> {
    const accessToken = await getAccessToken();
    if (!accessToken) throw sessionEnded();
    return accessToken;
  }

  type IdsPage = {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { cursor: string; node: { id: string } }[];
  };

  /** The cursor to read `id` after (null: it is the newest), or undefined when there is no such order. */
  async function cursorBefore(accessToken: string, id: string): Promise<string | null | undefined> {
    let after: string | null = null;
    for (;;) {
      const data: StorefrontCustomer<IdsPage> = await request<StorefrontCustomer<IdsPage>>(STOREFRONT_ORDER_IDS_QUERY, {
        accessToken,
        after,
      });
      if (!data.customer) throw sessionEnded();
      const { edges, pageInfo } = data.customer.orders;
      const at = edges.findIndex((edge) => edge.node.id === id);
      if (at >= 0) return at === 0 ? after : edges[at - 1].cursor;
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) return undefined;
      after = pageInfo.endCursor;
    }
  }

  return {
    async list(first, after) {
      const data = await request<StorefrontCustomer<RawPage<RawStorefrontOrder>>>(STOREFRONT_ORDER_HISTORY_QUERY, {
        accessToken: await token(),
        first,
        after,
      });
      if (!data.customer) throw sessionEnded();
      return toPage(data.customer.orders, fromStorefront);
    },
    async get(id) {
      const accessToken = await token();
      // Twice at most: an order placed between the two reads moves the one asked for along by one.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const after = await cursorBefore(accessToken, id);
        if (after === undefined) return null;
        const data = await request<StorefrontCustomer<{ nodes: (RawStorefrontOrder | null)[] }>>(
          STOREFRONT_ORDER_DETAIL_QUERY,
          { accessToken, after },
        );
        if (!data.customer) throw sessionEnded();
        const node = data.customer.orders.nodes[0];
        if (node?.id === id) return toDetails(fromStorefront(node));
      }
      throw new ShopifyError('The order list changed while it was being read; try again');
    },
  };
}

// ── Paging ─────────────────────────────────────────────────────────────────

export interface OrdersShown {
  orders: OrderSummary[];
  endCursor: string | null;
  hasMore: boolean;
}

/**
 * A refreshed first page laid over what is on screen. The pages loaded after it are kept, so a list
 * scrolled down stays where it was (they aren't re-read). When the fresh page doesn't reach back to
 * them (many new orders since), or it is the whole history, it replaces the list.
 */
export function withFreshFirstPage(shown: OrdersShown, page: OrdersPage): OrdersShown {
  const fresh: OrdersShown = { orders: page.orders, endCursor: page.endCursor, hasMore: page.hasNextPage };
  if (!page.hasNextPage || page.orders.length === 0) return fresh;
  const lastFresh = page.orders[page.orders.length - 1].id;
  const at = shown.orders.findIndex((order) => order.id === lastFresh);
  if (at < 0) return fresh;
  const freshIds = new Set(page.orders.map((order) => order.id));
  const rest = shown.orders.slice(at + 1).filter((order) => !freshIds.has(order.id));
  if (rest.length === 0) return fresh;
  return { orders: [...page.orders, ...rest], endCursor: shown.endCursor, hasMore: shown.hasMore };
}

/** The next page after what is shown, leaving out any order already there. */
export function withNextPage(shown: OrdersShown, page: OrdersPage): OrdersShown {
  const ids = new Set(shown.orders.map((order) => order.id));
  return {
    orders: [...shown.orders, ...page.orders.filter((order) => !ids.has(order.id))],
    endCursor: page.endCursor,
    hasMore: page.hasNextPage,
  };
}

// ── Buy again ──────────────────────────────────────────────────────────────

export interface BuyAgainPlan {
  /** What to add: one input per line that fits, in the order's order. */
  inputs: CartLineInput[];
  /**
   * Lines left out: no variant any more, not for sale, `skipVariant` said so, or no stock beyond
   * what the cart holds.
   */
  skipped: number;
}

/**
 * Which of an order's lines can go back in the cart, and how many of each, by the cart's stock rule
 * (`stockCeiling`, as `useAddToCart` checks it): a quantity over what is left is cut to what is left,
 * counting what the cart already holds and what earlier lines of this order take. `variants` are read
 * fresh; a line whose variant isn't among them no longer exists.
 *
 * A variant still sold out and enrolled in pre-order (a selling plan) goes back on that plan, at the
 * ordered quantity: a pre-order isn't limited by stock. Everything else goes back as an ordinary line.
 * The same "sold out and on a plan" rule as the Waitlist's pre-order add. Decided 2026-10-04 by the
 * Head of Engineering: "if item is still out of stock with selling plan add them as pre order
 * otherwise add it normally".
 *
 * `options.skipVariant` leaves out (and counts as skipped) every line whose variant it returns true
 * for, before anything is added or claimed. The app passes Cart Hold's `isHeldOut`, so a size whose
 * every unit was just found held in other carts isn't tried again. Decided 2026-10-04 by the Head of
 * Engineering.
 */
export function planBuyAgain(
  lines: OrderLine[],
  variants: (Pick<ProductVariant, 'id' | 'availableForSale' | 'quantityAvailable'> & { sellingPlan?: { id: string } | null })[],
  cart: Pick<Cart, 'lines'> | null,
  options: { skipVariant?: (variantId: string) => boolean } = {},
): BuyAgainPlan {
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const planned = new Map<string, number>();
  const inputs: CartLineInput[] = [];
  let skipped = 0;
  for (const line of lines) {
    const variant = line.variantId ? byId.get(line.variantId) : undefined;
    if (!variant || !variant.availableForSale || line.quantity <= 0) {
      skipped += 1;
      continue;
    }
    if (options.skipVariant?.(variant.id)) {
      skipped += 1;
      continue;
    }
    if ((variant.quantityAvailable ?? 0) <= 0 && variant.sellingPlan) {
      inputs.push({ merchandiseId: variant.id, quantity: line.quantity, sellingPlanId: variant.sellingPlan.id });
      continue;
    }
    const ceiling = stockCeiling(variant);
    const taken = quantityInCart(cart, variant.id) + (planned.get(variant.id) ?? 0);
    const quantity = ceiling === null ? line.quantity : Math.min(line.quantity, ceiling - taken);
    if (quantity <= 0) {
      skipped += 1;
      continue;
    }
    planned.set(variant.id, (planned.get(variant.id) ?? 0) + quantity);
    inputs.push({ merchandiseId: variant.id, quantity });
  }
  return { inputs, skipped };
}
