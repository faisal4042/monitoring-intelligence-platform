import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, Search } from 'lucide-react';
import type { SearchEntity } from '@mip/shared';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/influencers';
import { VALUE_LABELS, fieldConditions, setFieldCondition, type FieldInfo } from '../../lib/search';

/** The most used conditions, one click away. Values come from the field catalogue or the suggestion API — never invented. */
const QUICK: Array<{ field: string; label: string; remote?: boolean; hide?: string[] }> = [
  { field: 'program', label: 'البرنامج', remote: true },
  { field: 'sentiment', label: 'المشاعر', hide: ['very_positive', 'very_negative'] },
  { field: 'classification', label: 'نوع التفاعل' },
  { field: 'source', label: 'المصدر', remote: true },
];

export default function QuickFilters({ fields, tab, q, onChange }: {
  fields: FieldInfo[]; tab: SearchEntity; q: string; onChange: (q: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {QUICK.map((qf) => {
        const def = fields.find((f) => f.name === qf.field);
        if (!def) return null;
        return <QuickFilter key={qf.field} def={def} label={qf.label} remote={!!qf.remote} hide={qf.hide ?? []} tab={tab} q={q}
          open={open === qf.field} setOpen={(v) => setOpen(v ? qf.field : null)} onChange={onChange} />;
      })}
    </>
  );
}

function QuickFilter({ def, label, remote, hide, tab, q, open, setOpen, onChange }: {
  def: FieldInfo; label: string; remote: boolean; hide: string[]; tab: SearchEntity; q: string;
  open: boolean; setOpen: (v: boolean) => void; onChange: (q: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [prefix, setPrefix] = useState('');
  const debounced = useDebounced(prefix, 200);
  const unavailable = def.availability[tab];
  const current = fieldConditions(q, def.name);
  const value = current.length === 1 ? current[0].node.value : null;
  const shown = current.length > 1 ? 'عدة قيم' : value ? (VALUE_LABELS[value] ?? value) : null;

  const suggestions = useQuery({
    queryKey: ['search-suggest', def.name, debounced],
    queryFn: () => api.get<{ items: Array<{ value: string; label: string }> }>(`/search/suggestions?${new URLSearchParams({ field: def.name, prefix: debounced })}`),
    enabled: open && remote,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open, setOpen]);

  const pick = (v: string | null) => { onChange(setFieldCondition(q, def.name, v)); setOpen(false); trigger.current?.focus(); };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.as-qf-option') ?? [])];
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  };
  const options = remote
    ? (suggestions.data?.items ?? []).map((s) => ({ value: s.value, label: s.label }))
    : (def.values ?? []).filter((v) => !hide.includes(v)).map((v) => ({ value: v, label: VALUE_LABELS[v] ?? v }));

  return (
    <div className="as-qf" ref={root} onKeyDown={onKey}>
      <button ref={trigger} type="button" className={`as-qf-trigger ${shown ? 'is-set' : ''}`} disabled={!!unavailable}
        aria-haspopup="true" aria-expanded={open} title={unavailable ?? undefined} onClick={() => setOpen(!open)}>
        <span className="as-qf-label">{label}</span>
        {shown && <span className="as-qf-value" dir="auto">{shown}</span>}
        <ChevronDown size={14} aria-hidden="true" className="as-qf-caret" />
      </button>
      {open && (
        <div className="as-qf-pop" role="group" aria-label={`اختيار ${label}`}>
          {remote && (
            <label className="as-qf-search">
              <Search size={14} aria-hidden="true" />
              <input autoFocus className="as-qf-search-input" value={prefix} onChange={(e) => setPrefix(e.target.value)}
                placeholder={`ابحث في ${label}`} aria-label={`ابحث في ${label}`} dir="auto" />
              {suggestions.isFetching && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            </label>
          )}
          <div className="as-qf-list">
            <button type="button" className="as-qf-option" aria-pressed={!value && !current.length} onClick={() => pick(null)} autoFocus={!remote}>
              <span>الكل</span>{!current.length && <Check size={14} aria-hidden="true" />}
            </button>
            {options.map((o) => (
              <button key={o.value} type="button" className="as-qf-option" aria-pressed={value === o.value} onClick={() => pick(o.value)}>
                <span dir="auto">{o.label}</span>{value === o.value && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {remote && suggestions.isSuccess && !options.length && <p className="as-qf-empty">لا توجد قيم مطابقة.</p>}
            {remote && suggestions.isError && <p className="as-qf-empty" role="alert">تعذر تحميل القيم.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
