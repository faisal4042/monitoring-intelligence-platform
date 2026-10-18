/**
 * Auto-Discovery for "اختبار الاتصال" (Test Connection): given a base URL,
 * find the best available connector for that source WITHOUT persisting
 * anything — this only reports what it found so an admin can confirm before
 * saving the source (Phase 2 is what actually ingests articles on a
 * schedule). Priority mirrors the spec: RSS/Atom > News Sitemap > Sitemap >
 * Crawler (crawler is never recommended here — it stays behind its own
 * opt-in flag, added in a later phase).
 */
import { XMLParser } from 'fast-xml-parser';
import robotsParser from 'robots-parser';
import { safeFetch } from './ssrf-guard.js';
import { HttpError } from '../../../lib/errors.js';

const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml'];
const NEWS_SITEMAP_PATHS = ['/news-sitemap.xml', '/sitemap-news.xml'];

const LINK_TAG = /<link\b[^>]*>/gi;
const REL_ALTERNATE = /rel=["']alternate["']/i;
const TYPE_RSS = /type=["']application\/rss\+xml["']/i;
const TYPE_ATOM = /type=["']application\/atom\+xml["']/i;
const HREF = /href=["']([^"']+)["']/i;

export interface LastArticle {
  title: string;
  publishedAt: string | null;
}

export interface DiscoveryResult {
  connectionOk: boolean;
  httpStatus: number | null;
  responseMs: number | null;
  detectedRssUrl: string | null;
  detectedAtomUrl: string | null;
  detectedSitemapUrl: string | null;
  detectedNewsSitemapUrl: string | null;
  robotsStatus: 'allowed' | 'disallowed' | 'unknown';
  crawlAllowed: boolean;
  recommendedMethod: 'rss' | 'atom' | 'sitemap' | 'unknown';
  lastArticle: LastArticle | null;
  errors: string[];
}

// See connectors/sitemap.ts for why this is raised rather than left at the
// library default — this parser validates the same candidate RSS/sitemap
// bodies the connectors will later parse for real, so it needs the same limit.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: { maxTotalExpansions: 20000 },
});

function findLinkHref(html: string, typeRe: RegExp): string | null {
  for (const tag of html.match(LINK_TAG) ?? []) {
    if (REL_ALTERNATE.test(tag) && typeRe.test(tag)) {
      const m = tag.match(HREF);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * A candidate path (e.g. /sitemap.xml) commonly 200s with an unrelated page
 * — a redirect to the homepage, a custom 404, a login wall — rather than
 * actually failing. Checking `res.ok` alone accepted those as "found";
 * requiring one of the four known feed/sitemap XML roots is what actually
 * tells a real feed apart from an arbitrary 200 response.
 */
function parseFeedBody(body: string): Record<string, unknown> | null {
  try {
    const parsed = xmlParser.parse(body) as Record<string, unknown>;
    if (parsed && ('rss' in parsed || 'feed' in parsed || 'urlset' in parsed || 'sitemapindex' in parsed)) {
      return parsed;
    }
  } catch {
    // not XML at all — fall through to null
  }
  return null;
}

/** Best-effort — a feed with none of these shapes just means no "last article" preview, not a hard error. */
function extractLastArticleFromFeed(parsed: Record<string, unknown>): LastArticle | null {
  const rssItem = (parsed as any)?.rss?.channel?.item;
  const first = Array.isArray(rssItem) ? rssItem[0] : rssItem;
  if (first?.title) {
    return { title: String(first.title), publishedAt: first.pubDate ? String(first.pubDate) : null };
  }
  const atomEntry = (parsed as any)?.feed?.entry;
  const firstEntry = Array.isArray(atomEntry) ? atomEntry[0] : atomEntry;
  if (firstEntry?.title) {
    const title = typeof firstEntry.title === 'object' ? firstEntry.title['#text'] : firstEntry.title;
    return { title: String(title), publishedAt: firstEntry.updated ? String(firstEntry.updated) : null };
  }
  // Sitemap (urlset) — no title, just report the most recent lastmod as a freshness signal.
  const urls = (parsed as any)?.urlset?.url;
  const firstUrl = Array.isArray(urls) ? urls[0] : urls;
  if (firstUrl?.loc) {
    return { title: String(firstUrl.loc), publishedAt: firstUrl.lastmod ? String(firstUrl.lastmod) : null };
  }
  return null;
}

async function probeFeed(url: string, request: typeof safeFetch = safeFetch): Promise<{ url: string; lastArticle: LastArticle | null } | null> {
  try {
    const res = await request(url);
    if (!res.ok) return null;
    const parsed = parseFeedBody(res.body);
    if (!parsed) return null;
    return { url: res.finalUrl, lastArticle: extractLastArticleFromFeed(parsed) };
  } catch {
    return null;
  }
}

async function checkRobots(baseUrl: string, request: typeof safeFetch = safeFetch): Promise<{ status: 'allowed' | 'disallowed' | 'unknown'; allowed: boolean; sitemaps: string[] }> {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    const res = await request(robotsUrl);
    if (!res.ok) return { status: 'unknown', allowed: true, sitemaps: [] };
    const robots = robotsParser(robotsUrl, res.body);
    const allowed = robots.isAllowed(baseUrl, 'MIP-NewsMonitor') ?? true;
    return { status: allowed ? 'allowed' : 'disallowed', allowed, sitemaps: robots.getSitemaps() };
  } catch {
    return { status: 'unknown', allowed: true, sitemaps: [] };
  }
}

const OVERALL_DEADLINE_MS = 20_000;

const recentProbes = new Map<string, number>();
/** Per-host 60-second cooldown, including in-flight checks; no cached result recorded as a new check. */
export function discoverSource(baseUrl: string): Promise<DiscoveryResult> {
  const key = new URL(baseUrl).host.toLowerCase();
  const old = recentProbes.get(key);
  if (old !== undefined && Date.now() - old < 60_000)
    return Promise.reject(new HttpError(429, 'انتظر دقيقة قبل إعادة اختبار هذا النطاق', 'DISCOVERY_COOLDOWN'));
  for (const [host, at] of recentProbes) if (Date.now() - at >= 60_000) recentProbes.delete(host);
  if (recentProbes.size >= 256)
    return Promise.reject(new HttpError(429, 'وصلت اختبارات الاتصال إلى حدها المؤقت', 'DISCOVERY_CAPACITY'));
  recentProbes.set(key, Date.now()); return boundedDiscovery(baseUrl);
}
async function boundedDiscovery(baseUrl: string): Promise<DiscoveryResult> {
  let count = 0; let stopped = false; const visited = new Set<string>();
  const started = Date.now(); let timer: ReturnType<typeof setTimeout> | undefined;
  const request: typeof safeFetch = async (url, headers) => {
    if (stopped || count >= 6 || visited.has(url) || Date.now()-started >= OVERALL_DEADLINE_MS) throw new Error('Discovery request budget exhausted');
    count++; visited.add(url);
    const response = await safeFetch(url,headers,1);
    if ([401,403,429,451].includes(response.status)) stopped = true;
    return response;
  };
  try { return await Promise.race([
    discoverSourceInner(baseUrl,request),
    new Promise<DiscoveryResult>((resolve) => { timer = setTimeout(() => {
      stopped = true;
      resolve({connectionOk:false,httpStatus:null,responseMs:null,detectedRssUrl:null,detectedAtomUrl:null,
        detectedSitemapUrl:null,detectedNewsSitemapUrl:null,robotsStatus:'unknown',crawlAllowed:true,
        recommendedMethod:'unknown',lastArticle:null,errors:['انتهت مهلة اكتشاف المصدر']});
    },OVERALL_DEADLINE_MS); }),
  ]); } finally { stopped = true; if(timer) clearTimeout(timer); }
}

async function discoverSourceInner(baseUrl: string, request: typeof safeFetch): Promise<DiscoveryResult> {
  const errors: string[] = [];
  let connectionOk = false;
  let httpStatus: number | null = null;
  let responseMs: number | null = null;
  let detectedRssUrl: string | null = null;
  let detectedAtomUrl: string | null = null;

  try {
    const home = await request(baseUrl);
    connectionOk = home.ok;
    httpStatus = home.status;
    responseMs = home.responseMs;
    if (!home.ok) errors.push(`الصفحة الرئيسية أرجعت الحالة ${home.status}`);
    const rssHref = findLinkHref(home.body, TYPE_RSS);
    const atomHref = findLinkHref(home.body, TYPE_ATOM);
    if (rssHref) detectedRssUrl = new URL(rssHref, home.finalUrl).toString();
    if (atomHref) detectedAtomUrl = new URL(atomHref, home.finalUrl).toString();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'تعذّر الوصول إلى الرابط');
  }

  const rssProbe = detectedRssUrl ? await probeFeed(detectedRssUrl,request) : null;
  const atomProbe = !rssProbe && detectedAtomUrl ? await probeFeed(detectedAtomUrl,request) : null;
  const robots = await checkRobots(baseUrl,request);

  let detectedSitemapUrl: string | null = null;
  let detectedNewsSitemapUrl: string | null = null;
  let sitemapProbe: Awaited<ReturnType<typeof probeFeed>> = null;
  let newsSitemapProbe: Awaited<ReturnType<typeof probeFeed>> = null;

  // Only probe sitemaps when no feed was found — RSS/Atom always wins per
  // the priority order, so a sitemap round-trip would be wasted work.
  // Robots-declared candidates precede guessed paths. Each probe shares the
  // sequential request budget, deadline and blocking-status stop condition.
  if (!rssProbe && !atomProbe) {
    const robotsSitemapCandidates = robots.sitemaps.filter(
      (url) => !SITEMAP_PATHS.some((p) => url.endsWith(p)) && !NEWS_SITEMAP_PATHS.some((p) => url.endsWith(p)),
    );
    // Sequential candidates share a six-call budget; stop after first valid feed.
    for (const url of [...robotsSitemapCandidates.slice(0,2), ...NEWS_SITEMAP_PATHS.map(p=>new URL(p,baseUrl).toString()), ...SITEMAP_PATHS.map(p=>new URL(p,baseUrl).toString())]) {
      const probe = await probeFeed(url,request);
      if (probe) {
        if (NEWS_SITEMAP_PATHS.some(path => new URL(url).pathname === path)) newsSitemapProbe = probe;
        else sitemapProbe = probe;
        break;
      }
    }
    if (sitemapProbe) detectedSitemapUrl = sitemapProbe.url;
    if (newsSitemapProbe) detectedNewsSitemapUrl = newsSitemapProbe.url;
  }

  const recommendedMethod: DiscoveryResult['recommendedMethod'] =
    rssProbe ? 'rss' : atomProbe ? 'atom' : (detectedNewsSitemapUrl || detectedSitemapUrl) ? 'sitemap' : 'unknown';

  const lastArticle = rssProbe?.lastArticle ?? atomProbe?.lastArticle ?? newsSitemapProbe?.lastArticle ?? sitemapProbe?.lastArticle ?? null;

  if (recommendedMethod === 'unknown') {
    errors.push('لم يُعثر على RSS أو Atom أو Sitemap — يمكن إضافة المصدر يدوياً وتحديد الرابط بنفسك');
  }
  // A <link rel="alternate"> tag pointing at an RSS/Atom URL is not proof
  // that URL actually serves a feed to a non-browser request — some sites
  // (Cloudflare bot challenges being the common case) return an HTML
  // interstitial there instead. Say so explicitly rather than silently
  // recommending sitemap and leaving a human to wonder why.
  if (detectedRssUrl && !rssProbe) {
    errors.push('عُثر على رابط RSS في الصفحة لكن تعذّر التحقق من محتواه الفعلي (قد يحجبه الموقع عن الطلبات غير المتصفحية)');
  }
  if (detectedAtomUrl && !atomProbe) {
    errors.push('عُثر على رابط Atom في الصفحة لكن تعذّر التحقق من محتواه الفعلي (قد يحجبه الموقع عن الطلبات غير المتصفحية)');
  }

  return {
    connectionOk,
    httpStatus,
    responseMs,
    detectedRssUrl: rssProbe ? rssProbe.url : detectedRssUrl,
    detectedAtomUrl: atomProbe ? atomProbe.url : detectedAtomUrl,
    detectedSitemapUrl,
    detectedNewsSitemapUrl,
    robotsStatus: robots.status,
    crawlAllowed: robots.allowed,
    recommendedMethod,
    lastArticle,
    errors,
  };
}
