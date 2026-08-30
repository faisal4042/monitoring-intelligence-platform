/**
 * RSS 2.0 / Atom connector. Handles both under one connector since they
 * share a fetch+conditional-request path and only differ in item shape.
 */
import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from '../lib/ssrf-guard.js';
import { isObviouslyNotAnArticle } from '../lib/article-path-filter.js';
import type { FetchResult, NewsConnector, RawArticle, Watermark } from './types.js';

// See sitemap.ts for why this is raised rather than left at the library default.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: { maxTotalExpansions: 20000 },
});

const MAX_ITEMS_PER_FETCH = 100;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object') return textOf((value as Record<string, unknown>)['#text']);
  return String(value);
}

function urlOf(value: unknown): string | null {
  const text = textOf(value)?.trim().replace(/^>+\s*/, '') ?? null;
  if (!text) return null;
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

// Some WordPress feeds syndicate every post type, including numbered
// attachments/gallery entries whose own <title> is genuinely just "41" —
// not a URL artifact this time, the feed itself provides it. A real
// headline is essentially never just digits.
function isRealTitle(title: string): boolean {
  return !/^\d+$/.test(title.trim()) && title.trim().length >= 4;
}

function rssItemToArticle(item: Record<string, unknown>): RawArticle | null {
  const url = urlOf(item.link);
  const rawTitle = textOf(item.title);
  const publisherName = textOf(item.source);
  const publisherUrl = urlOf((item.source as Record<string, unknown> | undefined)?.['@_url']);
  const title = rawTitle && publisherName && rawTitle.endsWith(` - ${publisherName}`)
    ? rawTitle.slice(0, -(publisherName.length + 3)).trim()
    : rawTitle;
  if (!url || !title || !isRealTitle(title) || isObviouslyNotAnArticle(url)) return null;
  const enclosure = item.enclosure as { '@_url'?: string; '@_type'?: string } | undefined;
  const mediaContent = item['media:content'] as { '@_url'?: string } | undefined;
  return {
    url,
    title,
    description: textOf(item.description),
    author: textOf(item.author ?? item['dc:creator']),
    publishedAt: textOf(item.pubDate),
    imageUrl: (enclosure?.['@_type']?.startsWith('image/') ? enclosure['@_url'] : null) ?? mediaContent?.['@_url'] ?? null,
    language: null,
    publisherName,
    publisherUrl,
    raw: item,
  };
}

function atomEntryToArticle(entry: Record<string, unknown>): RawArticle | null {
  const links = asArray(entry.link as any);
  const htmlLink = links.find((l: any) => !l['@_rel'] || l['@_rel'] === 'alternate');
  const url = urlOf(htmlLink?.['@_href']);
  const title = textOf(entry.title);
  if (!url || !title || !isRealTitle(title) || isObviouslyNotAnArticle(url)) return null;
  return {
    url,
    title,
    description: textOf(entry.summary ?? entry.content),
    author: textOf((entry.author as any)?.name),
    publishedAt: textOf(entry.published ?? entry.updated),
    imageUrl: null,
    language: null,
    raw: entry,
  };
}

export const RSSConnector: NewsConnector = {
  type: 'rss',
  async fetchLatest(feedUrl: string, watermark: Watermark): Promise<FetchResult> {
    const headers: Record<string, string> = {};
    if (watermark.etag) headers['If-None-Match'] = watermark.etag;
    if (watermark.lastModified) headers['If-Modified-Since'] = watermark.lastModified;

    const res = await safeFetch(feedUrl, headers);
    if (res.status === 304) return { items: [], notModified: true };
    if (!res.ok) throw new Error(`فشل جلب الخلاصة — حالة HTTP ${res.status}`);

    const parsed = xmlParser.parse(res.body) as Record<string, any>;
    let items: RawArticle[] = [];

    if (parsed?.rss?.channel) {
      items = asArray(parsed.rss.channel.item).map(rssItemToArticle).filter((a): a is RawArticle => a != null);
    } else if (parsed?.feed) {
      items = asArray(parsed.feed.entry).map(atomEntryToArticle).filter((a): a is RawArticle => a != null);
    } else {
      throw new Error('محتوى الخلاصة ليس RSS أو Atom صالحاً');
    }

    return {
      items: items.slice(0, MAX_ITEMS_PER_FETCH),
      newEtag: res.headers.get('etag'),
      newLastModified: res.headers.get('last-modified'),
      notModified: false,
    };
  },
};
