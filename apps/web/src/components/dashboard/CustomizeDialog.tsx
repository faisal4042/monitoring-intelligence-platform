import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, RotateCcw, Star, X } from 'lucide-react';
import { KPI_KEYS, KPI_META, PERIODS, SECTION_LABELS, TREND_LABELS, TREND_SERIES, type DashboardMeta, type Layout, type SectionId } from '../../lib/dashboard';

/**
 * Arrange the dashboard for one scope (all programs, or the selected program).
 * Presentation only: hiding a section never changes what the API allows.
 */
export default function CustomizeDialog({ layout, scopeName, isProgram, meta, saving, error, onSave, onReset, onClose }: {
  layout: Layout; scopeName: string; isProgram: boolean; meta?: DashboardMeta; saving: boolean; error?: string | null;
  onSave: (l: Layout) => void; onReset: () => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<Layout>(layout);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const move = <T,>(arr: T[], i: number, by: number) => { const next = [...arr]; const j = i + by; if (j < 0 || j >= next.length) return arr; [next[i], next[j]] = [next[j], next[i]]; return next; };
  const favorites = draft.favorites ?? [];
  const toggleFav = (id: SectionId) => setDraft((d) => ({ ...d, favorites: favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id] }));
  return <div className="queue-drawer" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="تخصيص اللوحة" className="card p-5 space-y-5" onClick={(e) => e.stopPropagation()}>
      <header className="flex justify-between items-start gap-3">
        <div><h2 className="text-lg font-bold">تخصيص اللوحة</h2><p className="text-sm muted">يُحفظ لحسابك فقط لعرض: <strong>{scopeName}</strong>. لا يغيّر التخصيص صلاحياتك أو البيانات المتاحة لك.</p></div>
        <button ref={closeRef} className="icon-button" aria-label="إغلاق" onClick={onClose}><X size={18} /></button>
      </header>

      <fieldset className="space-y-2"><legend className="dash-subtitle">الأقسام وترتيبها</legend>
        <ul className="dash-sortable">{draft.sections.map((s, i) => <li key={s.id}>
          <label className="dash-check flex-1"><input type="checkbox" checked={s.visible} onChange={(e) => setDraft((d) => ({ ...d, sections: d.sections.map((x) => x.id === s.id ? { ...x, visible: e.target.checked } : x) }))} />{SECTION_LABELS[s.id]}</label>
          <button className="icon-button" aria-pressed={favorites.includes(s.id)} aria-label={`تفضيل ${SECTION_LABELS[s.id]}`} title="قسم مفضل (يظهر أولًا ويُميَّز)" onClick={() => toggleFav(s.id)}>
            <Star size={14} fill={favorites.includes(s.id) ? 'currentColor' : 'none'} /></button>
          <button className="icon-button" aria-label={`رفع ${SECTION_LABELS[s.id]}`} disabled={i === 0} onClick={() => setDraft((d) => ({ ...d, sections: move(d.sections, i, -1) }))}><ArrowUp size={14} /></button>
          <button className="icon-button" aria-label={`خفض ${SECTION_LABELS[s.id]}`} disabled={i === draft.sections.length - 1} onClick={() => setDraft((d) => ({ ...d, sections: move(d.sections, i, 1) }))}><ArrowDown size={14} /></button>
        </li>)}</ul>
      </fieldset>

      <fieldset className="space-y-2"><legend className="dash-subtitle">بطاقات المؤشرات الظاهرة وترتيبها</legend>
        <ul className="dash-sortable">{draft.kpis.map((k, i) => <li key={k}><span className="flex-1">{KPI_META[k].label}</span>
          <button className="icon-button" aria-label={`رفع ${KPI_META[k].label}`} disabled={i === 0} onClick={() => setDraft((d) => ({ ...d, kpis: move(d.kpis, i, -1) }))}><ArrowUp size={14} /></button>
          <button className="icon-button" aria-label={`خفض ${KPI_META[k].label}`} disabled={i === draft.kpis.length - 1} onClick={() => setDraft((d) => ({ ...d, kpis: move(d.kpis, i, 1) }))}><ArrowDown size={14} /></button>
          <button className="icon-button" aria-label={`نقل ${KPI_META[k].label} إلى المؤشرات الإضافية`} disabled={draft.kpis.length === 1} onClick={() => setDraft((d) => ({ ...d, kpis: d.kpis.filter((x) => x !== k) }))}><X size={14} /></button>
        </li>)}</ul>
        <div className="flex flex-wrap gap-2">{KPI_KEYS.filter((k) => !draft.kpis.includes(k)).map((k) =>
          <button key={k} className="dash-chip dash-chip--sm" onClick={() => setDraft((d) => ({ ...d, kpis: [...d.kpis, k] }))}>+ {KPI_META[k].label}</button>)}</div>
      </fieldset>

      <fieldset className="space-y-2"><legend className="dash-subtitle">سلاسل اتجاه التفاعلات الافتراضية</legend>
        <div className="flex flex-wrap gap-3">{TREND_SERIES.map((s) => { const on = (draft.trendSeries ?? []).includes(s); return <label key={s} className="dash-check">
          <input type="checkbox" checked={on} disabled={on && (draft.trendSeries ?? []).length === 1}
            onChange={(e) => setDraft((d) => ({ ...d, trendSeries: e.target.checked ? [...(d.trendSeries ?? []), s] : (d.trendSeries ?? []).filter((x) => x !== s) }))} />{TREND_LABELS[s]}</label>; })}</div>
      </fieldset>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="queue-field">الفترة الافتراضية<select className="input" value={draft.defaultPeriod ?? ''} onChange={(e) => setDraft((d) => ({ ...d, defaultPeriod: (e.target.value || undefined) as Layout['defaultPeriod'] }))}>
          <option value="">آخر 30 يومًا (افتراضي النظام)</option>{PERIODS.filter((p) => p.key !== 'custom').map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
        {!isProgram && <label className="queue-field">العرض الافتراضي عند الفتح<select className="input" value={draft.defaultProgram ?? ''} onChange={(e) => setDraft((d) => ({ ...d, defaultProgram: e.target.value || null }))}>
          <option value="">جميع البرامج</option>{meta?.programs.map((p) => <option key={p.id} value={p.key}>{p.name_ar}</option>)}</select></label>}
      </div>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <footer className="flex flex-wrap gap-2 justify-between">
        <button className="btn-ghost" onClick={onReset} disabled={saving}><RotateCcw size={15} />استعادة التخطيط الافتراضي</button>
        <div className="flex gap-2"><button className="btn-ghost" onClick={onClose}>إلغاء</button>
          <button className="btn-primary" disabled={saving} onClick={() => onSave(draft)}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</button></div>
      </footer>
    </section>
  </div>;
}
