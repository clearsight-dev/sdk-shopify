// `useBlogArticles` and `useArticle` (0.17.0) rendered in jsdom with the real ShopifyProvider and the
// Storefront API stubbed at `fetch`: a blog's newest articles, read once a session and again on refresh;
// an article opened from a list drawn without a read (same image size) or at once while its own size is
// read; its words as paragraphs, bullets and bold runs; a missing article, a failed read, no handles.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const BLOG = { id: 'gid://shopify/Blog/1', handle: 'journal', title: 'Journal' };
const articleNode = (handle, title, publishedAt, contentHtml) => ({
  id: `gid://shopify/Article/${handle}`, handle, title, publishedAt,
  content: contentHtml.replace(/<[^>]*>/g, ''), contentHtml,
  excerpt: null, excerptHtml: null, tags: [],
  image: { url: `https://cdn.shopify.com/${handle}.jpg`, altText: title, width: 1200, height: 800 },
  authorV2: { name: 'Mia Lane', email: null, bio: null },
  blog: BLOG,
});
/** The store's articles, newest first: the order Shopify answers `PUBLISHED_AT` reversed in. */
const ARTICLES = [
  articleNode('fall-edit', 'The Fall Edit', '2026-10-01T09:00:00Z', '<p>Layers, <strong>soft knits</strong> and boots.</p><ul><li>Wool coats</li><li>Ankle boots</li></ul>'),
  articleNode('care-guide', 'How to Care for Linen', '2026-09-12T09:00:00Z', '<p>Wash cold.</p>'),
  articleNode('summer-notes', 'Summer Notes', '2026-07-03T09:00:00Z', '<p>Sun and sand.</p>'),
];

const sent = [];
const fail = { articles: false, article: false };
global.fetch = async (_url, init = {}) => {
  const { query, variables } = JSON.parse(init.body);
  const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'anon';
  if (query.includes('shop {')) {
    return response(200, { data: { shop: { moneyFormat: '${{amount}}', paymentSettings: { currencyCode: 'USD' } }, localization: { country: { isoCode: 'US' } } } });
  }
  sent.push({ name, variables });
  // The provider makes a cart when it starts; an empty one does.
  if (name === 'CartCreate' || name === 'CartGet') {
    const cart = {
      id: 'gid://shopify/Cart/1', checkoutUrl: 'https://shop/checkout', note: '', attributes: [], totalQuantity: 0,
      buyerIdentity: { countryCode: 'US', email: null, phone: null }, lines: { nodes: [] },
      cost: { subtotalAmount: money('0.00'), totalAmount: money('0.00') },
      discountCodes: [], appliedGiftCards: [], createdAt: '', updatedAt: '',
    };
    return response(200, { data: name === 'CartCreate' ? { cartCreate: { cart, userErrors: [] } } : { cart } });
  }
  const pageInfo = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
  if (name === 'BlogArticles') {
    if (fail.articles) return response(500, 'boom');
    if (variables.handle !== BLOG.handle) return response(200, { data: { blog: null } });
    return response(200, { data: { blog: { articles: { nodes: ARTICLES.slice(0, variables.first), pageInfo } } } });
  }
  if (name === 'BlogArticleByHandle') {
    if (fail.article) return response(500, 'boom');
    if (variables.blogHandle !== BLOG.handle) return response(200, { data: { blog: null } });
    const found = ARTICLES.find((article) => article.handle === variables.articleHandle) ?? null;
    return response(200, { data: { blog: { articleByHandle: found } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useBlogArticles, useArticle, clearBlogArticles, clearRequestCache, BLOG_ARTICLES_SHOWN } = await import('../dist/index.js');

const t = harness("a blog's articles, and one article");
const count = (name) => sent.filter((call) => call.name === name).length;
const lastOf = (name) => sent.filter((call) => call.name === name).at(-1);
const settle = (ms = 30) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** Both caches emptied: this session's reads, and the SDK's recent answers. */
const forgetEverything = () => {
  clearBlogArticles();
  clearRequestCache();
};

/** Mounts a probe under the provider; `read()` is the hook's latest answer, `first` its first frame's. */
async function mount(useHook) {
  let latest = null;
  let first = null;
  function Probe() {
    latest = useHook();
    if (!first) first = latest;
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await runAct(async () => {
    root.render(React.createElement(
      ShopifyProvider,
      { config: { storeDomain: 'shop.myshopify.com', storefrontAccessToken: 't', apiVersion: '2026-07' }, auth: { method: 'password', secureStorage: keychain() } },
      React.createElement(Probe),
    ));
  });
  await settle();
  return { read: () => latest, first: () => first, unmount: () => runAct(async () => root.unmount()) };
}

const CARD = { maxWidth: 1080 };

t.section('useBlogArticles');
await t.check('the newest articles first, as many as asked, at the image size asked', async () => {
  const probe = await mount(() => useBlogArticles('journal', { limit: 2, imageTransform: CARD }));
  const { articles, loading, error } = probe.read();
  assert.deepEqual(articles.map((article) => article.handle), ['fall-edit', 'care-guide']);
  assert.equal(articles[0].author.name, 'Mia Lane');
  assert.equal(articles[0].blog.handle, 'journal');
  assert.equal(loading, false);
  assert.equal(error, false);
  const call = lastOf('BlogArticles');
  assert.deepEqual(
    { handle: call.variables.handle, first: call.variables.first, sortKey: call.variables.sortKey, reverse: call.variables.reverse },
    { handle: 'journal', first: 2, sortKey: 'PUBLISHED_AT', reverse: true },
  );
  assert.deepEqual(call.variables.imageTransform, CARD);
  await probe.unmount();
});

await t.check('read once a session: a second section on the same blog draws them in its first frame; refresh reads again', async () => {
  const before = count('BlogArticles');
  const probe = await mount(() => useBlogArticles('journal', { limit: 2, imageTransform: CARD }));
  assert.equal(count('BlogArticles'), before);
  assert.equal(probe.first().articles.length, 2);
  await runAct(async () => probe.read().refresh());
  await settle();
  assert.equal(count('BlogArticles'), before + 1);
  assert.equal(probe.read().articles.length, 2);
  await probe.unmount();
});

await t.check(`the count: ${BLOG_ARTICLES_SHOWN} when not given, 1–50, rounded`, async () => {
  forgetEverything();
  const unset = await mount(() => useBlogArticles('journal'));
  assert.equal(lastOf('BlogArticles').variables.first, BLOG_ARTICLES_SHOWN);
  await unset.unmount();
  const tooMany = await mount(() => useBlogArticles('journal', { limit: 400 }));
  assert.equal(lastOf('BlogArticles').variables.first, 50);
  await tooMany.unmount();
  const none = await mount(() => useBlogArticles('journal', { limit: 0.2 }));
  assert.equal(lastOf('BlogArticles').variables.first, 1);
  assert.equal(none.read().articles.length, 1);
  await none.unmount();
});

await t.check("a blog the store doesn't have: no articles; no blog, or enabled false: nothing read", async () => {
  const missing = await mount(() => useBlogArticles('no-such-blog'));
  assert.deepEqual(missing.read().articles, []);
  assert.equal(missing.read().loading, false);
  assert.equal(missing.read().error, false);
  await missing.unmount();
  const before = count('BlogArticles');
  const none = await mount(() => useBlogArticles(null));
  const off = await mount(() => useBlogArticles('journal', { limit: 3, enabled: false }));
  assert.equal(count('BlogArticles'), before);
  assert.deepEqual(off.read().articles, []);
  await none.unmount();
  await off.unmount();
});

await t.check('a failed read says so, and tells onError', async () => {
  forgetEverything();
  fail.articles = true;
  const errors = [];
  const probe = await mount(() => useBlogArticles('journal', { onError: (_error, context) => errors.push(context) }));
  assert.equal(probe.read().error, true);
  assert.equal(probe.read().loading, false);
  assert.deepEqual(probe.read().articles, []);
  assert.deepEqual(errors[0], { at: 'useBlogArticles', blogHandle: 'journal' });
  fail.articles = false;
  await probe.unmount();
});

t.section('useArticle');
await t.check("its words as paragraphs and bullets with their bold runs, as a product's description", async () => {
  forgetEverything();
  const probe = await mount(() => useArticle('journal', 'fall-edit'));
  const { article, content, loading, notFound } = probe.read();
  assert.equal(article.title, 'The Fall Edit');
  assert.equal(loading, false);
  assert.equal(notFound, false);
  assert.equal(content.html, ARTICLES[0].contentHtml);
  assert.deepEqual(content.blocks, [
    { spans: [{ text: 'Layers, ', bold: false }, { text: 'soft knits', bold: true }, { text: ' and boots.', bold: false }], bullet: false },
    { spans: [{ text: 'Wool coats', bold: false }], bullet: true },
    { spans: [{ text: 'Ankle boots', bold: false }], bullet: true },
  ]);
  await probe.unmount();
});

await t.check('parseContent: false gives no blocks; a parser of your own is used', async () => {
  const off = await mount(() => useArticle('journal', 'fall-edit', { parseContent: false }));
  assert.deepEqual(off.read().content.blocks, []);
  assert.equal(off.read().content.html, ARTICLES[0].contentHtml);
  await off.unmount();
  const own = await mount(() => useArticle('journal', 'fall-edit', { parseContent: (html) => [{ spans: [{ text: String(html.length), bold: false }], bullet: false }] }));
  assert.equal(own.read().content.blocks[0].spans[0].text, String(ARTICLES[0].contentHtml.length));
  await own.unmount();
});

await t.check('opened from a blog section at the same image size: drawn in the first frame, nothing read', async () => {
  forgetEverything();
  const section = await mount(() => useBlogArticles('journal', { limit: 3, imageTransform: CARD }));
  await section.unmount();
  const before = count('BlogArticleByHandle');
  const page = await mount(() => useArticle('journal', 'care-guide', { imageTransform: CARD }));
  assert.equal(page.first().article.title, 'How to Care for Linen');
  assert.equal(page.first().loading, false);
  assert.equal(page.first().content.blocks[0].spans[0].text, 'Wash cold.');
  assert.equal(count('BlogArticleByHandle'), before);
  await page.unmount();
});

await t.check("at another image size: the list's copy at once, then its own size read", async () => {
  const before = count('BlogArticleByHandle');
  const page = await mount(() => useArticle('journal', 'summer-notes', { imageTransform: { maxWidth: 400 } }));
  assert.equal(page.first().article.title, 'Summer Notes');
  assert.equal(page.first().loading, false);
  assert.equal(count('BlogArticleByHandle'), before + 1);
  assert.deepEqual(lastOf('BlogArticleByHandle').variables.imageTransform, { maxWidth: 400 });
  await page.unmount();
});

await t.check('read once a session; refresh reads it again from the network', async () => {
  const before = count('BlogArticleByHandle');
  const probe = await mount(() => useArticle('journal', 'summer-notes', { imageTransform: { maxWidth: 400 } }));
  assert.equal(count('BlogArticleByHandle'), before);
  await runAct(async () => probe.read().refresh());
  await settle();
  assert.equal(count('BlogArticleByHandle'), before + 1);
  assert.equal(probe.read().article.title, 'Summer Notes');
  await probe.unmount();
});

await t.check('no such article, or no such blog: notFound, and it stays known', async () => {
  forgetEverything();
  const missing = await mount(() => useArticle('journal', 'gone'));
  assert.equal(missing.read().article, null);
  assert.equal(missing.read().notFound, true);
  assert.equal(missing.read().loading, false);
  assert.deepEqual(missing.read().content, { html: '', blocks: [] });
  await missing.unmount();
  const before = count('BlogArticleByHandle');
  const again = await mount(() => useArticle('journal', 'gone'));
  assert.equal(again.first().notFound, true);
  assert.equal(count('BlogArticleByHandle'), before);
  await again.unmount();
  const noBlog = await mount(() => useArticle('no-such-blog', 'fall-edit'));
  assert.equal(noBlog.read().notFound, true);
  await noBlog.unmount();
});

await t.check('no handles, or enabled false: nothing read, nothing found or missing', async () => {
  const before = count('BlogArticleByHandle');
  const noArticle = await mount(() => useArticle('journal', undefined));
  const noBlog = await mount(() => useArticle(null, 'fall-edit'));
  const off = await mount(() => useArticle('journal', 'fall-edit', { enabled: false }));
  assert.equal(count('BlogArticleByHandle'), before);
  for (const probe of [noArticle, noBlog, off]) {
    assert.equal(probe.read().article, null);
    assert.equal(probe.read().notFound, false);
    assert.equal(probe.read().loading, false);
    await probe.unmount();
  }
});

await t.check('a failed read says so, and tells onError; a failed refresh keeps the article', async () => {
  forgetEverything();
  fail.article = true;
  const errors = [];
  const probe = await mount(() => useArticle('journal', 'fall-edit', { onError: (_error, context) => errors.push(context) }));
  assert.equal(probe.read().error, true);
  assert.equal(probe.read().notFound, false);
  assert.deepEqual(errors[0], { at: 'useArticle', blogHandle: 'journal', articleHandle: 'fall-edit' });
  fail.article = false;
  await runAct(async () => probe.read().refresh());
  await settle();
  assert.equal(probe.read().article.title, 'The Fall Edit');
  assert.equal(probe.read().error, false);
  fail.article = true;
  await runAct(async () => probe.read().refresh());
  await settle();
  assert.equal(probe.read().error, true);
  assert.equal(probe.read().article.title, 'The Fall Edit');
  fail.article = false;
  await probe.unmount();
});

t.done();
