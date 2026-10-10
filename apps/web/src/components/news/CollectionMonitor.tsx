import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CircleOff, Cpu, Gauge } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime, fmtNum, fmtRelative } from '../../lib/format';

/** Shape of GET /news/extraction/metrics (every figure is a count over stored rows). */
export interface ExtractionMetrics {
  windowHours: number;
  flags: { enabled: boolean; shadow: boolean; dynamic: boolean };
  extractor: { ok: boolean; version?: string; dynamic_enabled?: boolean } | null;
  collection: { jobs: number; failed_jobs: number; discovered: number; saved: number; active: number; failed: number; degraded: number;
    opted_in: number; lastSuccess: string | null };
  extraction: { finished: number; complete: number; partial: number; empty: number; failed: number; duplicate: number; skipped: number;
    successRate: number | null; emptyRate: number | null; duplicateRate: number | null; dynamicRenders: number; retries: number;
    avgFetchMs: number | null; avgExtractMs: number | null };
  queue: { pending: number; retrying: number; dead: number; oldest_pending: string | null };
  shadow: { compared: number; titleMatches: number; datesOnlyFromPage: number; datesBoth: number; fullText: number; avgChars: number | null };
  sources: Array<{ id: string; name_ar: string; extraction_mode: string; engine: string; total: number; complete: number; partial: number;
    empty: number; failed: number; duplicate: number; dynamic: number; avg_fetch_ms: number | null; last_extracted_at: string | null;
    last_error: string | null; breakerOpen: boolean; successRate: number | null; health: string | null }>;
}

const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}٪`);
const MODE_LABEL: Record<string, string> = { off: 'معطّل', shadow: 'ظل (قياس فقط)', static: 'استخراج ثابت', dynamic: 'ثابت + متصفح عند الحاجة' };
// Extractor reason codes → readable Arabic; anything unknown (e.g. "HTTP 403") is shown as is.
const REASON_LABEL: Record<string, string> = {
  no_text: 'لا يوجد نص في الصفحة', too_short: 'نص قصير جدًا', title_only: 'العنوان فقط', short_text: 'نص قصير',
  unexpected_language: 'لغة غير متوقعة', robots_disallowed: 'ممنوع في robots.txt', busy: 'الخدمة مشغولة',
  source_disabled: 'المصدر معطل', expired: 'انتهت مهلة الانتظار',
};
const ENGINE_LABEL: Record<string, string> = { off: 'لا يعمل الآن', live: 'يعمل', shadow: 'قياس فقط' };

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : '';
  return <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
    <div className="text-xs muted font-medium">{label}</div>
    <div className={`text-lg font-semibold num ${color}`}>{value}</div>
    {sub && <div className="text-[11px] muted mt-0.5">{sub}</div>}
  </div>;
}

/**
 * Collection and extraction health for the news-sources page. Shows only what
 * the API counted; when the extraction engine is off it says so instead of
 * showing zeros as if they were results.
 */
export default function CollectionMonitor() {
  const [hours, setHours] = useState(24);
  const { data: m, isLoading, error } = useQuery({
    queryKey: ['news-extraction-metrics', hours],
    queryFn: () => api.get<ExtractionMetrics>(`/news/extraction/metrics?hours=${hours}`),
    refetchInterval: 60_000,
  });
  if (isLoading) return <div className="card p-5 muted text-sm">جارٍ تحميل مؤشرات الجمع…</div>;
  if (error || !m) return <div className="card p-5 text-sm text-red-600">تعذّر تحميل مؤشرات الجمع.</div>;
  const engineOn = m.flags.enabled || m.flags.shadow;
  const e = m.extraction;
  const issues = m.sources.filter((s) => s.breakerOpen || s.empty + s.failed > 0);

  return <section className="card p-5 space-y-4" aria-labelledby="collection-monitor">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="collection-monitor" className="flex items-center gap-2 font-semibold"><Activity size={18} className="text-brand-600" /> مراقبة الجمع والاستخراج</h2>
        <p className="text-xs muted mt-0.5">أرقام فعلية من سجلات الجمع خلال آخر {hours} ساعة · آخر جمع ناجح {m.collection.lastSuccess ? fmtRelative(m.collection.lastSuccess) : '—'}</p>
      </div>
      <label className="text-xs muted flex items-center gap-2">الفترة
        <select className="input !w-auto !py-1 text-xs" value={hours} onChange={(ev) => setHours(Number(ev.target.value))}>
          <option value={1}>ساعة</option><option value={24}>24 ساعة</option><option value={168}>7 أيام</option></select></label>
    </header>

    <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
      <Tile label="المصادر النشطة" value={fmtNum(m.collection.active)} sub={`${fmtNum(m.collection.degraded)} متدهورة`} />
      <Tile label="المصادر المتعطلة" value={fmtNum(m.collection.failed)} tone={m.collection.failed ? 'bad' : 'ok'} sub="3 إخفاقات متتالية أو أكثر" />
      <Tile label="روابط مكتشفة" value={fmtNum(m.collection.discovered)} sub={`${fmtNum(m.collection.jobs)} عملية جمع`} />
      <Tile label="أخبار جديدة محفوظة" value={fmtNum(m.collection.saved)} />
      <Tile label="عمليات جمع فاشلة" value={fmtNum(m.collection.failed_jobs)} tone={m.collection.failed_jobs ? 'warn' : 'ok'} />
      <Tile label="مكررات مستبعدة" value={engineOn ? fmtNum(e.duplicate) : '—'} sub={engineOn ? `من الرابط الأساسي أو النص · ${pct(e.duplicateRate)}` : 'يتطلب محرك الاستخراج'} />
    </div>

    <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Cpu size={16} className="text-brand-600" /><span className="font-medium">محرك استخراج النص (Scrapling)</span>
        <span className={`badge ${m.flags.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-[var(--surface-3)]'}`}>{m.flags.enabled ? 'مفعّل' : 'غير مفعّل'}</span>
        {m.flags.shadow && <span className="badge bg-sky-500/15 text-sky-600">وضع الظل</span>}
        <span className="badge bg-[var(--surface-3)]">المتصفح: {m.flags.dynamic ? 'مسموح' : 'غير مسموح'}</span>
        <span className={`badge ${m.extractor?.ok ? 'bg-emerald-500/15 text-emerald-600' : 'bg-red-500/15 text-red-600'}`}>
          الخدمة: {m.extractor?.ok ? 'متصلة' : 'غير متاحة'}</span>
        <span className="text-xs muted">{fmtNum(m.collection.opted_in)} مصدر مفعّل له الاستخراج</span>
      </div>
      {!engineOn ? <p className="text-xs muted flex items-center gap-1.5"><CircleOff size={14} />
        المحرك متوقف: الأخبار تُجمع من الخلاصات وخرائط المواقع كما هي دون جلب نص المقال. التفعيل عبر NEWS_SCRAPLING_ENABLED أو NEWS_SCRAPLING_SHADOW_MODE ثم اختيار وضع لكل مصدر.</p>
        : <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="نجاح الاستخراج" value={pct(e.successRate)} sub={`${fmtNum(e.complete)} كامل · ${fmtNum(e.partial)} جزئي`} tone={e.successRate !== null && e.successRate < 0.7 ? 'warn' : undefined} />
          <Tile label="محتوى فارغ" value={pct(e.emptyRate)} sub={`${fmtNum(e.empty)} صفحة`} />
          <Tile label="فشل الجلب" value={fmtNum(e.failed)} sub={`${fmtNum(e.retries)} إعادة محاولة`} tone={e.failed ? 'warn' : undefined} />
          <Tile label="تشغيل المتصفح" value={fmtNum(e.dynamicRenders)} />
          <Tile label="متوسط الجلب / الاستخراج" value={e.avgFetchMs === null ? '—' : `${fmtNum(e.avgFetchMs)} / ${fmtNum(e.avgExtractMs)}`} sub="ملّي ثانية" />
          <Tile label="قائمة الانتظار" value={fmtNum(m.queue.pending + m.queue.retrying)} sub={`${fmtNum(m.queue.dead)} للمراجعة${m.queue.oldest_pending ? ` · الأقدم ${fmtRelative(m.queue.oldest_pending)}` : ''}`}
            tone={m.queue.dead ? 'warn' : undefined} />
        </div>}
      {m.shadow.compared > 0 && <p className="text-xs muted flex items-center gap-1.5"><Gauge size={14} />
        مقارنة الظل على {fmtNum(m.shadow.compared)} خبرًا: تطابق العنوان {fmtNum(m.shadow.titleMatches)} · نص كامل {fmtNum(m.shadow.fullText)}
        · تاريخ متاح من الصفحة فقط {fmtNum(m.shadow.datesOnlyFromPage)} · متوسط طول النص {m.shadow.avgChars === null ? '—' : fmtNum(m.shadow.avgChars)} حرفًا</p>}
    </div>

    {m.sources.length > 0 && <div className="overflow-auto max-h-[22rem] rounded-lg border" style={{ borderColor: 'var(--border)' }}>
      <table className="w-full text-xs [&_th]:px-2.5 [&_td]:px-2.5 [&_th]:whitespace-nowrap [&_td.num]:whitespace-nowrap">
        <thead className="sticky top-0" style={{ background: 'var(--surface-raised)' }}><tr className="muted text-start">
          <th className="text-start py-2 font-medium">المصدر</th><th className="text-start font-medium">الوضع</th><th className="text-start font-medium">مستخرج</th>
          <th className="text-start font-medium">النجاح</th><th className="text-start font-medium">فارغ / فشل</th><th className="text-start font-medium">مكرر</th>
          <th className="text-start font-medium">متصفح</th><th className="text-start font-medium">آخر استخراج</th><th className="text-start font-medium">آخر سبب فشل</th></tr></thead>
        <tbody>{[...m.sources].sort((a, b) => Number(b.breakerOpen) - Number(a.breakerOpen) || (b.empty + b.failed) - (a.empty + a.failed) || b.total - a.total).map((s) => <tr key={s.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
          <td className="py-1.5 font-medium">{s.name_ar}{s.breakerOpen && <span className="badge bg-red-500/15 text-red-600 ms-1.5" title="أُوقف الاستخراج مؤقتًا بعد إخفاقات متتالية">موقوف مؤقتًا</span>}</td>
          <td>{MODE_LABEL[s.extraction_mode] ?? s.extraction_mode}<span className="block muted">{ENGINE_LABEL[s.engine] ?? s.engine}</span></td>
          <td className="num">{fmtNum(s.total)}</td><td className="num">{pct(s.successRate)}</td>
          <td className="num">{fmtNum(s.empty)} / {fmtNum(s.failed)}</td><td className="num">{fmtNum(s.duplicate)}</td><td className="num">{fmtNum(s.dynamic)}</td>
          <td className="whitespace-nowrap" title={s.last_extracted_at ? fmtDateTime(s.last_extracted_at) : undefined}>{s.last_extracted_at ? fmtRelative(s.last_extracted_at) : '—'}</td>
          <td className="max-w-[16rem] truncate" title={s.last_error ?? undefined}>{s.last_error ? REASON_LABEL[s.last_error] ?? s.last_error : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {engineOn && issues.length > 0 && <p className="text-xs text-amber-600 flex items-center gap-1.5"><AlertTriangle size={14} />
      {fmtNum(issues.length)} مصدر يحتاج مراجعة (فشل أو محتوى فارغ في الاستخراج).</p>}
  </section>;
}
