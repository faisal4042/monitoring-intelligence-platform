/**
 * Unified dashboard: URL state, API types, labels and the default layout.
 * The URL is the source of truth for filters (/dashboard?program=ejar&period=7d),
 * so links, reload and the back button all reproduce the same view.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const PERIODS = [
  { key: 'today', label: 'اليوم' }, { key: 'yesterday', label: 'أمس' }, { key: '7d', label: 'آخر 7 أيام' },
  { key: '30d', label: 'آخر 30 يومًا' }, { key: '90d', label: 'آخر 90 يومًا' }, { key: 'custom', label: 'فترة مخصصة' },
] as const;
export type PeriodKey = typeof PERIODS[number]['key'];
export const ADVANCED_KEYS = ['intent', 'sentiment', 'topicId', 'postType', 'influencersOnly', 'relevantOnly'] as const;

export const SECTION_IDS = ['kpis', 'insights', 'trend', 'programs', 'classifications', 'sentiment', 'hashtags', 'influencers', 'stories', 'news', 'operations', 'ai_quality'] as const;
export type SectionId = typeof SECTION_IDS[number];
export const SECTION_LABELS: Record<SectionId, string> = {
  insights: 'مؤشرات تستحق الانتباه', kpis: 'مؤشرات الأداء الرئيسية', trend: 'اتجاه التفاعلات', programs: 'تحليل البرامج',
  classifications: 'التصنيفات وأنواع التفاعلات', sentiment: 'تحليل المشاعر', hashtags: 'الهاشتاقات', influencers: 'المؤثرون',
  stories: 'القصص', news: 'الأخبار', operations: 'أداء فريق الرصد', ai_quality: 'جودة تصنيفات الذكاء الاصطناعي',
};
export const KPI_KEYS = ['total', 'relevant', 'excluded', 'inquiries', 'complaints', 'active_influencers', 'approved_stories', 'unique_hashtags'] as const;
export type KpiKey = typeof KPI_KEYS[number];
/** `up` says which direction needs attention; neutral metrics colour no direction. */
export const KPI_META: Record<KpiKey, { label: string; hint: string; attention?: 'up' | 'down' }> = {
  total: { label: 'إجمالي المنشورات المجمعة', hint: 'كل منشورات X المجمعة في الفترة (دون المكرر والمحجوب)، حسب تاريخ النشر' },
  relevant: { label: 'المنشورات ذات الصلة', hint: 'المنشورات المصنفة ذات صلة بالبرنامج (التصنيف الفعّال)' },
  excluded: { label: 'المنشورات المستبعدة', hint: 'استبعدها الفلتر المسبق أو صُنفت غير ذات صلة / إعلان / مزعج' },
  inquiries: { label: 'الاستفسارات', hint: 'منشورات ذات صلة نوعها الفعّال «استفسار»' },
  complaints: { label: 'الشكاوى', hint: 'منشورات ذات صلة نوعها الفعّال «شكوى»', attention: 'up' },
  active_influencers: { label: 'المؤثرون النشطون', hint: 'حسابات متابَعة ظهر لها منشور في الفترة (كل حساب مرة واحدة)' },
  approved_stories: { label: 'القصص المعتمدة', hint: 'قصص معتمدة (مصدران مستقلان على الأقل) لها نشاط في الفترة' },
  unique_hashtags: { label: 'الهاشتاقات الفريدة', hint: 'هاشتاقات مختلفة بعد التطبيع في المنشورات ذات الصلة' },
};
export const TREND_SERIES = ['total', 'relevant', 'complaints', 'inquiries'] as const;
export type TrendSeries = typeof TREND_SERIES[number];
export const TREND_LABELS: Record<TrendSeries, string> = { total: 'كل المنشورات', relevant: 'ذات الصلة', complaints: 'الشكاوى', inquiries: 'الاستفسارات' };

export interface Layout {
  sections: Array<{ id: SectionId; visible: boolean; collapsed?: boolean }>;
  kpis: KpiKey[];
  trendSeries?: TrendSeries[];
  favorites?: SectionId[];
  defaultPeriod?: 'today' | 'yesterday' | '7d' | '30d' | '90d';
  defaultProgram?: string | null;
}
export const DEFAULT_LAYOUT: Layout = {
  sections: SECTION_IDS.map((id) => ({ id, visible: true })),
  kpis: ['total', 'relevant', 'complaints', 'inquiries', 'active_influencers', 'approved_stories'],
  trendSeries: ['relevant', 'complaints', 'inquiries'],
};
/** Fills in sections added after a layout was saved, so a new section is never lost. */
export function normalizeLayout(saved?: Layout | null): Layout {
  if (!saved) return DEFAULT_LAYOUT;
  const known = saved.sections.filter((s) => (SECTION_IDS as readonly string[]).includes(s.id));
  const missing = SECTION_IDS.filter((id) => !known.some((s) => s.id === id)).map((id) => ({ id, visible: true }));
  return { ...DEFAULT_LAYOUT, ...saved, sections: [...known, ...missing] };
}

// ── API types ───────────────────────────────────────────────────────────────
export interface Window { from: string; to: string }
export interface Meta { range: { preset: string; fromDate: string | null; toDate: string | null }; current: Window; previous: Window | null;
  program: { id: string; key: string; name_ar: string; color: string | null } | null; generatedAt: string }
export interface DashboardMeta {
  programs: Array<{ id: string; key: string; name_ar: string; color: string | null }>;
  capabilities: { influencers: boolean; stories: boolean; news: boolean; queue: boolean; queueScope: 'own' | 'team' | 'all' | null };
  serverNow: string;
}
export interface Kpi { key: KpiKey; value: number | null; previous: number | null; available: boolean; reason?: string }

// ── URL state ───────────────────────────────────────────────────────────────
export function useDashboardFilters() {
  const [params, setParams] = useSearchParams();
  const program = params.get('program') || null;
  const period = (PERIODS.some((p) => p.key === params.get('period')) ? params.get('period') : null) as PeriodKey | null;
  const set = useCallback((patch: Record<string, string | null>, replace = false) => setParams((old) => {
    const next = new URLSearchParams(old);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace }), [setParams]);
  const advanced = Object.fromEntries(ADVANCED_KEYS.map((k) => [k, params.get(k)]).filter(([, v]) => v)) as Partial<Record<typeof ADVANCED_KEYS[number], string>>;
  return { params, program, period, from: params.get('from'), to: params.get('to'), advanced, set };
}

/** The API query for the current filters (period → range, custom → from/to). */
export function apiQuery(f: { program: string | null; period: PeriodKey; from: string | null; to: string | null; advanced: Record<string, string> }) {
  const q = new URLSearchParams();
  if (f.program) q.set('program', f.program);
  if (f.period === 'custom') { if (f.from) q.set('from', f.from); if (f.to) q.set('to', f.to); }
  else q.set('range', f.period);
  for (const [k, v] of Object.entries(f.advanced)) if (v) q.set(k, v);
  return q.toString();
}

/**
 * One section's data. The key carries every filter, so a program switch never
 * shows the previous program's figures; within the same filters a background
 * refresh keeps the last result on screen. Requests are cancelled when the
 * filters change, paused while the tab is hidden, and refreshed every 2 minutes.
 */
export function useSection<T>(section: string, qs: string, opts: { enabled?: boolean; fresh?: React.MutableRefObject<boolean> } = {}) {
  return useQuery<T & Meta>({
    queryKey: ['dashboard', section, qs],
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === qs ? prev : undefined),
    queryFn: ({ signal }) => api.get<T & Meta>(`/dashboard/${section}?${qs}${opts.fresh?.current ? '&fresh=1' : ''}`, signal),
  });
}

/** Manual refresh flag: the next fetch of every section bypasses the short server cache. */
export function useFreshFlag() {
  const ref = useRef(false);
  return useMemo(() => ({ ref, arm: () => { ref.current = true; setTimeout(() => { ref.current = false; }, 4000); } }), []);
}

// ── Formatting helpers ─────────────────────────────────────────────────────
export interface Change { kind: 'none' | 'new' | 'same' | 'up' | 'down'; pct: number | null; diff: number }
/** Change vs the previous period; no percentage when the base is zero. */
export function change(value: number | null, previous: number | null): Change | null {
  if (value === null || previous === null) return null;
  const diff = value - previous;
  if (previous === 0) return { kind: value === 0 ? 'same' : 'new', pct: null, diff };
  if (diff === 0) return { kind: 'same', pct: 0, diff };
  return { kind: diff > 0 ? 'up' : 'down', pct: Math.round((diff / previous) * 1000) / 10, diff };
}
export const share = (n: number, d: number) => (d > 0 ? n / d : null);

export const INTENT_LABELS: Record<string, string> = { complaint: 'شكوى', inquiry: 'استفسار', suggestion: 'اقتراح', praise: 'إشادة', news: 'خبر',
  experience: 'تجربة', warning: 'تحذير', issue: 'مشكلة', request: 'طلب', other: 'أخرى' };
export const SENTIMENT_GROUP_LABELS: Record<string, string> = { positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي', unclassified: 'غير مصنف' };
export const AI_FIELD_LABELS: Record<string, string> = { program: 'البرنامج', intent: 'نوع التفاعل', topic: 'التصنيف الرئيسي', subtopic: 'التصنيف الفرعي', sentiment: 'المشاعر' };
export const SENTIMENT_LABELS: Record<string, string> = { very_positive: 'إيجابي جداً', positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي', very_negative: 'سلبي جداً' };
export const STORY_STATE_LABELS: Record<string, string> = { new: 'جديدة', rising: 'متصاعدة', steady: 'مستقرة', fading: 'تخفت' };
