import { useState } from 'react';
import { RefreshCw, SlidersHorizontal, LayoutGrid, X } from 'lucide-react';
import { ADVANCED_KEYS, INTENT_LABELS, PERIODS, SENTIMENT_GROUP_LABELS, type DashboardMeta, type PeriodKey } from '../../lib/dashboard';
import { fmtDate, fmtDateTime, fmtRelative } from '../../lib/format';

interface Props {
  meta?: DashboardMeta; program: string | null; period: PeriodKey; from: string | null; to: string | null;
  advanced: Record<string, string>; topics: Array<{ id: string; name: string }>;
  set: (patch: Record<string, string | null>, replace?: boolean) => void;
  resolved?: { fromDate: string | null; toDate: string | null; previous: { from: string; to: string } | null };
  updatedAt: number; refreshing: boolean; onRefresh: () => void; onCustomize: () => void;
}

/** A Riyadh calendar day (YYYY-MM-DD), shown as a date — noon avoids any edge of the day. */
const day = (d: string) => fmtDate(`${d}T12:00:00+03:00`);

export default function FiltersBar(p: Props) {
  const [open, setOpen] = useState(() => Object.keys(p.advanced).length > 0);
  const active = Object.keys(p.advanced).length;
  return <div className="dash-filters card" role="search" aria-label="فلاتر اللوحة">
    <div className="dash-filters-row">
      {/* Chips while the list is short; a dropdown once there are many programs. */}
      {(p.meta?.programs.length ?? 0) <= 6 ? <div className="dash-chips" role="radiogroup" aria-label="البرنامج">
        <button role="radio" aria-checked={!p.program} className="dash-chip" onClick={() => p.set({ program: null, topicId: null })}>جميع البرامج</button>
        {p.meta?.programs.map((pr) => <button key={pr.id} role="radio" aria-checked={p.program === pr.key} className="dash-chip"
          onClick={() => p.set({ program: pr.key, topicId: null })}>
          <span className="dash-dot" style={{ background: pr.color ?? 'var(--color-brand-500)' }} aria-hidden="true" />{pr.name_ar}</button>)}
      </div> : <label className="dash-inline-field font-semibold">البرنامج
        <select className="input" aria-label="البرنامج" value={p.program ?? ''} onChange={(e) => p.set({ program: e.target.value || null, topicId: null })}>
          <option value="">جميع البرامج</option>{p.meta?.programs.map((pr) => <option key={pr.id} value={pr.key}>{pr.name_ar}</option>)}</select></label>}
      <div className="dash-filters-actions">
        <span className="text-xs muted" aria-live="polite" title={p.updatedAt ? fmtDateTime(new Date(p.updatedAt)) : undefined}>
          {p.updatedAt ? `آخر تحديث ${fmtRelative(new Date(p.updatedAt).toISOString())}` : 'جارٍ التحميل…'}</span>
        <button className="icon-button" onClick={p.onRefresh} disabled={p.refreshing} aria-label="تحديث البيانات" title="تحديث البيانات">
          <RefreshCw size={16} className={p.refreshing ? 'animate-spin' : ''} /></button>
        <button className="btn-ghost" onClick={p.onCustomize}><LayoutGrid size={16} />تخصيص اللوحة</button>
      </div>
    </div>
    <div className="dash-filters-row">
      <div className="dash-chips" role="radiogroup" aria-label="الفترة الزمنية">
        {PERIODS.map((x) => <button key={x.key} role="radio" aria-checked={p.period === x.key} className="dash-chip dash-chip--sm"
          onClick={() => p.set(x.key === 'custom' ? { period: 'custom', from: p.resolved?.fromDate ?? null, to: p.resolved?.toDate ?? null } : { period: x.key, from: null, to: null })}>{x.label}</button>)}
      </div>
      {p.period === 'custom' && <div className="flex items-center gap-2 flex-wrap">
        <label className="dash-inline-field">من<input type="date" className="input" value={p.from ?? ''} max={p.to ?? undefined} onChange={(e) => p.set({ from: e.target.value || null })} /></label>
        <label className="dash-inline-field">إلى<input type="date" className="input" value={p.to ?? ''} min={p.from ?? undefined} onChange={(e) => p.set({ to: e.target.value || null })} /></label>
      </div>}
      <button className={active ? 'btn-primary' : 'btn-ghost'} aria-expanded={open} aria-controls="dash-advanced" onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontal size={15} />فلاتر متقدمة{active ? ` (${active})` : ''}</button>
    </div>
    {p.resolved && <p className="dash-basis">
      الفترة: {p.resolved.fromDate ? day(p.resolved.fromDate) : 'منذ البداية'} — {p.resolved.toDate ? day(p.resolved.toDate) : 'الآن'} بتوقيت الرياض
      {p.resolved.previous ? ` · المقارنة بالمدة المساوية السابقة (${fmtDate(p.resolved.previous.from)} — ${fmtDate(new Date(Date.parse(p.resolved.previous.to) - 1).toISOString())})` : ' · لا توجد فترة مقارنة'}
    </p>}
    {open && <div id="dash-advanced" className="dash-advanced">
      <label className="queue-field">نوع التفاعل<select className="input" value={p.advanced.intent ?? ''} onChange={(e) => p.set({ intent: e.target.value || null })}>
        <option value="">كل الأنواع</option>{Object.entries(INTENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="queue-field">المشاعر<select className="input" value={p.advanced.sentiment ?? ''} onChange={(e) => p.set({ sentiment: e.target.value || null })}>
        <option value="">كل المشاعر</option>{Object.entries(SENTIMENT_GROUP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="queue-field">التصنيف<select className="input" value={p.advanced.topicId ?? ''} onChange={(e) => p.set({ topicId: e.target.value || null })} disabled={!p.topics.length && !p.advanced.topicId}>
        <option value="">{p.topics.length ? 'كل التصنيفات' : 'لا توجد تصنيفات في هذا النطاق'}</option>
        {p.advanced.topicId && !p.topics.some((t) => t.id === p.advanced.topicId) && <option value={p.advanced.topicId}>التصنيف المحدد</option>}
        {p.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="queue-field">نوع المنشور (X)<select className="input" value={p.advanced.postType ?? ''} onChange={(e) => p.set({ postType: e.target.value || null })}>
        <option value="">الكل</option><option value="original">تغريدة أصلية</option><option value="reply">رد</option><option value="quote">اقتباس</option></select></label>
      <label className="dash-check"><input type="checkbox" checked={p.advanced.influencersOnly === 'true'} onChange={(e) => p.set({ influencersOnly: e.target.checked ? 'true' : null })} disabled={!p.meta?.capabilities.influencers} />المؤثرون فقط</label>
      <label className="dash-check"><input type="checkbox" checked={p.advanced.relevantOnly === 'true'} onChange={(e) => p.set({ relevantOnly: e.target.checked ? 'true' : null })} />ذات الصلة فقط</label>
      <p className="dash-basis w-full">مصدر البيانات: منصة X (المصدر المتاح حاليًا). الفلاتر المتقدمة تخص منشورات X فقط؛ القصص والأخبار وأداء الفريق تتأثر بالبرنامج والفترة فقط.</p>
      {active > 0 && <button className="btn-ghost" onClick={() => p.set(Object.fromEntries(ADVANCED_KEYS.map((k) => [k, null])))}><X size={14} />مسح الفلاتر المتقدمة</button>}
    </div>}
  </div>;
}
