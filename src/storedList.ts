// A list kept on the device under one key: the storage rules the wishlist and the waitlist share.
//   - Entries are read in any shape the key has held (`read`) and written in one every reader
//     understands (`write`), so an app's earlier key keeps working and an older bundle (an OTA
//     rollback) still reads the list.
//   - Each entry can carry its details (the product or variant as last fetched), so the list draws
//     offline. Details stop at about 1 MB per list, newest first: Android's AsyncStorage can't read
//     back a value over about 2 MB, and a list that can't be read is a list lost.
//   - A value that isn't a list is copied to `<key>:unreadable` before anything replaces it, and a
//     list that fails to read is never written that session.
//   - Earlier keys (`migrateFrom`) are merged in once each, recorded under `<key>:merged`, and left
//     as they were, so an item removed later never comes back.
import type { WishlistStorageAdapter } from './types';

/** Characters of stored details per list. See the note above. */
export const STORED_DETAILS_BUDGET = 1_000_000;

export interface StoredListCodec<T> {
  /** The item's id, unique in the list. */
  idOf(item: T): string;
  /** When it was added (ms epoch, 0 when unknown), to order a merge. */
  addedAt(item: T): number;
  /** One stored entry, in any shape the key has held. Null when it names nothing. */
  read(v: unknown): T | null;
  /** The entry to store. `details` is what `detailsOf` returned, or undefined when over the budget. */
  write(item: T, details: unknown): Record<string, unknown>;
  /** The details to store with the item (trimmed as wanted), undefined when it has none. */
  detailsOf(item: T): unknown;
}

export interface StoredList<T> {
  /** Points the list at a storage and key. Nothing is read until `load`. */
  open(storage: WishlistStorageAdapter | null, key: string): void;
  /** The stored items; `[]` when there are none. A list that failed to read is `[]` and never written. */
  load(): Promise<T[]>;
  /** Merges each of `keys` not merged yet into `items`, newest first, and stores the result. */
  mergeOnce(items: T[], keys: string[]): Promise<T[]>;
  save(items: T[]): Promise<boolean>;
  clear(): Promise<void>;
}

export function createStoredList<T>(codec: StoredListCodec<T>): StoredList<T> {
  let storage: WishlistStorageAdapter | null = null;
  let key = '';
  /** False once the stored list failed to read: writing then would replace a list we never saw. */
  let writable = true;

  /** The entries under `k`, de-duplicated; `null` when it could not be read at all. */
  async function readList(k: string): Promise<T[] | null> {
    if (!storage) return [];
    let raw: string | null;
    try {
      raw = await Promise.resolve(storage.getItem(k));
    } catch {
      return null;
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      try {
        const backup = `${k}:unreadable`;
        if (!(await Promise.resolve(storage.getItem(backup)))) await Promise.resolve(storage.setItem(backup, raw));
      } catch {
        /* best effort */
      }
      return [];
    }
    const seen = new Set<string>();
    const out: T[] = [];
    for (const v of parsed) {
      const item = codec.read(v);
      if (!item) continue;
      const id = codec.idOf(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
    return out;
  }

  function serialize(items: T[]): string {
    let budget = STORED_DETAILS_BUDGET;
    return JSON.stringify(
      items.map((item) => {
        const details = codec.detailsOf(item);
        if (details == null) return codec.write(item, details);
        const size = JSON.stringify(details).length;
        if (size > budget) return codec.write(item, undefined);
        budget -= size;
        return codec.write(item, details);
      }),
    );
  }

  async function save(items: T[]): Promise<boolean> {
    if (!storage || !writable) return false;
    try {
      await Promise.resolve(storage.setItem(key, serialize(items)));
      return true;
    } catch {
      // Storage full or unavailable: the list in memory stays correct regardless.
      return false;
    }
  }

  return {
    open(nextStorage, nextKey) {
      storage = nextStorage;
      key = nextKey;
      writable = true;
    },

    async load() {
      const items = await readList(key);
      writable = items !== null;
      return items ?? [];
    },

    async mergeOnce(items, keys) {
      if (!storage || !writable || keys.length === 0) return items;
      const markerKey = `${key}:merged`;
      let merged: string[] = [];
      try {
        const raw = await Promise.resolve(storage.getItem(markerKey));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) merged = parsed.filter((k): k is string => typeof k === 'string');
      } catch {
        return items;
      }
      const pending = keys.filter((k) => k !== key && !merged.includes(k));
      if (pending.length === 0) return items;

      const seen = new Set(items.map(codec.idOf));
      const next = items.slice();
      for (const k of pending) {
        const found = await readList(k);
        if (found === null) return items;
        for (const item of found) {
          const id = codec.idOf(item);
          if (seen.has(id)) continue;
          seen.add(id);
          next.push(item);
        }
      }
      if (next.length > items.length) {
        // Newest first across the lists; entries without a date keep their order, last.
        next.sort((a, b) => codec.addedAt(b) - codec.addedAt(a));
        // Not recorded if it couldn't be stored: merged again next launch, which skips what's there.
        if (!(await save(next))) return next;
      }
      try {
        await Promise.resolve(storage.setItem(markerKey, JSON.stringify([...merged, ...pending])));
      } catch {
        /* merged again next launch: entries already saved are skipped */
      }
      return next;
    },

    save,

    async clear() {
      if (!storage || !writable) return;
      try {
        await Promise.resolve(storage.removeItem(key));
      } catch {
        /* ignore */
      }
    },
  };
}
