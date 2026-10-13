import { useCallback, useRef, useState } from "react";
import type { AttributionSource } from "../attribution";
import { stockCeiling } from "../productPage";
import type { CartLineAttribute, Product, ProductVariant } from "../types";
import { useCart } from "./ShopifyProvider";

/** What credits a quick add to a show. Every field is optional; without any, an add is the app's own. */
export interface QuickAddCredit {
  /** Put on the cart line (`_replay_id`, `_stream_id`), so the order carries the show. */
  lineAttributes?: CartLineAttribute[];
  /** Where the units came from, for the provider's `attribution` (`_apptile_attribution`). */
  source?: AttributionSource;
}

export interface UseQuickAddOptions {
  /** What credits each add: one for every product, or one per product (a live show's lot numbers). Read at the tap. */
  credit?: QuickAddCredit | ((product: Product) => QuickAddCredit);
  /**
   * A product with a choice to make (more than one variant, or its one variant not for sale): the app
   * opens its variant page to choose.
   */
  onChooseVariant?: (product: Product) => void;
  /** An add that landed (a show's analytics, a live room's announcement). */
  onAdded?: (product: Product, variant: ProductVariant) => void;
}

export interface QuickAdd {
  /** A product card's Add to Cart. */
  add: (product: Product) => void;
  /** Products whose add is on its way: their cards show a spinner and take no second tap. */
  addingProductIds: string[];
}

/**
 * Add to Cart from a product card (0.15.0, moved from amore-v2's `useQuickAdd`). A product with one
 * variant, for sale, has nothing to choose, so it is added here with its stock as the ceiling (the
 * provider's "Added to cart" alert, or its refusal, follows). Every other product goes to
 * `onChooseVariant`. A card has already turned its button off for a product that can't be bought.
 */
export function useQuickAdd(options: UseQuickAddOptions = {}): QuickAdd {
  const { addLine } = useCart();
  const [addingProductIds, setAddingProductIds] = useState<string[]>([]);
  // Read at the tap, so `add` keeps one identity while the screen's credit and routes change.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const add = useCallback(
    (product: Product) => {
      const { credit, onChooseVariant, onAdded } = optionsRef.current;
      const [onlyVariant, ...otherVariants] = product.variants;
      if (!onlyVariant || otherVariants.length > 0 || !onlyVariant.availableForSale) {
        onChooseVariant?.(product);
        return;
      }
      const productCredit = (typeof credit === "function" ? credit(product) : credit) ?? {};
      const attributes = productCredit.lineAttributes?.length ? productCredit.lineAttributes : undefined;
      setAddingProductIds((adding) => [...adding, product.id]);
      void (async () => {
        try {
          const result = await addLine({
            merchandiseId: onlyVariant.id,
            quantity: 1,
            maxQuantity: stockCeiling(onlyVariant),
            attributes,
            ...(productCredit.source ? { source: productCredit.source } : {}),
          });
          if (result.ok) onAdded?.(product, onlyVariant);
        } catch {
          // The provider has already raised the failed add's alert.
        } finally {
          setAddingProductIds((adding) => adding.filter((id) => id !== product.id));
        }
      })();
    },
    [addLine],
  );

  return { add, addingProductIds };
}
