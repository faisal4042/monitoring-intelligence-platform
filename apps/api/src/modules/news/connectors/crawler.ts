import { safeFetch } from '../lib/ssrf-guard.js';
import { isObviouslyNotAnArticle } from '../lib/article-path-filter.js';
import type { FetchResult, NewsConnector, RawArticle, Watermark } from './types.js';

const MAX_ITEMS_PER_FETCH = 50;
const ANCHOR = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (all, name) => named[name.toLowerCase()] ?? all)
    .replace(/\s+/g, ' ')
    .trim();
}

function samePublisher(candidate: URL, source: URL): boolean {
  const a = candidate.hostname.replace(/^www\./, '');
  const b = source.hostname.replace(/^www\./, '');
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function extractLinks(html: string, baseUrl: string): RawArticle[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const items: RawArticle[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    const title = decodeHtml(match[2]);
    if (title.length < 12 || title.split(/\s+/).length < 3) continue;
    let url: URL;
    try { url = new URL(match[1], baseUrl); } catch { continue; }
    if (!samePublisher(url, base) || isObviouslyNotAnArticle(url.toString())) continue;
    if (url.pathname === '/' || url.pathname.split('/').filter(Boolean).length === 0) continue;
    url.hash = '';
    const canonical = url.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    items.push({
      url: canonical,
      title,
      description: null,
      author: null,
      publishedAt: null,
      imageUrl: null,
      language: 'ar',
      raw: { discoveredFrom: baseUrl, method: 'homepage-crawler' },
    });
    if (items.length >= MAX_ITEMS_PER_FETCH) break;
  }
  return items;
}

export const CrawlerConnector: NewsConnector = {
  type: 'crawler',
  async fetchLatest(feedUrl: string, _watermark: Watermark): Promise<FetchResult> {
    const response = await safeFetch(feedUrl);
    if (!response.ok) throw new Error(`فشل جلب الصفحة الرئيسية — حالة HTTP ${response.status}`);
    const items = extractLinks(response.body, response.finalUrl);
    if (items.length === 0) throw new Error('لم يُعثر على روابط أخبار قابلة للقراءة في الصفحة الرئيسية');
    return { items, notModified: false };
  },
};
