// Helpers a Tile app's tiles import from the package root (0.21.0), from amore-v2, the base app: the card
// and product page image sizes, the auction tag, and `openWebPage` (the store's own pages in the in-app
// browser, any other site with the phone), with the store's web domains from the config.
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { harness, memoryStorage } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);

// ── Storefront stub: just enough for `shopify.init` and the provider to start ──
const money = { amount: '0.00', currencyCode: 'USD' };
const emptyCart = {
  id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', totalQuantity: 0, lines: { nodes: [] },
  cost: { subtotalAmount: money, totalAmount: money }, discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
};
const ANSWERS = {
  ShopInfo: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } } },
  CartCreate: { cartCreate: { cart: emptyCart, userErrors: [] } },
  CartGet: { cart: emptyCart },
};
global.fetch = async (_url, init) => {
  const { query } = JSON.parse(init.body);
  const name = (/(?:query|mutation) (\w+)/.exec(query) || [])[1];
  const body = JSON.stringify({ data: ANSWERS[name] ?? {} });
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
};

// A rejection the SDK let through would land here, where a phone shows a red box.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
const tick = () => new Promise((r) => setTimeout(r, 5));

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const {
  shopify,
  ShopifyProvider,
  CARD_IMAGE_WIDTH,
  CARD_IMAGE,
  PRODUCT_PAGE_IMAGE,
  cardImageUrl,
  cardPhotoUrl,
  AUCTION_TAG,
  isAuctioned,
  isStoreWebLink,
  openWebPage,
} = await import('../dist/index.js');

const CONFIG = { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', cache: false };
const STORE = 'store.example.com';
const CDN = 'https://cdn.shopify.com/s/files/1/0001/files';

const t = harness('tile helpers: image sizes, the auction tag, openWebPage');

// ── Image sizes ─────────────────────────────────────────────────────────────
t.section('card and product page image sizes');
await t.check('the values are amore-v2\'s: cards 660 wide, the product page 1080', () => {
  assert.equal(CARD_IMAGE_WIDTH, 660);
  assert.deepEqual(CARD_IMAGE, { maxWidth: 660 });
  assert.deepEqual(PRODUCT_PAGE_IMAGE, { maxWidth: 1080 });
});
await t.check('cardImageUrl: an original gets width=660, a sized URL is rewritten to 660, no URL is null', () => {
  assert.equal(cardImageUrl(`${CDN}/dress.jpg`), `${CDN}/dress.jpg?width=660`);
  assert.equal(cardImageUrl(`${CDN}/dress.jpg?v=17`), `${CDN}/dress.jpg?v=17&width=660`);
  assert.equal(cardImageUrl(`${CDN}/dress_1080x.jpg?v=17`), `${CDN}/dress_660x.jpg?v=17`);
  assert.equal(cardImageUrl(`${CDN}/dress_330x@2x.jpg`), `${CDN}/dress_660x.jpg`);
  assert.equal(cardImageUrl(null), null);
  assert.equal(cardImageUrl(undefined), null);
  assert.equal(cardImageUrl(''), null);
});
await t.check('cardPhotoUrl: a URL Shopify already sized is drawn as it is; an original at the card size', () => {
  for (const sized of [
    `${CDN}/dress_660x.jpg`,
    `${CDN}/dress_1080x.jpg?v=17`,
    `${CDN}/dress_330x@2x.jpg`,
    `${CDN}/dress_100x100_crop_center.jpg`,
    `${CDN}/dress_x480.webp`,
  ]) {
    assert.equal(cardPhotoUrl(sized), sized);
  }
  assert.equal(cardPhotoUrl(`${CDN}/dress.jpg?v=17`), `${CDN}/dress.jpg?v=17&width=660`);
  assert.equal(cardPhotoUrl(`${CDN}/dress.jpg`), `${CDN}/dress.jpg?width=660`);
  assert.equal(cardPhotoUrl(null), null);
  assert.equal(cardPhotoUrl(undefined), null);
  assert.equal(cardPhotoUrl(''), null);
});
await t.check('cardPhotoUrl answers as amore-v2\'s did, URL for URL', () => {
  // The app's rule as it was (src/core/utils/images.ts), on the SDK's own sizedImageUrl.
  const APP_SIZED = /_\d*x\d*(@\dx)?(_crop_[a-z]+)?\.[a-z0-9]+(\?|$)/i;
  const appCardPhotoUrl = (url) => (url && APP_SIZED.test(url) ? url : cardImageUrl(url));
  const urls = [
    `${CDN}/a.jpg`, `${CDN}/a.JPG?v=1`, `${CDN}/a_660x.png`, `${CDN}/a_200x200.jpg?v=2`, `${CDN}/a_2x.jpg`,
    `${CDN}/a_300x@3x.jpg?v=1&x=2`, `${CDN}/a_100x100_crop_TOP.jpg`, `${CDN}/a_x.jpg`, `${CDN}/a_xmas.jpg`,
    `${CDN}/a.jpg#frag`, '', null, undefined,
  ];
  for (const url of urls) assert.equal(cardPhotoUrl(url), appCardPhotoUrl(url), String(url));
});

// ── The auction tag ─────────────────────────────────────────────────────────
t.section('the auction tag');
await t.check('AUCTION_TAG is SEARCH-BLOCKED', () => {
  assert.equal(AUCTION_TAG, 'SEARCH-BLOCKED');
});
await t.check('isAuctioned: true while the product carries the tag, among others', () => {
  assert.equal(isAuctioned({ tags: ['SEARCH-BLOCKED'] }), true);
  assert.equal(isAuctioned({ tags: ['new', 'SEARCH-BLOCKED', 'dresses'] }), true);
  assert.equal(isAuctioned({ tags: Object.freeze(['SEARCH-BLOCKED']) }), true);
});
await t.check('false without it: other tags, no tags, empty or null tags, another case', () => {
  assert.equal(isAuctioned({ tags: ['new', 'dresses'] }), false);
  assert.equal(isAuctioned({ tags: [] }), false);
  assert.equal(isAuctioned({ tags: null }), false);
  assert.equal(isAuctioned({}), false);
  assert.equal(isAuctioned({ tags: ['search-blocked'] }), false);
  assert.equal(isAuctioned({ tags: ['SEARCH-BLOCKED-2024'] }), false);
});
await t.check('it filters a list of products, and reads a waitlist variant\'s product', () => {
  const products = [
    { id: 'a', tags: ['SEARCH-BLOCKED'] },
    { id: 'b', tags: [] },
    { id: 'c', tags: ['live', 'SEARCH-BLOCKED'] },
  ];
  assert.deepEqual(products.filter(isAuctioned).map((p) => p.id), ['a', 'c']);
  const waitlistVariant = { id: 'gid://shopify/ProductVariant/7', product: { handle: 'h', title: 'H', tags: ['SEARCH-BLOCKED'] } };
  assert.equal(isAuctioned(waitlistVariant.product), true);
});

// ── The store's web domains ─────────────────────────────────────────────────
t.section('isStoreWebLink and the config\'s webDomains');
const LINKS = {
  store: `https://${STORE}/pages/about`,
  upper: `HTTPS://STORE.EXAMPLE.COM/policies/privacy-policy`,
  www: `https://www.${STORE}/`,
};
await t.check('with no domains set, no link is the store\'s', () => {
  for (const url of Object.values(LINKS)) assert.equal(isStoreWebLink(url), false);
});
await shopify.init({ ...CONFIG, webDomains: ['Store.Example.COM', ' www.store.example.com '] });
await t.check('shopify.init sets them: an https link on one, in any case, is the store\'s', () => {
  assert.equal(isStoreWebLink(LINKS.store), true);
  assert.equal(isStoreWebLink(LINKS.upper), true);
  assert.equal(isStoreWebLink(LINKS.www), true);
  assert.equal(isStoreWebLink(`  https://${STORE}?ref=a  `), true);
  assert.equal(isStoreWebLink(`https://${STORE}:443/cart`), true);
});
await t.check('https only; another host, a lookalike, the Shopify domain or the app\'s scheme isn\'t', () => {
  assert.equal(isStoreWebLink(`http://${STORE}/`), false);
  assert.equal(isStoreWebLink(`${STORE}/pages/about`), false);
  assert.equal(isStoreWebLink(`https://${STORE}.evil.test/`), false);
  assert.equal(isStoreWebLink(`https://evil.test/?next=https://${STORE}/`), false);
  assert.equal(isStoreWebLink('https://shop.myshopify.com/'), false);
  assert.equal(isStoreWebLink('https://rewards.example.com/'), false);
  assert.equal(isStoreWebLink('amorefashion://collections/tops'), false);
  assert.equal(isStoreWebLink(''), false);
});
await shopify.init(CONFIG);
await t.check('a config without them clears them', () => {
  assert.equal(isStoreWebLink(LINKS.store), false);
});

let root = null;
const seen = [];
/** What a tile below the provider sees during its own render. */
function Probe({ url }) {
  seen.push(isStoreWebLink(url));
  return null;
}
async function render(config, url = LINKS.store) {
  root ??= createRoot(document.getElementById('root'));
  seen.length = 0;
  await runAct(async () => {
    root.render(React.createElement(ShopifyProvider, { config, storage: memoryStorage() }, React.createElement(Probe, { url })));
  });
  await runAct(async () => { await tick(); });
}
async function unmount() {
  if (root) await runAct(async () => root.unmount());
  root = null;
}

await render({ ...CONFIG, webDomains: [STORE.toUpperCase()] });
await t.check('ShopifyProvider sets them on its first render: a tile below it knows them on its own', () => {
  assert.equal(seen[0], true);
  assert.equal(isStoreWebLink(LINKS.upper), true);
});
await render({ ...CONFIG, webDomains: ['other.example.com'] });
await t.check('and again when its config brings others', () => {
  assert.equal(seen[0], false);
  assert.equal(isStoreWebLink('https://other.example.com/pages/faq'), true);
  assert.equal(isStoreWebLink(LINKS.store), false);
});
await unmount();
await render(CONFIG);
await t.check('a provider whose config has none: no link is the store\'s', () => {
  assert.equal(seen[0], false);
  assert.equal(isStoreWebLink('https://other.example.com/pages/faq'), false);
});
await unmount();

// ── openWebPage ─────────────────────────────────────────────────────────────
t.section('openWebPage: the phone\'s build');
await shopify.init({ ...CONFIG, webDomains: [STORE] });

/** A stand-in phone: what the in-app browser and `Linking` were asked to open. */
function phone({ browser = true, linking = true, browserFails = false, linkingFails = false, browserThrows = false } = {}) {
  const opened = { browser: [], linking: [] };
  const modules = {
    browser: browser && {
      openBrowserAsync(url) {
        if (browserThrows) throw new Error("Cannot find native module 'ExpoWebBrowser'");
        opened.browser.push(url);
        return browserFails ? Promise.reject(new Error('Another WebBrowser is already being presented')) : Promise.resolve({ type: 'opened' });
      },
    },
    linking: linking && {
      openURL(url) {
        opened.linking.push(url);
        return linkingFails ? Promise.reject(new Error(`Unable to open URL: ${url}`)) : Promise.resolve(true);
      },
    },
  };
  return { modules, opened };
}

/**
 * The phone's build (`openWebPage.native.js`, which Metro picks on iOS and Android), with React Native
 * and expo-web-browser stood in for while `fn` runs: it requires them on each call, not when it loads.
 * A module set to false is one the app doesn't have.
 */
const nativeFile = require.resolve('../dist/openWebPage.native.js');
function onPhone({ modules }, fn) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'expo-web-browser') {
      if (!modules.browser) throw new Error("Cannot find module 'expo-web-browser'");
      return modules.browser;
    }
    if (request === 'react-native') {
      if (!modules.linking) throw new Error("Cannot find module 'react-native'");
      return { Linking: modules.linking };
    }
    return load.call(this, request, ...rest);
  };
  try {
    return fn(require(nativeFile).openWebPage);
  } finally {
    Module._load = load;
  }
}

await t.check('a page on the store\'s website opens in the in-app browser, in any case, and Linking isn\'t asked', () => {
  const p = phone();
  onPhone(p, (open) => {
    open(`https://${STORE}/policies/privacy-policy`);
    open(LINKS.upper);
  });
  assert.deepEqual(p.opened.browser, [`https://${STORE}/policies/privacy-policy`, LINKS.upper]);
  assert.deepEqual(p.opened.linking, []);
});
await t.check('any other link goes to Linking.openURL: another site, http, a mail link, the app\'s scheme', () => {
  const p = phone();
  const urls = ['https://rewards.example.com/', `http://${STORE}/pages/about`, 'mailto:help@example.com', 'amorefashion://live'];
  onPhone(p, (open) => { for (const url of urls) open(url); });
  assert.deepEqual(p.opened.linking, urls);
  assert.deepEqual(p.opened.browser, []);
});
await t.check('it opens at once, in the call, not a tick later', () => {
  const p = phone();
  onPhone(p, (open) => {
    open(LINKS.store);
    open('https://rewards.example.com/');
    assert.deepEqual(p.opened, { browser: [LINKS.store], linking: ['https://rewards.example.com/'] });
  });
});
await t.check('with no domains set, the store\'s own page goes to Linking too', async () => {
  await shopify.init(CONFIG);
  const p = phone();
  onPhone(p, (open) => open(LINKS.store));
  assert.deepEqual(p.opened, { browser: [], linking: [LINKS.store] });
  await shopify.init({ ...CONFIG, webDomains: [STORE] });
});
await t.check('an app without expo-web-browser opens the store\'s page with Linking, and doesn\'t crash', () => {
  const p = phone({ browser: false });
  onPhone(p, (open) => open(LINKS.store));
  assert.deepEqual(p.opened.linking, [LINKS.store]);
});
await t.check('errors are swallowed: a rejected browser or Linking, a browser that throws, no React Native', async () => {
  const rejecting = phone({ browserFails: true, linkingFails: true });
  onPhone(rejecting, (open) => {
    assert.equal(open(LINKS.store), undefined);
    assert.equal(open('https://rewards.example.com/'), undefined);
  });
  assert.deepEqual(rejecting.opened, { browser: [LINKS.store], linking: ['https://rewards.example.com/'] });
  onPhone(phone({ browserThrows: true }), (open) => assert.doesNotThrow(() => open(LINKS.store)));
  onPhone(phone({ browser: false, linking: false }), (open) => {
    assert.doesNotThrow(() => open(LINKS.store));
    assert.doesNotThrow(() => open('https://rewards.example.com/'));
  });
  onPhone(phone(), (open) => assert.doesNotThrow(() => open(undefined)));
  await tick();
  assert.deepEqual(unhandled, []);
});

t.section('openWebPage: the web build (the editor preview, browsers)');
await t.check('the package root in Node is the web build: every link in a new tab, as React Native Web\'s Linking does', () => {
  const tabs = [];
  globalThis.open = (...args) => { tabs.push(args); return null; };
  try {
    openWebPage(LINKS.store);
    openWebPage('https://rewards.example.com/');
  } finally {
    delete globalThis.open;
  }
  assert.deepEqual(tabs, [
    [LINKS.store, '_blank', 'noopener'],
    ['https://rewards.example.com/', '_blank', 'noopener'],
  ]);
});
await t.check('no window (Node), or a window that throws: nothing opens, nothing is thrown', () => {
  assert.doesNotThrow(() => openWebPage(LINKS.store));
  globalThis.open = () => { throw new Error('blocked'); };
  try {
    assert.doesNotThrow(() => openWebPage(LINKS.store));
  } finally {
    delete globalThis.open;
  }
});

t.done();
