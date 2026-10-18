/**
 * Benchmark helper (not part of the app): fetch each sample article page with
 * the current engine's HTTP layer (safeFetch — the same code the news worker
 * uses for feeds and home pages) and record status, time and size. The
 * current engine has no article-body extraction, so this measures fetching only.
 *
 *   npx tsx src/bench/legacy-article-fetch.ts <sample.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { safeFetch } from '../modules/news/lib/ssrf-guard.js';

const [samplePath, outPath] = process.argv.slice(2);
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as Array<{ url: string; source: string }>;
const lastHit = new Map<string, number>();
const out = [];
const rssBefore = process.memoryUsage().rss;
let rssPeak = rssBefore;
for (const item of sample) {
  const host = new URL(item.url).hostname;
  const wait = 1500 - (Date.now() - (lastHit.get(host) ?? 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  const t0 = performance.now();
  try {
    const res = await safeFetch(item.url);
    out.push({ url: item.url, ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0), bytes: Buffer.byteLength(res.body), html: res.contentTypeAllowed });
  } catch (error) {
    out.push({ url: item.url, ok: false, status: null, ms: Math.round(performance.now() - t0), error: error instanceof Error ? error.message : String(error) });
  }
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}
writeFileSync(outPath, JSON.stringify({ rssBeforeMb: Math.round(rssBefore / 1e6), rssPeakMb: Math.round(rssPeak / 1e6), items: out }, null, 1));
console.log(`done: ${out.filter((x) => x.ok).length}/${out.length} ok`);
process.exit(0);
