/**
 * The signed-in customer's Shopify tags (0.22.0), for rules a store keys on them (who may bid, who sees an
 * early drop). What a tag means is the app's call; this only reads them.
 *
 * `tags` is null until read and while every read fails: a rule that protects something must treat that
 * as unknown, not as untagged (`known`). A failed re-read keeps the last known tags.
 */

/** Floor between re-reads once the tags are known. */
export const CUSTOMER_TAGS_MIN_GAP_MS = 30_000;

export const CUSTOMER_ACCOUNT_TAGS_QUERY = /* GraphQL */ `
  query CustomerTags {
    customer {
      tags
    }
  }
`;

export const STOREFRONT_CUSTOMER_TAGS_QUERY = /* GraphQL */ `
  query CustomerTagsStorefront($customerAccessToken: String!) {
    customer(customerAccessToken: $customerAccessToken) {
      tags
    }
  }
`;

export interface CustomerTagsState {
  /** Null when signed out. */
  customerId: string | null;
  /** Null until read. Empty when signed out. */
  tags: readonly string[] | null;
  /** The tags have been read (always true signed out). */
  known: boolean;
}

/** Whether `tags` holds `tag`, trimmed and case-insensitive. */
export function hasCustomerTag(tags: readonly string[] | null | undefined, tag: string): boolean {
  const wanted = tag.trim().toLowerCase();
  return !!tags?.some((t) => t.trim().toLowerCase() === wanted);
}

const SIGNED_OUT: CustomerTagsState = Object.freeze({ customerId: null, tags: Object.freeze([]), known: true });

export interface CustomerTagsStore {
  getState(): CustomerTagsState;
  subscribe(listener: () => void): () => void;
  /** Sign-in, sign-out or another account: starts from unknown, and a read for the previous one is dropped. */
  setCustomer(customerId: string | null): void;
  /** Re-reads, at most once per `CUSTOMER_TAGS_MIN_GAP_MS` once known (`force` skips that). Never rejects. */
  refresh(options?: { force?: boolean }): Promise<CustomerTagsState>;
}

/** The store behind `useCustomerTags`: one read shared by every caller. `readTags` throws on failure. */
export function createCustomerTagsStore(deps: { readTags: () => Promise<string[]>; now?: () => number; onError?: (error: unknown) => void }): CustomerTagsStore {
  const now = deps.now ?? Date.now;
  let state: CustomerTagsState = SIGNED_OUT;
  let lastReadAt = 0;
  let generation = 0;
  let inFlight: Promise<CustomerTagsState> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: CustomerTagsState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  function read(): Promise<CustomerTagsState> {
    const customerId = state.customerId;
    if (inFlight || !customerId) return inFlight ?? Promise.resolve(state);
    const mine = generation;
    lastReadAt = now();
    const run = deps
      .readTags()
      .then((tags) => {
        const same = state.tags?.length === tags.length && tags.every((tag, i) => tag === state.tags?.[i]);
        if (mine === generation && !(state.known && same)) publish({ customerId, tags: [...tags], known: true });
      })
      .catch((error) => {
        if (mine !== generation) return;
        deps.onError?.(error);
        if (!state.known) lastReadAt = 0; // nothing known yet: let the next ask retry at once
      })
      .then(() => state)
      .finally(() => {
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
    return run;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setCustomer(customerId) {
      if (customerId === state.customerId) return;
      generation += 1;
      inFlight = null;
      lastReadAt = 0;
      publish(customerId ? { customerId, tags: null, known: false } : SIGNED_OUT);
      if (customerId) void read();
    },
    refresh(options) {
      if (!options?.force && state.known && now() - lastReadAt < CUSTOMER_TAGS_MIN_GAP_MS) return inFlight ?? Promise.resolve(state);
      return read();
    },
  };
}
