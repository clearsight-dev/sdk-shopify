/**
 * Store credit on the cart: the balance, what is on the cart, and Apply / Remove, from the source the
 * app chose on `ShopifyProvider` (`storeCredit.source`). One hook either way, so a cart screen needs no
 * idea where the credit comes from.
 *
 * - **`tile`** (Tile Credit): Apply mints a gift card for the amount (`/public/me/redeem`) and adds it to
 *   the cart through the provider's cart queue (`useCart().addGiftCardCodes`). Remove takes the app's
 *   own card off and leaves every other gift card. Redeeming only reserves the credit: the wallet is
 *   charged for what the order uses, so the balance doesn't move on Apply.
 * - **`shopify`** (Shopify's store credit): only Shopify's checkout can take it, so the hook reads the
 *   balance and says `atCheckout`; `apply` and `remove` do nothing.
 *
 * Rules (decided 2026-10-05, Head of Engineering):
 * - **One Apply or Remove at a time.** A second call while one runs gets the running one's promise: two
 *   redeems at once with different keys would mint two cards (the service's idempotency isn't atomic).
 * - **Every Apply mints a new card** with a new idempotency key. The key is reused only to retry the
 *   same attempt (same shopper, same amount, right after it failed), so a retry after a lost answer
 *   gets the card already minted instead of another. A new card disables the previous one, so any
 *   earlier card of the app's still on the cart is taken off once the new one is on.
 * - **The app's card on the cart** is found by its last characters (`appliedGiftCards[].lastCharacters`):
 *   the last four of the card this hook minted, or after a restart the shopper's active card
 *   (`/public/me/gift-cards`). `applied` is what that card takes off this cart (`presentmentAmountUsed`).
 * - **The balance is read** when the hook mounts, for each new shopper (nothing from the one before
 *   shows, not even for a render), when the app comes back to the foreground, after every Apply and
 *   Remove, and on `refresh()`.
 * - Failures never reject: `apply` and `remove` resolve false and set `error`, a `TileCreditError`
 *   whose `code` the app words. A 401 renews the token once and never signs the shopper out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrencyCode } from '../client';
import { giftCardsEndingIn } from '../cart';
import { STORE_CREDIT_QUERY, sumStoreCredit, type StoreCreditAccountNode } from '../auth/storeCredit';
import { centsToMoney, DEFAULT_TILE_CREDIT_BASE_URL } from '../tileCredit';
import { ShopifyError, TileCreditError } from '../types';
import type { AppliedGiftCard, Cart, CartStoreCreditStatus, Money, TileCreditErrorCode } from '../types';
import { onAppForeground } from './appForeground';
import { useCart, useCustomer, useShopify } from './ShopifyProvider';
import { useShopper } from './useOrders';
import { tileCreditClientFor } from './tileCreditClient';

export interface CartStoreCreditState {
  /** The app's choice; null when it shows no store credit. */
  source: 'shopify' | 'tile' | null;
  status: CartStoreCreditStatus;
  /** The shopper's balance; null until it has been read (and while hidden). */
  balance: Money | null;
  /** What the app's card takes off this cart, in the cart's currency; null when it isn't on the cart. */
  applied: Money | null;
  /** Why the last read, Apply or Remove failed; null once the next one starts. */
  error: TileCreditError | null;
  /**
   * Mints a card for `amountCents` (whole cents, more than 0) and adds it to the cart. True once it is
   * on the cart. Never rejects. No app-side upper limit: the service answers an amount over the balance
   * (`insufficient_balance`) or outside the store's limits (`validation`).
   */
  apply: (amountCents: number) => Promise<boolean>;
  /** Takes the app's card off the cart, leaving any other gift card. True once it is off. Never rejects. */
  remove: () => Promise<boolean>;
  /** Reads the balance again (a screen coming into view). Joins a read already on its way. Never rejects. */
  refresh: () => Promise<void>;
}

/** What is held for one shopper; anything held for another never shows. */
interface Held {
  owner: string | null;
  balance: Money | null;
  /** The last characters of the shopper's active card, from the service: the app's card after a restart. */
  activeCardEnding: string | null;
  /** The balance has been read once (or failed to be). */
  answered: boolean;
  /** The last read failed. */
  readError: TileCreditError | null;
}

const nothingHeld = (owner: string | null): Held => ({
  owner, balance: null, activeCardEnding: null, answered: false, readError: null,
});

/** An Apply that hasn't finished well yet, so a retry of it can reuse its key. */
interface Attempt {
  owner: string;
  amountCents: number;
  idempotencyKey: string;
}

/** An Apply or Remove on its way. */
interface Running {
  owner: string;
  kind: 'applying' | 'removing';
  done: Promise<boolean>;
}

/** Unique per attempt on this device; not a secret. */
function newIdempotencyKey(): string {
  return `app-cart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Every failure as a `TileCreditError`, so the app words one kind of error. */
function asCreditError(error: unknown, fallback: TileCreditErrorCode = 'internal'): TileCreditError {
  if (error instanceof TileCreditError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ShopifyError && error.errors.length) return new TileCreditError('cart_refused', message);
  if (/network|fetch|request failed|timed? ?out|offline/i.test(message)) return new TileCreditError('network', message);
  return new TileCreditError(fallback, message);
}

/** The total the app's cards take off the cart, in its currency. */
function totalUsed(cards: AppliedGiftCard[]): Money | null {
  if (cards.length === 0) return null;
  const cents = cards.reduce((sum, card) => sum + Math.round((Number.parseFloat(card.presentmentAmountUsed?.amount ?? '0') || 0) * 100), 0);
  const currencyCode = cards[0].presentmentAmountUsed?.currencyCode ?? getCurrencyCode() ?? '';
  return { amount: centsToMoney(cents), currencyCode };
}

export function useCartStoreCredit(): CartStoreCreditState {
  const { storeCredit } = useShopify();
  const customer = useCustomer();
  const cartState = useCart();
  const source = storeCredit?.source ?? null;
  const available =
    source !== null && customer.loggedIn && (source === 'tile' || customer.sessionKind === 'shopify');
  const baseUrl = storeCredit?.tileCreditBaseUrl || DEFAULT_TILE_CREDIT_BASE_URL;
  const shopper = useShopper(customer);
  // Whose credit is held, and from where: anything else starts from nothing.
  const owner = available && shopper ? `${shopper}|${source}|${baseUrl}` : null;

  const customerRef = useRef(customer);
  customerRef.current = customer;
  const cartRef = useRef(cartState);
  cartRef.current = cartState;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  const [stored, setStored] = useState<Held>(() => nothingHeld(owner));
  // Another shopper's balance never shows, not even for the render before the effect below clears it.
  const held = stored.owner === owner ? stored : nothingHeld(owner);
  const heldRef = useRef(held);
  heldRef.current = held;

  // The last characters of the card this hook minted, for this shopper.
  const [minted, setMinted] = useState<{ owner: string; ending: string } | null>(null);
  const mintedEnding = minted && minted.owner === owner ? minted.ending : null;
  const mintedRef = useRef(mintedEnding);
  mintedRef.current = mintedEnding;

  const [running, setRunning] = useState<Running | null>(null);
  const runningRef = useRef<Running | null>(null);
  const [actionError, setActionError] = useState<{ owner: string; error: TileCreditError } | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const reading = useRef<{ owner: string; done: Promise<void> } | null>(null);

  const update = useCallback((forOwner: string, change: Partial<Held>) => {
    setStored((state) => (state.owner === forOwner ? { ...state, ...change } : { ...nothingHeld(forOwner), ...change }));
  }, []);

  /** Reads the balance (and, for Tile Credit, the active card) for the shopper now. */
  const read = useCallback((forOwner: string): Promise<void> => {
    const flight = { owner: forOwner, done: Promise.resolve() };
    flight.done = (async () => {
      try {
        const now = customerRef.current;
        const currency = getCurrencyCode() ?? '';
        if (source === 'shopify') {
          const data = await now.request<{ customer: { storeCreditAccounts: { nodes: StoreCreditAccountNode[] } } | null }>(STORE_CREDIT_QUERY);
          if (ownerRef.current !== forOwner) return;
          update(forOwner, { balance: sumStoreCredit(data.customer?.storeCreditAccounts.nodes ?? [], currency), answered: true, readError: null });
          return;
        }
        const client = tileCreditClientFor(now, baseUrl);
        const [wallet, cards] = await Promise.allSettled([client.getWallet(), client.listGiftCards()]);
        if (ownerRef.current !== forOwner) return;
        if (wallet.status === 'rejected') throw wallet.reason;
        const change: Partial<Held> = {
          balance: { amount: centsToMoney(wallet.value.balanceCents), currencyCode: currency },
          answered: true,
          readError: null,
        };
        // The cards list is what finds the app's card after a restart; a failure keeps what was known.
        if (cards.status === 'fulfilled') {
          change.activeCardEnding = cards.value.giftCards.find((card) => card.status === 'active')?.last4 ?? null;
        }
        update(forOwner, change);
      } catch (error) {
        if (ownerRef.current === forOwner) update(forOwner, { answered: true, readError: asCreditError(error, 'network') });
      } finally {
        if (reading.current === flight) reading.current = null;
      }
    })();
    reading.current = flight;
    return flight.done;
  }, [source, baseUrl, update]);

  const refresh = useCallback((): Promise<void> => {
    const forOwner = ownerRef.current;
    if (!forOwner) return Promise.resolve();
    if (reading.current?.owner === forOwner) return reading.current.done;
    return read(forOwner);
  }, [read]);

  /** After a write: a new read, not one that started before the write. */
  const readAfterWrite = useCallback((forOwner: string) => {
    if (ownerRef.current === forOwner) void read(forOwner);
  }, [read]);

  // Each shopper (or none) starts from nothing; signed out, nothing is read.
  useEffect(() => {
    setStored((state) => (state.owner === owner ? state : nothingHeld(owner)));
    if (owner) void refresh();
  }, [owner, refresh]);

  // Back in the foreground: the balance may have moved (an order, the web store's own redeem).
  useEffect(() => {
    if (!owner) return undefined;
    return onAppForeground(() => void refresh());
  }, [owner, refresh]);

  /** Runs `work` as the one Apply or Remove, or hands back the one already running. */
  const runOne = useCallback((kind: Running['kind'], forOwner: string, work: () => Promise<boolean>): Promise<boolean> => {
    const now = runningRef.current;
    if (now) return now.done;
    setActionError(null);
    const entry: Running = { owner: forOwner, kind, done: Promise.resolve(false) };
    entry.done = (async () => {
      try {
        return await work();
      } catch (error) {
        if (ownerRef.current === forOwner) setActionError({ owner: forOwner, error: asCreditError(error) });
        return false;
      } finally {
        runningRef.current = null;
        setRunning(null);
        readAfterWrite(forOwner);
      }
    })();
    runningRef.current = entry;
    setRunning(entry);
    return entry.done;
  }, [readAfterWrite]);

  const apply = useCallback((amountCents: number): Promise<boolean> => {
    const forOwner = ownerRef.current;
    if (!forOwner || source !== 'tile') return Promise.resolve(false);
    return runOne('applying', forOwner, async () => {
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new TileCreditError('validation', 'The amount must be more than zero');
      }
      // A retry of the attempt that just failed keeps its key; anything else is a new attempt.
      const last = attempt.current;
      const thisAttempt: Attempt =
        last && last.owner === forOwner && last.amountCents === amountCents
          ? last
          : { owner: forOwner, amountCents, idempotencyKey: newIdempotencyKey() };
      attempt.current = thisAttempt;

      const earlierEndings = [mintedRef.current, heldRef.current.activeCardEnding].filter((ending): ending is string => !!ending);
      const redeemed = await tileCreditClientFor(customerRef.current, baseUrl).redeem({
        amountCents,
        idempotencyKey: thisAttempt.idempotencyKey,
        reason: 'Applied to the cart in the app',
      });
      if (ownerRef.current !== forOwner) return false;
      setMinted({ owner: forOwner, ending: redeemed.last4 });
      mintedRef.current = redeemed.last4;

      let onCart: Cart | null;
      try {
        onCart = await cartRef.current.addGiftCardCodes([redeemed.code]);
      } catch (error) {
        // A card handed back for this key that won't go on (disabled since) is never retried with it.
        if (redeemed.duplicate) attempt.current = null;
        const failure = asCreditError(error, 'cart_refused');
        throw failure.code === 'network' ? failure : new TileCreditError('cart_refused', failure.message);
      }
      if (!onCart) throw new TileCreditError('cart_refused', 'There is no cart to put the credit on');
      attempt.current = null;

      // The new card disabled the app's earlier one; if that is still on the cart, it comes off.
      const newCard = new Set(giftCardsEndingIn(onCart, [redeemed.last4]).map((card) => card.id));
      const stale = giftCardsEndingIn(onCart, earlierEndings).filter((card) => !newCard.has(card.id));
      if (stale.length) {
        await cartRef.current.removeGiftCards(stale.map((card) => card.id)).catch(() => undefined);
      }
      return true;
    });
  }, [source, baseUrl, runOne]);

  const remove = useCallback((): Promise<boolean> => {
    const forOwner = ownerRef.current;
    if (!forOwner || source !== 'tile') return Promise.resolve(false);
    return runOne('removing', forOwner, async () => {
      const endings = [mintedRef.current, heldRef.current.activeCardEnding].filter((ending): ending is string => !!ending);
      const ours = giftCardsEndingIn(cartRef.current.cart, endings);
      if (ours.length === 0) return true;
      await cartRef.current.removeGiftCards(ours.map((card) => card.id));
      return true;
    });
  }, [source, runOne]);

  const endings = [mintedEnding, held.activeCardEnding].filter((ending): ending is string => !!ending);
  const ourCards = source === 'tile' && owner ? giftCardsEndingIn(cartState.cart, endings) : [];
  const appliedKey = ourCards.map((card) => `${card.id}:${card.presentmentAmountUsed?.amount}`).join('|');
  const applied = useMemo(() => totalUsed(ourCards), [appliedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const runningNow = running && running.owner === owner ? running.kind : null;
  const error = (actionError && actionError.owner === owner ? actionError.error : null) ?? held.readError;
  let status: CartStoreCreditStatus;
  if (!owner) status = 'hidden';
  else if (source === 'shopify') status = held.balance ? 'atCheckout' : held.readError ? 'error' : 'loading';
  else if (runningNow) status = runningNow;
  else if (ourCards.length > 0) status = 'applied';
  else if (held.balance) status = 'ready';
  else if (held.readError) status = 'error';
  else status = 'loading';

  return useMemo(
    () => ({
      source,
      status,
      balance: owner ? held.balance : null,
      applied: status === 'hidden' ? null : applied,
      error: owner ? error : null,
      apply,
      remove,
      refresh,
    }),
    [source, status, owner, held.balance, applied, error, apply, remove, refresh],
  );
}
