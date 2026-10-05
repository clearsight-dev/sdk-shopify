// Product page logic with no React: variant selection, availability per option value, the chosen
// variant's price, stock rules, the gallery's opening slide, description parsing, CDN image sizing
// and the share link. `useVariantSelection` / `useAddToCart` / `useProductPage` (react/) are built
// on these; an app that wants its own page can use them directly, piece by piece.
import { getConfig, isConfigured } from './client';
import type { ProductBase } from './productStore';
import type { Cart, Money, Product, ProductMedia, ProductOption, ProductVariant } from './types';

/** What the page logic needs of a product: the full product, or the store's preview of it. */
export type ProductLike = ProductBase & Partial<Pick<Product, 'media' | 'onlineStoreUrl' | 'images'>>;

/** Chosen value per option name, e.g. `{ Size: 'SM', Color: 'Wine' }`. */
export type OptionSelection = Record<string, string>;

// ---------------------------------------------------------------------------
// Options and variants
// ---------------------------------------------------------------------------

/** Selectors are shown Color, then Size, then anything else (case-insensitive). */
export const DEFAULT_OPTION_ORDER: readonly string[] = ['color', 'colour', 'size'];

/**
 * Shopify gives a single-variant product a placeholder option ("Title" with the one value "Default
 * Title"). It is not a choice and must not become a selector.
 */
export function isPlaceholderOption(option: ProductOption): boolean {
  return option.values.length < 2 && (option.name === 'Title' || option.values[0] === 'Default Title');
}

export interface SelectableOptionsConfig {
  /** Option names in display order (case-insensitive); unlisted ones keep their order after these. */
  order?: readonly string[];
  /** Keep an option (default: everything but the placeholder). */
  include?: (option: ProductOption) => boolean;
}

/** The options worth a selector, in display order. */
export function selectableOptions(options: ProductOption[] | null | undefined, config: SelectableOptionsConfig = {}): ProductOption[] {
  const order = (config.order ?? DEFAULT_OPTION_ORDER).map((n) => n.toLowerCase());
  const include = config.include ?? ((o: ProductOption) => !isPlaceholderOption(o));
  const rank = (name: string) => {
    const i = order.indexOf(name.toLowerCase());
    return i === -1 ? order.length : i;
  };
  return (options ?? [])
    .filter(include)
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option.name) - rank(b.option.name) || a.index - b.index)
    .map(({ option }) => option);
}

/** The variant matching every chosen value, or null for a combination Shopify doesn't sell. */
export function findVariant(variants: ProductVariant[] | null | undefined, selection: OptionSelection): ProductVariant | null {
  return (variants ?? []).find((v) => v.selectedOptions.every((o) => selection[o.name] === o.value)) ?? null;
}

/** The first purchasable combination, so Add to Cart works without touching a selector; else the first. */
export function initialSelection(variants: ProductVariant[] | null | undefined): OptionSelection {
  const list = variants ?? [];
  const variant = list.find((v) => v.availableForSale) ?? list[0];
  return variant ? Object.fromEntries(variant.selectedOptions.map((o) => [o.name, o.value])) : {};
}

/** The selection a variant represents, e.g. to preselect a variant from a link. */
export function selectionForVariant(variant: ProductVariant | null | undefined): OptionSelection {
  return variant ? Object.fromEntries(variant.selectedOptions.map((o) => [o.name, o.value])) : {};
}

/**
 * Can't be bought now: no such combination, not for sale, or none left. A variant can be 0 left and
 * still for sale (oversell / pre-order) only if `quantityAvailable` isn't 0, so 0 is treated as gone.
 */
export function isVariantUnavailable(variant: ProductVariant | null | undefined): boolean {
  return !variant || !variant.availableForSale || variant.quantityAvailable === 0;
}

export interface OptionValueState {
  value: string;
  selected: boolean;
  /** The variant this value would select, keeping the other options as they are. */
  variant: ProductVariant | null;
  available: boolean;
  /** Units left of that variant; null when Shopify doesn't track it. */
  quantityAvailable: number | null;
}

export interface OptionState {
  name: string;
  selectedValue: string | null;
  values: OptionValueState[];
}

/**
 * Every value of every option with what choosing it would give. Stock is per combination, so a
 * Size's count follows the selected Color and vice versa.
 */
export function optionStates(
  options: ProductOption[],
  variants: ProductVariant[] | null | undefined,
  selection: OptionSelection,
  isUnavailable: (variant: ProductVariant | null) => boolean = isVariantUnavailable,
): OptionState[] {
  return options.map((option) => ({
    name: option.name,
    selectedValue: selection[option.name] ?? null,
    values: option.values.map((value) => {
      const variant = findVariant(variants, { ...selection, [option.name]: value });
      return {
        value,
        selected: selection[option.name] === value,
        variant,
        available: !isUnavailable(variant),
        quantityAvailable: variant?.quantityAvailable ?? null,
      };
    }),
  }));
}

/** "Ivory / L": the chosen values, in the options' order. */
export function selectionLabel(options: ProductOption[], selection: OptionSelection, separator = ' / '): string {
  return options
    .map((o) => selection[o.name])
    .filter(Boolean)
    .join(separator);
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

export interface VariantPrice {
  price: Money | null;
  /** Only when it is above `price`; Shopify returns "0.0" for "no compare-at". */
  compareAtPrice: Money | null;
  onSale: boolean;
}

/** The chosen variant's price; without a variant, the product's lowest. */
export function variantPrice(
  variant: ProductVariant | null | undefined,
  product?: Pick<ProductBase, 'priceRange' | 'compareAtPriceRange'> | null,
): VariantPrice {
  const price = variant?.price ?? product?.priceRange?.min ?? null;
  const compare = variant ? variant.compareAtPrice : (product?.compareAtPriceRange?.min ?? null);
  const onSale = !!price && !!compare && Number(compare.amount) > Number(price.amount);
  return { price, compareAtPrice: onSale ? compare : null, onSale };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/** "Hurry! Only a few pieces left." at or below this many units across the product. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 10;

export function isLowStock(
  totalInventory: number | null | undefined,
  availableForSale: boolean | undefined,
  threshold: number | null = DEFAULT_LOW_STOCK_THRESHOLD,
): boolean {
  if (threshold == null || !availableForSale || totalInventory == null) return false;
  return totalInventory > 0 && totalInventory <= threshold;
}

/**
 * The most of `variant` a cart may hold, or null for no ceiling. Shopify doesn't refuse an add past
 * the stock level (it answers 200 and clamps silently), so the ceiling is checked before the write.
 * null: untracked inventory, or overselling allowed (`<= 0` while still for sale, e.g. pre-order).
 */
export function stockCeiling(variant: Pick<ProductVariant, 'availableForSale' | 'quantityAvailable'> | null | undefined): number | null {
  if (!variant) return 0;
  const available = variant.quantityAvailable;
  if (available == null) return null;
  if (available <= 0) return variant.availableForSale ? null : 0;
  return available;
}

/** How many of `variantId` the cart holds, across every line (one variant can fill several). */
export function quantityInCart(cart: Pick<Cart, 'lines'> | null | undefined, variantId: string | null | undefined): number {
  if (!cart || !variantId) return 0;
  return cart.lines.reduce((n, line) => (line.merchandise.id === variantId ? n + line.quantity : n), 0);
}

/** Whether `current + by` stays within `ceiling` (null: always). */
export function withinCeiling(ceiling: number | null, current: number, by = 1): boolean {
  return ceiling == null || current + by <= ceiling;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const isVideo = (m: ProductMedia) => m.kind === 'video' || m.kind === 'external-video';

/** The gallery's opening slide: the first video when asked for (and there is one), else the first image. */
export function initialMediaIndex(media: ProductMedia[] | null | undefined, preferVideo = false): number {
  const list = media ?? [];
  if (preferVideo) {
    const v = list.findIndex(isVideo);
    if (v >= 0) return v;
  }
  const i = list.findIndex((m) => m.kind === 'image');
  return i >= 0 ? i : 0;
}

/** The first still, for a thumbnail. Videos sort first, so `media[0]` is often a video frame. */
export function firstImageUrl(product: Pick<ProductLike, 'media' | 'featuredImage'> | null | undefined): string | null {
  if (!product) return null;
  const image = (product.media ?? []).find((m) => m.kind === 'image');
  return image?.posterUrl ?? product.media?.[0]?.posterUrl ?? product.featuredImage?.url ?? null;
}

/**
 * A Shopify CDN image at a pixel width. The SDK's `imageTransform` bakes the size into the file name
 * (`photo_1080x.jpg`, `photo_200x@2x.jpg`, `photo_100x100_crop_center.jpg`), so the suffix is rewritten;
 * a URL without one (an original) gets `width=`, which the CDN also honours.
 */
const SIZE_SUFFIX = /_(\d+)?x(\d+)?(@\dx)?(_crop_[a-z]+)?(?=\.[a-z0-9]+(?:\?|$))/i;
export function sizedImageUrl(url: string | null | undefined, pixels: number): string | null {
  if (!url) return null;
  const width = Math.round(pixels);
  if (!Number.isFinite(width) || width <= 0) return url;
  if (SIZE_SUFFIX.test(url)) return url.replace(SIZE_SUFFIX, `_${width}x`);
  return `${url}${url.includes('?') ? '&' : '?'}width=${width}`;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export type DescriptionSpan = { text: string; bold: boolean };
/** A paragraph or a bullet. */
export type DescriptionBlock = { spans: DescriptionSpan[]; bullet: boolean };

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const BOLD_TAGS = new Set(['strong', 'b']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'tr']);
/** Merchants type `**bold**` / `***bold***` into the rich-text editor: a paired run is bold, markers dropped. */
const ASTERISK_EMPHASIS = /\*{2,3}([^*]+?)\*{2,3}/g;

function splitAsterisks(span: DescriptionSpan): DescriptionSpan[] {
  const out: DescriptionSpan[] = [];
  let cursor = 0;
  for (const match of span.text.matchAll(ASTERISK_EMPHASIS)) {
    const at = match.index ?? 0;
    if (at > cursor) out.push({ text: span.text.slice(cursor, at), bold: span.bold });
    out.push({ text: match[1], bold: true });
    cursor = at + match[0].length;
  }
  if (cursor === 0) return [span];
  if (cursor < span.text.length) out.push({ text: span.text.slice(cursor), bold: span.bold });
  return out;
}

function finishBlock(spans: DescriptionSpan[], bullet: boolean): DescriptionBlock | null {
  const merged = spans.flatMap(splitAsterisks).reduce<DescriptionSpan[]>((acc, span) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.bold === span.bold) prev.text += span.text;
    else acc.push({ ...span });
    return acc;
  }, []);
  // Whitespace at a block's edges is layout, not content: the gap between blocks replaces it.
  if (merged.length) {
    merged[0].text = merged[0].text.replace(/^\s+/, '');
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, '');
  }
  const kept = merged.filter((s) => s.text.length);
  return kept.some((s) => s.text.trim()) ? { spans: kept, bullet } : null;
}

/**
 * Shopify's `descriptionHtml` as paragraphs and bullets with their bold runs (the "Details:" /
 * "Fit:" labels), for nested Text rather than an HTML renderer. Plain text works too.
 */
export function parseDescriptionHtml(html: string | null | undefined): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let spans: DescriptionSpan[] = [];
  let bullet = false;
  let boldDepth = 0;
  const flush = (nextBullet = false) => {
    const block = finishBlock(spans, bullet);
    if (block) blocks.push(block);
    spans = [];
    bullet = nextBullet;
  };
  for (const [index, token] of (html ?? '').split(/(<[^>]*>)/).entries()) {
    if (!token) continue;
    if (index % 2 === 0) {
      const text = decodeEntities(token).replace(/\s+/g, ' ');
      if (text) spans.push({ text, bold: boldDepth > 0 });
      continue;
    }
    const tag = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
    if (!tag) continue;
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    if (name === 'br') flush(bullet);
    else if (BOLD_TAGS.has(name)) boldDepth = closing ? Math.max(0, boldDepth - 1) : boldDepth + 1;
    else if (BLOCK_TAGS.has(name)) flush(!closing && name === 'li');
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * The link to share: Shopify's `onlineStoreUrl` (a page a shopper can open), else
 * `https://<storeDomain>/products/<handle>`, which on a store not on the Online Store channel is the
 * myshopify host. `storeDomain` defaults to the configured one.
 */
export function productShareUrl(
  product: Pick<ProductLike, 'handle' | 'onlineStoreUrl'> | null | undefined,
  storeDomain?: string,
): string | null {
  if (!product) return null;
  if (product.onlineStoreUrl) return product.onlineStoreUrl;
  const domain = storeDomain ?? (isConfigured() ? getConfig().storeDomain : '');
  return domain ? `https://${domain}/products/${product.handle}` : null;
}
