import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { WishlistStorageAdapter } from "../types";
import { useShopify } from "./ShopifyProvider";

/** Products per row on a grid with a layout switch. */
export type GridColumns = "1" | "2" | "3";

/** Where the choice is kept unless `ShopifyProvider gridColumnsStorageKey` says otherwise. */
export const GRID_COLUMNS_STORAGE_KEY = "shopify:grid-columns:v1";

export const isGridColumns = (value: unknown): value is GridColumns => value === "1" || value === "2" || value === "3";

/** One choice per app: every grid with the switch changes together. */
let chosen: GridColumns | null = null;
const listeners = new Set<() => void>();
const tellListeners = () => listeners.forEach((listener) => listener());
let readingKey: string | null = null;

/** Reads the saved choice once per launch (per key); a choice made before it arrives wins. */
function readSavedChoice(storage: WishlistStorageAdapter | null, key: string) {
  if (!storage || readingKey === key) return;
  readingKey = key;
  void Promise.resolve()
    .then(() => storage.getItem(key))
    .then((saved) => {
      if (chosen === null && isGridColumns(saved)) {
        chosen = saved;
        tellListeners();
      }
    })
    .catch(() => undefined);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const currentChoice = () => chosen;

/** For tests: forget the choice, as a fresh install would. */
export function forgetGridColumns(): void {
  chosen = null;
  readingKey = null;
}

/**
 * Products per row, and the switch's handler (0.15.0, moved from amore-v2's `gridColumns.ts`): the
 * shopper's choice once they've made one, kept on the phone across launches in the provider's
 * `storage` (one choice for every grid that has the switch), else `fallback` (the grid's own
 * setting), else 2.
 */
export function useGridColumns(fallback: unknown): { columns: GridColumns; setColumns: (columns: GridColumns) => void } {
  const { deviceStorage, gridColumnsStorageKey } = useShopify();
  useEffect(() => readSavedChoice(deviceStorage, gridColumnsStorageKey), [deviceStorage, gridColumnsStorageKey]);
  const choice = useSyncExternalStore(subscribe, currentChoice, currentChoice);
  const setColumns = useCallback(
    (next: GridColumns) => {
      if (!isGridColumns(next) || next === chosen) return;
      chosen = next;
      tellListeners();
      if (deviceStorage) void Promise.resolve().then(() => deviceStorage.setItem(gridColumnsStorageKey, next)).catch(() => undefined);
    },
    [deviceStorage, gridColumnsStorageKey],
  );
  return { columns: choice ?? (isGridColumns(fallback) ? fallback : "2"), setColumns };
}
