import { useCallback, useMemo, useRef, useState } from "react";
import type { Product } from "../types";
import { useShopify, useWishlist } from "./ShopifyProvider";

export interface FavoritesPage {
  /**
   * `loading`: the stored list, or saved products still being filled in with nothing to show yet.
   * `empty`: nothing saved, or nothing saved the store still has. `failed`: filling in failed with
   * nothing to show. `ready`.
   */
  status: "loading" | "empty" | "failed" | "ready";
  /** Saved products the store still has, newest first. */
  products: Product[];
  /** Fills in the saved products again (the failed state's Try again). */
  retry: () => void;
  /**
   * Call each time the page comes into view: fills in any saved product still missing (offline at
   * launch, or saved by id). Never on every change, so a failure waits for the next visit or a retry
   * rather than looping. Keeps one identity.
   */
  viewed: () => void;
}

/**
 * A favourites page (0.15.0, moved from amore-v2's `useFavoritesPage`): the wishlist, kept on the
 * device with each saved product so it draws offline; every star in the app writes to it, and the
 * provider fills the products in at launch.
 */
export function useFavoritesPage(): FavoritesPage {
  const { ready } = useShopify();
  const { items, refresh } = useWishlist();
  const [filling, setFilling] = useState(false);
  const [failed, setFailed] = useState(false);

  // Saved order, newest first. `null` is a product the store no longer has; `undefined`, one not filled in yet.
  const products = useMemo(() => items.map((item) => item.product).filter((product): product is Product => !!product), [items]);
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

  return { status, products, retry, viewed };
}
