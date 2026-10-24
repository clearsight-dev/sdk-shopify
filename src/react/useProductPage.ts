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
  mediaIndexOf,
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
import { cartLineFacts, isVariantHeldOut } from '../cartPage';
import { preorderPlanFor, purchaseModeFor, type PurchaseMode } from '../purchaseRules';
import type { CartLine, CartLineAttribute, CartWriteResult, Customer, ImageTransform, MetafieldIdentifier, Product, ProductMedia, ProductOption, ProductVariant } from '../types';
import { useCart, useCustomer, useShopify, useWaitlist, useWishlist } from './ShopifyProvider';
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
  /**
   * The product can't be bought at all (an auction), so no value's state is a `preorder` (0.19.0).
   * `useProductPage` sets it from `isBlocked`.
   */
  blocked?: boolean;
}

export interface VariantSelection {
  /** The options shown as selectors, in display order. */
  options: ProductOption[];
  /** Each option with every value's state: selected, available, units left, pre-order, the variant it picks. */
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
  /**
   * The gallery slide showing the chosen variant's photo (`mediaIndexOf` over the product's `media`);
   * null when it has none, or the photo isn't in the gallery (0.14.0).
   */
  mediaIndex: number | null;
  /**
   * How many times the shopper has picked (`setOption`, `selectVariant`), 0 until the first and again
   * after `reset` or a new product (0.14.0). A gallery that follows each pick moves on every new count,
   * the same variant picked again included, and never on the page's opening or a product's reload.
   */
  pickCount: number;
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
  const [pickCount, setPickCount] = useState(0);
  const resetKey = options.resetKey !== undefined ? options.resetKey : (product?.id ?? null);
  useEffect(() => {
    setChosen(null);
    setPickCount(0);
  }, [resetKey]);

  const selection = chosen ?? initial;
  const variant = known ? findVariant(variants, selection) : null;

  const setOption = useCallback(
    (name: string, value: string) => {
      setChosen((current) => ({ ...(current ?? initial), [name]: value }));
      setPickCount((count) => count + 1);
    },
    [initial],
  );
  const selectVariant = useCallback(
    (variantId: string) => {
      const found = variants.find((v) => v.id === variantId);
      if (!found) return;
      setChosen(selectionForVariant(found));
      setPickCount((count) => count + 1);
    },
    [variants],
  );
  const reset = useCallback(() => {
    setChosen(null);
    setPickCount(0);
  }, []);

  const blocked = options.blocked ?? false;
  const states = useMemo(
    () => buildOptionStates(selectable, variants, selection, isUnavailable, { blocked }),
    // isUnavailable is a rule, read each time; its identity isn't part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectable, variants, selection, blocked],
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
    mediaIndex: mediaIndexOf(product?.media, variant?.image?.url),
    pickCount,
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
// useVariantHeldOut
// ---------------------------------------------------------------------------

/**
 * Every unit of this variant is in other shoppers' carts right now, though Shopify still sells it: the
 * provider's `cartExtensions` say so (Cart Hold's `cartHoldExtension({ client })`: refused as sold out
 * within the last minute). Follows their answers as they change (0.15.0). False without such an extension.
 */
export function useVariantHeldOut(variantId: string | null | undefined): boolean {
  const extensions = useShopify().cartPage.extensions;
  const [, setChanges] = useState(0);
  useEffect(() => {
    const stops = extensions.map((extension) => {
      try {
        return extension.subscribeHeldOut?.(() => setChanges((count) => count + 1));
      } catch (error) {
        console.warn(`[cartExtensions] ${extension.name} failed`, error);
        return undefined;
      }
    });
    return () => stops.forEach((stop) => stop?.());
  }, [extensions]);
  return isVariantHeldOut(variantId, extensions);
}

// ---------------------------------------------------------------------------
// useProductPage
// ---------------------------------------------------------------------------

/** What `ProductPage.purchase.joinWaitlist` did, for `onJoinedWaitlist`. */
export interface JoinedWaitlist {
  product: ProductLike;
  variant: ProductVariant;
  /** This tap added it; false when the shopper was already waiting on it. */
  added: boolean;
  /**
   * What the shopper waits for: `otherCarts` for a size every unit of which is in other carts (it comes
   * back when they let go), `restock` for any other (a pre-order's included: sold out at Shopify).
   */
  waitingFor: 'restock' | 'otherCarts';
  /** Who joined. */
  customer: Customer | null;
}

/**
 * Buying the chosen size (0.15.0, moved from amore-v2's `useProductPurchase`): what a buy bar offers
 * and what its buttons do.
 */
export interface ProductPurchase {
  /**
   * What the bar offers (`purchaseModeFor`): `blocked` (an auction) over `preorder` over `soldOut` over
   * `heldInOtherCarts` (the provider's `cartExtensions`, `useVariantHeldOut`) over `allInCart` over `buy`.
   */
  mode: PurchaseMode;
  /**
   * The size's units in the cart that a stepper counts: for a pre-order, only its pre-order lines;
   * never a giveaway prize (an extension's `prize`), whose unit wasn't bought.
   */
  inCartCount: number;
  /** A − is running. */
  updating: boolean;
  /** Add to Cart: one of the size (refused past its stock, with the SDK's alert). */
  add: () => void;
  /** Preauthorize Now: one on the size's pre-order plan, so checkout authorises rather than takes the payment. */
  preorder: () => void;
  /** A stepper's +: one more on the plan for a pre-order, else `add`. */
  increase: () => void;
  /**
   * A stepper's −: one off the size's last counted line (one added during a live show can sit on a line
   * of its own); at 1 the line goes. A refusal raises `cart:updateFailed`.
   */
  removeOne: () => void;
  /**
   * Add to Waitlist / Notify Me. Signed out: `onSignInNeeded` (the shopper taps again once signed in).
   * Signed in: adds the size to the waitlist unless it's already there (never a toggle: removing is the
   * waitlist's own), then `onJoinedWaitlist`.
   */
  joinWaitlist: () => void;
}

/** What an add on a product page was of, for `UseProductPageOptions.onAdded` (0.15.0). */
export interface ProductPageAdd {
  product: ProductLike | null;
  variant: ProductVariant | null;
}

export interface UseProductPageOptions extends Omit<UseVariantSelectionOptions, 'blocked'>, Omit<UseAddToCartOptions, 'onAdded'> {
  /**
   * An add that landed, with what it was of (0.15.0: a show's analytics, a live room's announcement, a
   * "Success!" sheet). `onRefused` has every refusal.
   */
  onAdded?: (result: AddToCartResult, added: ProductPageAdd) => void;
  /** For every image of the product read (e.g. `{ maxWidth: 1080 }` for a full-width gallery). */
  imageTransform?: ImageTransform;
  onError?: (error: unknown, context: { at: string; handle: string }) => void;
  /** Metafields only this page needs (0.23.0; `useProduct`): read each time it opens, kept to this page. */
  metafields?: readonly MetafieldIdentifier[];
  variantMetafields?: readonly MetafieldIdentifier[];
  /** Open the gallery on the first video. */
  playVideo?: boolean;
  /**
   * The product can't be bought at all (e.g. live in an auction): `status: 'blocked'`, and no option
   * value is a `preorder`.
   */
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
  /** `purchase.joinWaitlist` while signed out: the app starts its sign-in (0.15.0). */
  onSignInNeeded?: () => void;
  /** `purchase.joinWaitlist` is done: the app reports it and shows the waitlist (0.15.0). */
  onJoinedWaitlist?: (joined: JoinedWaitlist) => void;
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
  /** Buying the chosen size: the bar's mode and its buttons (0.15.0). */
  purchase: ProductPurchase;
}

export function useProductPage(handle: string | null | undefined, options: UseProductPageOptions = {}): ProductPage {
  const result = useProduct(handle, {
    imageTransform: options.imageTransform,
    onError: options.onError,
    metafields: options.metafields,
    variantMetafields: options.variantMetafields,
  });
  const { product, preview } = result;
  const shown: ProductLike | null = product ?? preview ?? null;

  const blocked = !!shown && !!options.isBlocked?.(shown);
  const selection = useVariantSelection(shown, {
    ...options,
    resetKey: options.resetKey !== undefined ? options.resetKey : (handle ?? null),
    blocked,
  });
  // What an add was of, read when it lands: the callback is handed over before the page has them.
  const addedOf = useRef<ProductPageAdd>({ product: null, variant: null });
  addedOf.current = { product: shown, variant: selection.variant };
  const onAddedRef = useRef(options.onAdded);
  onAddedRef.current = options.onAdded;
  const cart = useAddToCart(selection.variant, {
    ...options,
    onAdded: (result) => onAddedRef.current?.(result, addedOf.current),
  });
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

  const purchase = useProductPurchase({ shown, status, selection, cart }, options);

  return {
    ...result,
    product,
    preview,
    shown,
    status,
    selection,
    cart,
    purchase,
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

export interface UseProductPurchaseOptions {
  /** `joinWaitlist` while signed out: the app starts its sign-in. */
  onSignInNeeded?: () => void;
  /** `joinWaitlist` is done: the app reports it and shows the waitlist. */
  onJoinedWaitlist?: (joined: JoinedWaitlist) => void;
}

/**
 * `ProductPage.purchase` from a page's parts (0.15.0): for a page of the app's own that has its own
 * product, selection and add (`useVariantSelection`, `useAddToCart`).
 */
export function useProductPurchase(
  { shown, status, selection, cart: addToCart }: { shown: ProductLike | null; status: ProductPageStatus; selection: VariantSelection; cart: AddToCart },
  options: UseProductPurchaseOptions = {},
): ProductPurchase {
  const { cartPage, report } = useShopify();
  const { cart, updateLine, removeLine } = useCart();
  const { loggedIn, customer } = useCustomer();
  const waitlist = useWaitlist();
  const variant = selection.variant;
  const heldInOtherCarts = useVariantHeldOut(variant?.id);
  const [updating, setUpdating] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mode = purchaseModeFor({ status, variant, canAddMore: addToCart.canAddMore, heldInOtherCarts });
  const preorderPlan = preorderPlanFor(variant, { blocked: status === 'blocked' });
  const extensions = cartPage.extensions;
  const sizeLines = useMemo<CartLine[]>(
    () =>
      cart?.lines.filter(
        (line) =>
          line.merchandise.id === variant?.id &&
          (!preorderPlan || !!line.sellingPlanId) &&
          !cartLineFacts(line, cart, extensions).prize,
      ) ?? [],
    [cart, variant?.id, preorderPlan, extensions],
  );
  const sizeLinesRef = useRef(sizeLines);
  sizeLinesRef.current = sizeLines;

  const addOne = addToCart.add;
  const add = useCallback(() => void addOne(), [addOne]);
  const planId = preorderPlan?.id ?? null;
  const preorder = useCallback(() => {
    if (planId) void addOne({ sellingPlanId: planId });
  }, [addOne, planId]);

  const updatingRef = useRef(false);
  const removeOne = useCallback(() => {
    const line = sizeLinesRef.current[sizeLinesRef.current.length - 1];
    if (!line || updatingRef.current) return;
    updatingRef.current = true;
    setUpdating(true);
    void (async () => {
      try {
        if (line.quantity > 1) await updateLine(line.id, line.quantity - 1);
        else await removeLine(line.id);
      } catch (error) {
        report('cart:updateFailed', { error });
      } finally {
        updatingRef.current = false;
        setUpdating(false);
      }
    })();
  }, [updateLine, removeLine, report]);

  const joinWaitlist = useCallback(() => {
    const { onSignInNeeded, onJoinedWaitlist } = optionsRef.current;
    if (!loggedIn) {
      onSignInNeeded?.();
      return;
    }
    if (!variant || !shown) return;
    const added = !waitlist.has(variant.id);
    if (added) void waitlist.add({ variantId: variant.id, productId: shown.id, productHandle: shown.handle });
    onJoinedWaitlist?.({
      product: shown,
      variant,
      added,
      waitingFor: heldInOtherCarts && !preorderPlan ? 'otherCarts' : 'restock',
      customer,
    });
  }, [loggedIn, variant, shown, waitlist, heldInOtherCarts, preorderPlan, customer]);

  return {
    mode,
    inCartCount: sizeLines.reduce((units, line) => units + line.quantity, 0),
    updating,
    add,
    preorder,
    increase: preorderPlan ? preorder : add,
    removeOne,
    joinWaitlist,
  };
}
