/**
 * The app's own discount code (SDK move 6): a code the store keeps for orders from the app (an
 * app-only discount), put on the cart from the app's settings rather than typed by the shopper.
 * Moved from amore-v2's and amber-v2's cart pages, which had the same lines.
 */
import { useEffect, useRef } from 'react';
import { useCart } from './ShopifyProvider';

export interface UseAppDiscountCodeOptions {
  /**
   * The write failed (offline, or Shopify answered with `userErrors`). That code isn't tried again on
   * that cart while this hook stays mounted. A code that doesn't apply to the cart usually comes back
   * on it with `applicable: false`, which isn't an error.
   */
  onError?: (error: unknown) => void;
}

/**
 * Puts `code` on the cart, once per cart and code, keeping the codes already on it
 * (`applyDiscountCodes` replaces the whole set). A code already on the cart is left as it is; letter
 * case doesn't matter, and spaces around the code are ignored. An empty code, or no cart yet, does
 * nothing.
 *
 * Runs only while the calling screen is mounted: amore-v2 and amber-v2 call it from the Cart, so the
 * code goes on when the shopper opens the cart.
 */
export function useAppDiscountCode(code: string | null | undefined, options: UseAppDiscountCodeOptions = {}): void {
  const { cart, applyDiscountCodes } = useCart();
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  // `cartId:code` pairs already tried by this hook.
  const tried = useRef(new Set<string>());
  const cartId = cart?.id;
  const wanted = typeof code === 'string' ? code.trim() : '';

  useEffect(() => {
    const current = cartRef.current;
    if (!wanted || !current || !cartId) return;
    const key = `${cartId}:${wanted.toLowerCase()}`;
    if (tried.current.has(key)) return;
    tried.current.add(key);
    const codesOnCart = current.discountCodes.map((entry) => entry.code);
    if (codesOnCart.some((onCart) => onCart.toLowerCase() === wanted.toLowerCase())) return;
    applyDiscountCodes([...codesOnCart, wanted]).catch((error) => onErrorRef.current?.(error));
  }, [cartId, wanted, applyDiscountCodes]);
}
