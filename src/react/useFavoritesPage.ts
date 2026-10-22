import { useCallback, useMemo, useRef, useState } from "react";
import type { Product, WishlistItem } from "../types";
import { useShopify, useWishlist } from "./ShopifyProvider";

export interface FavoritesPage {
  /**
   * `loading`: the stored list, or saved products still being filled in with nothing to show yet.
   * `empty`: nothing saved, or nothing saved the store still has. `failed`: filling in failed with
   * nothing to show. `ready`.
   */
  status: "loading" | "empty" | "failed" | "ready";
  /** Saved products the store still has, newest first; with `showGone`, those it no longer has too. */
  products: Product[];
  /**
   * With `showGone` (0.23.0): the ids in `products` the store no longer has, drawn from what the device
   * saved (title, photo, price), not for sale. For a card that opens nothing and can still be removed.
   */
  goneIds: string[];
  /** Fills in the saved products again (the failed state's Try again). */
  retry: () => void;
  /**
   * Call each time the page comes into view: fills in any saved product still missing (offline at
   * launch, or saved by id). Never on every change, so a failure waits for the next visit or a retry
   * rather than looping. Keeps one identity.
   */
  viewed: () => void;
}

export interface UseFavoritesPageOptions {
  /**
   * Keep saved products the store no longer has (a deleted or unpublished product, which Storefront can't
   * tell apart) as cards from what the device saved, in `goneIds` (0.23.0). Needs the provider's
   * `wishlistKeepDeleted`, which keeps their entries. Default: false, they aren't shown.
   */
  showGone?: boolean;
}

/** A saved entry the store no longer has, as a card's product: its saved title, photo and price, not for sale. */
function savedProduct(item: WishlistItem): Product | null {
  const { handle, title, image, price } = item.basic;
  if (!title) return null;
  const money = price ?? { amount: "0", currencyCode: "" };
  const photo = image ? { url: image, altText: title, width: null, height: null } : null;
  return {
    id: item.productId, handle: handle ?? "", title, description: "", descriptionHtml: "", vendor: "", productType: "",
    tags: [], totalInventory: 0, availableForSale: false, priceRange: { min: money, max: money }, compareAtPriceRange: null,
    options: [], variants: [], images: photo ? [photo] : [], featuredImage: photo, onlineStoreUrl: null,
    mediaContentTypes: [], hasVideo: false, media: [], metafields: {}, rating: null, updatedAt: "", createdAt: "",
  };
}

/**
 * A favourites page (0.15.0, moved from amore-v2's `useFavoritesPage`): the wishlist, kept on the
 * device with each saved product so it draws offline; every star in the app writes to it, and the
 * provider fills the products in at launch.
 */
export function useFavoritesPage(options: UseFavoritesPageOptions = {}): FavoritesPage {
  const { showGone = false } = options;
  const { ready } = useShopify();
  const { items, refresh } = useWishlist();
  const [filling, setFilling] = useState(false);
  const [failed, setFailed] = useState(false);

  // Saved order, newest first. `null` is a product the store no longer has; `undefined`, one not filled in yet.
  const { products, goneIds } = useMemo(() => {
    const gone: string[] = [];
    const list = items.flatMap((item) => {
      if (item.product) return [item.product];
      const saved = showGone && item.product === null ? savedProduct(item) : null;
      if (!saved) return [];
      gone.push(saved.id);
      return [saved];
    });
    return { products: list, goneIds: gone };
  }, [items, showGone]);
  const missing = items.some((item) => item.product === undefined);

  const retry = useCallback(() => {
    setFilling(true);
    setFailed(false);
    refresh()
      .catch(() => setFailed(true))
      .finally(() => setFilling(false));
  }, [refresh]);

  // Read through a ref, so a later visit sees how things are then.
  const latest = useRef({ ready, missing, filling });
  latest.current = { ready, missing, filling };
  const viewed = useCallback(() => {
    const now = latest.current;
    if (now.ready && now.missing && !now.filling) retry();
  }, [retry]);

  let status: FavoritesPage["status"];
  if (!ready || (products.length === 0 && missing && !failed)) status = "loading";
  else if (products.length === 0 && !missing) status = "empty";
  else if (products.length === 0) status = "failed";
  else status = "ready";

  return { status, products, goneIds, retry, viewed };
}
