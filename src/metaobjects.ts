/**
 * Metaobjects: a merchant's own content entries in Shopify (a hero's words, its picture and the
 * collection it opens), read by id through the Storefront API. A field comes back as its value, plus
 * the picture's URL when it refers to an image and the handle when it refers to a collection, so a
 * screen can lay it onto a tile's props without a second read.
 */
import { request } from './client';
import { METAOBJECT_BY_ID_QUERY } from './queries';
import type { Metaobject, MetaobjectField, ShopifyMetaobjectsAPI } from './types';

interface MetaobjectRaw {
  metaobject: {
    id: string;
    type: string;
    fields: {
      key: string;
      value: string | null;
      reference?: { image?: { url?: string | null } | null; handle?: string | null } | null;
    }[];
  } | null;
}

/** A metaobject as the SDK returns it, or null when Shopify has none by that id. */
export function normalizeMetaobject(raw: MetaobjectRaw['metaobject']): Metaobject | null {
  if (!raw) return null;
  const fields: Record<string, MetaobjectField> = {};
  for (const field of raw.fields ?? []) {
    if (!field?.key) continue;
    fields[field.key] = {
      value: field.value ?? null,
      imageUrl: field.reference?.image?.url ?? null,
      collectionHandle: field.reference?.handle ?? null,
    };
  }
  return { id: raw.id, type: raw.type, fields };
}

async function byId(id: string, opts?: { fresh?: boolean }): Promise<Metaobject | null> {
  const data = await request<MetaobjectRaw>(METAOBJECT_BY_ID_QUERY, { id }, { fresh: opts?.fresh });
  return normalizeMetaobject(data.metaobject);
}

export const metaobjects: ShopifyMetaobjectsAPI = { byId };
