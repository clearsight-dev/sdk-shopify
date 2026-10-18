/**
 * A blog's articles, newest first, and one article with its words as paragraphs: a home page's blog
 * section and the article page. The screen lays them onto tiles; tiles never read them.
 *
 * Read once per blog (and per article) and kept for the session, so coming back draws them at once;
 * `refresh()` reads again (pull to refresh). Every article a list read is kept too, so an article opened
 * from a blog section draws in the first frame: with the list's image size, without a read at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { parseDescriptionHtml, type DescriptionBlock } from '../productPage';
import { shopify } from '../shopify';
import type { Article, ImageTransform } from '../types';
import { useShopify } from './ShopifyProvider';

/** How many of a blog's newest articles `useBlogArticles` reads when not told: a section's worth. */
export const BLOG_ARTICLES_SHOWN = 6;
/** The most articles one `useBlogArticles` reads (one Storefront page). */
const MOST_ARTICLES = 50;

export interface UseBlogArticlesOptions {
  /** How many of the newest articles, 1–50 (rounded). @default 6 */
  limit?: number;
  /** For the articles' photos, e.g. `{ maxWidth: 1080 }`. The article page asking for the same size reads nothing again. */
  imageTransform?: ImageTransform;
  /** Read them. @default true */
  enabled?: boolean;
  onError?: (error: unknown, context: { at: string; blogHandle: string }) => void;
}

export interface BlogArticles {
  /** Newest first, at most `limit`. Empty until read, and for a blog the store doesn't have. */
  articles: Article[];
  /** Reading, with nothing known yet. */
  loading: boolean;
  /** The last read failed; what was known stays. */
  error: boolean;
  /** Read them again. */
  refresh(): void;
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

/** This session's lists, by blog, count and image size. */
const listsRead = new Map<string, Article[]>();
/** This session's articles, by blog, article and image size: the article, or null when the store has none. */
const articlesRead = new Map<string, Article | null>();
/** The last copy of each article read, at any image size: shown while the page reads its own. */
const anyImageSize = new Map<string, Article>();

const transformKeyOf = (imageTransform?: ImageTransform) => (imageTransform ? JSON.stringify(imageTransform) : '');
const articleId = (blogHandle: string, articleHandle: string) => `${blogHandle}/${articleHandle}`;
const articleKey = (blogHandle: string, articleHandle: string, transformKey: string) =>
  `${articleId(blogHandle, articleHandle)}|${transformKey}`;

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

/**
 * A blog's newest articles (`shopify.blogs.articles`, by date published, newest first). One read per
 * blog, count and image size a session; `refresh()` reads again.
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
  const key = blogHandle ? `${blogHandle}|${limit}|${transformKey}` : '';

  const [state, setState] = useState(() => ({
    articles: (key && listsRead.get(key)) || [],
    loading: false,
    error: false,
  }));
  const [reads, setReads] = useState(0);
  const fresh = useRef(false);

  useEffect(() => {
    if (!blogHandle || !enabled || !configured) {
      setState({ articles: [], loading: false, error: false });
      return;
    }
    const wantsFresh = fresh.current;
    fresh.current = false;
    const known = listsRead.get(key);
    if (!wantsFresh && known) {
      setState({ articles: known, loading: false, error: false });
      return;
    }
    let live = true;
    // A refresh keeps what is shown; another blog starts from nothing.
    setState((current) => {
      const shown = wantsFresh ? current.articles : [];
      return { articles: shown, loading: shown.length === 0, error: false };
    });
    const { imageTransform } = latest.current;
    shopify.blogs
      .articles(blogHandle, { first: limit, sortKey: 'PUBLISHED_AT', reverse: true, imageTransform, fresh: wantsFresh })
      .then((page) => {
        listsRead.set(key, page.nodes);
        keepEach(blogHandle, page.nodes, transformKey);
        if (live) setState({ articles: page.nodes, loading: false, error: false });
      })
      .catch((error) => {
        latest.current.onError?.(error, { at: 'useBlogArticles', blogHandle });
        if (live) setState((current) => ({ ...current, loading: false, error: true }));
      });
    return () => {
      live = false;
    };
  }, [blogHandle, key, limit, transformKey, enabled, configured, reads]);

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

/** Forget this session's blog reads (tests, or a new store). */
export function clearBlogArticles(): void {
  listsRead.clear();
  articlesRead.clear();
  anyImageSize.clear();
}
