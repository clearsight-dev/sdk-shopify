/**
 * Store credit, from the source each app picks on `ShopifyProvider` (`StoreCreditOptions`):
 * Shopify's own store credit, or Tile Credit. The balance is read by `useStoreCredit`, the history
 * behind it by `useStoreCreditHistory`.
 */
import { centsToMoney } from '../tileCredit';
import type { AccountRequest } from '../orders';
import type { Money, StoreCreditEntry, StoreCreditEntryKind, TileCreditAPI, TileCreditLedgerEntry } from '../types';

/**
 * `first: 10` because the accounts are per currency: a customer can hold several, and asking for one
 * would silently pick whichever Shopify ordered first.
 */
export const STORE_CREDIT_QUERY = /* GraphQL */ `
  query StoreCredit {
    customer {
      storeCreditAccounts(first: 10) {
        nodes { id balance { amount currencyCode } }
      }
    }
  }
`;

export interface StoreCreditAccountNode {
  id: string;
  balance: { amount: string; currencyCode: string } | null;
}

/**
 * The shopper's Shopify store credit as one figure: the accounts summed, in the currency of the
 * first one holding a balance. Summed rather than first-of-list so it can never show less than the
 * shopper has. No accounts reads as zero, in `fallbackCurrency` (the shop's).
 */
export function sumStoreCredit(nodes: StoreCreditAccountNode[], fallbackCurrency: string): Money {
  let cents = 0;
  for (const node of nodes) cents += Math.round((Number.parseFloat(node.balance?.amount ?? '0') || 0) * 100);
  const currencyCode = nodes.find((node) => node.balance)?.balance?.currencyCode ?? fallbackCurrency;
  return { amount: (cents / 100).toFixed(2), currencyCode };
}

// ── History ────────────────────────────────────────────────────────────────

/** History lines per page, unless `useStoreCreditHistory({ pageSize })` says otherwise. */
export const STORE_CREDIT_HISTORY_PAGE_SIZE = 25;

export interface StoreCreditHistoryPage {
  /** Newest first. */
  entries: StoreCreditEntry[];
  /** Hand back to `page` for the next page; null on the last one. */
  nextCursor: string | null;
}

/** The signed-in shopper's store-credit history, from the source the app chose, a page at a time. */
export interface StoreCreditHistorySource {
  /** `cursor`: the previous page's `nextCursor`; null for the newest page. */
  page(pageSize: number, cursor: string | null): Promise<StoreCreditHistoryPage>;
}

/** Whole cents, never negative, from a decimal amount ("-12.50" → 1250). */
const centsOf = (amount: string | null | undefined) => Math.abs(Math.round((Number.parseFloat(amount ?? '0') || 0) * 100));

const newestFirst = (a: StoreCreditEntry, b: StoreCreditEntry) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);

// Tile Credit

/** Tile Credit's sources, each the kind it is. A source this doesn't know reads by its type. */
const TILE_CREDIT_KINDS: Partial<Record<string, StoreCreditEntryKind>> = {
  signup: 'signupBonus',
  'live-join': 'liveShowReward',
  'order-fulfilled': 'orderReward',
  'manual-grant': 'addedByStore',
  'manual-deduct': 'removedByStore',
  redemption: 'spent',
  'expiry-sweep': 'expired',
};

/** The sources whose `reason` is the service's own reference, never words the store wrote. */
const MACHINE_REASONS = new Set(['signup', 'live-join', 'order-fulfilled', 'redemption', 'expiry-sweep']);

/** An order's name in free text: `#1043`. A Shopify id isn't one; the shopper has never seen it. */
function orderNameIn(text: string | null | undefined): string | null {
  const match = text ? /#(\d+)\b/.exec(text) : null;
  return match ? `#${match[1]}` : null;
}

/**
 * Whether a `reason` reads as words a shopper can use. The field is free text, and the grant paths
 * often put a reference there (an order id, a `dispenser-<uuid>` key, a gid), which on a statement
 * looks like a fault. So it has to be short prose with no reference in it (old Amore's rule, its
 * `readsAsProse`); an order's name goes to `orderName` instead.
 */
function readsAsSentence(reason: string): boolean {
  const text = reason.trim();
  if (text.length === 0 || text.length > 48) return false;
  if (/gid:\/\//i.test(text)) return false;
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) return false;
  if (/[0-9a-f]{12,}/i.test(text)) return false;
  if (/#\d/.test(text)) return false;
  if (/^\d[\d\s-]*$/.test(text)) return false;
  if (/\b(?:order|dispenser|transaction|txn|ref|id)[\s:_-]*#?\w*\d{3,}/i.test(text)) return false;
  // At least two words of language.
  return /[a-z]{3,}(?:\s+\S+)+/i.test(text);
}

/**
 * One Tile Credit ledger line. Which way it moved the balance comes from what it was: earned credit
 * adds; a redemption, an expiry and a manual deduction take away, and so does any line with a
 * negative amount. (Old Amore counted every `adjust` as credit, which showed a deduction as "+".)
 */
export function tileCreditEntry(entry: TileCreditLedgerEntry, fallbackCurrency: string): StoreCreditEntry {
  const takesCredit =
    entry.amountCents < 0 ||
    entry.type === 'redeem' ||
    entry.type === 'expire' ||
    entry.source === 'manual-deduct' ||
    entry.source === 'redemption' ||
    entry.source === 'expiry-sweep';
  const isCredit = !takesCredit;
  const kind =
    TILE_CREDIT_KINDS[entry.source] ??
    (entry.type === 'expire' ? 'expired' : entry.type === 'redeem' ? 'spent' : isCredit ? 'added' : 'removed');
  const storeWords = !MACHINE_REASONS.has(entry.source) && !!entry.reason && readsAsSentence(entry.reason);
  return {
    id: entry.id,
    kind,
    isCredit,
    amount: { amount: centsToMoney(Math.abs(entry.amountCents)), currencyCode: entry.currencyCode || fallbackCurrency },
    createdAt: entry.createdAt,
    expiresAt: isCredit ? entry.expiresAt ?? null : null,
    note: storeWords ? entry.reason!.trim() : null,
    orderName: orderNameIn(entry.sourceRef) ?? orderNameIn(entry.reason),
  };
}

/**
 * Tile Credit's ledger (`GET /public/me/ledger`), which pages by its own cursor. The ledger alone:
 * the gift cards a redemption minted only decorate a line, and `getHistory`'s join fails the whole
 * read when that second call does (old Amore's ENG-609).
 */
export function tileCreditHistory(client: Pick<TileCreditAPI, 'getLedger'>, fallbackCurrency: string): StoreCreditHistorySource {
  return {
    async page(pageSize, cursor) {
      const ledger = await client.getLedger({ limit: pageSize, before: cursor ?? undefined });
      return {
        entries: ledger.entries.map((entry) => tileCreditEntry(entry, fallbackCurrency)),
        nextCursor: ledger.nextCursor,
      };
    },
  };
}

// Shopify store credit (Customer Account API)

const TRANSACTIONS = /* GraphQL */ `
  pageInfo { hasNextPage endCursor }
  edges {
    cursor
    node {
      __typename
      amount { amount currencyCode }
      createdAt
      event
      ... on StoreCreditAccountCreditTransaction { expiresAt }
    }
  }
`;

/**
 * The newest page of every store-credit account (one per currency; `first: 10` as the balance).
 * Each account's cursor, in `edges`, is what reads that one account again on later pages.
 */
export const STORE_CREDIT_HISTORY_QUERY = /* GraphQL */ `
  query StoreCreditHistory($first: Int!) {
    customer {
      storeCreditAccounts(first: 10) {
        edges {
          cursor
          node { id transactions(first: $first, sortKey: CREATED_AT, reverse: true) { ${TRANSACTIONS} } }
        }
      }
    }
  }
`;

/**
 * The next page of each account that has more. The API has no way to read one account by id, so
 * each is read as "the one account after the account before it" (`storeCreditAccounts(first: 1,
 * after:)`), under an alias of its own.
 */
export function storeCreditHistoryNextQuery(accounts: number): string {
  const variables = ['$first: Int!'];
  const reads: string[] = [];
  for (let i = 0; i < accounts; i++) {
    variables.push(`$account${i}: String`, `$after${i}: String!`);
    reads.push(`account${i}: storeCreditAccounts(first: 1, after: $account${i}) {
      edges { cursor node { id transactions(first: $first, after: $after${i}, sortKey: CREATED_AT, reverse: true) { ${TRANSACTIONS} } } }
    }`);
  }
  return `query StoreCreditHistoryMore(${variables.join(', ')}) { customer { ${reads.join('\n')} } }`;
}

interface RawTransaction {
  __typename?: string;
  amount?: { amount: string; currencyCode: string } | null;
  createdAt?: string;
  event?: string | null;
  expiresAt?: string | null;
}

interface RawTransactions {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  edges?: ({ cursor: string; node: RawTransaction | null } | null)[] | null;
}

interface RawAccountEdge {
  cursor: string;
  node: { id: string; transactions: RawTransactions | null } | null;
}

/** Where an account's history is up to: its id, the cursor of the account before it, and its last transaction's. */
interface AccountPlace {
  id: string;
  account: string | null;
  after: string;
}

/** One Shopify store-credit transaction. Its type says which way it went; its event, why. */
function shopifyEntry(accountId: string, cursor: string, node: RawTransaction, fallbackCurrency: string): StoreCreditEntry {
  const type = node.__typename ?? '';
  const signed = Number.parseFloat(node.amount?.amount ?? '0') || 0;
  const isCredit =
    type === 'StoreCreditAccountCreditTransaction' || type === 'StoreCreditAccountDebitRevertTransaction'
      ? true
      : type === 'StoreCreditAccountDebitTransaction' || type === 'StoreCreditAccountExpirationTransaction'
        ? false
        : signed >= 0;
  let kind: StoreCreditEntryKind;
  if (type === 'StoreCreditAccountExpirationTransaction') kind = 'expired';
  else if (type === 'StoreCreditAccountDebitRevertTransaction') kind = 'refunded';
  else if (node.event === 'ADJUSTMENT') kind = isCredit ? 'addedByStore' : 'removedByStore';
  else if (type === 'StoreCreditAccountCreditTransaction') kind = node.event === 'ORDER_REFUND' ? 'refunded' : 'added';
  else if (type === 'StoreCreditAccountDebitTransaction') kind = 'spent';
  else kind = isCredit ? 'added' : 'removed';
  return {
    id: `${accountId}:${cursor}`,
    kind,
    isCredit,
    amount: { amount: centsToMoney(centsOf(node.amount?.amount)), currencyCode: node.amount?.currencyCode || fallbackCurrency },
    createdAt: node.createdAt ?? '',
    expiresAt: isCredit ? node.expiresAt ?? null : null,
    note: null,
    orderName: null,
  };
}

/**
 * Shopify's store credit, for a Shopify sign-in: every account's transactions, newest first. A
 * shopper has one account per currency, so almost always one; with several, each page holds the
 * next `pageSize` of every account that has more, merged by date (`useStoreCreditHistory` keeps the
 * whole list in date order as pages arrive).
 */
export function shopifyStoreCreditHistory(request: AccountRequest, fallbackCurrency: string): StoreCreditHistorySource {
  function read(accounts: (RawAccountEdge | null | undefined)[], before: (string | null)[]): StoreCreditHistoryPage {
    const entries: StoreCreditEntry[] = [];
    const more: AccountPlace[] = [];
    accounts.forEach((edge, i) => {
      const account = edge?.node;
      if (!account) return;
      for (const transaction of account.transactions?.edges ?? []) {
        if (transaction?.node) entries.push(shopifyEntry(account.id, transaction.cursor, transaction.node, fallbackCurrency));
      }
      const end = account.transactions?.pageInfo;
      if (end?.hasNextPage && end.endCursor) more.push({ id: account.id, account: before[i] ?? null, after: end.endCursor });
    });
    entries.sort(newestFirst);
    return { entries, nextCursor: more.length ? JSON.stringify(more) : null };
  }

  return {
    async page(pageSize, cursor) {
      if (!cursor) {
        const data = await request<{ customer: { storeCreditAccounts: { edges: RawAccountEdge[] } } | null }>(
          STORE_CREDIT_HISTORY_QUERY,
          { first: pageSize },
        );
        const edges = data.customer?.storeCreditAccounts.edges ?? [];
        // Each account's place in the list: the cursor of the one before it (none for the first).
        return read(edges, edges.map((_, i) => (i === 0 ? null : edges[i - 1].cursor)));
      }
      let places: AccountPlace[];
      try {
        places = JSON.parse(cursor) as AccountPlace[];
      } catch {
        return { entries: [], nextCursor: null };
      }
      if (!Array.isArray(places) || places.length === 0) return { entries: [], nextCursor: null };
      const variables: Record<string, unknown> = { first: pageSize };
      places.forEach((place, i) => {
        variables[`account${i}`] = place.account;
        variables[`after${i}`] = place.after;
      });
      const data = await request<{ customer: Record<string, { edges: RawAccountEdge[] } | null> | null }>(
        storeCreditHistoryNextQuery(places.length),
        variables,
      );
      // An account list that changed since the first page (one added or closed) puts another account
      // at that place: its transactions aren't this account's next page, so that account stops there.
      const accounts = places.map((place, i) => {
        const edge = data.customer?.[`account${i}`]?.edges?.[0];
        return edge?.node?.id === place.id ? edge : null;
      });
      return read(accounts, places.map((place) => place.account));
    },
  };
}
