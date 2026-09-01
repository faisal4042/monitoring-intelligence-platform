/**
 * News & Web Monitoring — Phase 2 scheduler. Mirrors collection.worker.ts's
 * claim/backoff pattern exactly (atomic UPDATE...RETURNING claim, so an
 * overlapping tick or a future second instance can't double-fetch the same
 * source), applied to news sources instead of X queries.
 */
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { newsLogger as log } from '@mip/logger';
import { discoverSource } from '../modules/news/lib/discovery.js';
import { withDomainLock } from '../modules/news/lib/domain-lock.js';
import { ingestArticles, recordHealthCheck } from '../modules/news/service.js';
import { RSSConnector } from '../modules/news/connectors/rss.js';
import { SitemapConnector } from '../modules/news/connectors/sitemap.js';
import { CrawlerConnector } from '../modules/news/connectors/crawler.js';
import type { NewsConnector } from '../modules/news/connectors/types.js';

let ticking = false;

interface DueSource {
  id: string; base_url: string; connector_type: string;
  rss_url: string | null; sitemap_url: string | null;
  etag: string | null; last_modified: string | null;
  check_interval_minutes: number; crawl_allowed: boolean;
}

interface ResolvedConnector { connector: NewsConnector; feedUrl: string; primary: boolean }

/**
 * Builds a resilient connector chain. A newspaper feed can be valid but
 * shallow, or disappear without notice; the public home page is therefore a
 * supplementary/fallback channel whenever crawling is allowed. Exact URL
 * deduplication in ingestArticles keeps the overlap harmless.
 */
async function resolveConnectors(source: DueSource): Promise<ResolvedConnector[]> {
  const resolved: ResolvedConnector[] = [];
  const add = (connector: NewsConnector, feedUrl: string, primary = resolved.length === 0) => {
    if (!resolved.some((item) => item.feedUrl === feedUrl && item.connector.type === connector.type)) {
      resolved.push({ connector, feedUrl, primary });
    }
  };

  if ((source.connector_type === 'rss' || source.connector_type === 'atom') && source.rss_url) {
    add(RSSConnector, source.rss_url);
  }
  if (source.connector_type === 'sitemap' && source.sitemap_url) {
    add(SitemapConnector, source.sitemap_url);
  }
  if (source.connector_type === 'crawler') {
    add(CrawlerConnector, source.base_url);
  }

  // Preserve every configured channel as a fallback/supplement, regardless
  // of which connector is currently marked preferred in the registry.
  if (source.connector_type !== 'manual' && source.connector_type !== 'api') {
    if (source.rss_url) add(RSSConnector, source.rss_url);
    if (source.sitemap_url) add(SitemapConnector, source.sitemap_url);
  }

  if (source.connector_type === 'auto') {
    if (resolved.length === 0) {
      const discovery = await discoverSource(source.base_url);
      const rss = discovery.detectedRssUrl ?? discovery.detectedAtomUrl;
      const sitemap = discovery.detectedNewsSitemapUrl ?? discovery.detectedSitemapUrl;
      if (rss) add(RSSConnector, rss);
      if (sitemap) add(SitemapConnector, sitemap);
      await sql`
        UPDATE news_sources SET
          rss_url = COALESCE(rss_url, ${rss}),
          sitemap_url = COALESCE(sitemap_url, ${sitemap}),
          robots_checked_at = now(), robots_status = ${discovery.robotsStatus},
          crawl_allowed = ${discovery.crawlAllowed}, updated_at = now()
        WHERE id = ${source.id}::uuid`;
      source.crawl_allowed = discovery.crawlAllowed;
    }
  }

  // RSS/search endpoints are not HTML home pages. Only supplement with the
  // crawler when base_url is a distinct publisher page.
  const baseLooksLikeFeed = /(?:\.xml|\/feed\/?|news\.google\.com\/rss)/i.test(source.base_url);
  if (source.crawl_allowed && !baseLooksLikeFeed && source.connector_type !== 'manual' && source.connector_type !== 'api') {
    add(CrawlerConnector, source.base_url, resolved.length === 0);
  }
  return resolved;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = await sql<DueSource[]>`
      SELECT id, base_url, connector_type, rss_url, sitemap_url, etag, last_modified, check_interval_minutes, crawl_allowed
      FROM news_sources
      WHERE is_active AND (next_run_at IS NULL OR next_run_at <= now())
      ORDER BY COALESCE(next_run_at, created_at) ASC
      LIMIT ${config.NEWS_FETCH_BATCH_SIZE}`;

    await Promise.all(due.map(async (source) => {
      const [claimed] = await sql<DueSource[]>`
        UPDATE news_sources
        SET next_run_at = now() + ${config.NEWS_FETCH_MAX_BACKOFF_MINUTES} * interval '1 minute'
        WHERE id = ${source.id}::uuid AND is_active
          AND (next_run_at IS NULL OR next_run_at <= now())
        RETURNING id, base_url, connector_type, rss_url, sitemap_url, etag, last_modified, check_interval_minutes, crawl_allowed`;
      if (!claimed) return;

      const [job] = await sql<{ id: string }[]>`
        INSERT INTO news_fetch_jobs (source_id, status, triggered_by)
        VALUES (${claimed.id}::uuid, 'running', 'scheduler') RETURNING id`;

      try {
        const connectors = await resolveConnectors(claimed);
        if (connectors.length === 0) {
          throw new Error('لا توجد طريقة جلب معروفة لهذا المصدر بعد (RSS/Sitemap غير مكتشفَين)');
        }

        const collected = new Map<string, Awaited<ReturnType<NewsConnector['fetchLatest']>>['items'][number]>();
        const successfulTypes: string[] = [];
        const connectorErrors: string[] = [];
        let newEtag: string | null = null;
        let newLastModified: string | null = null;
        let anyModified = false;
        for (const candidate of connectors) {
          try {
            const domain = new URL(candidate.feedUrl).hostname;
            const watermark = candidate.primary
              ? { etag: claimed.etag, lastModified: claimed.last_modified }
              : {};
            const result = await withDomainLock(domain, config.NEWS_DOMAIN_MIN_DELAY_MS, () =>
              candidate.connector.fetchLatest(candidate.feedUrl, watermark));
            successfulTypes.push(candidate.connector.type);
            if (candidate.primary) {
              newEtag = result.newEtag ?? null;
              newLastModified = result.newLastModified ?? null;
            }
            if (!result.notModified) {
              anyModified = true;
              for (const item of result.items) collected.set(item.url, item);
            }
          } catch (error) {
            connectorErrors.push(`${candidate.connector.type}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (successfulTypes.length === 0) throw new Error(connectorErrors.join(' | '));

        const items = [...collected.values()];
        const itemsNew = anyModified ? await ingestArticles(claimed.id, items) : 0;

        await sql`
          UPDATE news_sources SET
            last_checked_at = now(), last_success_at = now(),
            etag = COALESCE(${newEtag}, etag),
            last_modified = COALESCE(${newLastModified}, last_modified),
            check_interval_minutes = ${config.NEWS_FETCH_INTERVAL_MINUTES},
            next_run_at = now() + ${config.NEWS_FETCH_INTERVAL_MINUTES} * interval '1 minute',
            updated_at = now()
          WHERE id = ${claimed.id}::uuid`;
        await recordHealthCheck(claimed.id, true, null);

        await sql`
          UPDATE news_fetch_jobs SET status = 'success', finished_at = now(),
            connector_used = ${[...new Set(successfulTypes)].join('+')},
            items_discovered = ${items.length}, items_new = ${itemsNew},
            error = ${connectorErrors.length ? connectorErrors.join(' | ') : null}
          WHERE id = ${job.id}::uuid`;

        if (itemsNew > 0) {
          log.info({ sourceId: claimed.id, itemsNew, discovered: items.length, connectors: successfulTypes }, 'news fetch completed');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextInterval = config.NEWS_FETCH_INTERVAL_MINUTES;
        await sql`
          UPDATE news_sources SET
            last_checked_at = now(),
            next_run_at = now() + ${nextInterval} * interval '1 minute',
            updated_at = now()
          WHERE id = ${claimed.id}::uuid`;
        await recordHealthCheck(claimed.id, false, null);
        await sql`
          UPDATE news_fetch_jobs SET status = 'failed', finished_at = now(), error = ${message}
          WHERE id = ${job.id}::uuid`;
        log.error({ sourceId: claimed.id, err: message }, 'news fetch failed');
      }
    }));
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'news fetch tick failed');
  } finally {
    ticking = false;
  }
}

/** Queue every active source now and kick the existing single-flight worker. */
export async function queueNewsRefresh(): Promise<{ queued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE news_sources SET next_run_at = now(), updated_at = now()
    WHERE is_active RETURNING id`;
  void tick();
  return { queued: rows.length };
}

export function startNewsFetchWorker(): () => void {
  if (!config.NEWS_FETCH_ENABLED) {
    log.info('automatic news fetching is disabled');
    return () => {};
  }
  void sql`
    UPDATE news_sources SET
      check_interval_minutes = ${config.NEWS_FETCH_INTERVAL_MINUTES},
      next_run_at = LEAST(COALESCE(next_run_at, now()), now() + ${config.NEWS_FETCH_INTERVAL_MINUTES} * interval '1 minute'),
      updated_at = now()
    WHERE is_active`;
  const timer = setInterval(() => void tick(), config.NEWS_FETCH_TICK_SECONDS * 1000);
  timer.unref();
  void tick();
  log.info({ tickSeconds: config.NEWS_FETCH_TICK_SECONDS, intervalMinutes: config.NEWS_FETCH_INTERVAL_MINUTES, batchSize: config.NEWS_FETCH_BATCH_SIZE }, 'news fetch worker started');
  return () => clearInterval(timer);
}
