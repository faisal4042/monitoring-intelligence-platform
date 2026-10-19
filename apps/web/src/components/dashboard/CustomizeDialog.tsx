import ModalSurface, { ModalCloseButton } from '../ModalSurface';
import { useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { PERIODS, SECTION_GROUPS, SECTION_LABELS, TREND_LABELS, TREND_SERIES, type DashboardMeta, type Layout, type SectionId } from '../../lib/dashboard';

import { Button } from '../ui/Button';
/**
 * Choose what the dashboard shows for one scope (all programs, or the selected
 * program). The reading order is fixed; this only hides or shows sections and
 * sets the defaults. Presentation only: it never changes what the API allows.
 */
export default function CustomizeDialog({ layout, scopeName, isProgram, meta, saving, error, onSave, onReset, onClose }: {
  layout: Layout; scopeName: string; isProgram: boolean; meta?: DashboardMeta; saving: boolean; error?: string | null;
  onSave: (l: Layout) => void; onReset: () => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<Layout>(layout);


  const isOn = (id: SectionId) => draft.sections.find((s) => s.id === id)?.visible !== false;
  const toggle = (id: SectionId, visible: boolean) => setDraft((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? { ...s, visible } : s)) }));
  const metric = draft.trendSeries?.[0] ?? 'total';
  return <ModalSurface label={'تخصيص اللوحة'} onClose={onClose} busy={saving} overlayClassName="queue-drawer" panelClassName="card p-5 space-y-5">
      <header className="flex justify-between items-start gap-3">
        <div><h2 className="text-lg font-bold">تخصيص اللوحة</h2><p className="text-sm muted">يُحفظ لحسابك فقط لعرض: <strong>{scopeName}</strong>. لا يغيّر التخصيص صلاحياتك أو البيانات المتاحة لك.</p></div>
        <ModalCloseButton  className="icon-button" aria-label="إغلاق" onClick={onClose}><X size={18} /></ModalCloseButton>
      </header>

      <fieldset className="space-y-3"><legend className="dash-subtitle">الأقسام الظاهرة</legend>
        <p className="text-xs muted">ترتيب الأقسام ثابت: الملخص، ثم الاتجاهات، ثم المقارنات والقضايا، ثم التفاصيل والمراقبة التشغيلية.</p>
        {SECTION_GROUPS.map((g) => <div key={g.id} className="dash-custom-group">
          <span className="dash-custom-group-title">{g.title}</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">{g.sections.map((id) => <label key={id} className="dash-check">
            <input type="checkbox" checked={isOn(id)} onChange={(e) => toggle(id, e.target.checked)} />{SECTION_LABELS[id]}</label>)}</div>
        </div>)}
      </fieldset>

      <fieldset className="space-y-2"><legend className="dash-subtitle">المؤشر الافتراضي في رسم الاتجاه</legend>
        <div className="flex flex-wrap gap-3">{TREND_SERIES.map((s) => <label key={s} className="dash-check">
          <input type="radio" name="trend-metric" checked={metric === s} onChange={() => setDraft((d) => ({ ...d, trendSeries: [s] }))} />{TREND_LABELS[s]}</label>)}</div>
      </fieldset>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="queue-field">الفترة الافتراضية<select className="input" value={draft.defaultPeriod ?? ''} onChange={(e) => setDraft((d) => ({ ...d, defaultPeriod: (e.target.value || undefined) as Layout['defaultPeriod'] }))}>
          <option value="">آخر 7 أيام (افتراضي النظام)</option>{PERIODS.filter((p) => p.key !== 'custom').map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
        {!isProgram && <label className="queue-field">العرض الافتراضي عند الفتح<select className="input" value={draft.defaultProgram ?? ''} onChange={(e) => setDraft((d) => ({ ...d, defaultProgram: e.target.value || null }))}>
          <option value="">جميع البرامج</option>{meta?.programs.map((p) => <option key={p.id} value={p.key}>{p.name_ar}</option>)}</select></label>}
      </div>

      {error && <p role="alert" className="text-sm text-(--status-danger)">{error}</p>}
      <footer className="flex flex-wrap gap-2 justify-between">
        <Button variant="ghost" type="submit" onClick={onReset} disabled={saving}><RotateCcw size={15} />استعادة التخطيط الافتراضي</Button>
        <div className="flex gap-2"><ModalCloseButton className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton>
          <Button variant="primary" type="submit" disabled={saving} onClick={() => onSave(draft)}>{saving ? 'جارٍ الحفظ…' : 'حفظ'}</Button></div>
      </footer>
    </ModalSurface>;
}
