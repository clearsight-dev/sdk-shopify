/**
 * Device storage — WEB build (the editor preview, browsers, tests): `localStorage`, which is
 * synchronous like MMKV. See `deviceStoreCore.ts`; the native build is `deviceStore.native.ts`.
 */
import { memoryStore, type DeviceStore } from './deviceStoreCore';

const PREFIX = 'tiledev.sdk-shopify:';

function openLocalStorage(): DeviceStore | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    // Private modes and blocked storage throw on write, not on access.
    ls.setItem(`${PREFIX}probe`, '1');
    ls.removeItem(`${PREFIX}probe`);
    return {
      kind: 'localStorage',
      get: (key) => {
        try {
          return ls.getItem(PREFIX + key) ?? undefined;
        } catch {
          return undefined;
        }
      },
      set: (key, value) => {
        try {
          ls.setItem(PREFIX + key, value);
        } catch {
          // Quota exceeded: the entry is simply not kept. Caps upstream keep this rare.
        }
      },
      remove: (key) => {
        try {
          ls.removeItem(PREFIX + key);
        } catch {
          /* ignore */
        }
      },
      keys: () => {
        const out: string[] = [];
        try {
          for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
          }
        } catch {
          /* ignore */
        }
        return out;
      },
    };
  } catch {
    return null;
  }
}

let store: DeviceStore | null = null;

export function deviceStore(): DeviceStore {
  if (!store) store = openLocalStorage() ?? memoryStore();
  return store;
}

/** Tests only: swap the backend (null re-opens the default on next use). */
export function setDeviceStore(next: DeviceStore | null): void {
  store = next;
}
