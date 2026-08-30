/**
 * Shared shape every connector implements, so adding a new fetch method
 * later (API, crawler) never requires touching the scheduler or the
 * ingestion pipeline — only a new file implementing this interface.
 */
export interface RawArticle {
  url: string;
  title: string;
  description?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  imageUrl?: string | null;
  language?: string | null;
  publisherName?: string | null;
  publisherUrl?: string | null;
  raw: Record<string, unknown>;
}

export interface FetchResult {
  items: RawArticle[];
  newEtag?: string | null;
  newLastModified?: string | null;
  /** True on an HTTP 304 — the feed hasn't changed, nothing to process. */
  notModified: boolean;
}

export interface Watermark {
  etag?: string | null;
  lastModified?: string | null;
}

export interface NewsConnector {
  type: 'rss' | 'atom' | 'sitemap' | 'crawler';
  fetchLatest(feedUrl: string, watermark: Watermark): Promise<FetchResult>;
}
