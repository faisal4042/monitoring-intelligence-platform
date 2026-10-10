/**
 * News article extraction around the existing persistence pipeline, on the
 * guarded *_test database with a scripted fake extractor (no network).
 *
 * Covers: engine off by default, live inline extraction and gap filling,
 * canonical/content duplicates, idempotency under repeats and concurrency,
 * extractor outage, retry with backoff → dead letter, lease recovery after a
 * restart, shadow mode leaving news_articles untouched, the circuit breaker,
 * re-extraction without touching classification, RBAC and metrics.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
// The harness must be the first import that reaches @mip/db (it points every pool at *_test).
import { call, createUser, login, makeApp, sql, type App } from './harness.js';
import { config } from '@mip/config';
import { ingestArticles } from '../modules/news/service.js';
import { breakerOpen, processExtractionQueue } from '../modules/news/extraction/service.js';
import type { ExtractResult } from '../modules/news/extraction/client.js';
import type { RawArticle } from '../modules/news/connectors/types.js';

const RUN = Date.now().toString(36);
const mutable = config as Record<string, unknown>;
const saved = { ...config };
let app: App; let admin: string; let viewer: string;
let fake: Server; let down = false;
const calls: string[] = [];
const script = new Map<string, (n: number) => Partial<ExtractResult>>();

function result(url: string, over: Partial<ExtractResult> = {}): ExtractResult {
  const content = over.content === undefined ? `نص الخبر الكامل للرابط ${url} `.repeat(20) : over.content;
  return {
    url, status: 'complete', method: 'static', reason: null, error_kind: null, retryable: false, http_status: 200,
    final_url: url, canonical_url: url, title: 'عنوان من الصفحة', summary: 'ملخص', content,
    content_hash: content ? `h-${url}` : null, simhash: null, char_count: content?.length ?? 0, word_count: content ? content.split(' ').length : 0,
    language: 'ar', published_at: '2026-10-05T09:30:00+03:00', modified_at: null, authors: ['كاتب الصفحة'], publisher: 'ناشر',
    image_url: 'https://img.example.sa/a.jpg', categories: [], tags: [], metadata: {}, fetch_ms: 12, extract_ms: 3, attempts: 1,
    dynamic_used: false, correlation_id: 'test', extractor_version: 'fake', ...over,
  };
}

async function source(mode: string) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO news_sources (name_ar, base_url, source_type, connector_type, extraction_mode)
    VALUES (${'مصدر اختبار ' + RUN + mode + Math.random().toString(36).slice(2, 6)}, ${`https://src-${RUN}-${Math.random().toString(36).slice(2, 8)}.example.sa`},
            'news_site', 'rss', ${mode}) RETURNING id`;
  await sql`INSERT INTO news_source_health (source_id) VALUES (${row.id}::uuid)`;
  return row.id;
}
const item = (url: string, over: Partial<RawArticle> = {}): RawArticle => ({
  url, title: `الهيئة العامة للعقار تطلق خدمة ${url.slice(-8)}`, description: 'خبر عن الهيئة العامة للعقار', publishedAt: null, raw: {}, ...over });
const url = (p: string) => `https://pub-${RUN}.example.sa/${p}`;
const articles = (sourceId: string) => sql<{ id: string; url: string; published_at: Date | null; author: string | null; title: string;
  description: string | null; is_relevant: boolean | null; relevance_score: number; program_id: string | null }[]>`
  SELECT id, url, published_at, author, title, description, is_relevant, relevance_score, program_id FROM news_articles WHERE source_id = ${sourceId}::uuid ORDER BY url`;
const extractions = (sourceId: string) => sql<{ mode: string; status: string; attempts: number; article_id: string | null;
  duplicate_of: string | null; next_attempt_at: Date | null; content: string | null; reason: string | null }[]>`
  SELECT mode, status, attempts, article_id, duplicate_of, next_attempt_at, content, reason FROM news_article_extractions WHERE source_id = ${sourceId}::uuid ORDER BY url`;
const flags = (over: Record<string, unknown>) => Object.assign(mutable, over);

before(async () => {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (down) { res.statusCode = 503; res.end('down'); return; }
      const { url: u } = JSON.parse(body || '{}') as { url: string };
      calls.push(u);
      const n = calls.filter((x) => x === u).length;
      const over = script.get(u)?.(n) ?? {};
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result(u, over)));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const port = (fake.address() as { port: number }).port;
  flags({ NEWS_EXTRACTOR_URL: `http://127.0.0.1:${port}`, NEWS_EXTRACTION_MAX_PER_RUN: 5, NEWS_EXTRACTION_QUEUE_BATCH: 50,
    NEWS_EXTRACTION_MAX_ATTEMPTS: 3, NEWS_EXTRACTION_BREAKER_FAILURES: 3 });
  app = await makeApp();
  const a = await createUser('admin'); const v = await createUser('viewer');
  admin = (await login(app, a.email)).accessToken; viewer = (await login(app, v.email)).accessToken;
});
after(async () => { Object.assign(mutable, saved); await app?.close(); fake?.close(); });
beforeEach(() => { down = false; calls.length = 0; script.clear(); flags({ NEWS_SCRAPLING_ENABLED: false, NEWS_SCRAPLING_SHADOW_MODE: false }); });

test('engine off by default: the pipeline behaves exactly as before', async () => {
  const s = await source('static'); // opted in, but the global flag is off
  assert.equal(await ingestArticles(s, [item(url('off-1'))]), 1);
  assert.equal(calls.length, 0);
  assert.equal((await extractions(s)).length, 0);
  assert.equal((await articles(s))[0].published_at, null);
});

test('live: page extracted before insert, gaps filled, feed values and classification untouched', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true });
  const s = await source('static');
  const legacy = await source('off');
  const feedDated = item(url('live-2'), { publishedAt: '2026-10-01T08:00:00Z', author: 'كاتب الخلاصة' });
  assert.equal(await ingestArticles(s, [item(url('live-1')), feedDated]), 2);
  await ingestArticles(legacy, [item(url('live-1-legacy'))]);
  const [a1, a2] = await articles(s);
  assert.equal(new Date(a1.published_at!).toISOString(), '2026-10-05T06:30:00.000Z'); // filled from the page
  assert.equal(a1.author, 'كاتب الصفحة');
  assert.equal(new Date(a2.published_at!).toISOString(), '2026-10-01T08:00:00.000Z');  // the feed's date wins
  assert.equal(a2.author, 'كاتب الخلاصة');
  const [l] = await articles(legacy);
  assert.equal(a1.is_relevant, l.is_relevant); assert.equal(a1.relevance_score, l.relevance_score); // same relevance input
  assert.equal(a1.title, item(url('live-1')).title); // feed title kept
  const ex = await extractions(s);
  assert.deepEqual(ex.map((e) => [e.mode, e.status]), [['live', 'complete'], ['live', 'complete']]);
  assert.ok(ex.every((e) => e.article_id && e.content));
});

test('live duplicates: same canonical URL or same body is not inserted again, and is not re-fetched', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true });
  const s = await source('static');
  await ingestArticles(s, [item(url('orig'))]);
  script.set(url('amp-copy'), () => ({ canonical_url: url('orig') }));
  script.set(url('same-body'), () => ({ content_hash: `h-${url('orig')}`, canonical_url: url('same-body') }));
  assert.equal(await ingestArticles(s, [item(url('amp-copy')), item(url('same-body'))]), 0);
  const [orig] = await articles(s);
  const ex = (await extractions(s)).filter((e) => e.status === 'duplicate');
  assert.equal(ex.length, 2);
  assert.ok(ex.every((e) => e.duplicate_of === orig.id && e.article_id === null));
  calls.length = 0;
  assert.equal(await ingestArticles(s, [item(url('amp-copy')), item(url('same-body')), item(url('orig'))]), 0);
  assert.equal(calls.length, 0); // known duplicates and stored articles are not fetched again
});

test('idempotent under repeated and concurrent runs', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true });
  const s = await source('static');
  const batch = [item(url('c-1')), item(url('c-2'))];
  await Promise.all([ingestArticles(s, batch), ingestArticles(s, batch), ingestArticles(s, batch)]);
  await ingestArticles(s, batch);
  assert.equal((await articles(s)).length, 2);
  assert.equal((await extractions(s)).length, 2);
});

test('extractor outage: article stored as today and queued; queue pass completes it later', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true });
  const s = await source('static');
  down = true;
  assert.equal(await ingestArticles(s, [item(url('out-1'))]), 1);
  let [e] = await extractions(s);
  assert.equal(e.status, 'pending');
  await processExtractionQueue();
  [e] = await extractions(s);
  assert.equal(e.status, 'pending'); assert.equal(e.attempts, 0); // handed back, attempt not counted
  down = false;
  await sql`UPDATE news_article_extractions SET next_attempt_at = now() WHERE source_id = ${s}::uuid`;
  await processExtractionQueue();
  [e] = await extractions(s);
  assert.equal(e.status, 'complete');
  assert.ok((await articles(s))[0].published_at); // filled after the fact
});

test('retryable failures back off, then go to the dead-letter state; non-retryable ones stop', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true });
  const s = await source('static');
  script.set(url('flaky'), () => ({ status: 'failed', retryable: true, error_kind: 'server_error', http_status: 503, content: null }));
  script.set(url('gone'), () => ({ status: 'failed', retryable: false, error_kind: 'not_found', http_status: 404, content: null }));
  await ingestArticles(s, [item(url('flaky')), item(url('gone'))]);
  let [flaky, gone] = await extractions(s);
  assert.equal(flaky.status, 'failed'); assert.ok(flaky.next_attempt_at && new Date(flaky.next_attempt_at).getTime() > Date.now());
  assert.equal(gone.status, 'failed'); assert.equal(gone.next_attempt_at, null);
  for (let i = 0; i < 4; i++) {
    await sql`UPDATE news_article_extractions SET next_attempt_at = now() WHERE source_id = ${s}::uuid AND next_attempt_at IS NOT NULL`;
    await processExtractionQueue();
  }
  [flaky, gone] = await extractions(s);
  assert.equal(flaky.status, 'dead'); assert.equal(flaky.attempts, 3);
  assert.equal(gone.status, 'failed'); assert.equal(calls.filter((c) => c === url('gone')).length, 1);
  assert.equal((await articles(s)).length, 2); // failures never remove the article
});

test('worker restart: an expired lease is picked up again, a live one is not', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true, NEWS_EXTRACTION_MAX_PER_RUN: 0 });
  const s = await source('static');
  await ingestArticles(s, [item(url('lease-1')), item(url('lease-2'))]);
  await sql`UPDATE news_article_extractions SET status = 'running', attempts = 1, locked_until = now() - interval '1 minute'
    WHERE source_id = ${s}::uuid AND url = ${url('lease-1')}`;
  await sql`UPDATE news_article_extractions SET status = 'running', attempts = 1, locked_until = now() + interval '5 minutes'
    WHERE source_id = ${s}::uuid AND url = ${url('lease-2')}`;
  await processExtractionQueue();
  const [l1, l2] = await extractions(s);
  assert.equal(l1.status, 'complete'); assert.equal(l2.status, 'running');
  flags({ NEWS_EXTRACTION_MAX_PER_RUN: 5 });
});

test('shadow mode: news_articles is written exactly as the current pipeline would', async () => {
  flags({ NEWS_SCRAPLING_SHADOW_MODE: true });
  const s = await source('static');
  await ingestArticles(s, [item(url('sh-1'))]);
  assert.equal(calls.length, 0); // nothing fetched inline
  await processExtractionQueue();
  const [a] = await articles(s);
  assert.equal(a.published_at, null); assert.equal(a.author, null); // never filled in shadow
  const [e] = await extractions(s);
  assert.equal(e.mode, 'shadow'); assert.equal(e.status, 'complete'); assert.equal(e.article_id, a.id);
});

test('circuit breaker opens after consecutive failures and holds the queue for the cooldown', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true });
  const s = await source('static');
  const bad = ['b1', 'b2', 'b3'].map(url);
  for (const u of bad) script.set(u, () => ({ status: 'empty', reason: 'no_text', content: null }));
  await ingestArticles(s, bad.map((u) => item(u)));
  assert.equal(await breakerOpen(s), true);
  flags({ NEWS_EXTRACTION_MAX_PER_RUN: 0 });
  await ingestArticles(s, [item(url('b4'))]);
  calls.length = 0;
  await processExtractionQueue();
  assert.equal(calls.length, 0);
  const held = (await extractions(s)).find((e) => e.status === 'pending')!;
  assert.ok(new Date(held.next_attempt_at!).getTime() > Date.now() + 30 * 60_000);
  flags({ NEWS_EXTRACTION_MAX_PER_RUN: 5 });
});

test('re-extraction via the API keeps classification, needs manage permission; metrics and source mode', async () => {
  flags({ NEWS_SCRAPLING_ENABLED: true });
  const s = await source('static');
  await ingestArticles(s, [item(url('re-1'))]);
  const [before] = await articles(s);
  script.set(url('re-1'), () => ({ content: 'نص جديد مختلف تمامًا عن السابق '.repeat(20), content_hash: 'h-new' }));
  assert.equal((await call(app, viewer, 'POST', `/api/v1/news/articles/${before.id}/extract`)).statusCode, 403);
  const res = await call(app, admin, 'POST', `/api/v1/news/articles/${before.id}/extract`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'complete');
  const [afterRow] = await articles(s);
  assert.deepEqual([afterRow.is_relevant, afterRow.relevance_score, afterRow.program_id, afterRow.title, afterRow.description],
    [before.is_relevant, before.relevance_score, before.program_id, before.title, before.description]);
  const [e] = await extractions(s);
  assert.match(e.content ?? '', /نص جديد/);
  const view = await call(app, viewer, 'GET', `/api/v1/news/articles/${before.id}/extraction`);
  assert.equal(view.statusCode, 200); assert.equal(view.json().items.length, 1);

  const m = await call(app, viewer, 'GET', '/api/v1/news/extraction/metrics?hours=1');
  assert.equal(m.statusCode, 200, m.body);
  const metrics = m.json();
  assert.ok(metrics.extraction.complete >= 1);
  assert.ok(metrics.sources.some((x: { id: string }) => x.id === s));

  const other = await source('off');
  assert.equal((await call(app, viewer, 'PATCH', `/api/v1/news/sources/${other}`, { extractionMode: 'shadow' })).statusCode, 403);
  const patched = await call(app, admin, 'PATCH', `/api/v1/news/sources/${other}`, { extractionMode: 'shadow' });
  assert.equal(patched.statusCode, 200, patched.body); assert.equal(patched.json().extraction_mode, 'shadow');
  assert.equal((await call(app, admin, 'PATCH', `/api/v1/news/sources/${other}`, { extractionMode: 'turbo' })).statusCode, 400);
});
