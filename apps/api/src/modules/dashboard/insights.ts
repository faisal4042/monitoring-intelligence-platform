/**
 * "Worth attention": explainable rules over the same figures the dashboard
 * shows. No model, no inference — each insight names its numbers and the
 * rule that fired, and every rule has a minimum sample so small counts never
 * raise an alarm. Separate from the queue's sound/visual alerts.
 */
import { analyticsSql as sql } from '@mip/db';
import type { QueueActor } from '../../lib/authz.js';
import { cached, interactions } from './base.js';
import type { Filters, Window } from './filters.js';
import { hashtags, overview } from './monitoring.js';
import { aiQuality, operations } from './operations.js';

export const RULES = {
  complaints: { minCurrent: 10, minPrevious: 5, minChangePct: 20 },
  negativeShare: { minSample: 30, minPointRise: 5 },
  hashtag: { minCurrent: 5, minPrevious: 2, minGrowthPct: 50, minNew: 8 },
  influencer: { minCurrent: 5, minGrowthPct: 100 },
  aiAgreement: { minSample: 20, minPointDrop: 10 },
} as const;

export interface Insight { key: string; severity: 'warning' | 'info'; title: string; detail: string; rule: string; drill?: Record<string, string> }
const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100);
const share = (n: number, d: number) => (d ? (n / d) * 100 : 0);

async function influencerActivity(f: Filters, w: Window) {
  return sql<{ id: string; username: string; posts: number }[]>`SELECT ti.id,ti.username,count(*)::int AS posts
    FROM ${interactions(f, w)} JOIN authors a ON a.id=b.author_id
    JOIN tracked_influencers ti ON lower(ti.username)=lower(a.username) AND ti.is_active GROUP BY 1,2`;
}

export async function insights(f: Filters, actor: QueueActor, can: { influencers: boolean; queue: boolean }) {
  const out: Insight[] = [];
  if (!f.previous) return { items: out, rules: RULES, comparable: false };
  // Same cache entries as the overview and hashtag sections, so a dashboard load computes them once.
  const [ov, tags] = await Promise.all([
    cached(`overview:${can.influencers}:false`, f, () => overview(f, { influencers: can.influencers, stories: false })),
    cached('hashtags', f, () => hashtags(f), 120_000)]);
  const kpi = (key: string) => ov.kpis.find((k) => k.key === key)!;

  const c = kpi('complaints'), R = RULES.complaints;
  if (c.value! >= R.minCurrent && c.previous! >= R.minPrevious && pct(c.value!, c.previous!) >= R.minChangePct)
    out.push({ key: 'complaints_rise', severity: 'warning', title: `ارتفعت الشكاوى بنسبة ${pct(c.value!, c.previous!)}٪`,
      detail: `${c.value} شكوى مقابل ${c.previous} في الفترة السابقة المساوية.`,
      rule: `ارتفاع ${R.minChangePct}٪ فأكثر مع ${R.minCurrent} شكاوى على الأقل حاليًا و${R.minPrevious} سابقًا`, drill: { series: 'complaints' } });

  const { negative, sentimentSample, negativePrev, sentimentSamplePrev } = ov.context, N = RULES.negativeShare;
  if (sentimentSample >= N.minSample && (sentimentSamplePrev ?? 0) >= N.minSample) {
    const now = share(negative, sentimentSample), before = share(negativePrev ?? 0, sentimentSamplePrev!);
    if (now - before >= N.minPointRise)
      out.push({ key: 'negative_share_rise', severity: 'warning', title: `زادت نسبة المشاعر السلبية ${Math.round(now - before)} نقاط`,
        detail: `${Math.round(now)}٪ من ${sentimentSample} منشورًا مصنف المشاعر، مقابل ${Math.round(before)}٪ من ${sentimentSamplePrev}.`,
        rule: `زيادة ${N.minPointRise} نقاط فأكثر وعينة ${N.minSample} منشورًا على الأقل في كل فترة`, drill: { series: 'negative' } });
  }

  const H = RULES.hashtag;
  for (const t of tags.top) {
    if (t.previous === null) continue;
    if (t.previous >= H.minPrevious && t.posts >= H.minCurrent && pct(t.posts, t.previous) >= H.minGrowthPct)
      out.push({ key: `hashtag_growth:${t.key}`, severity: 'info', title: `نما استخدام #${t.tag} بنسبة ${pct(t.posts, t.previous)}٪`,
        detail: `${t.posts} منشورًا مقابل ${t.previous} سابقًا.`, rule: `نمو ${H.minGrowthPct}٪ فأكثر مع ${H.minCurrent} منشورات على الأقل`, drill: { hashtag: t.key } });
    else if (t.previous === 0 && t.posts >= H.minNew)
      out.push({ key: `hashtag_new:${t.key}`, severity: 'info', title: `هاشتاق جديد نشط: #${t.tag}`,
        detail: `${t.posts} منشورًا ولم يظهر في الفترة السابقة.`, rule: `لم يُستخدم سابقًا و${H.minNew} منشورات على الأقل حاليًا`, drill: { hashtag: t.key } });
  }

  if (can.influencers) {
    const I = RULES.influencer;
    const [cur, prev] = await Promise.all([influencerActivity(f, f.current), influencerActivity(f, f.previous)]);
    for (const a of cur) {
      const before = prev.find((p) => p.id === a.id)?.posts ?? 0;
      if (a.posts >= I.minCurrent && (before === 0 || pct(a.posts, before) >= I.minGrowthPct))
        out.push({ key: `influencer_rise:${a.id}`, severity: 'info', title: `ارتفع نشاط @${a.username}`,
          detail: `${a.posts} منشورًا مقابل ${before} في الفترة السابقة.`, rule: `${I.minCurrent} منشورات على الأقل وتضاعف النشاط أو ظهور جديد`, drill: { influencerId: a.id } });
    }
  }

  if (can.queue) {
    const [ops, ai] = await Promise.all([operations(actor, f), aiQuality(actor, f)]);
    if (ops.snapshot.overdue > 0)
      out.push({ key: 'queue_overdue', severity: 'warning', title: `${ops.snapshot.overdue} عناصر تجاوزت حد الانتظار`,
        detail: `عناصر مسندة أو قيد المراجعة منذ أكثر من ${ops.warnMinutes} دقيقة (الحالة الآن).`, rule: `حد الانتظار المضبوط في الإعدادات: ${ops.warnMinutes} دقيقة` });
    const A = RULES.aiAgreement;
    if (ai.overall && ai.overallPrevious && ai.overall.sample >= A.minSample && ai.overallPrevious.sample >= A.minSample
      && ai.overallPrevious.rate! - ai.overall.rate! >= A.minPointDrop)
      out.push({ key: 'ai_agreement_drop', severity: 'warning', title: `انخفضت نسبة الاتفاق مع المراجعة البشرية ${Math.round(ai.overallPrevious.rate! - ai.overall.rate!)} نقاط`,
        detail: `${ai.overall.rate}٪ (عينة ${ai.overall.sample}) مقابل ${ai.overallPrevious.rate}٪ (عينة ${ai.overallPrevious.sample}).`,
        rule: `انخفاض ${A.minPointDrop} نقاط فأكثر وعينة ${A.minSample} مقارنة على الأقل في كل فترة` });
  }
  return { items: out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1)), rules: RULES, comparable: true };
}
