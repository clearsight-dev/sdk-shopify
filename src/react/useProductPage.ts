/**
 * Product page hooks, from small to whole:
 *
 * - `useVariantSelection(product)`: the selection, every option value's state, the chosen variant,
 *   its price and stock. For any surface that sells a variant (a page, a buy sheet, a quick add).
 * - `useAddToCart(variant)`: add with the stock ceiling checked first, the `adding` state, the result.
 * - `useProductPage(handle)`: both, on `useProduct`'s cache-first product, plus the gallery's media,
 *   the parsed description, the favourite, the share link and, when asked, "You may also like"
 *   (`useProductRecommendations`).
 *
 * Everything is overridable: each rule takes an option, each returned section is plain data a
 * screen can ignore, and the pure helpers (`../productPage`) are there for a page of its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  firstImageUrl,
  findVariant,
  initialMediaIndex,
  initialSelection as defaultInitialSelection,
  isLowStock,
  isVariantUnavailable,
  optionStates as buildOptionStates,
  parseDescriptionHtml,
  productShareUrl,
  quantityInCart,
  selectableOptions,
  selectionForVariant,
  selectionLabel,
  stockCeiling,
  variantPrice,
  withinCeiling,
  DEFAULT_LOW_STOCK_THRESHOLD,
  type DescriptionBlock,
  type OptionSelection,
  type OptionState,
  type ProductLike,
  type VariantPrice,
} from '../productPage';
import type { AttributionSource } from '../attribution';
import type { CartLineAttribute, CartWriteResult, ImageTransform, Product, ProductMedia, ProductOption, ProductVariant } from '../types';
import { useCart, useWishlist } from './ShopifyProvider';
import { useProduct, type UseProductResult } from './useProduct';
import {
  useProductRecommendations,
  type ProductRecommendations,
  type UseProductRecommendationsOptions,
} from './useProductRecommendations';

// ---------------------------------------------------------------------------
// useVariantSelection
// ---------------------------------------------------------------------------

export interface UseVariantSelectionOptions {
  /** Option names in display order (default Color, Colour, Size, then the rest). */
  optionOrder?: readonly string[];
  /** Keep an option as a selector (default: all but Shopify's "Default Title" placeholder). */
  includeOption?: (option: ProductOption) => boolean;
  /** The selection to start on (default: the first purchasable variant, else the first). */
  initialSelection?: (variants: ProductVariant[]) => OptionSelection;
  /** Start on this variant (e.g. a link to one), when it exists. Wins over `initialSelection`. */
  initialVariantId?: string | null;
  /** Can't be bought now (default: missing, not for sale, or 0 left). */
  isUnavailable?: (variant: ProductVariant | null) => boolean;
  /** Units across the product at or below which `lowStock` is true; null turns it off. Default 10. */
  lowStockThreshold?: number | null;
  /** Between values in `label` (default " / "). */
  separator?: string;
  /** The selection starts over when this changes (default: the product's id). */
  resetKey?: string | null;
}

export interface VariantSelection {
  /** The options shown as selectors, in display order. */
  options: ProductOption[];
  /** Each option with every value's state: selected, available, units left, the variant it picks. */
  optionStates: OptionState[];
  selection: OptionSelection;
  setOption: (name: string, value: string) => void;
  selectVariant: (variantId: string) => void;
  /** Back to the initial selection. */
  reset: () => void;
  /** The variant the selection names; null while variants are unknown or for a combination not sold. */
  variant: ProductVariant | null;
  /** "Ivory / L". */
  label: string;
  /** Variants are known (always for a full product; for a preview since sdk-shopify 0.9). */
  known: boolean;
  /** The variant's price; without one, the product's lowest. */
  price: VariantPrice;
  /** The chosen variant can't be bought now (only meaningful when `known`). */
  unavailable: boolean;
  lowStock: boolean;
}

export function useVariantSelection(
  product: ProductLike | null | undefined,
  options: UseVariantSelectionOptions = {},
): VariantSelection {
  const variants = useMemo(() => product?.variants ?? [], [product?.variants]);
  const known = variants.length > 0;
  const isUnavailable = options.isUnavailable ?? isVariantUnavailable;
  const orderKey = (options.optionOrder ?? []).join('\u0001');
  const includeRef = useRef(options.includeOption);
  includeRef.current = options.includeOption;

  const selectable = useMemo(
    () => selectableOptions(product?.options, { order: options.optionOrder, include: includeRef.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [product?.options, orderKey],
  );

  const startRef = useRef(options.initialSelection);
  startRef.current = options.initialSelection;
  const initial = useMemo(() => {
    const linked = options.initialVariantId ? variants.find((v) => v.id === options.initialVariantId) : null;
    if (linked) return selectionForVariant(linked);
    return (startRef.current ?? defaultInitialSelection)(variants);
  }, [variants, options.initialVariantId]);

  const [chosen, setChosen] = useState<OptionSelection | null>(null);
  const resetKey = options.resetKey !== undefined ? options.resetKey : (product?.id ?? null);
  useEffect(() => setChosen(null), [resetKey]);

  const selection = chosen ?? initial;
  const variant = known ? findVariant(variants, selection) : null;

  const setOption = useCallback(
    (name: string, value: string) => setChosen((current) => ({ ...(current ?? initial), [name]: value })),
    [initial],
  );
  const selectVariant = useCallback(
    (variantId: string) => {
      const found = variants.find((v) => v.id === variantId);
      if (found) setChosen(selectionForVariant(found));
    },
    [variants],
  );
  const reset = useCallback(() => setChosen(null), []);

  const states = useMemo(
    () => buildOptionStates(selectable, variants, selection, isUnavailable),
    // isUnavailable is a rule, read each time; its identity isn't part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectable, variants, selection],
  );

  const threshold = options.lowStockThreshold === undefined ? DEFAULT_LOW_STOCK_THRESHOLD : options.lowStockThreshold;
  return {
    options: selectable,
    optionStates: states,
    selection,
    setOption,
    selectVariant,
    reset,
    variant,
    label: selectionLabel(selectable, selection, options.separator),
    known,
    price: variantPrice(variant, product),
    unavailable: known && (!product?.availableForSale || isUnavailable(variant)),
    lowStock: known && isLowStock(product?.totalInventory, product?.availableForSale, threshold),
  };
}

// ---------------------------------------------------------------------------
// useAddToCart
// ---------------------------------------------------------------------------

/** Why an add didn't land: the SDK's reasons, or `no-variant` (nothing chosen / not sold). */
export type AddToCartReason = NonNullable<CartWriteResult['reason']> | 'no-variant';

export interface AddToCartResult extends Omit<CartWriteResult, 'reason'> {
  reason?: AddToCartReason;
  /** Shopify refused the write; already reported as `cart:outOfStock`. */
  error?: unknown;
}

export interface AddToCartInput {
  quantity?: number;
  attributes?: CartLineAttribute[];
  sellingPlanId?: string | null;
  /**
   * Where the units came from (a live show, a replay), for the provider's `attribution`
   * (`_apptile_attribution`). Passed on to `addLine`, never to Shopify. Left out: the app's own
   * (`{ type: 'app' }`). Given to `useProductPage` / `useAddToCart`, it is every add's (SDK move 6).
   */
  source?: AttributionSource;
}

export interface UseAddToCartOptions extends AddToCartInput {
  /** The most of the variant the cart may hold (default: its stock, `stockCeiling`). null: no ceiling. */
  maxQuantity?: (variant: ProductVariant) => number | null;
  onAdded?: (result: AddToCartResult) => void;
  /** Every refusal, including ones the SDK already raised an alert for (`stock`, `limit`, `outOfStock`). */
  onRefused?: (result: AddToCartResult) => void;
}

export interface AddToCart {
  /** Add the variant (overrides apply to this add only). Never throws. */
  add: (input?: AddToCartInput) => Promise<AddToCartResult>;
  adding: boolean;
  /** Units of the variant already in the cart, across lines. */
  inCart: number;
  /** One more fits under the ceiling. */
  canAddMore: boolean;
}

export function useAddToCart(variant: ProductVariant | null | undefined, options: UseAddToCartOptions = {}): AddToCart {
  const { addLine, cart } = useCart();
  const [adding, setAdding] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ceiling = variant ? (options.maxQuantity ? options.maxQuantity(variant) : stockCeiling(variant)) : 0;
  const inCart = quantityInCart(cart, variant?.id);

  const add = useCallback(
    async (input: AddToCartInput = {}): Promise<AddToCartResult> => {
      const o = optionsRef.current;
      const done = (result: AddToCartResult) => {
        (result.ok ? o.onAdded : o.onRefused)?.(result);
        return result;
      };
      if (!variant) return done({ ok: false, reason: 'no-variant', cart });
      const max = o.maxQuantity ? o.maxQuantity(variant) : stockCeiling(variant);
      setAdding(true);
      try {
        const result = await addLine({
          merchandiseId: variant.id,
          quantity: input.quantity ?? o.quantity ?? 1,
          attributes: input.attributes ?? o.attributes,
          sellingPlanId: input.sellingPlanId ?? o.sellingPlanId,
          maxQuantity: max,
          source: input.source ?? o.source,
        });
        return done(result);
      } catch (error) {
        // Shopify refused the line: the provider has raised cart:outOfStock already.
        return done({ ok: false, reason: 'outOfStock', error, cart });
      } finally {
        setAdding(false);
      }
    },
    [variant, addLine, cart],
  );

  return { add, adding, inCart, canAddMore: !!variant && withinCeiling(ceiling, inCart, 1) };
}

// ---------------------------------------------------------------------------
// useProductPage
// ---------------------------------------------------------------------------

export interface UseProductPageOptions extends UseVariantSelectionOptions, UseAddToCartOptions {
  /** For every image of the product read (e.g. `{ maxWidth: 1080 }` for a full-width gallery). */
  imageTransform?: ImageTransform;
  onError?: (error: unknown, context: { at: string; handle: string }) => void;
  /** Open the gallery on the first video. */
  playVideo?: boolean;
  /** The product can't be bought at all (e.g. live in an auction): `status: 'blocked'`. */
  isBlocked?: (product: ProductLike) => boolean;
  /**
   * Parse the description: true (default), false to wait (e.g. until after the screen's
   * transition), or your own parser.
   */
  parseDescription?: boolean | ((html: string) => DescriptionBlock[]);
  /** Called once per product, when the full product is in hand (e.g. a productView event). */
  onView?: (product: Product) => void;
  /** For the share link's fallback (default: the configured store). */
  storeDomain?: string;
  /**
   * "You may also like": Shopify's related products, read when this is true (or options). Below the
   * fold, so a page usually passes it once settled. Leaves out the product itself and anything
   * `isBlocked` says can't be bought, unless `exclude` is given. Unset: nothing is read.
   */
  recommendations?: boolean | UseProductRecommendationsOptions;
}

/**
 * - `loading`: nothing known yet. `available` / `unavailable`: the chosen variant can or can't be
 *   bought (unavailable is the waitlist case). `blocked`: `isBlocked` said no. `unknown`: a preview
 *   from before sdk-shopify 0.9, without variants, until the full product lands.
 */
export type ProductPageStatus = 'loading' | 'unknown' | 'available' | 'unavailable' | 'blocked';

export interface ProductPage extends Omit<UseProductResult, 'product' | 'preview'> {
  /** The full product, once read. */
  product: Product | null;
  /** The store's preview (card keys, variants, description): render it while `product` is null. */
  preview: UseProductResult['preview'];
  /** `product ?? preview`: what to render now. */
  shown: ProductLike | null;
  status: ProductPageStatus;
  selection: VariantSelection;
  cart: AddToCart;
  media: {
    /** The gallery (from the full product; empty until then). */
    items: ProductMedia[];
    /** The slide to open on. */
    initialIndex: number;
    /** The first still image, for a thumbnail (the preview's featured image until the full product). */
    firstImageUrl: string | null;
    /** The image the device already has (the card's): draw it first. */
    previewImageUrl: string | null;
  };
  description: { html: string; blocks: DescriptionBlock[] };
  favorite: { isFavorite: boolean; toggle: () => Promise<boolean> };
  shareUrl: string | null;
  /** "You may also like" (empty unless `recommendations` asked for them). */
  recommendations: ProductRecommendations;
}

export function useProductPage(handle: string | null | undefined, options: UseProductPageOptions = {}): ProductPage {
  const result = useProduct(handle, { imageTransform: options.imageTransform, onError: options.onError });
  const { product, preview } = result;
  const shown: ProductLike | null = product ?? preview ?? null;

  const selection = useVariantSelection(shown, { ...options, resetKey: options.resetKey !== undefined ? options.resetKey : (handle ?? null) });
  const cart = useAddToCart(selection.variant, options);
  const wishlist = useWishlist();

  // Once per product, when the full product lands.
  const viewed = useRef<string | null>(null);
  const onViewRef = useRef(options.onView);
  onViewRef.current = options.onView;
  useEffect(() => {
    if (!product || viewed.current === product.id) return;
    viewed.current = product.id;
    onViewRef.current?.(product);
  }, [product]);

  const html = shown?.descriptionHtml || shown?.description || '';
  const parse = options.parseDescription ?? true;
  const blocks = useMemo(
    () => (parse === false ? [] : typeof parse === 'function' ? parse(html) : parseDescriptionHtml(html)),
    [parse, html],
  );

  const blocked = !!shown && !!options.isBlocked?.(shown);
  const status: ProductPageStatus = !shown
    ? 'loading'
    : blocked
      ? 'blocked'
      : !selection.known
        ? 'unknown'
        : selection.unavailable
          ? 'unavailable'
          : 'available';

  const toggle = useCallback(() => (shown ? wishlist.toggle(product ?? shown.id) : Promise.resolve(false)), [wishlist, product, shown]);

  const asked = options.recommendations;
  const recommendationOptions: UseProductRecommendationsOptions = typeof asked === 'object' ? asked : {};
  const isBlocked = options.isBlocked;
  const recommendations = useProductRecommendations(shown?.id, {
    ...recommendationOptions,
    enabled: !!asked && (recommendationOptions.enabled ?? true),
    exclude: recommendationOptions.exclude ?? (isBlocked ? (p) => isBlocked(p) : undefined),
    onError: recommendationOptions.onError ?? (options.onError ? (error, ctx) => options.onError!(error, { at: ctx.at, handle: handle ?? '' }) : undefined),
  });

  return {
    ...result,
    product,
    preview,
    shown,
    status,
    selection,
    cart,
    media: {
      items: product?.media ?? [],
      initialIndex: product ? initialMediaIndex(product.media, options.playVideo) : 0,
      firstImageUrl: product ? firstImageUrl(product) : (preview?.featuredImage?.url ?? null),
      previewImageUrl: preview?.featuredImage?.url ?? null,
    },
    description: { html, blocks },
    favorite: { isFavorite: !!shown && wishlist.has(shown.id), toggle },
    shareUrl: productShareUrl(product ?? shown, options.storeDomain),
    recommendations,
  };
}
