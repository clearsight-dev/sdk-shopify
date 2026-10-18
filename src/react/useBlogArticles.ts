/**
 * Every blog with its newest articles (`useBlogs`, 0.18.0), a blog's articles newest first a page at
 * a time, and one article with its words as paragraphs: a blogs page, a home page's blog section, a
 * blog's own page and the article page. The screen lays them onto tiles; tiles never read them.
 *
 * A blog's first page is read once per blog, count and image size a session, so coming back draws it at
 * once; `loadMore()` reads the next (0.18.0), `refresh()` the first again (pull to refresh). Every
 * article a list read is kept too, so an article opened from a blog section draws in the first frame:
 * with the list's image size, without a read at all. `useBlogs` keeps each blog's articles as its first
 * page, so a blog opened from the blogs page draws in the first frame too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { parseDescriptionHtml, type DescriptionBlock } from '../productPage';
import { shopify } from '../shopify';
import type { Article, Blog, BlogWithArticles, ImageTransform } from '../types';
import { useShopify } from './ShopifyProvider';

/** How many of a blog's newest articles `useBlogArticles` reads when not told: a section's worth. */
export const BLOG_ARTICLES_SHOWN = 6;
/** The most articles one read brings (one Storefront page). */
const MOST_ARTICLES = 50;

export interface UseBlogArticlesOptions {
  /** How many of the newest articles, 1–50 (rounded); each `loadMore()` reads as many again. @default 6 */
  limit?: number;
  /** For the articles' photos, e.g. `{ maxWidth: 1080 }`. The article page asking for the same size reads nothing again. */
  imageTransform?: ImageTransform;
  /** Read them. @default true */
  enabled?: boolean;
  onError?: (error: unknown, context: { at: string; blogHandle: string }) => void;
}

export interface BlogArticles {
  /** Newest first: `limit` of them, and as many more per `loadMore()`. Empty until read, and for a blog the store doesn't have. */
  articles: Article[];
  /** Reading, with nothing known yet: from the first frame (0.18.0; until then from the second). */
  loading: boolean;
  /** The last read failed; what was known stays. A failed `loadMore` also ends `hasMore` until a refresh. */
  error: boolean;
  /** Read the first page again, keeping what is shown until it lands (pull to refresh). */
  refresh(): void;
  /** The blog's id, handle and title, once read (0.18.0); null before, and for a blog the store doesn't have. */
  blog: Blog | null;
  /** Read, and the store has no blog by that handle (0.18.0). */
  notFound: boolean;
  /** The blog has more articles than these (0.18.0). */
  hasMore: boolean;
  /** Read the next `limit` articles and add them after these (0.18.0). Does nothing while a read is on its way, or with no more. */
  loadMore(): void;
  /** `loadMore()` is reading (0.18.0). */
  loadingMore: boolean;
  /** `refresh()` is reading, with articles shown (0.18.0): pull to refresh's spinner. */
  refreshing: boolean;
}

export interface UseArticleOptions {
  /** For the article's photo. The same size a blog section read it at draws it without a read. */
  imageTransform?: ImageTransform;
  /** Read it. @default true */
  enabled?: boolean;
  /**
   * The article's words as paragraphs (`content.blocks`): `true` (the default) with
   * `parseDescriptionHtml`, as a product's description; `false` for none (`content.html` only); or your
   * own parser.
   */
  parseContent?: boolean | ((html: string) => DescriptionBlock[]);
  onError?: (error: unknown, context: { at: string; blogHandle: string; articleHandle: string }) => void;
}

export interface ArticleState {
  article: Article | null;
  /**
   * The article's words: Shopify's `contentHtml`, and as paragraphs and bullets with their bold runs
   * (the same blocks as `useProductPage().description`), for a description tile.
   */
  content: { html: string; blocks: DescriptionBlock[] };
  /** Reading, with nothing known yet. */
  loading: boolean;
  /** The last read failed; what was known stays. */
  error: boolean;
  /** Read, and the store has no such article in that blog (or no such blog). */
  notFound: boolean;
  /** Read it again. */
  refresh(): void;
}

/** A blog's first page of articles as read, with the blog and where the next page starts. */
interface BlogFirstPage {
  /** Null: the store has no blog by that handle. */
  blog: Blog | null;
  articles: Article[];
  hasMore: boolean;
  /** Where the next page starts (`after`); null with no more. */
  endCursor: string | null;
}

/** This session's first pages, by blog, count and image size. */
const firstPagesRead = new Map<string, BlogFirstPage>();
/** This session's articles, by blog, article and image size: the article, or null when the store has none. */
const articlesRead = new Map<string, Article | null>();
/** The last copy of each article read, at any image size: shown while the page reads its own. */
const anyImageSize = new Map<string, Article>();

const transformKeyOf = (imageTransform?: ImageTransform) => (imageTransform ? JSON.stringify(imageTransform) : '');
const articleId = (blogHandle: string, articleHandle: string) => `${blogHandle}/${articleHandle}`;
const articleKey = (blogHandle: string, articleHandle: string, transformKey: string) =>
  `${articleId(blogHandle, articleHandle)}|${transformKey}`;
const firstPageKey = (blogHandle: string, count: number, transformKey: string) => `${blogHandle}|${count}|${transformKey}`;

/** A count of articles as asked: a whole number, 1–50; the default when it isn't a number. */
function articlesWanted(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.min(MOST_ARTICLES, Math.max(1, Math.round(limit)))
    : BLOG_ARTICLES_SHOWN;
}

/** Keeps each article of a list, so the article page finds it. */
function keepEach(blogHandle: string, articles: Article[], transformKey: string): void {
  for (const article of articles) {
    articlesRead.set(articleKey(blogHandle, article.handle, transformKey), article);
    anyImageSize.set(articleId(blogHandle, article.handle), article);
  }
}

/** Keeps a blog's first page, by blog, count and image size, and each of its articles for the article page. */
function keepFirstPage(blogHandle: string, count: number, transformKey: string, page: BlogFirstPage): void {
  firstPagesRead.set(firstPageKey(blogHandle, count, transformKey), page);
  keepEach(blogHandle, page.articles, transformKey);
}

/** Articles after these, each once (an article published between two reads can't show twice). */
function withNextPage(shown: Article[], next: Article[]): Article[] {
  const ids = new Set(shown.map((article) => article.id));
  return shown.concat(next.filter((article) => !ids.has(article.id)));
}

interface ShownArticles {
  blog: Blog | null;
  articles: Article[];
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: boolean;
  notFound: boolean;
}

const NOTHING_SHOWN: ShownArticles = {
  blog: null,
  articles: [],
  hasMore: false,
  loading: false,
  loadingMore: false,
  refreshing: false,
  error: false,
  notFound: false,
};

/** What a first page shows: its articles, and whether the store has the blog. */
const shownFrom = (page: BlogFirstPage | undefined): ShownArticles =>
  page ? { ...NOTHING_SHOWN, blog: page.blog, articles: page.articles, hasMore: page.hasMore, notFound: !page.blog } : NOTHING_SHOWN;

/**
 * A blog's newest articles (`shopify.blogs.articlesWithBlog`, by date published, newest first), a page
 * of `limit` at a time. The first page is read once per blog, count and image size a session;
 * `loadMore()` reads the next, `refresh()` the first again.
 */
export function useBlogArticles(
  blogHandle: string | null | undefined,
  options: UseBlogArticlesOptions = {},
): BlogArticles {
  const { ready } = useShopify();
  const configured = ready || isConfigured();
  const enabled = options.enabled ?? true;
  const limit = articlesWanted(options.limit);
  const transformKey = transformKeyOf(options.imageTransform);
  const latest = useRef(options);
  latest.current = options;
  const key = blogHandle ? firstPageKey(blogHandle, limit, transformKey) : '';

  // Nothing known and about to read: loading from the first frame, so a screen never shows "no articles" first.
  const [state, setState] = useState<ShownArticles>(() => {
    const known = key ? firstPagesRead.get(key) : undefined;
    return known || !key || !enabled || !configured ? shownFrom(known) : { ...NOTHING_SHOWN, loading: true };
  });
  const shown = useRef(state);
  shown.current = state;
  const [reads, setReads] = useState(0);
  const fresh = useRef(false);
  /** Where the next page starts. */
  const nextCursor = useRef<string | null>(null);
  /** Up on every first-page read and on leaving: a next page that lands after either is dropped. */
  const listVersion = useRef(0);
  /** A next page is on its way: a list's end can ask twice before the state says so. */
  const readingMore = useRef(false);

  useEffect(() => {
    listVersion.current += 1;
    readingMore.current = false;
    if (!blogHandle || !enabled || !configured) {
      nextCursor.current = null;
      setState(NOTHING_SHOWN);
      return;
    }
    const wantsFresh = fresh.current;
    fresh.current = false;
    const known = firstPagesRead.get(key);
    if (!wantsFresh && known) {
      nextCursor.current = known.endCursor;
      setState(shownFrom(known));
      return;
    }
    let live = true;
    // A refresh keeps what is shown; another blog starts from nothing.
    setState((current) =>
      wantsFresh && current.articles.length > 0
        ? { ...current, loadingMore: false, refreshing: true, error: false }
        : { ...NOTHING_SHOWN, loading: true },
    );
    const { imageTransform } = latest.current;
    shopify.blogs
      .articlesWithBlog(blogHandle, { first: limit, sortKey: 'PUBLISHED_AT', reverse: true, imageTransform, fresh: wantsFresh })
      .then(({ blog, articles }) => {
        const page: BlogFirstPage = {
          blog,
          articles: articles.nodes,
          hasMore: articles.pageInfo.hasNextPage && !!articles.pageInfo.endCursor,
          endCursor: articles.pageInfo.endCursor,
        };
        keepFirstPage(blogHandle, limit, transformKey, page);
        if (!live) return;
        nextCursor.current = page.endCursor;
        setState(shownFrom(page));
      })
      .catch((error) => {
        latest.current.onError?.(error, { at: 'useBlogArticles', blogHandle });
        if (live) setState((current) => ({ ...current, loading: false, refreshing: false, error: true }));
      });
    return () => {
      live = false;
    };
  }, [blogHandle, key, limit, transformKey, enabled, configured, reads]);

  // Leaving drops a next page still on its way.
  useEffect(
    () => () => {
      listVersion.current += 1;
    },
    [],
  );

  const refresh = useCallback(() => {
    fresh.current = true;
    setReads((count) => count + 1);
  }, []);

  const loadMore = useCallback(() => {
    const now = shown.current;
    const after = nextCursor.current;
    if (!blogHandle || readingMore.current || now.loading || now.refreshing || !now.hasMore || !after) return;
    readingMore.current = true;
    const version = listVersion.current;
    setState((current) => ({ ...current, loadingMore: true }));
    const { imageTransform } = latest.current;
    shopify.blogs
      .articlesWithBlog(blogHandle, { first: limit, after, sortKey: 'PUBLISHED_AT', reverse: true, imageTransform })
      .then(({ articles }) => {
        keepEach(blogHandle, articles.nodes, transformKey);
        if (version !== listVersion.current) return;
        readingMore.current = false;
        nextCursor.current = articles.pageInfo.endCursor;
        setState((current) => ({
          ...current,
          articles: withNextPage(current.articles, articles.nodes),
          hasMore: articles.pageInfo.hasNextPage && !!articles.pageInfo.endCursor,
          loadingMore: false,
          error: false,
        }));
      })
      .catch((error) => {
        latest.current.onError?.(error, { at: 'useBlogArticles.loadMore', blogHandle });
        if (version !== listVersion.current) return;
        readingMore.current = false;
        // The list stops growing: its end would ask again and again while offline. A refresh starts over.
        setState((current) => ({ ...current, loadingMore: false, hasMore: false, error: true }));
      });
  }, [blogHandle, limit, transformKey]);

  return { ...state, refresh, loadMore };
}

/** How many blogs one read of `useBlogs` asks for, and the most reads: 250 blogs. One read for any real store. */
const BLOGS_PER_READ = 50;
const MOST_BLOG_READS = 5;

export interface UseBlogsOptions {
  /** How many of each blog's newest articles, 1–50 (rounded). @default 6 */
  articlesPerBlog?: number;
  /** For the articles' photos. A blog's page and an article's page asking for the same size read nothing again. */
  imageTransform?: ImageTransform;
  /** Read them. @default true */
  enabled?: boolean;
  onError?: (error: unknown, context: { at: string }) => void;
}

export interface BlogsState {
  /**
   * Every blog the store has, in the order the store made them, each with its newest articles first
   * (none for a blog without any). Empty until read.
   */
  blogs: BlogWithArticles[];
  /** Reading, with nothing known yet: from the first frame, so "no blogs" never shows before the read. */
  loading: boolean;
  /** The last read failed; what was known stays. */
  error: boolean;
  /** Read them again, keeping what is shown until it lands (pull to refresh). */
  refresh(): void;
  /** `refresh()` is reading, with blogs shown: pull to refresh's spinner. */
  refreshing: boolean;
}

/** This session's blogs, by articles per blog and image size. */
const blogsRead = new Map<string, BlogWithArticles[]>();

/** Every blog, a page of `BLOGS_PER_READ` at a time; each page brings each of its blogs' newest articles. */
async function readEveryBlog(articlesPerBlog: number, imageTransform: ImageTransform | undefined, fresh: boolean) {
  const everyBlog: BlogWithArticles[] = [];
  let after: string | undefined;
  for (let read = 0; read < MOST_BLOG_READS; read += 1) {
    const page = await shopify.blogs.listWithArticles({ first: BLOGS_PER_READ, after, articlesPerBlog, imageTransform, fresh });
    everyBlog.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return everyBlog;
}

/**
 * Every blog the store has, each with its newest articles (`shopify.blogs.listWithArticles`: one
 * request for up to 50 blogs). Read once per count and image size a session; `refresh()` reads again.
 * Each blog's articles count as its first page for `useBlogArticles` at the same count and image size,
 * and each article for `useArticle`, so a blog or an article opened from here draws in the first frame.
 */
export function useBlogs(options: UseBlogsOptions = {}): BlogsState {
  const { ready } = useShopify();
  const configured = ready || isConfigured();
  const enabled = options.enabled ?? true;
  const articlesPerBlog = articlesWanted(options.articlesPerBlog);
  const transformKey = transformKeyOf(options.imageTransform);
  const latest = useRef(options);
  latest.current = options;
  const key = `${articlesPerBlog}|${transformKey}`;

  // Nothing known and about to read: loading from the first frame, so a screen never shows "no blogs" first.
  const [state, setState] = useState(() => {
    const known = blogsRead.get(key);
    return { blogs: known ?? [], loading: !known && enabled && configured, refreshing: false, error: false };
  });
  const [reads, setReads] = useState(0);
  const fresh = useRef(false);

  useEffect(() => {
    if (!enabled || !configured) {
      setState({ blogs: [], loading: false, refreshing: false, error: false });
      return;
    }
    const wantsFresh = fresh.current;
    fresh.current = false;
    const known = blogsRead.get(key);
    if (!wantsFresh && known) {
      setState({ blogs: known, loading: false, refreshing: false, error: false });
      return;
    }
    let live = true;
    // A refresh keeps what is shown.
    setState((current) =>
      wantsFresh && current.blogs.length > 0
        ? { ...current, refreshing: true, error: false }
        : { blogs: [], loading: true, refreshing: false, error: false },
    );
    readEveryBlog(articlesPerBlog, latest.current.imageTransform, wantsFresh)
      .then((blogs) => {
        blogsRead.set(key, blogs);
        for (const blog of blogs) {
          keepFirstPage(blog.handle, articlesPerBlog, transformKey, {
            blog: { id: blog.id, handle: blog.handle, title: blog.title },
            articles: blog.articles,
            hasMore: blog.articlesPageInfo.hasNextPage && !!blog.articlesPageInfo.endCursor,
            endCursor: blog.articlesPageInfo.endCursor,
          });
        }
        if (live) setState({ blogs, loading: false, refreshing: false, error: false });
      })
      .catch((error) => {
        latest.current.onError?.(error, { at: 'useBlogs' });
        if (live) setState((current) => ({ ...current, loading: false, refreshing: false, error: true }));
      });
    return () => {
      live = false;
    };
  }, [key, articlesPerBlog, transformKey, enabled, configured, reads]);

  const refresh = useCallback(() => {
    fresh.current = true;
    setReads((count) => count + 1);
  }, []);

  return { ...state, refresh };
}

/** What is known of an article before reading it: this size's copy, else any size's (from a list). */
function knownArticle(blogHandle: string | null | undefined, articleHandle: string | null | undefined, transformKey: string) {
  if (!blogHandle || !articleHandle) return { article: null, read: false };
  const key = articleKey(blogHandle, articleHandle, transformKey);
  if (articlesRead.has(key)) return { article: articlesRead.get(key) ?? null, read: true };
  return { article: anyImageSize.get(articleId(blogHandle, articleHandle)) ?? null, read: false };
}

/**
 * One article, by its blog's handle and its own (`shopify.blogs.articleByHandle`), its words parsed into
 * paragraphs. Read once a session; one a blog section already read at this image size is not read
 * again, and one it read at another size shows at once while this size is read.
 */
export function useArticle(
  blogHandle: string | null | undefined,
  articleHandle: string | null | undefined,
  options: UseArticleOptions = {},
): ArticleState {
  const { ready } = useShopify();
  const configured = ready || isConfigured();
  const enabled = options.enabled ?? true;
  const transformKey = transformKeyOf(options.imageTransform);
  const latest = useRef(options);
  latest.current = options;

  const [state, setState] = useState(() => {
    const known = knownArticle(blogHandle, articleHandle, transformKey);
    return { article: known.article, loading: false, error: false, notFound: known.read && !known.article };
  });
  const [reads, setReads] = useState(0);
  const fresh = useRef(false);

  useEffect(() => {
    if (!blogHandle || !articleHandle || !enabled || !configured) {
      setState({ article: null, loading: false, error: false, notFound: false });
      return;
    }
    const wantsFresh = fresh.current;
    fresh.current = false;
    const known = knownArticle(blogHandle, articleHandle, transformKey);
    if (!wantsFresh && known.read) {
      setState({ article: known.article, loading: false, error: false, notFound: !known.article });
      return;
    }
    let live = true;
    // A refresh keeps what is shown; another article starts from a list's copy, if a list read it.
    setState((current) => {
      const shown = wantsFresh ? current.article : known.article;
      return { article: shown, loading: !shown, error: false, notFound: false };
    });
    const { imageTransform } = latest.current;
    shopify.blogs
      .articleByHandle(blogHandle, articleHandle, { imageTransform, fresh: wantsFresh })
      .then((article) => {
        articlesRead.set(articleKey(blogHandle, articleHandle, transformKey), article);
        if (article) anyImageSize.set(articleId(blogHandle, articleHandle), article);
        if (live) setState({ article, loading: false, error: false, notFound: !article });
      })
      .catch((error) => {
        latest.current.onError?.(error, { at: 'useArticle', blogHandle, articleHandle });
        if (live) setState((current) => ({ ...current, loading: false, error: true }));
      });
    return () => {
      live = false;
    };
  }, [blogHandle, articleHandle, transformKey, enabled, configured, reads]);

  const refresh = useCallback(() => {
    fresh.current = true;
    setReads((count) => count + 1);
  }, []);

  const html = state.article?.contentHtml || state.article?.content || '';
  const parse = options.parseContent ?? true;
  const blocks = useMemo(
    () => (parse === false ? [] : typeof parse === 'function' ? parse(html) : parseDescriptionHtml(html)),
    [parse, html],
  );

  return { ...state, content: { html, blocks }, refresh };
}

/** Forget this session's blog reads, `useBlogs`' too (tests, or a new store). */
export function clearBlogArticles(): void {
  blogsRead.clear();
  firstPagesRead.clear();
  articlesRead.clear();
  anyImageSize.clear();
}
