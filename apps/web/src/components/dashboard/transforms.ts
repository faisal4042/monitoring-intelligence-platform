/**
 * Pure data shaping for the dashboard panels. Nothing here invents a value:
 * a figure the API did not return becomes null and is shown as unavailable.
 */
import { fmtDate, fmtDateTime, fmtDayShort, fmtHourLabel, fmtNum } from '../../lib/format';
import { KPI_META, share, type Kpi } from '../../lib/dashboard';
import type { ClassData, Granularity, InsightsData, KpiData, NewsData, NewsSourceHealth, ProgramRow, SentData, SentRow, StoriesData, StoryRow, TrendData } from './types';
import type { StackCat } from './charts/options';

// ── Time buckets ───────────────────────────────────────────────────────────
export const bucketLabel = (g: Granularity, b: string) => (g === 'hour' ? fmtHourLabel(b) : fmtDayShort(b));
export const bucketTitle = (g: Granularity, b: string) => (g === 'hour' ? fmtDateTime(b) : g === 'week' ? `أسبوع يبدأ ${fmtDate(b)}` : fmtDate(b));
export const granularityText = (g: Granularity) => (g === 'hour' ? 'بالساعة' : g === 'week' ? 'أسبوعي (يبدأ الأحد)' : 'يومي');

/** A sparkline needs at least two buckets to say anything. */
const spark = (values: Array<number | null>) => (values.filter((v) => v !== null).length >= 2 ? values : undefined);

// ── Executive KPIs ─────────────────────────────────────────────────────────
export type ExecKey = 'total' | 'news' | 'issues' | 'negative_share' | 'complaints' | 'attention';
export interface ExecKpi {
  key: ExecKey; label: string; hint: string;
  value: number | null; previous: number | null;
  /** count = absolute number (change in %); share = 0..1 (change in points). */
  kind: 'count' | 'share';
  attention?: 'up' | 'down';
  spark?: Array<number | null>;
  unavailable?: string;
  sub?: string;
}
/** Minimum classified posts per bucket before a negative-share point is drawn. */
export const MIN_SENTIMENT_SAMPLE = 5;

export function negativeShare(ctx: KpiData['context'] | undefined) {
  if (!ctx || ctx.sentimentSample === undefined) return null;
  const value = share(ctx.negative ?? 0, ctx.sentimentSample);
  const previous = ctx.sentimentSamplePrev ? share(ctx.negativePrev ?? 0, ctx.sentimentSamplePrev) : null;
  return { value, previous, sample: ctx.sentimentSample };
}

export function negativeTrend(d: SentData | undefined) {
  if (!d) return null;
  return {
    labels: d.trend.map((t) => bucketLabel(d.granularity, t.bucket)),
    titles: d.trend.map((t) => bucketTitle(d.granularity, t.bucket)),
    values: d.trend.map((t) => (t.sample >= MIN_SENTIMENT_SAMPLE ? Math.round((t.negative / t.sample) * 1000) / 10 : null)),
    samples: d.trend.map((t) => t.sample),
  };
}

export function execKpis(src: {
  overview?: KpiData; trends?: TrendData; sentiments?: SentData; news?: NewsData; stories?: StoriesData; insights?: InsightsData;
  can: { news: boolean; stories: boolean };
}): ExecKpi[] {
  const kpi = (k: Kpi['key']) => src.overview?.kpis.find((x) => x.key === k);
  const series = (f: 'total' | 'complaints') => (src.trends ? spark(src.trends.items.map((i) => i[f])) : undefined);
  const total = kpi('total');
  const complaints = kpi('complaints');
  const neg = negativeShare(src.overview?.context);
  const negSpark = negativeTrend(src.sentiments)?.values;
  const warnings = src.insights?.items.filter((i) => i.severity === 'warning').length ?? 0;
  return [
    { key: 'total', label: 'التفاعلات المرصودة', hint: KPI_META.total.hint, kind: 'count',
      value: total?.available ? total.value : null, previous: total?.previous ?? null, spark: series('total'), unavailable: total && !total.available ? total.reason : undefined },
    { key: 'news', label: 'الأخبار المجمعة', hint: 'أخبار المصادر المرصودة في الفترة حسب تاريخ النشر (أو الاكتشاف إن لم يتوفر). منفصلة عن منشورات إكس.', kind: 'count',
      value: src.news?.total ?? null, previous: src.news?.totalPrevious ?? null,
      sub: src.news ? `${fmtNum(src.news.relevant)} ذات صلة` : undefined,
      unavailable: src.can.news ? undefined : 'يتطلب صلاحية عرض الأخبار' },
    { key: 'issues', label: 'القضايا النشطة', hint: 'قصص معتمدة (مصدران مستقلان على الأقل) ظهر لها نشاط خلال الفترة.', kind: 'count',
      value: src.stories?.active ?? null, previous: src.stories?.activePrevious ?? null,
      sub: src.stories ? `${fmtNum(src.stories.created)} جديدة في الفترة` : undefined,
      unavailable: src.can.stories ? undefined : 'يتطلب صلاحية عرض المواضيع والقصص' },
    { key: 'negative_share', label: 'نسبة المشاعر السلبية', kind: 'share', attention: 'up',
      hint: `المنشورات ذات الصلة المصنفة «سلبي» مقسومة على المنشورات ذات الصلة المصنفة المشاعر فقط (غير المصنف لا يدخل في النسبة). التغير بالنقاط المئوية.`,
      value: neg?.value ?? null, previous: neg?.previous ?? null, spark: negSpark && spark(negSpark),
      sub: neg ? (neg.sample ? `من ${fmtNum(neg.sample)} منشورًا مصنفًا` : 'لا توجد منشورات مصنفة المشاعر') : undefined },
    { key: 'complaints', label: 'الشكاوى', hint: KPI_META.complaints.hint, kind: 'count', attention: 'up',
      value: complaints?.available ? complaints.value : null, previous: complaints?.previous ?? null, spark: series('complaints') },
    { key: 'attention', label: 'إشارات تستحق الانتباه', kind: 'count',
      hint: 'تغيرات تجاوزت حدود قواعد ثابتة قابلة للتفسير (مثل ارتفاع الشكاوى أو تأخر الطابور). ليست تنبيهات الطابور.',
      value: src.insights ? src.insights.items.length : null, previous: null,
      sub: src.insights ? (warnings ? `${warnings} تحذير` : 'لا تحذيرات') : undefined },
  ];
}

// ── Programs ───────────────────────────────────────────────────────────────
export const PROGRAM_LIMIT = 8;
export function rankPrograms(items: ProgramRow[]) {
  const active = items.filter((p) => p.posts > 0 || p.stories > 0);
  return [...active].sort((a, b) => b.relevant - a.relevant || b.posts - a.posts);
}

// ── Sentiment ──────────────────────────────────────────────────────────────
export const SENTIMENT_KEYS = ['positive', 'neutral', 'negative'] as const;
/** Categories (programs or topics) for the 100% stacked chart, largest sample first. */
export function sentimentCats(rows: SentRow[], limit = PROGRAM_LIMIT): StackCat[] {
  const byId = new Map<string, StackCat>();
  for (const r of rows) {
    if (!(SENTIMENT_KEYS as readonly string[]).includes(r.g)) continue;
    const cat = byId.get(r.id) ?? { name: r.name_ar, counts: {}, total: 0 };
    cat.counts[r.g] = (cat.counts[r.g] ?? 0) + r.n;
    cat.total += r.n;
    byId.set(r.id, cat);
  }
  return [...byId.values()].filter((c) => c.total > 0).sort((a, b) => b.total - a.total).slice(0, limit);
}

// ── Issues ─────────────────────────────────────────────────────────────────
export const ISSUE_LIMIT = 5;
/** Most voluminous active issues first; the state (new/rising/…) is the API's own. */
export const topIssues = (items: StoryRow[]) => [...items].sort((a, b) => b.post_count - a.post_count || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at)).slice(0, ISSUE_LIMIT);

// ── Classifications ────────────────────────────────────────────────────────
export function topicGrowth(d: ClassData | undefined) {
  return (d?.topics ?? []).filter((t) => t.previous !== null && t.count >= 3 && t.count > (t.previous ?? 0))
    .sort((a, b) => (b.count - (b.previous ?? 0)) - (a.count - (a.previous ?? 0))).slice(0, 5);
}

// ── Operational health ─────────────────────────────────────────────────────
export function newsSourceHealth(rows: NewsSourceHealth[] | undefined) {
  if (!rows) return null;
  const active = rows.filter((r) => r.is_active);
  const lastChecked = active.reduce<string | null>((m, r) => (r.last_checked_at && (!m || Date.parse(r.last_checked_at) > Date.parse(m)) ? r.last_checked_at : m), null);
  return {
    active: active.length,
    healthy: active.filter((r) => r.health_state === 'healthy').length,
    degraded: active.filter((r) => r.health_state === 'degraded').length,
    failed: active.filter((r) => r.health_state === 'failed').length,
    lastChecked,
  };
}
