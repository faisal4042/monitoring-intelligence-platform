import { ChevronDown, Plus } from 'lucide-react';
import { addCondition, type CompareOp, type SearchEntity } from '@mip/shared';
import { GROUP_LABELS, VALUE_LABELS, fieldConditions, type FieldInfo } from '../../lib/search';

const ORDER = ['classification', 'account', 'content', 'engagement', 'dates', 'source', 'workflow'];

/** Drawer state owned by the page, so closing the drawer never loses open sections or half-typed values. */
export interface FiltersDraft { open: Record<string, boolean>; values: Record<string, { v: string; op: CompareOp }> }
export const INITIAL_FILTERS_DRAFT: FiltersDraft = { open: { classification: true }, values: {} };

/**
 * Advanced filters (drawer body). Each control appends a `field:value` condition to the query
 * text — the query stays the single source of truth, so a filter set here is the same as one
 * typed, shareable in the URL and shown as a removable chip. Fields with no data for the
 * current tab are listed apart with the server's reason.
 */
export default function FiltersPanel({ fields, tab, q, onChange, draft, setDraft }: {
  fields: FieldInfo[]; tab: SearchEntity; q: string; onChange: (q: string) => void;
  draft: FiltersDraft; setDraft: (update: (d: FiltersDraft) => FiltersDraft) => void;
}) {
  const usable = fields.filter((f) => !f.availability[tab]);
  const missing = fields.filter((f) => f.availability[tab]);
  const add = (field: string, value: string, op: CompareOp = ':') => value.trim() && onChange(addCondition(q, field, value.trim(), op));

  return (
    <div className="as-filters" aria-label="الفلاتر المتقدمة">
      {ORDER.map((g) => {
        const list = usable.filter((f) => f.group === g);
        if (!list.length) return null;
        const active = list.reduce((n, f) => n + fieldConditions(q, f.name).length, 0);
        const isOpen = !!draft.open[g];
        return (
          <section key={g} className="as-filter-group">
            <h3>
              <button type="button" className="as-filter-head" aria-expanded={isOpen} aria-controls={`as-fg-${g}`}
                onClick={() => setDraft((d) => ({ ...d, open: { ...d.open, [g]: !d.open[g] } }))}>
                <span>{GROUP_LABELS[g]}</span>
                {active > 0 && <span className="as-count-badge num" aria-label={`${active} شرط نشط`}>{active}</span>}
                <ChevronDown size={16} className="as-filter-caret" aria-hidden="true" />
              </button>
            </h3>
            {isOpen && <div className="as-filter-body" id={`as-fg-${g}`}>{list.map((f) => (
              <FieldControl key={f.name} f={f} q={q} add={add}
                draft={draft.values[f.name] ?? { v: '', op: '>' }}
                setValue={(v) => setDraft((d) => ({ ...d, values: { ...d.values, [f.name]: v } }))} />
            ))}</div>}
          </section>
        );
      })}
      {missing.length > 0 && (
        <details className="as-missing">
          <summary>حقول غير متاحة في هذا التبويب ({missing.length})</summary>
          <ul>{missing.map((f) => <li key={f.name}><b>{f.label}</b> <code dir="ltr">{f.name}:</code> — {f.availability[tab]}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function FieldControl({ f, q, add, draft, setValue }: {
  f: FieldInfo; q: string; add: (field: string, value: string, op?: CompareOp) => void;
  draft: { v: string; op: CompareOp }; setValue: (v: { v: string; op: CompareOp }) => void;
}) {
  if (f.values) {
    const selected = new Set(fieldConditions(q, f.name).map((c) => c.node.value));
    return (
      <div className="as-field" role="group" aria-label={f.label}>
        <span className="as-field-label">{f.label}</span>
        <div className="as-chips">
          {f.values.filter((x) => !['very_positive', 'very_negative'].includes(x)).map((x) => (
            <button key={x} type="button" className="as-chip" aria-pressed={selected.has(x)} disabled={selected.has(x)}
              onClick={() => add(f.name, x)} title={`${f.name}:${x}`}>{VALUE_LABELS[x] ?? x}</button>
          ))}
        </div>
      </div>
    );
  }
  const submit = () => { add(f.name, draft.v, f.kind === 'number' ? draft.op : ':'); setValue({ ...draft, v: '' }); };
  return (
    <form className="as-field" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label className="as-field-label" htmlFor={`as-f-${f.name}`}>{f.label}</label>
      <div className="as-field-row">
        {f.kind === 'number' && (
          <select className="input as-op" value={draft.op} onChange={(e) => setValue({ ...draft, op: e.target.value as CompareOp })} aria-label={`مقارنة ${f.label}`}>
            <option value=">">أكثر من</option><option value=">=">على الأقل</option><option value="<">أقل من</option><option value="<=">على الأكثر</option>
          </select>
        )}
        <input id={`as-f-${f.name}`} className="input" type={f.kind === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text'} min={f.kind === 'number' ? 0 : undefined}
          value={draft.v} onChange={(e) => setValue({ ...draft, v: e.target.value })} placeholder={f.example.split(':').slice(1).join(':').replace(/^[<>]=?/, '')} dir="auto" />
        <button className="as-add" aria-label={`إضافة شرط ${f.label}`} disabled={!draft.v.trim()}><Plus size={15} aria-hidden="true" /> إضافة</button>
      </div>
    </form>
  );
}
