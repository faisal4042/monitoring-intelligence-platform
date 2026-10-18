export interface MetricGroup {
  mode: string; status: string; n: number; fetch_sum: number; fetch_n: number; extract_sum: number; extract_n: number;
  retries: number; dynamic: number; title_n: number; date_n: number; body_n: number;
}
export function summarizeMetrics(rows: MetricGroup[]) {
  const sum = (key: keyof MetricGroup) => rows.reduce((n, r) => n + Number(r[key]), 0);
  const count = (...statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r.n, 0);
  const finished = count('complete', 'partial', 'empty', 'failed', 'dead');
  const qualityRows = rows.filter((r) => ['complete', 'partial', 'empty', 'failed', 'dead', 'duplicate'].includes(r.status));
  const denominator = qualityRows.reduce((n, r) => n + r.n, 0);
  const quality = (key: 'title_n' | 'date_n' | 'body_n') => denominator ? qualityRows.reduce((n, r) => n + r[key], 0) / denominator : null;
  return {
    total: sum('n'), finished, pending: count('pending'), running: count('running'), complete: count('complete'), partial: count('partial'),
    empty: count('empty'), failed: count('failed', 'dead'), duplicate: count('duplicate'), skipped: count('skipped'),
    successRate: finished ? count('complete', 'partial') / finished : null,
    emptyRate: finished ? count('empty') / finished : null,
    duplicateRate: finished + count('duplicate') ? count('duplicate') / (finished + count('duplicate')) : null,
    titleCompleteness: quality('title_n'), dateCompleteness: quality('date_n'), bodyCompleteness: quality('body_n'),
    qualityDenominator: denominator, dynamicRenders: sum('dynamic'), retries: sum('retries'),
    avgFetchMs: sum('fetch_n') ? Math.round(sum('fetch_sum') / sum('fetch_n')) : null,
    avgExtractMs: sum('extract_n') ? Math.round(sum('extract_sum') / sum('extract_n')) : null,
  };
}
export function titleForComparison(title: string, publishers: string[], normalize: (s: string) => string): string {
  const segments = title.split(/\s+[|–—-]\s+/);
  const known = publishers.flatMap((p) => [p, `صحيفة ${p}`]).map(normalize);
  const suffix = segments.at(-1) ?? '';
  if (segments.length > 1 && known.includes(normalize(suffix)))
    return normalize(title.slice(0, title.lastIndexOf(suffix)).replace(/\s+[|–—-]\s*$/, ''));
  return normalize(title);
}
