import { useCallback, useMemo, useRef, useState } from "react";
import { parsePriceFilterInput } from "../filters";
import { stockCeiling } from "../productPage";
import { waitlistActionFor, type WaitlistAction } from "../purchaseRules";
import type { StandaloneVariant } from "../types";
import { useCart, useShopify, useWaitlist } from "./ShopifyProvider";

/** The waitlist's Status filter values (0.15.0): a filter sheet hands them back as `selectedFilters`. */
export const WAITLIST_READY_FILTER = JSON.stringify({ waitlistStatus: "ready" });
export const WAITLIST_WAITING_FILTER = JSON.stringify({ waitlistStatus: "waiting" });

/** One size on the waitlist, as its card shows it. */
export interface WaitlistPageItem {
  /** The variant's id: the list's key. */
  id: string;
  variant: StandaloneVariant;
  /** When the shopper joined, in ms; 0 for an entry an earlier app stored without a date. */
  addedAt: number;
  /** What the card's footer offers (`waitlistActionFor`): `blocked` is a product under auction. */
  action: WaitlistAction;
  /** An add from this card is on its way. */
  busy: boolean;
}

/**
 * Ready for you: a size the shopper can buy now, or already has in the cart ("In your cart" counts as
 * ready: decided 2026-10-08, Head of Engineering, amore-v2). Everything else still waits, a size being
 * auctioned included.
 */
export function isWaitlistReady(action: WaitlistAction): boolean {
  return action === "preorder" || action === "addToCart" || action === "inCart";
}

/** Sizes ready for you first, each group in the order given (the waitlist's, newest first). */
export function readyFirst<T extends { action: WaitlistAction }>(items: T[]): T[] {
  return [...items.filter((item) => isWaitlistReady(item.action)), ...items.filter((item) => !isWaitlistReady(item.action))];
}

/** A size's price as a number, for the price filter; null for one that isn't known or isn't a number. */
function priceAmountOf(variant: StandaloneVariant): number | null {
  const text = variant.price?.amount;
  if (typeof text !== 'string' || text.trim() === '') return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * The sizes the shopper's filters leave, in the order given. Status keeps the ticked groups (none
 * ticked keeps both); price keeps a size within the range, either end open. A filter it doesn't know
 * is ignored rather than emptying the list.
 */
export function filterWaitlist<T extends { action: WaitlistAction; variant: StandaloneVariant }>(items: T[], selectedFilters: readonly string[]): T[] {
  const wantsReady = selectedFilters.includes(WAITLIST_READY_FILTER);
  const wantsWaiting = selectedFilters.includes(WAITLIST_WAITING_FILTER);
  const price = selectedFilters.map(parsePriceFilterInput).find((range) => range !== null) ?? null;
  return items.filter((item) => {
    if (wantsReady !== wantsWaiting && isWaitlistReady(item.action) !== wantsReady) return false;
    const amount = priceAmountOf(item.variant);
    if (price && amount !== null) {
      if (price.min !== undefined && amount < price.min) return false;
      if (price.max !== undefined && amount > price.max) return false;
    }
    return true;
  });
}

export interface UseWaitlistPageOptions {
  /** A product that can't be bought here (an auction): its card says so, with no button. */
  isBlocked?: (product: StandaloneVariant["product"]) => boolean;
}

export interface WaitlistPage {
  /**
   * `loading`: the stored list, or sizes never fetched still on their way. `failed`: those couldn't be
   * fetched, with nothing to show. `empty`: nothing waited on. `ready`.
   */
  status: "loading" | "failed" | "empty" | "ready";
  /** Every size the store still has, ready ones first, each group newest first as stored. */
  allItems: WaitlistPageItem[];
  /** What the shopper's filters leave of `allItems`. */
  items: WaitlistPageItem[];
  /** The filters leave nothing, though there are sizes. */
  noMatch: boolean;
  readyCount: number;
  waitingCount: number;
  /** The lowest and highest price among every size, for the price filter. */
  lowestPrice: number | null;
  highestPrice: number | null;
  /** The shopper's filters, applied here on the phone, never sent anywhere. */
  selectedFilters: string[];
  setFilters: (selected: string[]) => void;
  removeFilter: (input: string) => void;
  /** A card's Add to Cart: one of the size, its stock the ceiling. Only one card adds at a time. */
  addToCart: (variantId: string) => void;
  /** A card's Preauthorize Now: one on the size's pre-order plan. */
  preorder: (variantId: string) => void;
  /** The size whose add just landed (a "Success!" sheet shows it), until `dismissAdded`. */
  justAdded: StandaloneVariant | null;
  dismissAdded: () => void;
  /** Takes a size off at once, with no undo. */
  remove: (variantId: string) => void;
  /** Fetches every size's stock again (the failed state's Try again). */
  retry: () => void;
  /** Call each time the page comes into view: fetches stock again, with the stored cards on screen. Keeps one identity. */
  viewed: () => void;
}

/**
 * A waitlist page (0.15.0, moved from amore-v2's `useWaitlistPage`, its rules as decided there): every
 * size the shopper waits on, from the device (so it draws offline), its stock fetched again on each
 * visit. A card's footer is `waitlistActionFor`, the product page's rule. Sizes ready for you come
 * first, and the shopper's filters (Status, Price) narrow the list on the phone. Only an add that
 * landed opens "Success!" (`justAdded`).
 */
export function useWaitlistPage(options: UseWaitlistPageOptions = {}): WaitlistPage {
  const { ready } = useShopify();
  const waitlist = useWaitlist();
  const { addLine, cart } = useCart();
  const { refresh } = waitlist;
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [justAdded, setJustAdded] = useState<StandaloneVariant | null>(null);
  const [selectedFilters, setSelectedFilters] = useState<string[]>([]);
  const isBlockedRef = useRef(options.isBlocked);
  isBlockedRef.current = options.isBlocked;

  // Stored order, newest first. A size the store no longer has (`null`) is left out; one never fetched
  // (`undefined`: an earlier app's entry, offline since) waits for the next fetch.
  const loaded = useMemo(
    () => waitlist.items.flatMap((item) => (item.variant ? [{ variant: item.variant, addedAt: item.addedAt }] : [])),
    [waitlist.items],
  );
  const hasUnloaded = waitlist.items.some((item) => item.variant === undefined);

  const fetchStock = useCallback(() => {
    setFailed(false);
    refresh().catch(() => setFailed(true));
  }, [refresh]);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const viewed = useCallback(() => {
    if (readyRef.current) fetchStock();
  }, [fetchStock]);

  const allItems = useMemo(
    () =>
      readyFirst(
        loaded.map(({ variant, addedAt }) => ({
          id: variant.id,
          variant,
          addedAt,
          action: waitlistActionFor(variant, cart, { blocked: !!isBlockedRef.current?.(variant.product) }),
          busy: busyId === variant.id,
        })),
      ),
    [loaded, cart, busyId],
  );
  const items = useMemo(() => filterWaitlist(allItems, selectedFilters), [allItems, selectedFilters]);
  const prices = useMemo(
    () => allItems.map((item) => priceAmountOf(item.variant)).filter((amount): amount is number => amount !== null),
    [allItems],
  );

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const add = useCallback(
    (variantId: string, preorder: boolean) => {
      const variant = loadedRef.current.find((entry) => entry.variant.id === variantId)?.variant;
      if (!variant || busyRef.current) return;
      busyRef.current = variant.id;
      setBusyId(variant.id);
      void (async () => {
        try {
          const result = await addLine({
            merchandiseId: variant.id,
            quantity: 1,
            // The plan is what makes checkout authorise the payment rather than take it. Otherwise the
            // stock is the ceiling: Shopify would cap an add past it silently, and "Success!" would lie.
            ...(preorder && variant.sellingPlan ? { sellingPlanId: variant.sellingPlan.id } : { maxQuantity: stockCeiling(variant) }),
          });
          if (result.ok) setJustAdded(variant);
        } catch {
          // The provider has already raised the failed add's alert.
        } finally {
          busyRef.current = null;
          setBusyId(null);
        }
      })();
    },
    [addLine],
  );
  const addToCart = useCallback((variantId: string) => add(variantId, false), [add]);
  const preorder = useCallback((variantId: string) => add(variantId, true), [add]);
  const dismissAdded = useCallback(() => setJustAdded(null), []);
  const removeFilter = useCallback((input: string) => setSelectedFilters((current) => current.filter((selected) => selected !== input)), []);
  const { remove: removeFromWaitlist } = waitlist;
  const remove = useCallback((variantId: string) => void removeFromWaitlist(variantId), [removeFromWaitlist]);

  let status: WaitlistPage["status"];
  if (!ready || (loaded.length === 0 && hasUnloaded && !failed)) status = "loading";
  else if (loaded.length === 0 && hasUnloaded) status = "failed";
  else if (loaded.length === 0) status = "empty";
  else status = "ready";

  const readyCount = allItems.filter((item) => isWaitlistReady(item.action)).length;
  return {
    status,
    allItems,
    items,
    noMatch: allItems.length > 0 && items.length === 0,
    readyCount,
    waitingCount: allItems.length - readyCount,
    lowestPrice: prices.length ? Math.min(...prices) : null,
    highestPrice: prices.length ? Math.max(...prices) : null,
    selectedFilters,
    setFilters: setSelectedFilters,
    removeFilter,
    addToCart,
    preorder,
    justAdded,
    dismissAdded,
    remove,
    retry: fetchStock,
    viewed,
  };
}
