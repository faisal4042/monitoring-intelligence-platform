/**
 * HTTP client for apps/news-extractor. The extractor does all fetching of
 * article pages (Scrapling, SSRF-guarded, robots-aware) in its own process;
 * the API only sends a URL and what the feed already said about it.
 */
import { randomUUID } from 'node:crypto';
import { config } from '@mip/config';

export interface ExtractRequest {
  url: string;
  language?: string | null;
  rssTitle?: string | null;
  rssSummary?: string | null;
  rssContentHtml?: string | null;
  rssPublishedAt?: string | null;
  allowDynamic: boolean;
  jsRequired?: boolean;
}

export interface ExtractResult {
  url: string;
  status: 'complete' | 'partial' | 'empty' | 'failed' | 'skipped';
  method: 'rss' | 'static' | 'dynamic' | 'none';
  reason: string | null;
  error_kind: string | null;
  retryable: boolean;
  http_status: number | null;
  final_url: string | null;
  canonical_url: string | null;
  title: string | null;
  summary: string | null;
  content: string | null;
  content_hash: string | null;
  simhash: number | null;
  char_count: number;
  word_count: number;
  language: string | null;
  published_at: string | null;
  modified_at: string | null;
  authors: string[];
  publisher: string | null;
  image_url: string | null;
  categories: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  fetch_ms: number;
  extract_ms: number;
  attempts: number;
  dynamic_used: boolean;
  correlation_id: string;
  extractor_version: string;
}

export class ExtractorUnavailable extends Error {}

export const newCorrelationId = () => randomUUID().replace(/-/g, '').slice(0, 16);

export async function callExtractor(req: ExtractRequest, correlationId = newCorrelationId(), signal?: AbortSignal): Promise<ExtractResult> {
  let res: Response;
  try {
    res = await fetch(new URL('/extract', config.NEWS_EXTRACTOR_URL), {
      method: 'POST',
      signal: signal ?? AbortSignal.timeout(config.NEWS_EXTRACTION_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': correlationId,
        ...(config.NEWS_EXTRACTOR_TOKEN ? { 'X-Extractor-Token': config.NEWS_EXTRACTOR_TOKEN } : {}),
      },
      body: JSON.stringify({
        url: req.url,
        language: req.language ?? null,
        rss_title: req.rssTitle?.slice(0, 1000) ?? null,
        rss_summary: req.rssSummary?.slice(0, 20_000) ?? null,
        rss_content_html: req.rssContentHtml?.slice(0, 500_000) ?? null,
        rss_published_at: req.rssPublishedAt?.slice(0, 64) ?? null,
        allow_dynamic: req.allowDynamic,
        js_required: req.jsRequired ?? false,
      }),
    });
  } catch (error) {
    throw new ExtractorUnavailable(`extractor unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new ExtractorUnavailable(`extractor HTTP ${res.status}`);
  return (await res.json()) as ExtractResult;
}

export async function extractorHealth(): Promise<{ ok: boolean; version?: string; dynamic_enabled?: boolean; dynamic_renders?: number } | null> {
  try {
    const res = await fetch(new URL('/health', config.NEWS_EXTRACTOR_URL), { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() as { ok: boolean } : null;
  } catch {
    return null;
  }
}
