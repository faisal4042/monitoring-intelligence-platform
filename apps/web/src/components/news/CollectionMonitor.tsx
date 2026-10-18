import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime, fmtNum, fmtRelative } from '../../lib/format';

interface Summary {
  total: number; pending: number; running: number; complete: number; partial: number; empty: number; failed: number;
  duplicate: number; skipped: number; successRate: number | null; titleCompleteness: number | null;
  dateCompleteness: number | null; bodyCompleteness: number | null; qualityDenominator: number;
  avgFetchMs: number | null; avgExtractMs: number | null; retries: number; dynamicRenders: number;
}
export interface ExtractionMetrics {
  windowHours: number;
  flags: { enabled: boolean; shadow: boolean; dynamic: boolean };
  extractor: { ok: boolean } | null;
  collection: { active: number; failed: number; degraded: number; discovered: number; saved: number; jobs: number; failed_jobs: number; lastSuccess: string | null };
  extraction: Summary & { modes: Record<'shadow' | 'live', Summary> };
  queue: { modes: Partial<Record<'shadow' | 'live', { pending: number; running: number; retrying: number; dead: number }>> };
  shadow: { compared: number; titleMatches: number; datesOnlyFromPage: number; fullText: number; avgChars: number | null };
  sources: Array<{
    id: string; name_ar: string; mode: 'shadow' | 'live'; engine: string; total: number; pending: number; running: number;
    complete: number; partial: number; empty: number; failed: number; duplicate: number; skipped: number;
    successRate: number | null; titleCompleteness: number | null; dateCompleteness: number | null; bodyCompleteness: number | null;
    last_extracted_at: string | null; last_accepted_at: string | null; last_error: string | null; last_error_at: string | null;
    errorRecovered: boolean; breakerOpen: boolean;
  }>;
}
const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}٪`;
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
    <div className="text-xs muted">{label}</div><div className="text-lg font-semibold num">{value}</div>
    {sub && <div className="text-[11px] muted">{sub}</div>}
  </div>;
}
const statuses = [['pending', 'منتظر'], ['running', 'جارٍ'], ['complete', 'كامل'], ['partial', 'جزئي'],
  ['empty', 'فارغ'], ['failed', 'فاشل'], ['duplicate', 'مكرر'], ['skipped', 'متخطى']] as const;
const reasons: Record<string, string> = { no_text: 'لم يُستخرج متن', too_short: 'المتن أقصر من الحد', unexpected_language: 'لغة غير متوقعة', expired: 'انتهت مهلة الانتظار' };

/** Presentational view can be rendered against fixtures without contacting the API. */
export function MonitorView({ m, mode }: { m: ExtractionMetrics; mode: 'shadow' | 'live' }) {
  const e = m.extraction.modes[mode];
  const q = m.queue.modes[mode];
  const sources = m.sources.filter((s) => s.mode === mode);
  return <div className="space-y-4">
    <p className="text-xs muted">السجلات في آخر {m.windowHours} ساعة بحسب آخر تحديث، وليست سجلًا لكل طلب. حالة المصادر والإيقاف لحظية.
      آخر جمع ناجح في الفترة: {m.collection.lastSuccess ? fmtRelative(m.collection.lastSuccess) : '—'}</p>
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-2.5">
      <Tile label="المصادر النشطة الآن" value={fmtNum(m.collection.active)} sub={`${fmtNum(m.collection.degraded)} متدهورة · ${fmtNum(m.collection.failed)} متعطلة`} />
      <Tile label="روابط مكتشفة" value={fmtNum(m.collection.discovered)} />
      <Tile label="أخبار جديدة محفوظة" value={fmtNum(m.collection.saved)} />
      <Tile label="عمليات الجمع" value={fmtNum(m.collection.jobs)} sub={`${fmtNum(m.collection.failed_jobs)} فاشلة`} />
      <Tile label="خدمة Scrapling" value={m.extractor?.ok ? 'متصلة' : 'غير متاحة'} sub="الجمع الأساسي مستقل عن خدمة الاستخراج" />
      <Tile label="إعدادات التشغيل الحالية" value={m.flags.shadow ? 'Shadow' : m.flags.enabled ? 'Live' : 'معطّل'} sub={`Live: ${m.flags.enabled ? 'مفعّل' : 'معطّل'} · المتصفح: ${m.flags.dynamic ? 'مسموح' : 'معطّل'}`} />
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
      <Tile label="سجلات الاستخراج" value={fmtNum(e.total)} />
      <Tile label="نسبة قبول المتن" value={pct(e.successRate)} sub="كامل + جزئي ÷ النتائج المنتهية؛ يستبعد الانتظار والتكرار والتخطي" />
      <Tile label="متوسط الجلب / الاستخراج" value={`${e.avgFetchMs === null ? '—' : fmtNum(e.avgFetchMs)} / ${e.avgExtractMs === null ? '—' : fmtNum(e.avgExtractMs)}`} sub="ملّي ثانية؛ لكل حقل عيناته غير الخالية" />
      <Tile label="مهام الانتظار في الفترة" value={fmtNum((q?.pending ?? 0) + (q?.running ?? 0) + (q?.retrying ?? 0))} sub={`${fmtNum(q?.dead ?? 0)} منتهية بلا نجاح`} />
      <Tile label="اكتمال العنوان" value={pct(e.titleCompleteness)} sub={`توفر الحقل في ${fmtNum(e.qualityDenominator)} نتيجة؛ ليس تقييمًا لدقته`} />
      <Tile label="اكتمال التاريخ" value={pct(e.dateCompleteness)} sub="تاريخ نتيجة الاستخراج، لا تاريخ الخبر الأصلي" />
      <Tile label="اكتمال المتن" value={pct(e.bodyCompleteness)} sub="وجود متن محفوظ؛ قد يكون من محاولة سابقة" />
      <Tile label="إعادات المحاولة / المتصفح" value={`${fmtNum(e.retries)} / ${fmtNum(e.dynamicRenders)}`} sub="عدادات السجلات؛ ليست عدد الطلبات الشبكية" />
    </div>
    <div className="flex flex-wrap gap-3 text-xs">{statuses.map(([key, label]) => <span key={key}>{label}: <b className="num">{fmtNum(e[key])}</b></span>)}</div>
    <p className="text-xs muted">التكرار المسجل لا يعني حذف الخبر؛ فحص التكرار يعمل في Live فقط. «فاشل» يشمل dead.</p>
    {sources.length > 0 && <div className="overflow-auto max-h-[24rem] border rounded-lg" style={{ borderColor: 'var(--border)' }}>
      <table className="w-full text-xs [&_th]:p-2 [&_td]:p-2 [&_th]:whitespace-nowrap">
        <thead><tr><th>المصدر</th><th>الوضع</th><th>سجلات الاستخراج</th><th>نسبة قبول المتن</th>
          {statuses.map(([key, label]) => <th key={key}>{label}</th>)}
          <th>اكتمال العنوان / التاريخ / المتن</th><th>آخر نتيجة منتهية</th><th>آخر متن مقبول</th><th>آخر إخفاق في الفترة</th></tr></thead>
        <tbody>{sources.map((s) => <tr key={`${s.id}:${s.mode}`} className="border-t" style={{ borderColor: 'var(--border)' }}>
          <td className="font-medium whitespace-nowrap">{s.name_ar}{s.breakerOpen && <span className="badge text-red-600 ms-2">الاستخراج موقوف مؤقتًا</span>}</td>
          <td>{s.mode}<span className="block muted">{s.engine === 'off' ? 'معطل الآن' : s.engine === s.mode ? 'الوضع الحالي' : 'سجلات وضع سابق'}</span></td>
          <td>{fmtNum(s.total)}</td><td>{pct(s.successRate)}</td>
          {statuses.map(([key]) => <td key={key} className="num">{fmtNum(s[key])}</td>)}
          <td className="whitespace-nowrap">{pct(s.titleCompleteness)} / {pct(s.dateCompleteness)} / {pct(s.bodyCompleteness)}</td>
          <td>{s.last_extracted_at ? fmtDateTime(s.last_extracted_at) : '—'}</td>
          <td>{s.last_accepted_at ? fmtDateTime(s.last_accepted_at) : '—'}</td>
          <td>{s.last_error ? reasons[s.last_error] ?? s.last_error : '—'}
            {s.last_error_at && <span className="block muted">{fmtDateTime(s.last_error_at)}{s.errorRecovered ? ' · تلاه متن مقبول' : ''}</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {mode === 'shadow' && m.shadow.compared > 0 && <p className="text-xs muted">مقارنة Shadow: {fmtNum(m.shadow.compared)} خبرًا · تطابق العنوان بعد إزالة لاحقة الناشر المعروفة: {fmtNum(m.shadow.titleMatches)} · نص كامل: {fmtNum(m.shadow.fullText)}</p>}
  </div>;
}
export default function CollectionMonitor() {
  const [hours, setHours] = useState(24);
  const [mode, setMode] = useState<'shadow' | 'live'>('shadow');
  const { data, isLoading, error } = useQuery({ queryKey: ['news-extraction-metrics', hours],
    queryFn: () => api.get<ExtractionMetrics>(`/news/extraction/metrics?hours=${hours}`), refetchInterval: 60_000 });
  if (isLoading) return <div className="card p-5">جارٍ تحميل المؤشرات…</div>;
  if (error || !data)
    return <div className="card p-5 text-red-600">تعذر تحميل مؤشرات الجمع.</div>;
  if (!data.extraction?.modes || !data.queue?.modes)
    return <div className="card p-5 space-y-2" role="status">
      <h2 className="font-semibold">مراقبة الجمع والاستخراج</h2>
      <p className="text-sm text-amber-600">نسخة API المتصلة لا تدعم مؤشرات المراقبة الجديدة بعد.</p>
      <p className="text-xs muted">يلزم تحديث جلسة API المحلية لعرض فصل Shadow وLive والمؤشرات المصححة. هذه الرسالة لا تعني فشل جمع الأخبار.</p>
    </div>;
  return <section className="card p-5 space-y-4" aria-labelledby="collection-monitor">
    <header className="flex flex-wrap justify-between gap-3">
      <h2 id="collection-monitor" className="flex items-center gap-2 font-semibold"><Activity size={18} />مراقبة الجمع والاستخراج</h2>
      <div className="flex gap-3 text-xs">
        <label>الفترة <select className="input !w-auto" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
          <option value={1}>ساعة</option><option value={24}>24 ساعة</option><option value={168}>7 أيام</option></select></label>
        <label>سجلات الوضع <select className="input !w-auto" value={mode} onChange={(event) => setMode(event.target.value as 'shadow' | 'live')}>
          <option value="shadow">Shadow</option><option value="live">Live</option></select></label>
      </div>
    </header>
    <MonitorView m={data} mode={mode} />
  </section>;
}
