// Shared by the auth tests: storage, randomness, a clock, and fake Shopify responses.

/** expo-secure-store's rule: letters, digits, `.`, `-` and `_` only. It throws on anything else. */
export const SECURE_STORE_KEY = /^[\w.-]+$/;

/**
 * In-memory storage. `{ secure: true }` behaves like expo-secure-store and throws on a key it would
 * refuse, so a key that only fails on a phone fails here first.
 */
export function memoryStorage(initial = {}, { secure = false } = {}) {
  const map = new Map(Object.entries(initial));
  const check = (key) => {
    if (secure && !SECURE_STORE_KEY.test(key)) throw new Error(`Invalid key provided to SecureStore: ${key}`);
  };
  return {
    map,
    getItem: async (key) => { check(key); return map.has(key) ? map.get(key) : null; },
    setItem: async (key, value) => { check(key); map.set(key, String(value)); },
    removeItem: async (key) => { check(key); map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

/** Storage that behaves like the keychain (expo-secure-store). */
export const keychain = (initial = {}) => memoryStorage(initial, { secure: true });

/** Deterministic bytes: tests check the flow, not the randomness. */
export function counterRandom() {
  let n = 1;
  return (length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (n++ * 37) & 0xff;
    return out;
  };
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** An unsigned JWT: the SDK reads the nonce from it and never checks a signature. */
export const jwt = (claims) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.signature`;

export const parseForm = (body) => Object.fromEntries(new URLSearchParams(body));

export function response(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export const networkDown = () => { throw new TypeError('Network request failed'); };

export function harness(title) {
  let pass = 0;
  console.log(title);
  // The SDK warns on the failures these tests cause on purpose; kept, not printed.
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return {
    warnings,
    section: (name) => console.log(name),
    async check(label, fn) {
      await fn();
      pass += 1;
      console.log('  ✓', label);
    },
    done: () => console.log(`\n${pass} checks passed`),
  };
}
