/**
 * Sitemap connector. A plain sitemap only has <loc>/<lastmod> — no title, no
 * article content — so entries land with a placeholder title (the URL
 * itself) unless the News Sitemap extension (xmlns:news) is present, which
 * carries a real <news:title>/<news:publication_date>. Either way this is
 * "found a URL worth fetching", not full metadata — richer extraction from
 * the article page itself is a later phase.
 */
import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from '../lib/ssrf-guard.js';
import { looksLikeArticlePath } from '../lib/article-path-filter.js';
import type { FetchResult, NewsConnector, RawArticle, Watermark } from './types.js';

// Default entity-expansion ceiling (1000) is a DoS guard against adversarial
// XML — but a large, legitimate news sitemap with many tracking params in its
// <loc> URLs (each "&amp;" counts as an expansion) can genuinely exceed it
// (independentarabia.com hit 1008). Raised, not disabled — still bounded.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: { maxTotalExpansions: 20000 },
});

const MAX_URLS_PER_FETCH = 50;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object') return textOf((value as Record<string, unknown>)['#text']);
  return String(value);
}

/**
 * A plain sitemap (no News Sitemap extension) has no title field at all —
 * but many Arabic sites' URL slugs ARE the headline, just percent-encoded
 * with hyphens for spaces (e.g. .../مصرشاهد-رد-فعل-جنود.../). Decoding that
 * beats showing a raw URL as the "title" until a later phase fetches the
 * actual article page. Falls back to the untouched URL if the slug isn't
 * decodable UTF-8 text (numeric IDs, non-Arabic slugs, etc.).
 */
function titleFromSlug(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const slug = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
      .replace(/\.(aspx?|html?|php|jsp)$/i, '')
      // trailing numeric post ID (a common CMS suffix, e.g. "...-13302") is
      // not part of the headline — strip it before showing as a title.
      .replace(/-\d+$/, '');
    const readable = slug.replace(/[-_]+/g, ' ').trim();
    // A numeric ID or a bare filename (e.g. "159852", "new123" — one letter
    // from a stripped extension is not a headline) isn't an improvement
    // over the URL — require something that actually reads as a multi-word
    // title before preferring it.
    const letterCount = (readable.match(/\p{L}/gu) ?? []).length;
    const wordCount = readable.split(/\s+/).filter(Boolean).length;
    return wordCount >= 3 && letterCount >= 12 ? readable : url;
  } catch {
    return url;
  }
}

function sitemapUrlToArticle(entry: Record<string, any>): RawArticle | null {
  const url = textOf(entry.loc);
  if (!url) return null;
  const news = entry['news:news'];
  if (news) {
    const title = textOf(news['news:title']);
    return {
      url,
      title: title ?? titleFromSlug(url),
      description: null,
      author: null,
      publishedAt: textOf(news['news:publication_date']) ?? textOf(entry.lastmod),
      imageUrl: textOf(entry['image:image']?.['image:loc']) ?? null,
      language: textOf(news['news:publication']?.['news:language']),
      raw: entry,
    };
  }
  if (!looksLikeArticlePath(url)) return null;
  return {
    url,
    title: titleFromSlug(url),
    description: null,
    author: null,
    publishedAt: textOf(entry.lastmod),
    imageUrl: textOf(entry['image:image']?.['image:loc']) ?? null,
    language: null,
    raw: entry,
  };
}

function extractArticles(parsed: Record<string, any>): RawArticle[] {
  return asArray(parsed.urlset.url)
    .map(sitemapUrlToArticle)
    .filter((a): a is RawArticle => a != null)
    // Most-recent-first by lastmod so a capped batch favors new content
    // over whatever happened to sort first in the file.
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}

async function fetchAndParse(url: string, headers: Record<string, string>) {
  const res = await safeFetch(url, headers);
  if (res.status === 304) return { notModified: true as const, res: null, parsed: null };
  if (!res.ok) throw new Error(`فشل جلب خريطة الموقع — حالة HTTP ${res.status}`);
  return { notModified: false as const, res, parsed: xmlParser.parse(res.body) as Record<string, any> };
}

export const SitemapConnector: NewsConnector = {
  type: 'sitemap',
  async fetchLatest(feedUrl: string, watermark: Watermark): Promise<FetchResult> {
    const headers: Record<string, string> = {};
    if (watermark.etag) headers['If-None-Match'] = watermark.etag;
    if (watermark.lastModified) headers['If-Modified-Since'] = watermark.lastModified;

    let { notModified, res, parsed } = await fetchAndParse(feedUrl, headers);
    if (notModified) return { items: [], notModified: true };

    // A sitemap index is a list of OTHER sitemaps, not articles — larger
    // sites (SPA is a real example) point their root sitemap.xml here.
    // Sorting children by lastmod and taking the first isn't reliably enough
    // on its own: a real site (aleqt.com) has an "archive index" child whose
    // OWN lastmod is newer than the actual current-articles sitemap (the
    // archive wrapper gets touched whenever any archived-year sitemap
    // changes, even ancient ones), AND separate real-urlset siblings for
    // authors/sections/tags that resolve fine as a urlset but contain zero
    // article-shaped URLs. So this tries candidates in recency order and
    // moves on whenever one doesn't resolve to a real urlset OR resolves but
    // yields no article entries after filtering, capped at a handful of
    // attempts rather than recursively crawling the whole index tree.
    const MAX_INDEX_CANDIDATES = 5;
    let entries: RawArticle[] = [];
    if (parsed?.sitemapindex && !parsed?.urlset) {
      const children = asArray(parsed.sitemapindex.sitemap)
        .map((s: Record<string, any>) => ({ loc: textOf(s.loc), lastmod: textOf(s.lastmod) }))
        .filter((s): s is { loc: string; lastmod: string | null } => s.loc != null)
        .sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
      if (children.length === 0) throw new Error('فهرس خرائط المواقع فارغ');

      let resolved: { res: NonNullable<typeof res>; parsed: Record<string, any> } | null = null;
      for (const child of children.slice(0, MAX_INDEX_CANDIDATES)) {
        // Conditional headers only apply to the exact URL they were recorded
        // for — the index, not whichever child ends up being tried.
        const attempt = await fetchAndParse(child.loc, {});
        if (attempt.notModified) continue; // unchanged since some prior run — not useful as "the" child here, try the next
        if (!attempt.parsed?.urlset) continue; // this child was itself another index (or something invalid) — move to the next candidate
        const candidateEntries = extractArticles(attempt.parsed);
        if (candidateEntries.length === 0) continue; // a real urlset (authors/sections/tags) but not the article one — keep looking
        resolved = { res: attempt.res, parsed: attempt.parsed };
        entries = candidateEntries;
        break;
      }
      if (!resolved) throw new Error('تعذّر العثور على خريطة مقالات فعلية ضمن فهرس خرائط المواقع');
      ({ res } = resolved);
    } else {
      if (!parsed?.urlset) throw new Error('محتوى خريطة الموقع غير صالح');
      entries = extractArticles(parsed);
    }

    return {
      items: entries.slice(0, MAX_URLS_PER_FETCH),
      newEtag: res!.headers.get('etag'),
      newLastModified: res!.headers.get('last-modified'),
      notModified: false,
    };
  },
};
