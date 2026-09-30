/**
 * The SDK's own device storage: synchronous, so a hook can read it during render and a product page
 * can open with data on its first frame.
 *
 * Two builds pick the backend. `deviceStore.native.ts` (iOS/Android) uses MMKV; `deviceStore.ts`
 * (web, the editor preview, tests) uses `localStorage`. Metro resolves the right file per platform,
 * so a web bundle never sees MMKV. Either falls back to memory when its backend is missing, so the
 * cache only ever gets slower, never breaks the app.
 *
 * Only public catalogue data goes here: no cart, customer, order or wallet data, ever.
 */

export interface DeviceStore {
  readonly kind: 'mmkv' | 'localStorage' | 'memory';
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Every key this store holds (its own namespace only). */
  keys(): string[];
}

/** A store that lives as long as the JS process: the fallback when the device has none. */
export function memoryStore(): DeviceStore {
  const map = new Map<string, string>();
  return {
    kind: 'memory',
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: () => Array.from(map.keys()),
  };
}

/** FNV-1a 32-bit as 8 hex digits: short, stable keys for long inputs. */
export function hashKey(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
