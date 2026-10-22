/**
 * The signed-in customer's tags (0.23.0; `../customerTags.ts`). One read per session, shared by every
 * caller: on sign-in and account change, then when a caller becomes `active` (pass the screen's focus),
 * on return to the foreground while active, and every `everyMs` while active.
 *
 * ```tsx
 * const tags = useCustomerTags({ active: useIsFocused() });
 * const early = tags.hasTag("VIP");
 * if (tags.bidding !== "allowed") … // BIDBLOCKED / APPBLOCKED, or not read yet
 * ```
 *
 * A Shopify sign-in reads the Customer Account API, a password session the Storefront API. Signed out:
 * no tags, `known`, nothing sent.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { request as storefrontRequest } from '../client';
import {
  createCustomerTagsStore,
  CUSTOMER_ACCOUNT_TAGS_QUERY,
  customerRestrictionsOf,
  hasCustomerTag,
  type CustomerRestrictions,
  STOREFRONT_CUSTOMER_TAGS_QUERY,
  type CustomerTagsState,
  type CustomerTagsStore,
} from '../customerTags';
import { onAppForeground } from './appForeground';
import { useCustomer, type CustomerState } from './ShopifyProvider';

export interface UseCustomerTagsOptions {
  /** The screen using the tags is on screen. Default true. */
  active?: boolean;
  /** Re-read this often while active. Unset: no timer. */
  everyMs?: number;
}

export interface CustomerTags extends CustomerTagsState, CustomerRestrictions {
  /** Trimmed, case-insensitive. False while unread. */
  hasTag: (tag: string) => boolean;
  refresh: (options?: { force?: boolean }) => Promise<CustomerTagsState>;
}

type Source = Pick<CustomerState, 'sessionKind' | 'request' | 'getAccessToken'>;
type TagsAnswer = { customer: { tags: string[] | null } | null };

async function readTags(source: Source): Promise<string[]> {
  let data: TagsAnswer;
  if (source.sessionKind === 'shopify') {
    data = await source.request<TagsAnswer>(CUSTOMER_ACCOUNT_TAGS_QUERY);
  } else {
    const token = await source.getAccessToken();
    if (!token) throw new Error('[sdk-shopify] no customer access token');
    data = await storefrontRequest<TagsAnswer>(STOREFRONT_CUSTOMER_TAGS_QUERY, { customerAccessToken: token }, { fresh: true });
  }
  // No customer in the answer is a failed read, not an untagged customer.
  if (!data?.customer) throw new Error('[sdk-shopify] no customer for the session');
  return data.customer.tags ?? [];
}

/** One store per session (`request` is stable for the provider's life). */
const stores = new WeakMap<CustomerState['request'], { store: CustomerTagsStore; source: { current: Source } }>();

function storeFor(customer: CustomerState): CustomerTagsStore {
  let entry = stores.get(customer.request);
  if (!entry) {
    const source = { current: customer as Source };
    const store = createCustomerTagsStore({
      readTags: () => readTags(source.current),
      onError: (error) => console.warn('[sdk-shopify] customer tags did not load', error),
    });
    entry = { store, source };
    stores.set(customer.request, entry);
  }
  entry.source.current = customer;
  return entry.store;
}

export function useCustomerTags({ active = true, everyMs }: UseCustomerTagsOptions = {}): CustomerTags {
  const customer = useCustomer();
  const store = storeFor(customer);
  const customerId = customer.loggedIn ? customer.customer?.id ?? null : null;

  // While a stored session restores, wait rather than clearing the tags it is about to bring back.
  useEffect(() => {
    if (!customer.restoring) store.setCustomer(customerId);
  }, [store, customerId, customer.restoring]);

  useEffect(() => {
    if (!active || !customerId) return;
    void store.refresh();
    const timer = everyMs && everyMs > 0 ? setInterval(() => void store.refresh(), everyMs) : null;
    const offForeground = onAppForeground(() => void store.refresh());
    return () => {
      if (timer) clearInterval(timer);
      offForeground();
    };
  }, [store, active, everyMs, customerId]);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const refresh = useCallback((options?: { force?: boolean }) => store.refresh(options), [store]);
  return useMemo(() => {
    // Never another customer's tags, while the account changes hands.
    const shown: CustomerTagsState =
      state.customerId === customerId ? state : { customerId, tags: customerId ? null : [], known: !customerId };
    return { ...shown, ...customerRestrictionsOf(shown), hasTag: (tag: string) => hasCustomerTag(shown.tags, tag), refresh };
  }, [state, customerId, refresh]);
}
