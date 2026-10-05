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

/**
 * An amount a shopper typed, in whole cents, or null when it isn't one. For a field where money is
 * typed, so the field and whoever acts on it read it the same way.
 *
 * - **Accepted:** `1500`, `1,500`, `1500.5`, `$1,500.00`, ` 25 `, `€12,50` (a comma before one or two
 *   final digits is a decimal comma, as a phone's decimal key types in some regions), `1.500,00`. A
 *   currency sign or a space anywhere is ignored. More than two decimals round to the nearest cent.
 * - **Refused (null):** nothing typed, a letter (`12abc`, `USD 10`), a minus sign, two decimal points
 *   (`1.2.3`), or a number too long to be money.
 * - **Grouping:** with both `,` and `.`, the last one is the decimal point and the other groups. One
 *   `,` before exactly three digits groups (`1,500` is 1500, which old Amore read as 1.5), and so do
 *   several (`1,500,000`). A `.` alone is always the decimal point (`1.500` is 1.5).
 *
 * Zero is an answer (0), not an error: whoever acts on it decides that zero can't be applied.
 */
export function typedAmountToCents(typed: string | null | undefined): number | null {
  if (typeof typed !== 'string') return null;
  const text = typed.trim();
  if (!text || /[A-Za-z]/.test(text) || /[-\u2212]/.test(text)) return null;
  const kept = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(kept)) return null;

  const lastDot = kept.lastIndexOf('.');
  const lastComma = kept.lastIndexOf(',');
  const dots = kept.split('.').length - 1;
  const commas = kept.split(',').length - 1;
  let decimalAt = -1;
  if (dots > 0 && commas > 0) {
    // The last mark is the decimal point, so it appears once; the other one only groups.
    decimalAt = Math.max(lastDot, lastComma);
    if (kept.split(kept[decimalAt]).length - 1 > 1) return null;
  } else if (dots > 1) {
    return null;
  } else if (dots === 1) {
    decimalAt = lastDot;
  } else if (commas === 1) {
    decimalAt = kept.length - lastComma - 1 === 3 ? -1 : lastComma;
  }

  const whole = (decimalAt === -1 ? kept : kept.slice(0, decimalAt)).replace(/[.,]/g, '');
  const fraction = decimalAt === -1 ? '' : kept.slice(decimalAt + 1);
  if (/[.,]/.test(fraction)) return null;
  if (whole.length > 13) return null;
  const firstThree = (fraction + '000').slice(0, 3);
  const cents = Number(whole || '0') * 100 + Math.round(Number(firstThree) / 10);
  return Number.isSafeInteger(cents) ? cents : null;
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
