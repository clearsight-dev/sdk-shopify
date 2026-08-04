/**
 * Money formatting driven by the shop's `moneyFormat` Liquid template
 * (fetched from the Storefront API `shop { moneyFormat }`), falling back to a
 * currency-symbol map when the template hasn't loaded yet.
 */
import type { Money } from './types';
import { request, getMoneyFormat, setShopInfo } from './client';
import { SHOP_QUERY } from './queries';

const SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: '$', AUD: '$',
};

/** Group the integer part with a separator every 3 digits. */
function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/**
 * Render a numeric amount for one Liquid money placeholder.
 * Supports Shopify's standard money_format tokens.
 */
function renderAmount(amount: number, token: string): string {
  const noDecimals = /no_decimals/.test(token);
  const decimals = noDecimals ? 0 : 2;
  const fixed = amount.toFixed(decimals);
  let [int, frac] = fixed.split('.');

  let thousands = ',';
  let decimalSep = '.';
  if (/comma_separator/.test(token)) { thousands = '.'; decimalSep = ','; }
  else if (/apostrophe_separator/.test(token)) { thousands = "'"; decimalSep = '.'; }
  else if (/space_separator/.test(token)) { thousands = ' '; decimalSep = ','; }

  const grouped = group(int, thousands);
  return frac ? `${grouped}${decimalSep}${frac}` : grouped;
}

/** Apply a Shopify `moneyFormat` template to an amount, e.g. `"Rs. {{amount}}"`. */
export function applyMoneyFormat(template: string, amount: number): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, token) => renderAmount(amount, token));
}

/**
 * Format a Money value. Uses the shop's fetched `moneyFormat` template when
 * available; otherwise falls back to a leading currency symbol.
 */
export function formatMoney(money: Money | null | undefined): string {
  if (!money) return '';
  const num = Number(money.amount);
  const template = getMoneyFormat();
  if (template && !Number.isNaN(num)) return applyMoneyFormat(template, num);
  const symbol = SYMBOLS[money.currencyCode] ?? `${money.currencyCode} `;
  if (Number.isNaN(num)) return `${symbol}${money.amount}`;
  return `${symbol}${num.toFixed(2)}`;
}

/** Shop's IP-localized country (e.g. `"US"`). Fetched once on demand and
 *  cached — used as the fallback countryCode for gift-card apply. */
let cachedCountryCode: string | null = null;
async function loadCountryCode(): Promise<string | null> {
  if (cachedCountryCode) return cachedCountryCode;
  try {
    const data = await request<{ localization: { country: { isoCode: string | null } } }>(
      // Inlined so this file doesn't create a queries.ts dep cycle.
      `query ShopLocalization { localization { country { isoCode } } }`,
    );
    cachedCountryCode = data.localization?.country?.isoCode ?? null;
    return cachedCountryCode;
  } catch {
    return null;
  }
}

/** Fetch shop-level money settings and cache them for synchronous formatting. */
export const shop = {
  async load(): Promise<{ moneyFormat: string | null; currencyCode: string | null }> {
    try {
      const data = await request<{ shop: { moneyFormat: string | null; paymentSettings: { currencyCode: string | null } } }>(SHOP_QUERY);
      const info = {
        moneyFormat: data.shop?.moneyFormat ?? null,
        currencyCode: data.shop?.paymentSettings?.currencyCode ?? null,
      };
      setShopInfo(info);
      return info;
    } catch {
      return { moneyFormat: null, currencyCode: null };
    }
  },
  moneyFormat: getMoneyFormat,
  countryCode: loadCountryCode,
};
