// One rule for what a shopper can do with a size (SDK move 6): `preorderPlanFor`, `purchaseModeFor`
// and `waitlistActionFor`, with the Head of Engineering's two decisions of 2026-10-06; then the product
// tags a waitlist card needs for an auction, read with every standalone variant.
import assert from 'node:assert/strict';
import { harness, response } from './auth-helpers.mjs';

const { preorderPlanFor, purchaseModeFor, waitlistActionFor } = await import('../dist/index.js');

const t = harness('purchase rules: pre-order, the buy bar, a waitlist card');

const PLAN = { id: 'gid://shopify/SellingPlan/1', name: 'Pre-authorize' };
const size = (quantityAvailable, extra = {}) => ({
  id: 'gid://shopify/ProductVariant/7', availableForSale: true, quantityAvailable, sellingPlan: PLAN, ...extra,
});
const cartWith = (units) => ({ lines: units ? [{ merchandise: { id: 'gid://shopify/ProductVariant/7' }, quantity: units }] : [] });

t.section('preorderPlanFor');
await t.check('sold out (0, or oversold below 0), still for sale, with a plan of its own: that plan', () => {
  assert.equal(preorderPlanFor(size(0)), PLAN);
  assert.equal(preorderPlanFor(size(-2)), PLAN);
});
await t.check('decided (a), "Add to Cart": a count Shopify doesn\'t track (null) isn\'t sold out, so no pre-order', () => {
  assert.equal(preorderPlanFor(size(null)), null);
});
await t.check('decided (b), "Auction notice wins": a blocked product is never pre-ordered', () => {
  assert.equal(preorderPlanFor(size(0), { blocked: true }), null);
});
await t.check('in stock, not for sale, or no plan: none', () => {
  assert.equal(preorderPlanFor(size(3)), null);
  assert.equal(preorderPlanFor(size(0, { availableForSale: false })), null);
  assert.equal(preorderPlanFor(size(0, { sellingPlan: null })), null);
  assert.equal(preorderPlanFor(null), null);
  assert.equal(preorderPlanFor(undefined), null);
});

t.section('purchaseModeFor (a product page\'s buy bar)');
const mode = (over) => purchaseModeFor({ status: 'available', variant: size(5), canAddMore: true, heldInOtherCarts: false, ...over });
await t.check('decided (b): blocked wins over a pre-order, and over everything else', () => {
  assert.equal(mode({ status: 'blocked', variant: size(0) }), 'blocked');
  assert.equal(mode({ status: 'blocked', heldInOtherCarts: true, canAddMore: false }), 'blocked');
});
await t.check('a pre-order wins over sold out, held in other carts and every unit in this cart', () => {
  assert.equal(mode({ status: 'unavailable', variant: size(0) }), 'preorder');
  assert.equal(mode({ status: 'unavailable', variant: size(-1), heldInOtherCarts: true, canAddMore: false }), 'preorder');
});
await t.check('decided (a): untracked stock with a plan is bought, not pre-ordered', () => {
  assert.equal(mode({ variant: size(null) }), 'buy');
});
await t.check('then sold out, then held in other carts, then every unit in this cart, then buy', () => {
  assert.equal(mode({ status: 'unavailable', variant: size(0, { sellingPlan: null }) }), 'soldOut');
  assert.equal(mode({ heldInOtherCarts: true }), 'heldInOtherCarts');
  assert.equal(mode({ canAddMore: false }), 'allInCart');
  assert.equal(mode({}), 'buy');
});
await t.check('every unit in this cart needs a chosen size on a page that has loaded', () => {
  assert.equal(mode({ canAddMore: false, variant: null }), 'buy');
  assert.equal(mode({ canAddMore: false, status: 'loading' }), 'buy');
  assert.equal(mode({ canAddMore: false, status: 'unknown' }), 'buy');
});

t.section('waitlistActionFor (a waitlist card)');
await t.check('sold out with a plan: preorder', () => {
  assert.equal(waitlistActionFor(size(0), cartWith(0)), 'preorder');
});
await t.check('decided (a), "Add to Cart": untracked stock with a plan is added to the cart, with no ceiling', () => {
  assert.equal(waitlistActionFor(size(null), cartWith(0)), 'addToCart');
  assert.equal(waitlistActionFor(size(null), cartWith(40)), 'addToCart');
});
await t.check('decided (b), "Auction notice wins": a blocked product is not buyable, sold out with a plan or in stock', () => {
  assert.equal(waitlistActionFor(size(0), cartWith(0), { blocked: true }), 'blocked');
  assert.equal(waitlistActionFor(size(5, { sellingPlan: null }), cartWith(0), { blocked: true }), 'blocked');
});
await t.check('back in stock with a unit beyond this cart\'s: addToCart; every unit already in it: inCart', () => {
  assert.equal(waitlistActionFor(size(2, { sellingPlan: null }), cartWith(1)), 'addToCart');
  assert.equal(waitlistActionFor(size(2, { sellingPlan: null }), cartWith(2)), 'inCart');
  assert.equal(waitlistActionFor(size(2, { sellingPlan: null }), null), 'addToCart');
});
await t.check('sold out with no plan, or not for sale: waiting', () => {
  assert.equal(waitlistActionFor(size(0, { sellingPlan: null }), cartWith(0)), 'waiting');
  assert.equal(waitlistActionFor(size(5, { availableForSale: false }), cartWith(0)), 'waiting');
});

t.section('a standalone variant carries its product\'s tags');
const sent = [];
global.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  sent.push(query);
  const node = (id, tags) => ({
    __typename: 'ProductVariant', id, title: 'S', sku: null, availableForSale: true, quantityAvailable: 0,
    price: { amount: '10.0', currencyCode: 'USD' }, compareAtPrice: null, selectedOptions: [], image: null,
    sellingPlanAllocations: { nodes: [{ sellingPlan: PLAN, remainingBalanceChargeAmount: null }] },
    product: { id: 'gid://shopify/Product/1', title: 'P', handle: 'p', featuredImage: null, media: { nodes: [] }, ...(tags ? { tags } : {}) },
  });
  return response(200, { data: { nodes: variables.ids.map((id, i) => node(id, i === 0 ? ['SEARCH-BLOCKED', 'new'] : null)) } });
};
const { shopify } = await import('../dist/index.js');
const { setConfig } = await import('../dist/client.js');
setConfig({ storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' });
const variants = await shopify.variants.byIds(['gid://shopify/ProductVariant/1', 'gid://shopify/ProductVariant/2']);
await t.check('the query asks for the product\'s tags, and each variant has them ([] when Shopify sends none)', () => {
  assert.match(sent.find((q) => q.includes('query VariantNodes')), /product \{[^}]*\btags\b/);
  assert.deepEqual(variants.map((v) => v.product.tags), [['SEARCH-BLOCKED', 'new'], []]);
});
await t.check('so an app\'s auction rule can block the card', () => {
  const blocked = variants[0].product.tags.includes('SEARCH-BLOCKED');
  assert.equal(waitlistActionFor(variants[0], null, { blocked }), 'blocked');
  assert.equal(waitlistActionFor(variants[1], null, { blocked: variants[1].product.tags.includes('SEARCH-BLOCKED') }), 'preorder');
});

t.done();
