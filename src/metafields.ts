/**
 * Metafield reads via the Storefront API.
 *
 * Storefront is read-only here. There is no `metafieldsSet` on this endpoint —
 * writing a customer metafield needs the Customer Account API (different
 * endpoint, OAuth flow), which this Storefront client deliberately does not
 * cover. See README › Metafields.
 *
 * Storefront also won't enumerate a resource's metafields, so every call takes
 * explicit `{namespace, key}` identifiers and returns only the ones that exist:
 * unset identifiers come back as `null` and are stripped.
 */
import { request } from './client';
import {
  COLLECTION_METAFIELDS_QUERY,
  CUSTOMER_METAFIELDS_QUERY,
  ORDER_METAFIELDS_QUERY,
  PRODUCT_METAFIELDS_QUERY,
  VARIANT_METAFIELDS_QUERY,
} from './queries';
import type { Metafield, MetafieldIdentifier, ShopifyMetafieldsAPI } from './types';

interface MetafieldHost {
  metafields: (Metafield | null)[];
}

/** Storefront returns a null slot per identifier it couldn't resolve. */
function compact(host: MetafieldHost | null | undefined): Metafield[] {
  return (host?.metafields ?? []).filter((metafield): metafield is Metafield => metafield != null);
}

/**
 * Guard against a silent empty result: an identifier list is required, and an
 * empty one means the caller built it from an empty config.
 */
function assertIdentifiers(label: string, identifiers: MetafieldIdentifier[]): void {
  if (!identifiers?.length) {
    throw new Error(`[shopify.metafields.${label}] requires at least one {namespace, key} identifier`);
  }
}

export const metafields: ShopifyMetafieldsAPI = {
  async product(productId: string, identifiers: MetafieldIdentifier[]): Promise<Metafield[]> {
    assertIdentifiers('product', identifiers);
    const data = await request<{ product: MetafieldHost | null }>(PRODUCT_METAFIELDS_QUERY, {
      id: productId,
      identifiers,
    });
    return compact(data.product);
  },

  async variant(variantId: string, identifiers: MetafieldIdentifier[]): Promise<Metafield[]> {
    assertIdentifiers('variant', identifiers);
    const data = await request<{ node: MetafieldHost | null }>(VARIANT_METAFIELDS_QUERY, {
      id: variantId,
      identifiers,
    });
    return compact(data.node);
  },

  async collection(collectionId: string, identifiers: MetafieldIdentifier[]): Promise<Metafield[]> {
    assertIdentifiers('collection', identifiers);
    const data = await request<{ collection: MetafieldHost | null }>(COLLECTION_METAFIELDS_QUERY, {
      id: collectionId,
      identifiers,
    });
    return compact(data.collection);
  },

  async customer(accessToken: string, identifiers: MetafieldIdentifier[]): Promise<Metafield[]> {
    assertIdentifiers('customer', identifiers);
    const data = await request<{ customer: MetafieldHost | null }>(CUSTOMER_METAFIELDS_QUERY, {
      accessToken,
      identifiers,
    });
    return compact(data.customer);
  },

  async order(orderId: string, identifiers: MetafieldIdentifier[]): Promise<Metafield[]> {
    assertIdentifiers('order', identifiers);
    const data = await request<{ node: MetafieldHost | null }>(ORDER_METAFIELDS_QUERY, {
      id: orderId,
      identifiers,
    });
    return compact(data.node);
  },
};
