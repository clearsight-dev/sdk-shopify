/**
 * The signed-in shopper's store credit, from the source the app chose on `ShopifyProvider`
 * (`storeCredit.source`): Shopify's own store credit, or the Tile Credit wallet. One hook either
 * way, so an account screen shows a balance without knowing where it comes from.
 *
 * Putting credit on the cart is `useCartStoreCredit`; Shopify store credit is spent at Shopify's
 * checkout. `useStoreCreditHistory`, below, reads the lines behind the balance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrencyCode } from '../client';
import {
  shopifyStoreCreditHistory,
  STORE_CREDIT_HISTORY_PAGE_SIZE,
  STORE_CREDIT_QUERY,
  sumStoreCredit,
  tileCreditHistory,
  type StoreCreditAccountNode,
  type StoreCreditHistorySource,
} from '../auth/storeCredit';
import { centsToMoney, DEFAULT_TILE_CREDIT_BASE_URL } from '../tileCredit';
import { useCustomer, useShopify } from './ShopifyProvider';
import { tileCreditClientFor } from './tileCreditClient';
import { useShopper } from './useOrders';
import type { Money, StoreCreditEntry } from '../types';

export interface StoreCreditState {
  /** The app's choice; null when it shows no store credit. */
  source: 'shopify' | 'tile' | null;
  /**
   * The balance can be read for this shopper: signed in, and for `shopify`, signed in with Shopify.
   * Shopify store credit is only readable through the Customer Account API, so it is unavailable
   * to a password session (App Store review mode).
   */
  available: boolean;
  balance: Money | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function useStoreCredit(): StoreCreditState {
  const { storeCredit } = useShopify();
  const customer = useCustomer();
  const source = storeCredit?.source ?? null;
  const available =
    source !== null && customer.loggedIn && (source === 'tile' || customer.sessionKind === 'shopify');

  const [balance, setBalance] = useState<Money | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Read through refs so `refresh` keeps one identity across renders.
  const customerRef = useRef(customer);
  customerRef.current = customer;
  const baseUrl = storeCredit?.tileCreditBaseUrl || DEFAULT_TILE_CREDIT_BASE_URL;
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    if (!available) {
      setBalance(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let next: Money;
      if (source === 'shopify') {
        const data = await customerRef.current.request<{ customer: { storeCreditAccounts: { nodes: StoreCreditAccountNode[] } } | null }>(STORE_CREDIT_QUERY);
        next = sumStoreCredit(data.customer?.storeCreditAccounts.nodes ?? [], getCurrencyCode() ?? '');
      } else {
        const wallet = await tileCreditClientFor(customerRef.current, baseUrl).getWallet();
        next = { amount: centsToMoney(wallet.balanceCents), currencyCode: getCurrencyCode() ?? '' };
      }
      if (id === request.current) setBalance(next);
    } catch (e) {
      if (id === request.current) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [available, source, baseUrl]);

  // Loads when it becomes readable, and again for a different shopper.
  const customerId = customer.customer?.id ?? null;
  useEffect(() => {
    void refresh();
  }, [refresh, customerId]);

  return useMemo(
    () => ({ source, available, balance: available ? balance : null, loading, error, refresh }),
    [source, available, balance, loading, error, refresh],
  );
}

// ── History ────────────────────────────────────────────────────────────────

export interface UseStoreCreditHistoryOptions {
  /** Lines per page. Default `STORE_CREDIT_HISTORY_PAGE_SIZE` (25). */
  pageSize?: number;
}

export interface StoreCreditHistoryState {
  /** The app's choice; null when it shows no store credit. */
  source: 'shopify' | 'tile' | null;
  /** The history can be read for this shopper: the same rule as the balance (`useStoreCredit`). */
  available: boolean;
  /** Newest first. Empty when it can't be read. */
  entries: StoreCreditEntry[];
  /**
   * True only before the first answer: while a stored session is read on app open, then until the
   * first page arrives. A refresh never sets it; the list stays on screen.
   */
  loading: boolean;
  /** A next page is on its way (`loadMore`). */
  loadingMore: boolean;
  /** More lines than are loaded. */
  hasMore: boolean;
  /** The last read failed. Whatever was shown stays. Cleared by the next read that works. */
  error: Error | null;
  /** Reads the next page. Does nothing while another read is on its way, or at the end. */
  loadMore: () => void;
  /**
   * Reads the newest page again (pull to refresh, a screen coming back into view) and starts the
   * list over from it. Joins a first read already on its way. Never rejects.
   */
  refresh: () => Promise<void>;
}

interface HistoryHeld {
  owner: string | null;
  entries: StoreCreditEntry[];
  cursor: string | null;
  answered: boolean;
  loadingMore: boolean;
  error: Error | null;
}

const emptyHistory = (owner: string | null): HistoryHeld => ({
  owner, entries: [], cursor: null, answered: false, loadingMore: false, error: null,
});

/** The lines shown so far and a next page, in date order, each line once. */
function withPage(entries: StoreCreditEntry[], page: StoreCreditEntry[]): StoreCreditEntry[] {
  const seen = new Set(entries.map((entry) => entry.id));
  const merged = [...entries, ...page.filter((entry) => !seen.has(entry.id))];
  // Already in order from one source; Shopify's accounts in several currencies can interleave.
  return merged.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/**
 * The history behind the balance, from the same source as `useStoreCredit`, newest first, a page at a
 * time:
 * - `tile`: Tile Credit's ledger (`/public/me/ledger`), with the same service, token and shop as the
 *   balance. Either sign-in.
 * - `shopify`: the Customer Account API's store-credit transactions, for a Shopify sign-in only.
 *
 * Signed out, or with no source, it is empty with no error and reads nothing. Loads when it becomes
 * readable, and starts over for another shopper.
 */
export function useStoreCreditHistory(options: UseStoreCreditHistoryOptions = {}): StoreCreditHistoryState {
  const { storeCredit } = useShopify();
  const customer = useCustomer();
  const source = storeCredit?.source ?? null;
  const available =
    source !== null && customer.loggedIn && (source === 'tile' || customer.sessionKind === 'shopify');
  const baseUrl = storeCredit?.tileCreditBaseUrl || DEFAULT_TILE_CREDIT_BASE_URL;
  const shopper = useShopper(customer);
  // Whose history is held, and from where: anything else starts from nothing.
  const owner = available && shopper ? `${shopper}|${source}|${baseUrl}` : null;

  const customerRef = useRef(customer);
  customerRef.current = customer;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const pageSizeRef = useRef(STORE_CREDIT_HISTORY_PAGE_SIZE);
  pageSizeRef.current = Math.max(1, Math.floor(options.pageSize ?? STORE_CREDIT_HISTORY_PAGE_SIZE)) || STORE_CREDIT_HISTORY_PAGE_SIZE;

  const [stored, setStored] = useState<HistoryHeld>(() => emptyHistory(owner));
  // Another shopper's lines never show, not even for the render before the effect below clears them.
  const shown = stored.owner === owner ? stored : emptyHistory(owner);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const firstPage = useRef<{ owner: string; done: Promise<void> } | null>(null);
  const nextPage = useRef<{ owner: string } | null>(null);

  const update = useCallback((forOwner: string, change: (state: HistoryHeld) => Partial<HistoryHeld>) => {
    setStored((state) => (state.owner === forOwner ? { ...state, ...change(state) } : state));
  }, []);

  /** The source for this shopper now. Tile Credit's client reads a fresh token for each request. */
  const historySource = useCallback(async (): Promise<StoreCreditHistorySource> => {
    const now = customerRef.current;
    const currency = getCurrencyCode() ?? '';
    if (source === 'shopify') return shopifyStoreCreditHistory(now.request, currency);
    return tileCreditHistory(tileCreditClientFor(now, baseUrl), currency);
  }, [source, baseUrl]);

  const refresh = useCallback((): Promise<void> => {
    const forOwner = ownerRef.current;
    if (!forOwner) return Promise.resolve();
    const running = firstPage.current;
    if (running?.owner === forOwner) return running.done;
    // The list starts over, so a next page still on its way would land on the wrong list.
    nextPage.current = null;
    const flight = { owner: forOwner, done: Promise.resolve() };
    flight.done = (async () => {
      try {
        const page = await (await historySource()).page(pageSizeRef.current, null);
        update(forOwner, () => ({
          entries: withPage([], page.entries), cursor: page.nextCursor, answered: true, loadingMore: false, error: null,
        }));
      } catch (error) {
        update(forOwner, () => ({ answered: true, loadingMore: false, error: asError(error) }));
      } finally {
        if (firstPage.current === flight) firstPage.current = null;
      }
    })();
    firstPage.current = flight;
    return flight.done;
  }, [historySource, update]);

  const loadMore = useCallback(() => {
    const forOwner = ownerRef.current;
    const now = shownRef.current;
    if (!forOwner || !now.answered || !now.cursor) return;
    if (firstPage.current?.owner === forOwner || nextPage.current?.owner === forOwner) return;
    const flight = { owner: forOwner };
    nextPage.current = flight;
    const cursor = now.cursor;
    update(forOwner, () => ({ loadingMore: true }));
    void (async () => {
      try {
        const page = await (await historySource()).page(pageSizeRef.current, cursor);
        if (nextPage.current !== flight) return;
        update(forOwner, (state) => ({
          entries: withPage(state.entries, page.entries), cursor: page.nextCursor, loadingMore: false, error: null,
        }));
      } catch (error) {
        if (nextPage.current !== flight) return;
        update(forOwner, () => ({ loadingMore: false, error: asError(error) }));
      } finally {
        if (nextPage.current === flight) nextPage.current = null;
      }
    })();
  }, [historySource, update]);

  // A new shopper (or none) starts from nothing; signed out, nothing is read.
  useEffect(() => {
    setStored((state) => (state.owner === owner ? state : emptyHistory(owner)));
    if (owner) void refresh();
  }, [owner, refresh]);

  const restoring = customer.restoring && owner === null;
  const loading = restoring || (owner !== null && !shown.answered);
  return useMemo(
    () => ({
      source,
      available,
      entries: shown.entries,
      loading,
      loadingMore: shown.loadingMore,
      hasMore: !!shown.cursor,
      error: shown.error,
      loadMore,
      refresh,
    }),
    [source, available, shown.entries, loading, shown.loadingMore, shown.cursor, shown.error, loadMore, refresh],
  );
}
