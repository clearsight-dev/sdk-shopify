// The checkout's address helpers (src/checkout.ts): which addresses mean the order was placed, and the
// script that reports each address change from inside the checkout's web view, run here in jsdom as
// the web view would run it. No network, no React.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { isOrderPlacedUrl, REPORT_ADDRESS_CHANGES_SCRIPT } = await import('../dist/checkout.js');

let pass = 0;
const check = async (label, fn) => { await fn(); pass++; console.log('  ✓', label); };

const SHOP = 'https://shop.example';
const CHECKOUT = `${SHOP}/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3`;

console.log('isOrderPlacedUrl: the pages that mean the order was placed');
await check("today's thank-you page and the older checkout's thank_you page", () => {
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/thank-you`), true);
  assert.equal(isOrderPlacedUrl(`${SHOP}/68843864220/checkouts/4f1c2a9be0d7/thank_you`), true);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/thank-you/`), true);
});
await check("one-page checkout's /confirmation", () => {
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/confirmation`), true);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/confirmation/`), true);
});
await check('the order status page under /orders/, and what follows it', () => {
  assert.equal(isOrderPlacedUrl(`${SHOP}/12345/orders/abc123`), true);
  assert.equal(isOrderPlacedUrl(`${SHOP}/12345/orders/abc123/authenticate?key=f00d`), true);
  assert.equal(isOrderPlacedUrl(`${SHOP}/12345/orders/`), true);
});
await check('a query or a fragment after the page is ignored', () => {
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/confirmation?x=1`), true);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/thank-you?locale=en&step=done`), true);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/thank_you#summary`), true);
});
await check('letter case does not matter, and a path with no host is read the same', () => {
  assert.equal(isOrderPlacedUrl(`${SHOP}/CHECKOUTS/CN/Z2Nw/Thank-You`), true);
  assert.equal(isOrderPlacedUrl(`${SHOP}/12345/ORDERS/abc123`), true);
  assert.equal(isOrderPlacedUrl('/checkouts/cn/Z2Nw/confirmation'), true);
  assert.equal(isOrderPlacedUrl('/12345/orders/abc123'), true);
});

console.log('isOrderPlacedUrl: everything else');
await check("the checkout's own steps", () => {
  for (const step of ['information', 'shipping', 'payment', 'processing', '']) {
    assert.equal(isOrderPlacedUrl(`${CHECKOUT}/${step}`), false, step);
  }
  assert.equal(isOrderPlacedUrl(`${SHOP}/cart`), false);
});
await check('a page named only in the query or the fragment never counts', () => {
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/information?return=/orders/`), false);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/information?return=/orders/x`), false);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/information?return_to=%2F12345%2Forders%2Fabc123`), false);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/information?next=/thank-you`), false);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/information?step=/confirmation`), false);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/information#/orders/12`), false);
  assert.equal(isOrderPlacedUrl(`${CHECKOUT}/information#/thank-you`), false);
});
await check('an order opened from the account menu is an old order: nothing under /account/ counts', () => {
  assert.equal(isOrderPlacedUrl(`${SHOP}/account/orders/4f1c2a9be0d7`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/account/orders/4f1c2a9be0d7/`), false);
  assert.equal(isOrderPlacedUrl(`https://shopify.com/68843864220/account/orders/5512345678`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/en/account/orders/4f1c2a9be0d7?ref=checkout`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/ACCOUNT/Orders/4f1c2a9be0d7`), false);
  assert.equal(isOrderPlacedUrl('/account/orders/4f1c2a9be0d7'), false);
  // `account` must be a whole part of the path before `orders`.
  assert.equal(isOrderPlacedUrl(`${SHOP}/myaccount/12345/orders/abc123`), true);
});
await check('the order history list is not an order page (no part after /orders)', () => {
  assert.equal(isOrderPlacedUrl(`${SHOP}/account/orders`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/account/orders?page=2`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/orders`), false);
});
await check('a part of the path that only looks like one of the pages', () => {
  assert.equal(isOrderPlacedUrl(`${SHOP}/pages/thankyou-gift-cards`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/pages/thank-you-for-subscribing`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/blogs/news/thank_youtube`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/pages/confirmations`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/pages/confirmation-pending`), false);
  assert.equal(isOrderPlacedUrl(`${SHOP}/collections/preorders/products/tee`), false);
});
await check('the host is never read as part of the path', () => {
  assert.equal(isOrderPlacedUrl('https://orders/checkouts/cn/Z2Nw/information'), false);
  assert.equal(isOrderPlacedUrl('//orders/checkouts/cn/Z2Nw/information'), false);
  assert.equal(isOrderPlacedUrl('https://confirmation/'), false);
});
await check('no address, or not words at all', () => {
  for (const nothing of [null, undefined, '', 'about:blank', 42, {}, [`${CHECKOUT}/thank-you`]]) {
    assert.equal(isOrderPlacedUrl(nothing), false, String(nothing));
  }
});
await check('asking again gives the same answer (no regex remembers its last match)', () => {
  const placed = `${SHOP}/12345/orders/abc123`;
  for (let round = 0; round < 5; round++) {
    assert.equal(isOrderPlacedUrl(placed), true);
    assert.equal(isOrderPlacedUrl(`${CHECKOUT}/thank-you`), true);
    assert.equal(isOrderPlacedUrl(`${CHECKOUT}/confirmation`), true);
    assert.equal(isOrderPlacedUrl(`${CHECKOUT}/shipping`), false);
    assert.equal(isOrderPlacedUrl(`${SHOP}/account/orders/4f1c2a9be0d7`), false);
  }
});

console.log('REPORT_ADDRESS_CHANGES_SCRIPT, run in a page');
/** A checkout page in jsdom, with the web view's bridge collecting what the script posts. */
function checkoutPage(url = `${CHECKOUT}/information`, { bridge = true } = {}) {
  const dom = new JSDOM('<!doctype html><title>Checkout</title>', { url, runScripts: 'outside-only' });
  const posts = [];
  if (bridge) dom.window.ReactNativeWebView = { postMessage: (data) => posts.push(JSON.parse(data)) };
  return { window: dom.window, posts, run: () => dom.window.eval(REPORT_ADDRESS_CHANGES_SCRIPT) };
}

await check('reports the page it was run in as { kind: "load", url }, and ends in true', () => {
  const page = checkoutPage();
  assert.equal(page.run(), true);
  assert.deepEqual(page.posts, [{ kind: 'load', url: `${CHECKOUT}/information` }]);
});
await check('reports pushState and replaceState, and both still move the page as before', () => {
  const page = checkoutPage();
  page.run();
  page.window.history.pushState({ step: 2 }, '', '/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3/shipping');
  page.window.history.replaceState(null, '', '/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3/thank-you');
  assert.deepEqual(page.posts.slice(1), [
    { kind: 'pushState', url: `${CHECKOUT}/shipping` },
    { kind: 'replaceState', url: `${CHECKOUT}/thank-you` },
  ]);
  assert.equal(page.window.location.pathname, '/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3/thank-you');
  assert.equal(page.window.history.length, 2);
});
await check('reports going back (popstate) and an anchor change (hashchange)', async () => {
  const page = checkoutPage();
  page.run();
  page.window.dispatchEvent(new page.window.PopStateEvent('popstate', { state: null }));
  assert.deepEqual(page.posts.map((post) => post.kind), ['load', 'popstate']);
  // A browser fires popstate and then hashchange for an anchor change: both are reported.
  page.window.location.hash = '#summary';
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(page.posts.slice(2).map((post) => post.kind), ['popstate', 'hashchange']);
  assert.equal(page.posts.at(-1).url, `${CHECKOUT}/information#summary`);
});
await check('run twice in one page, it wraps the history calls once: one report per change', () => {
  const page = checkoutPage();
  assert.equal(page.run(), true);
  assert.equal(page.run(), true);
  page.window.history.pushState(null, '', '/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3/payment');
  assert.deepEqual(page.posts.map((post) => post.kind), ['load', 'pushState']);
});
await check('in a page with no web view to post to (a plain browser), nothing throws', () => {
  const page = checkoutPage(`${CHECKOUT}/information`, { bridge: false });
  assert.equal(page.run(), true);
  page.window.history.pushState(null, '', '/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3/shipping');
  assert.equal(page.window.location.pathname, '/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3/shipping');
});
await check('of a checkout reported step by step, only the thank-you page means the order was placed', () => {
  const page = checkoutPage();
  page.run();
  for (const step of ['shipping', 'payment', 'thank-you']) {
    page.window.history.pushState(null, '', `/checkouts/cn/Z2NwLXVzLWVhc3QxOjAxSjk3/${step}`);
  }
  assert.deepEqual(page.posts.map((post) => isOrderPlacedUrl(post.url)), [false, false, false, true]);
});

console.log("the package's main entry");
await check('exports both, the same ones', async () => {
  const entry = await import('../dist/index.js');
  assert.equal(entry.isOrderPlacedUrl, isOrderPlacedUrl);
  assert.equal(entry.REPORT_ADDRESS_CHANGES_SCRIPT, REPORT_ADDRESS_CHANGES_SCRIPT);
});

console.log(`\n${pass} checks passed`);
