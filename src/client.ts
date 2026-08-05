import { ShopifyConfig, ShopifyError, UserError } from './types';

interface InternalState {
  config: ShopifyConfig | null;
  /** `shop.moneyFormat` Liquid template (e.g. `"Rs. {{amount}}"`). */
  moneyFormat: string | null;
  currencyCode: string | null;
}

const state: InternalState = { config: null, moneyFormat: null, currencyCode: null };

export function setShopInfo(info: { moneyFormat?: string | null; currencyCode?: string | null }): void {
  if (info.moneyFormat) state.moneyFormat = info.moneyFormat;
  if (info.currencyCode) state.currencyCode = info.currencyCode;
}

/** Null until the shop query resolves. */
export function getMoneyFormat(): string | null {
  return state.moneyFormat;
}

export function getCurrencyCode(): string | null {
  return state.currencyCode;
}

const DEFAULT_API_VERSION = '2024-10';

export function setConfig(config: ShopifyConfig): void {
  if (!config.storeDomain) throw new Error('shopify.init: storeDomain is required');
  if (!config.storefrontAccessToken) throw new Error('shopify.init: storefrontAccessToken is required');
  state.config = config;
}

export function getConfig(): ShopifyConfig {
  if (!state.config) throw new ShopifyError('shopify.init() must be called before any other method');
  return state.config;
}

export function isConfigured(): boolean {
  return state.config !== null;
}

function endpoint(): string {
  const c = getConfig();
  const version = c.apiVersion || DEFAULT_API_VERSION;
  return `https://${c.storeDomain}/api/${version}/graphql.json`;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

/**
 * Fragments are composed via template literals, so one included by two parents is
 * emitted twice — Shopify rejects that with "Fragment name X must be unique."
 * Keeps the first definition of each name.
 */
function deduplicateFragments(operation: string): string {
  const seen = new Set<string>();
  let result = '';
  let i = 0;
  while (i < operation.length) {
    const idx = operation.indexOf('fragment ', i);
    if (idx === -1) {
      result += operation.slice(i);
      break;
    }
    result += operation.slice(i, idx);

    const afterKeyword = idx + 'fragment '.length;
    const nameMatch = operation.slice(afterKeyword).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!nameMatch) {
      result += operation.slice(idx);
      break;
    }
    const name = nameMatch[1];
    const openBrace = operation.indexOf('{', afterKeyword + name.length);
    if (openBrace === -1) {
      result += operation.slice(idx);
      break;
    }
    let depth = 1;
    let j = openBrace + 1;
    while (j < operation.length && depth > 0) {
      const ch = operation[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    const fragmentBlock = operation.slice(idx, j);
    if (!seen.has(name)) {
      seen.add(name);
      result += fragmentBlock;
    }
    i = j;
  }
  return result;
}

export async function request<T>(operation: string, variables?: Record<string, unknown>): Promise<T> {
  const c = getConfig();
  const query = deduplicateFragments(operation);
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': c.storefrontAccessToken,
      'Accept': 'application/json',
      'Accept-Language': c.language || 'en',
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* ignore */ }
    throw new ShopifyError(
      `Shopify Storefront API HTTP ${res.status}: ${res.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`
    );
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new ShopifyError(
      `GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`
    );
  }
  if (json.data === undefined || json.data === null) {
    throw new ShopifyError('GraphQL response had no `data` field');
  }
  return json.data;
}

/** Throws if a Shopify mutation payload contains userErrors. */
export function assertNoUserErrors(label: string, errors: UserError[] | null | undefined): void {
  if (errors && errors.length > 0) {
    throw new ShopifyError(
      `${label} failed: ${errors.map((e) => e.message).join('; ')}`,
      errors
    );
  }
}
