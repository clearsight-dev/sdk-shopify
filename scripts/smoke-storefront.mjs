#!/usr/bin/env node
/**
 * Live smoke test against a real Storefront API.
 *
 * Zero deps, like the SDK itself — run it after `npm run build`:
 *
 *   SHOPIFY_STORE_DOMAIN=my-store.myshopify.com \
 *   SHOPIFY_STOREFRONT_TOKEN=xxxx \
 *   node scripts/smoke-storefront.mjs
 *
 * Optional: SHOPIFY_API_VERSION (default 2024-10).
 *
 * Cart checks create a throwaway cart on the target store. Carts are ephemeral
 * and never become orders, but point this at a dev store if that matters to you.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shopify, request } = require('../dist/index.js');

const domain = process.env.SHOPIFY_STORE_DOMAIN;
const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';

if (!domain || !token) {
  console.error('Set SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_TOKEN.');
  process.exit(2);
}

let failures = 0;
function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await shopify.init({
    storeDomain: domain,
    storefrontAccessToken: token,
    apiVersion,
    country: 'US',
    language: 'EN',
  });
  console.log(`Storefront smoke — ${domain} @ ${apiVersion}\n`);

  console.log('products.byIds');
  const seed = await shopify.products.list({ first: 3 });
  const ids = seed.nodes.map((product) => product.id);
  const bulk = await shopify.products.byIds(ids);
  check('resolves a batch in one round-trip', bulk.length === ids.length, `${bulk.length}/${ids.length}`);
  check('empty input short-circuits', (await shopify.products.byIds([])).length === 0);

  console.log('\nmetafields (read-only)');
  const identifiers = [{ namespace: 'reviews', key: 'rating' }];
  const productMetafields = await shopify.metafields.product(ids[0], identifiers);
  check('product query is accepted', Array.isArray(productMetafields), `${productMetafields.length} set`);
  const variantId = bulk[0]?.variants?.[0]?.id;
  if (variantId) {
    const variantMetafields = await shopify.metafields.variant(variantId, identifiers);
    check('variant query is accepted', Array.isArray(variantMetafields), `${variantMetafields.length} set`);
  }
  let guarded = false;
  try {
    await shopify.metafields.product(ids[0], []);
  } catch {
    guarded = true;
  }
  check('empty identifier list is rejected', guarded);

  console.log('\ncart note + attributes');
  const cart = await shopify.cart.create({ lines: variantId ? [{ merchandiseId: variantId, quantity: 1 }] : [] });
  const noted = await shopify.cart.updateNote(cart.id, 'smoke-test note');
  check('note round-trips', noted.note === 'smoke-test note', JSON.stringify(noted.note));
  const withAttrs = await shopify.cart.updateAttributes(cart.id, [{ key: '_smokeTest', value: 'true' }]);
  check(
    'attributes round-trip',
    withAttrs.attributes.some((attribute) => attribute.key === '_smokeTest' && attribute.value === 'true'),
    JSON.stringify(withAttrs.attributes),
  );
  check('note survives an attributes update', withAttrs.note === 'smoke-test note');
  const cleared = await shopify.cart.updateNote(cart.id, null);
  check('null clears the note', !cleared.note, JSON.stringify(cleared.note));

  console.log('\nrequest() escape hatch');
  const raw = await request('query { shop { name } }');
  check('runs an unwrapped operation', typeof raw?.shop?.name === 'string', raw?.shop?.name);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSmoke run threw:', error.message);
  process.exit(1);
});
