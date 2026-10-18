// `useBlogs` and `useBlogArticles`' paging (0.18.0) rendered in jsdom with the real ShopifyProvider and
// the Storefront API stubbed at `fetch`: every blog with its newest articles in one request, read once a
// session and again on refresh, a store with more blogs than one read; a blog opened from there drawn in
// the first frame; a blog's articles a page at a time, the blog's title and a missing blog, a failed next
// page and a refresh starting over.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { deferred, harness, keychain, response } from './auth-helpers.mjs';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;

const money = (amount) => ({ amount, currencyCode: 'USD' });
const blogOf = (handle, title) => ({ id: `gid://shopify/Blog/${handle}`, handle, title });
const articleNode = (blog, number) => ({
  id: `gid://shopify/Article/${blog.handle}-${number}`,
  handle: `${blog.handle}-post-${number}`,
  title: `${blog.title} post ${number}`,
  // Newest first: post 1 is the newest.
  publishedAt: new Date(Date.UTC(2026, 9, 1) - number * 86_400_000).toISOString(),
  content: `Words of post ${number}.`,
  contentHtml: `<p>Words of post ${number}.</p>`,
  excerpt: null, excerptHtml: null, tags: [],
  image: { url: `https://cdn.shopify.com/${blog.handle}-${number}.jpg`, altText: null, width: 1200, height: 800 },
  authorV2: { name: 'Mia Lane', email: null, bio: null },
  blog,
});
const postsOf = (blog, count) => Array.from({ length: count }, (_, index) => articleNode(blog, index + 1));

const JOURNAL = blogOf('journal', 'Journal');
const LOOKBOOK = blogOf('lookbook', 'Lookbook');
const EMPTY = blogOf('empty', 'Empty');
/** The store's blogs in the order it made them, each with its articles newest first. */
const STORE = [
  { blog: JOURNAL, articles: postsOf(JOURNAL, 7) },
  { blog: LOOKBOOK, articles: postsOf(LOOKBOOK, 2) },
  { blog: EMPTY, articles: [] },
];
/** A store with 60 blogs of one article each: more than one read brings. */
const MANY = Array.from({ length: 60 }, (_, index) => {
  const blog = blogOf(`blog-${index + 1}`, `Blog ${index + 1}`);
  return { blog, articles: postsOf(blog, 1) };
});

const sent = [];
const store = { blogs: STORE };
const fail = { blogs: false, articles: false };
/** A read held until the test lets it go. */
const hold = { articles: null, blogs: null };

/** A page of a list: `after` is where it starts, as a number in words. */
function pageOf(items, first, after) {
  const start = after ? Number(after) : 0;
  const end = Math.min(items.length, start + first);
  return {
    nodes: items.slice(start, end),
    pageInfo: { hasNextPage: end < items.length, hasPreviousPage: start > 0, startCursor: String(start), endCursor: end < items.length ? String(end) : null },
  };
}

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
  if (name === 'BlogsWithArticles') {
    if (hold.blogs) await hold.blogs.promise;
    if (fail.blogs) return response(500, 'boom');
    const page = pageOf(store.blogs, variables.first, variables.after);
    return response(200, {
      data: {
        blogs: {
          nodes: page.nodes.map(({ blog, articles }) => ({ ...blog, articles: pageOf(articles, variables.articlesPerBlog) })),
          pageInfo: page.pageInfo,
        },
      },
    });
  }
  if (name === 'BlogArticles') {
    if (hold.articles) await hold.articles.promise;
    if (fail.articles) return response(500, 'boom');
    const found = store.blogs.find(({ blog }) => blog.handle === variables.handle);
    if (!found) return response(200, { data: { blog: null } });
    return response(200, { data: { blog: { ...found.blog, articles: pageOf(found.articles, variables.first, variables.after) } } });
  }
  return response(200, { data: {} });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const TestUtils = await import('react-dom/test-utils');
const runAct = React.act ?? TestUtils.act ?? TestUtils.default.act;
const { ShopifyProvider, useBlogs, useBlogArticles, useArticle, clearBlogArticles, clearRequestCache, shopify } = await import('../dist/index.js');

const t = harness('every blog, and a blog a page at a time');
const count = (name) => sent.filter((call) => call.name === name).length;
const lastOf = (name) => sent.filter((call) => call.name === name).at(-1);
const settle = (ms = 30) => runAct(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** Both caches emptied: this session's reads, and the SDK's recent answers. */
const forgetEverything = () => {
  clearBlogArticles();
  clearRequestCache();
};
const handles = (articles) => articles.map((article) => article.handle);

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

t.section('useBlogs');
await t.check("every blog in the store's order, each with its newest articles, in one request", async () => {
  const before = count('BlogsWithArticles');
  const probe = await mount(() => useBlogs({ articlesPerBlog: 3, imageTransform: CARD }));
  const { blogs, loading, error, refreshing } = probe.read();
  // Loading from the first frame: a page never says "no blogs" before reading.
  assert.equal(probe.first().loading, true);
  assert.equal(count('BlogsWithArticles'), before + 1);
  assert.deepEqual(blogs.map((blog) => [blog.handle, blog.title]), [['journal', 'Journal'], ['lookbook', 'Lookbook'], ['empty', 'Empty']]);
  assert.deepEqual(handles(blogs[0].articles), ['journal-post-1', 'journal-post-2', 'journal-post-3']);
  assert.equal(blogs[0].articlesPageInfo.hasNextPage, true);
  assert.deepEqual(handles(blogs[1].articles), ['lookbook-post-1', 'lookbook-post-2']);
  assert.equal(blogs[1].articlesPageInfo.hasNextPage, false);
  assert.deepEqual(blogs[2].articles, []);
  assert.equal(blogs[0].articles[0].author.name, 'Mia Lane');
  assert.deepEqual([loading, error, refreshing], [false, false, false]);
  const call = lastOf('BlogsWithArticles');
  assert.deepEqual({ first: call.variables.first, articlesPerBlog: call.variables.articlesPerBlog }, { first: 50, articlesPerBlog: 3 });
  assert.deepEqual(call.variables.imageTransform, CARD);
  await probe.unmount();
});

await t.check('read once a session: coming back draws them in the first frame; refresh reads again, keeping them shown', async () => {
  const before = count('BlogsWithArticles');
  const probe = await mount(() => useBlogs({ articlesPerBlog: 3, imageTransform: CARD }));
  assert.equal(count('BlogsWithArticles'), before);
  assert.equal(probe.first().blogs.length, 3);
  assert.equal(probe.first().loading, false);
  hold.blogs = deferred();
  await runAct(async () => probe.read().refresh());
  await settle();
  const { refreshing, blogs, loading } = probe.read();
  assert.deepEqual({ refreshing, blogs: blogs.length, loading }, { refreshing: true, blogs: 3, loading: false });
  hold.blogs.resolve();
  hold.blogs = null;
  await settle();
  assert.equal(count('BlogsWithArticles'), before + 1);
  assert.equal(probe.read().refreshing, false);
  assert.equal(probe.read().blogs.length, 3);
  await probe.unmount();
});

await t.check('articles per blog: 6 when not given, 1–50, rounded', async () => {
  forgetEverything();
  const unset = await mount(() => useBlogs());
  assert.equal(lastOf('BlogsWithArticles').variables.articlesPerBlog, 6);
  assert.equal(unset.read().blogs[0].articles.length, 6);
  await unset.unmount();
  const tooMany = await mount(() => useBlogs({ articlesPerBlog: 400 }));
  assert.equal(lastOf('BlogsWithArticles').variables.articlesPerBlog, 50);
  await tooMany.unmount();
  const tooFew = await mount(() => useBlogs({ articlesPerBlog: 0.2 }));
  assert.equal(lastOf('BlogsWithArticles').variables.articlesPerBlog, 1);
  await tooFew.unmount();
});

await t.check('a store with more blogs than one read brings: the next read starts where the first ended', async () => {
  forgetEverything();
  store.blogs = MANY;
  const before = count('BlogsWithArticles');
  const probe = await mount(() => useBlogs({ articlesPerBlog: 1 }));
  assert.equal(count('BlogsWithArticles'), before + 2);
  assert.equal(lastOf('BlogsWithArticles').variables.after, '50');
  assert.equal(probe.read().blogs.length, 60);
  assert.equal(probe.read().blogs[59].handle, 'blog-60');
  store.blogs = STORE;
  forgetEverything();
  await probe.unmount();
});

await t.check('enabled false: nothing read', async () => {
  const before = count('BlogsWithArticles');
  const off = await mount(() => useBlogs({ enabled: false }));
  assert.equal(count('BlogsWithArticles'), before);
  assert.deepEqual(off.read().blogs, []);
  assert.equal(off.read().loading, false);
  await off.unmount();
});

await t.check('a failed read says so and tells onError; a failed refresh keeps the blogs', async () => {
  forgetEverything();
  fail.blogs = true;
  const errors = [];
  const probe = await mount(() => useBlogs({ onError: (_error, context) => errors.push(context) }));
  assert.equal(probe.read().error, true);
  assert.equal(probe.read().loading, false);
  assert.deepEqual(probe.read().blogs, []);
  assert.deepEqual(errors[0], { at: 'useBlogs' });
  fail.blogs = false;
  await runAct(async () => probe.read().refresh());
  await settle();
  assert.equal(probe.read().error, false);
  assert.equal(probe.read().blogs.length, 3);
  fail.blogs = true;
  await runAct(async () => probe.read().refresh());
  await settle();
  assert.equal(probe.read().error, true);
  assert.equal(probe.read().refreshing, false);
  assert.equal(probe.read().blogs.length, 3);
  fail.blogs = false;
  await probe.unmount();
});

await t.check('a blog opened from the blogs page at the same count and size: drawn in the first frame, nothing read; so is an article', async () => {
  forgetEverything();
  const blogsPage = await mount(() => useBlogs({ articlesPerBlog: 3, imageTransform: CARD }));
  await blogsPage.unmount();
  const before = count('BlogArticles');
  const blogPage = await mount(() => useBlogArticles('journal', { limit: 3, imageTransform: CARD }));
  assert.deepEqual(handles(blogPage.first().articles), ['journal-post-1', 'journal-post-2', 'journal-post-3']);
  assert.equal(blogPage.first().blog.title, 'Journal');
  assert.equal(blogPage.first().hasMore, true);
  assert.equal(blogPage.first().loading, false);
  assert.equal(count('BlogArticles'), before);
  // Its next page carries on from where the blogs page's read ended.
  await runAct(async () => blogPage.read().loadMore());
  await settle();
  assert.equal(lastOf('BlogArticles').variables.after, '3');
  assert.deepEqual(handles(blogPage.read().articles), ['journal-post-1', 'journal-post-2', 'journal-post-3', 'journal-post-4', 'journal-post-5', 'journal-post-6']);
  await blogPage.unmount();
  const beforeArticle = count('BlogArticleByHandle');
  const articlePage = await mount(() => useArticle('lookbook', 'lookbook-post-2', { imageTransform: CARD }));
  assert.equal(articlePage.first().article.title, 'Lookbook post 2');
  assert.equal(count('BlogArticleByHandle'), beforeArticle);
  await articlePage.unmount();
});

t.section("useBlogArticles' pages");
await t.check('the first page with the blog itself; loadMore adds the next, as many again, until there are no more', async () => {
  forgetEverything();
  const probe = await mount(() => useBlogArticles('journal', { limit: 3 }));
  assert.equal(probe.first().loading, true);
  assert.equal(probe.read().blog.title, 'Journal');
  assert.equal(probe.read().notFound, false);
  assert.equal(probe.read().hasMore, true);
  assert.deepEqual(handles(probe.read().articles), ['journal-post-1', 'journal-post-2', 'journal-post-3']);
  await runAct(async () => probe.read().loadMore());
  await settle();
  const call = lastOf('BlogArticles');
  assert.deepEqual(
    { first: call.variables.first, after: call.variables.after, sortKey: call.variables.sortKey, reverse: call.variables.reverse },
    { first: 3, after: '3', sortKey: 'PUBLISHED_AT', reverse: true },
  );
  assert.equal(probe.read().articles.length, 6);
  assert.equal(probe.read().hasMore, true);
  await runAct(async () => probe.read().loadMore());
  await settle();
  assert.equal(probe.read().articles.length, 7);
  assert.equal(probe.read().articles[6].handle, 'journal-post-7');
  assert.equal(probe.read().hasMore, false);
  const before = count('BlogArticles');
  await runAct(async () => probe.read().loadMore());
  await settle();
  assert.equal(count('BlogArticles'), before);
  await probe.unmount();
});

await t.check('loadingMore while the next page reads; a second loadMore meanwhile asks nothing more', async () => {
  forgetEverything();
  const probe = await mount(() => useBlogArticles('journal', { limit: 2 }));
  hold.articles = deferred();
  const before = count('BlogArticles');
  await runAct(async () => {
    probe.read().loadMore();
    probe.read().loadMore();
  });
  await settle();
  assert.equal(probe.read().loadingMore, true);
  assert.equal(probe.read().articles.length, 2);
  await runAct(async () => probe.read().loadMore());
  hold.articles.resolve();
  hold.articles = null;
  await settle();
  assert.equal(count('BlogArticles'), before + 1);
  assert.equal(probe.read().loadingMore, false);
  assert.equal(probe.read().articles.length, 4);
  await probe.unmount();
});

await t.check('a failed next page keeps the articles, says so, and stops; refresh starts over from the first page', async () => {
  forgetEverything();
  const errors = [];
  const probe = await mount(() => useBlogArticles('journal', { limit: 3, onError: (_error, context) => errors.push(context) }));
  await runAct(async () => probe.read().loadMore());
  await settle();
  assert.equal(probe.read().articles.length, 6);
  fail.articles = true;
  await runAct(async () => probe.read().loadMore());
  await settle();
  assert.equal(probe.read().articles.length, 6);
  assert.equal(probe.read().error, true);
  assert.equal(probe.read().hasMore, false);
  assert.equal(probe.read().loadingMore, false);
  assert.deepEqual(errors.at(-1), { at: 'useBlogArticles.loadMore', blogHandle: 'journal' });
  fail.articles = false;
  hold.articles = deferred();
  await runAct(async () => probe.read().refresh());
  await settle();
  // While it reads, what was shown stays, with pull to refresh's spinner.
  assert.equal(probe.read().refreshing, true);
  assert.equal(probe.read().articles.length, 6);
  hold.articles.resolve();
  hold.articles = null;
  await settle();
  assert.equal(probe.read().refreshing, false);
  assert.equal(probe.read().error, false);
  assert.equal(probe.read().hasMore, true);
  assert.deepEqual(handles(probe.read().articles), ['journal-post-1', 'journal-post-2', 'journal-post-3']);
  await probe.unmount();
});

await t.check('a next page that lands after a refresh began is dropped', async () => {
  forgetEverything();
  const probe = await mount(() => useBlogArticles('journal', { limit: 3 }));
  hold.articles = deferred();
  await runAct(async () => probe.read().loadMore());
  await runAct(async () => probe.read().refresh());
  hold.articles.resolve();
  hold.articles = null;
  await settle();
  assert.deepEqual(handles(probe.read().articles), ['journal-post-1', 'journal-post-2', 'journal-post-3']);
  assert.equal(probe.read().loadingMore, false);
  await probe.unmount();
});

await t.check("a blog the store doesn't have: notFound, no blog, nothing more", async () => {
  const probe = await mount(() => useBlogArticles('no-such-blog'));
  assert.equal(probe.read().notFound, true);
  assert.equal(probe.read().blog, null);
  assert.equal(probe.read().hasMore, false);
  assert.deepEqual(probe.read().articles, []);
  await probe.unmount();
  const none = await mount(() => useBlogArticles(null));
  assert.equal(none.read().notFound, false);
  assert.equal(none.read().blog, null);
  await none.unmount();
});

await t.check('without React: listWithArticles and articlesWithBlog', async () => {
  forgetEverything();
  const page = await shopify.blogs.listWithArticles({ articlesPerBlog: 2 });
  assert.deepEqual(page.nodes.map((blog) => blog.articles.length), [2, 2, 0]);
  assert.equal(page.pageInfo.hasNextPage, false);
  const journal = await shopify.blogs.articlesWithBlog('journal', { first: 4, sortKey: 'PUBLISHED_AT', reverse: true });
  assert.deepEqual(journal.blog, { id: 'gid://shopify/Blog/journal', handle: 'journal', title: 'Journal' });
  assert.equal(journal.articles.nodes.length, 4);
  assert.equal(journal.articles.pageInfo.endCursor, '4');
  const missing = await shopify.blogs.articlesWithBlog('no-such-blog');
  assert.equal(missing.blog, null);
  assert.deepEqual(missing.articles.nodes, []);
  // `articles` is still the connection alone.
  const articles = await shopify.blogs.articles('lookbook', { first: 5 });
  assert.equal(articles.nodes.length, 2);
});

t.done();
