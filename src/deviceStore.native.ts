/**
 * Device storage — NATIVE build (iOS/Android): MMKV 3, synchronous and memory-mapped, so reading a
 * product by key costs microseconds inside a render. See `deviceStoreCore.ts`.
 *
 * `react-native-mmkv` is an optional peer: required lazily inside `try`, which Expo's Metro config
 * (`allowOptionalDependencies: true`) bundles as optional. An app without it in its binary (Expo
 * Go, or a build from before it was added) gets the memory fallback instead of a crash. The app
 * lists it in its own dependencies only so the native module is compiled in.
 */
import { memoryStore, type DeviceStore } from './deviceStoreCore';

/** The slice of MMKV 3's API used here, typed locally so the package stays optional. */
interface MMKVInstance {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  getAllKeys(): string[];
}

/** Its own instance id, so the SDK's keys never mix with an app's own MMKV data. */
const INSTANCE_ID = 'tiledev.sdk-shopify';

function openMmkv(): DeviceStore | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-mmkv') as { MMKV?: new (config: { id: string }) => MMKVInstance };
    if (!mod?.MMKV) return null;
    const mmkv = new mod.MMKV({ id: INSTANCE_ID });
    return {
      kind: 'mmkv',
      get: (key) => mmkv.getString(key),
      set: (key, value) => mmkv.set(key, value),
      remove: (key) => mmkv.delete(key),
      keys: () => mmkv.getAllKeys(),
    };
  } catch {
    return null;
  }
}

let store: DeviceStore | null = null;

export function deviceStore(): DeviceStore {
  if (!store) store = openMmkv() ?? memoryStore();
  return store;
}

/** Tests only: swap the backend (null re-opens the default on next use). */
export function setDeviceStore(next: DeviceStore | null): void {
  store = next;
}
