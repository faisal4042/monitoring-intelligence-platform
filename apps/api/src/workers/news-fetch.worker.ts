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
  check_interval_minutes: number;
}

/** Picks (and, for 'auto' sources with nothing discovered yet, first discovers) which connector+URL to use. */
async function resolveConnector(source: DueSource): Promise<{ connector: NewsConnector; feedUrl: string } | null> {
  if ((source.connector_type === 'rss' || source.connector_type === 'atom') && source.rss_url) {
    return { connector: RSSConnector, feedUrl: source.rss_url };
  }
  if (source.connector_type === 'sitemap' && source.sitemap_url) {
    return { connector: SitemapConnector, feedUrl: source.sitemap_url };
  }
  if (source.connector_type === 'crawler') {
    return { connector: CrawlerConnector, feedUrl: source.base_url };
  }
  if (source.connector_type !== 'auto') return null; // api/crawler/manual — not handled by this worker

  if (source.rss_url) return { connector: RSSConnector, feedUrl: source.rss_url };
  if (source.sitemap_url) return { connector: SitemapConnector, feedUrl: source.sitemap_url };

  // Nothing discovered yet for an auto source — probe once, persist whatever
  // is found (and pin connector_type so future ticks skip this probe
  // entirely), and use it immediately this same tick if something worked.
  const discovery = await discoverSource(source.base_url);
  const rss = discovery.detectedRssUrl;
  const sitemap = discovery.detectedSitemapUrl ?? discovery.detectedNewsSitemapUrl;
  if (rss) {
    await sql`UPDATE news_sources SET rss_url = ${rss}, connector_type = 'rss', updated_at = now() WHERE id = ${source.id}::uuid`;
    return { connector: RSSConnector, feedUrl: rss };
  }
  if (sitemap) {
    await sql`UPDATE news_sources SET sitemap_url = ${sitemap}, connector_type = 'sitemap', updated_at = now() WHERE id = ${source.id}::uuid`;
    return { connector: SitemapConnector, feedUrl: sitemap };
  }
  if (discovery.crawlAllowed && discovery.connectionOk) {
    await sql`UPDATE news_sources SET connector_type = 'crawler', updated_at = now() WHERE id = ${source.id}::uuid`;
    return { connector: CrawlerConnector, feedUrl: source.base_url };
  }
  return null;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = await sql<DueSource[]>`
      SELECT id, base_url, connector_type, rss_url, sitemap_url, etag, last_modified, check_interval_minutes
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
        RETURNING id, base_url, connector_type, rss_url, sitemap_url, etag, last_modified, check_interval_minutes`;
      if (!claimed) return;

      const [job] = await sql<{ id: string }[]>`
        INSERT INTO news_fetch_jobs (source_id, status, triggered_by)
        VALUES (${claimed.id}::uuid, 'running', 'scheduler') RETURNING id`;

      try {
        const resolved = await resolveConnector(claimed);
        if (!resolved) {
          throw new Error('لا توجد طريقة جلب معروفة لهذا المصدر بعد (RSS/Sitemap غير مكتشفَين)');
        }

        const domain = new URL(resolved.feedUrl).hostname;
        const result = await withDomainLock(domain, config.NEWS_DOMAIN_MIN_DELAY_MS, () =>
          resolved.connector.fetchLatest(resolved.feedUrl, { etag: claimed.etag, lastModified: claimed.last_modified }));

        const itemsNew = result.notModified ? 0 : await ingestArticles(claimed.id, result.items);

        await sql`
          UPDATE news_sources SET
            last_checked_at = now(), last_success_at = now(),
            etag = COALESCE(${result.newEtag ?? null}, etag),
            last_modified = COALESCE(${result.newLastModified ?? null}, last_modified),
            check_interval_minutes = ${config.NEWS_FETCH_INTERVAL_MINUTES},
            next_run_at = now() + ${config.NEWS_FETCH_INTERVAL_MINUTES} * interval '1 minute',
            updated_at = now()
          WHERE id = ${claimed.id}::uuid`;
        await recordHealthCheck(claimed.id, true, null);

        await sql`
          UPDATE news_fetch_jobs SET status = 'success', finished_at = now(),
            connector_used = ${resolved.connector.type},
            items_discovered = ${result.notModified ? 0 : result.items.length}, items_new = ${itemsNew}
          WHERE id = ${job.id}::uuid`;

        if (itemsNew > 0) {
          log.info({ sourceId: claimed.id, itemsNew, discovered: result.items.length }, 'news fetch completed');
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
