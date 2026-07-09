/**
 * Real Shopify blogs / articles via Storefront API.
 */
import { request } from './client';
import {
  BLOGS_LIST_QUERY,
  BLOG_ARTICLES_QUERY,
  BLOG_ARTICLE_BY_HANDLE_QUERY,
  BLOG_BY_HANDLE_QUERY,
} from './queries';
import type {
  Article,
  Blog,
  Connection,
  ListOptions,
  PageInfo,
  ShopifyBlogsAPI,
} from './types';

interface BlogsRaw {
  blogs: { nodes: Blog[]; pageInfo: PageInfo };
}
interface BlogRaw {
  blog: Blog | null;
}
interface BlogArticlesRaw {
  blog: { articles: { nodes: any[]; pageInfo: PageInfo } } | null;
}
interface BlogArticleRaw {
  blog: { articleByHandle: any | null } | null;
}

/** Storefront `authorV2` → friendlier `author` shape. */
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
    const data = await request<BlogArticlesRaw>(BLOG_ARTICLES_QUERY, {
      handle: blogHandle,
      first: opts?.first ?? 20,
      after: opts?.after,
      sortKey: opts?.sortKey,
      reverse: opts?.reverse ?? false,
    });
    if (!data.blog) {
      return { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    return {
      nodes: data.blog.articles.nodes.map(normalizeArticle),
      pageInfo: data.blog.articles.pageInfo,
    };
  },

  async articleByHandle(blogHandle: string, articleHandle: string): Promise<Article | null> {
    const data = await request<BlogArticleRaw>(BLOG_ARTICLE_BY_HANDLE_QUERY, {
      blogHandle,
      articleHandle,
    });
    if (!data.blog || !data.blog.articleByHandle) return null;
    return normalizeArticle(data.blog.articleByHandle);
  },
};
