import type { Money } from './types';
import { request, getMoneyFormat, getCurrencyCode, setShopInfo } from './client';
import { SHOP_QUERY } from './queries';

const SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: '$', AUD: '$',
};

/**
 * Symbols more than one currency uses. On a money that is not the shop's own, `$` alone repeats the
 * very mistake the template path makes — so these carry their ISO code as well.
 */
const AMBIGUOUS_SYMBOLS = new Set(['$', '¥']);

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Renders one Liquid money placeholder, honouring Shopify's money_format tokens. */
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

/** Applies a `moneyFormat` template, e.g. `"Rs. {{amount}}"`. */
export function applyMoneyFormat(template: string, amount: number): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, token) => renderAmount(amount, token));
}

/**
 * Falls back to a leading currency symbol until the shop's template has loaded — and for any money
 * that is not in the shop's own currency.
 *
 * **The shop's `moneyFormat` hardcodes the shop's currency**: a USD store's is `${{amount}}`, with
 * no token for the code. Applying it to a `Money` that carries another currency prints `$14,600.00`
 * for `14600.0 INR` — a rupee amount wearing a dollar sign, which is worse than an unformatted
 * number because it looks right. A cart's market is fixed when the cart is created, so a customer
 * whose address puts them in another market really does get one of these.
 */
export function formatMoney(money: Money | null | undefined): string {
  if (!money) return '';
  const num = Number(money.amount);
  const template = getMoneyFormat();
  const shopCurrency = getCurrencyCode();
  // No code on either side means nothing to disagree about — the template is still the shop's own
  // formatting, and is what renders before `shop.load()` resolves.
  const isShopCurrency = !shopCurrency || !money.currencyCode || money.currencyCode === shopCurrency;
  if (template && isShopCurrency && !Number.isNaN(num)) return applyMoneyFormat(template, num);

  const symbol = SYMBOLS[money.currencyCode] ?? `${money.currencyCode} `;
  const suffix =
    !isShopCurrency && AMBIGUOUS_SYMBOLS.has(symbol) ? ` ${money.currencyCode}` : '';
  if (Number.isNaN(num)) return `${symbol}${money.amount}${suffix}`;
  // Grouped the way the template would have grouped it — `14600.00` is hard to read as a price.
  return `${symbol}${renderAmount(num, 'amount')}${suffix}`;
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
