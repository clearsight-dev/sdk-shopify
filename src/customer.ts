/**
 * Real Shopify customer via Storefront API.
 */
import { request, assertNoUserErrors } from './client';
import {
  CUSTOMER_ACCESS_TOKEN_CREATE_MUTATION,
  CUSTOMER_ACCESS_TOKEN_DELETE_MUTATION,
  CUSTOMER_CREATE_MUTATION,
  CUSTOMER_ORDERS_QUERY,
  CUSTOMER_QUERY,
  CUSTOMER_RECOVER_MUTATION,
  CUSTOMER_UPDATE_MUTATION,
} from './queries';
import type {
  Connection,
  Customer,
  CustomerAccessToken,
  ListOptions,
  Order,
  PageInfo,
  ShopifyCustomerAPI,
  UserError,
} from './types';

interface CreatePayload {
  customerCreate: { customer: Customer | null; customerUserErrors: UserError[] };
}
interface TokenPayload {
  customerAccessTokenCreate: {
    customerAccessToken: CustomerAccessToken | null;
    customerUserErrors: UserError[];
  };
}
interface DeletePayload {
  customerAccessTokenDelete: { deletedAccessToken: string | null; userErrors: UserError[] };
}
interface CustomerPayload { customer: Customer | null }
interface RecoverPayload { customerRecover: { customerUserErrors: UserError[] } }
interface UpdatePayload {
  customerUpdate: { customer: Customer | null; customerUserErrors: UserError[] };
}
interface OrdersPayload {
  customer: { orders: { nodes: any[]; pageInfo: PageInfo } } | null;
}

function normalizeOrder(o: any): Order {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    name: o.name,
    processedAt: o.processedAt,
    fulfillmentStatus: o.fulfillmentStatus ?? null,
    financialStatus: o.financialStatus ?? null,
    statusUrl: o.statusUrl,
    currencyCode: o.currencyCode,
    email: o.email ?? null,
    phone: o.phone ?? null,
    totalPrice: o.totalPrice,
    subtotalPrice: o.subtotalPrice ?? null,
    totalShippingPrice: o.totalShippingPrice,
    totalTax: o.totalTax ?? null,
    totalRefunded: o.totalRefunded,
    shippingAddress: o.shippingAddress ?? null,
    lineItems: (o.lineItems?.nodes ?? []).map((line: any) => ({
      title: line.title,
      quantity: line.quantity,
      variant: line.variant ?? null,
      originalTotalPrice: line.originalTotalPrice,
      discountedTotalPrice: line.discountedTotalPrice,
    })),
  };
}

export const customer: ShopifyCustomerAPI = {
  async signup(input): Promise<{ customer: Customer; accessToken: CustomerAccessToken }> {
    // 1. Create the customer
    const created = await request<CreatePayload>(CUSTOMER_CREATE_MUTATION, {
      input: {
        email: input.email,
        password: input.password,
        firstName: input.firstName,
        lastName: input.lastName,
        acceptsMarketing: input.acceptsMarketing ?? false,
      },
    });
    assertNoUserErrors('customerCreate', created.customerCreate.customerUserErrors);
    if (!created.customerCreate.customer) {
      throw new Error('customerCreate returned no customer');
    }

    // 2. Mint an access token (signup doesn't auto-login)
    const accessToken = await this.login({ email: input.email, password: input.password });
    return { customer: created.customerCreate.customer, accessToken };
  },

  async login(input): Promise<CustomerAccessToken> {
    const data = await request<TokenPayload>(CUSTOMER_ACCESS_TOKEN_CREATE_MUTATION, {
      input: { email: input.email, password: input.password },
    });
    assertNoUserErrors('customerAccessTokenCreate', data.customerAccessTokenCreate.customerUserErrors);
    if (!data.customerAccessTokenCreate.customerAccessToken) {
      throw new Error('customerAccessTokenCreate returned no token');
    }
    return data.customerAccessTokenCreate.customerAccessToken;
  },

  async logout(accessToken: string): Promise<void> {
    const data = await request<DeletePayload>(CUSTOMER_ACCESS_TOKEN_DELETE_MUTATION, {
      customerAccessToken: accessToken,
    });
    if (data.customerAccessTokenDelete.userErrors?.length > 0) {
      // logout should succeed silently — log but don't throw
      // eslint-disable-next-line no-console
      console.warn('[shopify.customer.logout]', data.customerAccessTokenDelete.userErrors);
    }
  },

  async profile(accessToken: string): Promise<Customer | null> {
    const data = await request<CustomerPayload>(CUSTOMER_QUERY, { accessToken });
    return data.customer;
  },

  async recoverPassword(email: string): Promise<void> {
    const data = await request<RecoverPayload>(CUSTOMER_RECOVER_MUTATION, { email });
    assertNoUserErrors('customerRecover', data.customerRecover.customerUserErrors);
  },

  async updateProfile(accessToken, patch): Promise<Customer> {
    const data = await request<UpdatePayload>(CUSTOMER_UPDATE_MUTATION, {
      accessToken,
      customer: {
        firstName: patch.firstName,
        lastName: patch.lastName,
        phone: patch.phone,
        acceptsMarketing: patch.acceptsMarketing,
      },
    });
    assertNoUserErrors('customerUpdate', data.customerUpdate.customerUserErrors);
    if (!data.customerUpdate.customer) {
      throw new Error('customerUpdate returned no customer');
    }
    return data.customerUpdate.customer;
  },

  async orders(accessToken: string, opts?: ListOptions): Promise<Connection<Order>> {
    const data = await request<OrdersPayload>(CUSTOMER_ORDERS_QUERY, {
      accessToken,
      first: opts?.first ?? 20,
      after: opts?.after,
    });
    if (!data.customer) {
      return { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    return {
      nodes: data.customer.orders.nodes.map(normalizeOrder),
      pageInfo: data.customer.orders.pageInfo,
    };
  },

  async orderById(accessToken: string, orderId: string): Promise<Order | null> {
    // Storefront API does not expose an order-by-id query; fetch list and filter.
    const list = await this.orders(accessToken, { first: 250 });
    return list.nodes.find((o) => o.id === orderId) ?? null;
  },
};
