import { request } from './client';
import {
  BLOGS_LIST_QUERY,
  BLOGS_WITH_ARTICLES_QUERY,
  BLOG_ARTICLES_QUERY,
  BLOG_ARTICLE_BY_HANDLE_QUERY,
  BLOG_BY_HANDLE_QUERY,
} from './queries';
import type {
  Article,
  Blog,
  BlogArticlesPage,
  BlogsWithArticlesOptions,
  BlogWithArticles,
  Connection,
  ListOptions,
  PageInfo,
  ShopifyBlogsAPI,
  ImageOptions,
} from './types';

interface BlogsRaw {
  blogs: { nodes: Blog[]; pageInfo: PageInfo };
}
interface BlogRaw {
  blog: Blog | null;
}
interface BlogArticlesRaw {
  blog: (Partial<Blog> & { articles: { nodes: any[]; pageInfo: PageInfo } }) | null;
}
interface BlogsWithArticlesRaw {
  blogs: { nodes: (Blog & { articles: { nodes: any[]; pageInfo: PageInfo } })[]; pageInfo: PageInfo };
}

const NO_MORE: PageInfo = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };

/** A count Shopify takes: a whole number, 1–250; the default when it isn't a number. */
function countOf(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(250, Math.max(1, Math.round(value))) : fallback;
}
interface BlogArticleRaw {
  blog: { articleByHandle: any | null } | null;
}

function normalizeArticle(a: any): Article {
  return {
    id: a.id,
    handle: a.handle,
    title: a.title,
    content: a.content,
    contentHtml: a.contentHtml,
    excerpt: a.excerpt ?? null,
    excerptHtml: a.excerptHtml ?? null,
    publishedAt: a.publishedAt,
    tags: a.tags ?? [],
    image: a.image ?? null,
    author: a.authorV2
      ? {
          name: a.authorV2.name,
          email: a.authorV2.email ?? null,
          bio: a.authorV2.bio ?? null,
        }
      : null,
    blog: a.blog,
  };
}

export const blogs: ShopifyBlogsAPI = {
  async list(opts?: ListOptions): Promise<Connection<Blog>> {
    const data = await request<BlogsRaw>(BLOGS_LIST_QUERY, {
      first: opts?.first ?? 20,
      after: opts?.after,
      query: opts?.query,
      sortKey: opts?.sortKey,
      reverse: opts?.reverse ?? false,
    });
    return data.blogs;
  },

  async byHandle(handle: string): Promise<Blog | null> {
    const data = await request<BlogRaw>(BLOG_BY_HANDLE_QUERY, { handle });
    return data.blog;
  },

  async articles(blogHandle: string, opts?: ListOptions): Promise<Connection<Article>> {
    return (await blogs.articlesWithBlog(blogHandle, opts)).articles;
  },

  async articlesWithBlog(blogHandle: string, opts?: ListOptions): Promise<BlogArticlesPage> {
    const data = await request<BlogArticlesRaw>(BLOG_ARTICLES_QUERY, {
      handle: blogHandle,
      first: opts?.first ?? 20,
      after: opts?.after,
      sortKey: opts?.sortKey,
      reverse: opts?.reverse ?? false,
    }, { fresh: opts?.fresh, imageTransform: opts?.imageTransform });
    if (!data.blog) return { blog: null, articles: { nodes: [], pageInfo: NO_MORE } };
    const { id, handle, title } = data.blog;
    return {
      blog: { id: id ?? '', handle: handle ?? blogHandle, title: title ?? '' },
      articles: { nodes: data.blog.articles.nodes.map(normalizeArticle), pageInfo: data.blog.articles.pageInfo },
    };
  },

  async listWithArticles(opts?: BlogsWithArticlesOptions): Promise<Connection<BlogWithArticles>> {
    const data = await request<BlogsWithArticlesRaw>(BLOGS_WITH_ARTICLES_QUERY, {
      first: countOf(opts?.first, 50),
      after: opts?.after,
      articlesPerBlog: countOf(opts?.articlesPerBlog, 6),
    }, { fresh: opts?.fresh, imageTransform: opts?.imageTransform });
    return {
      nodes: data.blogs.nodes.map((blog) => ({
        id: blog.id,
        handle: blog.handle,
        title: blog.title,
        articles: blog.articles.nodes.map(normalizeArticle),
        articlesPageInfo: blog.articles.pageInfo,
      })),
      pageInfo: data.blogs.pageInfo,
    };
  },

  async articleByHandle(blogHandle: string, articleHandle: string, opts?: { fresh?: boolean } & ImageOptions): Promise<Article | null> {
    const data = await request<BlogArticleRaw>(BLOG_ARTICLE_BY_HANDLE_QUERY, {
      blogHandle,
      articleHandle,
    }, { fresh: opts?.fresh, imageTransform: opts?.imageTransform });
    if (!data.blog || !data.blog.articleByHandle) return null;
    return normalizeArticle(data.blog.articleByHandle);
  },
};
