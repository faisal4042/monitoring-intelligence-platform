import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Lightbulb, Search, X } from 'lucide-react';
import { parseSearch, SearchSyntaxError, type SearchEntity } from '@mip/shared';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/influencers';
import { VALUE_LABELS, type FieldInfo } from '../../lib/search';

interface Suggestion { insert: string; label: string; hint?: string; disabled?: string }

/** The token the caret is in: [start, end) and its text. */
function tokenAt(text: string, caret: number) {
  let s = caret; while (s > 0 && !/[\s(),"]/.test(text[s - 1])) s--;
  let e = caret; while (e < text.length && !/[\s(),"]/.test(text[e])) e++;
  return { start: s, end: e, text: text.slice(s, e) };
}

const REMOTE = new Set(['program', 'topic', 'source', 'user', 'mention', 'hashtag', 'action_by']);

/**
 * The query box. Suggests field names while typing a bare word, and values
 * after `field:` (enum values locally; programs, topics, sources, accounts,
 * hashtags and staff from the API, limited to what the user may read).
 * Syntax is checked locally with the same parser the API uses.
 */
export default function SearchBar({ value, onSubmit, fields, tab }: {
  value: string; onSubmit: (q: string) => void; fields: FieldInfo[]; tab: SearchEntity;
}) {
  const [text, setText] = useState(value);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [examples, setExamples] = useState(false);
  const examplesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!examples) return;
    const down = (e: MouseEvent) => { if (!examplesRef.current?.contains(e.target as Node)) setExamples(false); };
    document.addEventListener('mousedown', down); return () => document.removeEventListener('mousedown', down);
  }, [examples]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(value); }, [value]);

  const syntax = useMemo(() => {
    try { parseSearch(text); return null; } catch (e) { return e instanceof SearchSyntaxError ? e : null; }
  }, [text]);

  const tok = tokenAt(text, caret);
  const fieldPart = /^-?([A-Za-z_]+):(.*)$/.exec(tok.text);
  const fieldDef = fieldPart ? fields.find((f) => f.name === fieldPart[1].toLowerCase() || f.aliases.includes(fieldPart[1].toLowerCase())) : undefined;
  const remotePrefix = useDebounced(fieldPart?.[2]?.replace(/^[<>]=?/, '') ?? '', 200);
  const remote = useQuery({
    queryKey: ['search-suggest', fieldDef?.name, remotePrefix],
    queryFn: () => api.get<{ items: Array<{ value: string; label: string }> }>(`/search/suggestions?${new URLSearchParams({ field: fieldDef!.name, prefix: remotePrefix })}`),
    enabled: open && !!fieldDef && REMOTE.has(fieldDef.name),
    staleTime: 60_000,
  });

  const suggestions: Suggestion[] = useMemo(() => {
    if (fieldDef && fieldPart) {
      const neg = tok.text.startsWith('-') ? '-' : '';
      if (fieldDef.values) {
        const p = fieldPart[2].toLowerCase();
        return fieldDef.values.filter((v) => v.toLowerCase().startsWith(p))
          .map((v) => ({ insert: `${neg}${fieldDef.name}:${v}`, label: `${fieldDef.name}:${v}`, hint: VALUE_LABELS[v] }));
      }
      if (REMOTE.has(fieldDef.name)) return (remote.data?.items ?? []).map((s) => ({
        insert: `${neg}${fieldDef.name}:${/[\s(),"]/.test(s.value) ? `"${s.value}"` : s.value}`, label: s.label, hint: s.value,
      }));
      return [{ insert: tok.text, label: fieldDef.example, hint: fieldDef.label }];
    }
    const word = tok.text.replace(/^-/, '').toLowerCase();
    if (!/^[a-z_]{1,20}$/.test(word)) return [];
    return fields.filter((f) => [f.name, ...f.aliases].some((n) => n.startsWith(word)))
      .map((f) => ({ insert: `${tok.text.startsWith('-') ? '-' : ''}${f.name}:`, label: `${f.name}:`, hint: f.label, disabled: f.availability[tab] ?? undefined }))
      .slice(0, 8);
  }, [fieldDef, fieldPart?.[2], remote.data, tok.text, fields, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (s: Suggestion) => {
    const next = text.slice(0, tok.start) + s.insert + text.slice(tok.end);
    const pos = tok.start + s.insert.length;
    setText(next);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(pos, pos); setCaret(pos); });
    setActive(0);
    setOpen(!s.insert.endsWith(':') ? false : true);
  };

  const onKey = (e: KeyboardEvent) => {
    const list = open ? suggestions : [];
    if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setActive((a) => (a + 1) % list.length); }
    else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setActive((a) => (a - 1 + list.length) % list.length); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && list.length && open && list[active] && list[active].insert !== tok.text) { e.preventDefault(); apply(list[active]); }
    else if (e.key === 'Enter') { e.preventDefault(); setOpen(false); if (!syntax) onSubmit(text); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const applyExample = (q: string) => {
    setText(q); setExamples(false);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(q.length, q.length); setCaret(q.length); });
  };

  return (
    <div className="as-bar">
      <div className="as-bar-row">
        <div className="as-input-wrap">
          <Search size={20} aria-hidden="true" className="as-input-icon" />
          <input
            ref={input} className={`as-input ${syntax ? 'as-input--error' : ''}`} value={text} dir="auto"
            placeholder="ابحث بالكلمات أو العبارات أو الحقول…"
            aria-label="استعلام البحث المتقدم" aria-invalid={!!syntax} aria-describedby="as-syntax"
            role="combobox" aria-expanded={open && suggestions.length > 0} aria-controls="as-suggest" aria-autocomplete="list"
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setOpen(true); setActive(0); }}
            onKeyDown={onKey} onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
            onKeyUp={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
            onBlur={() => setTimeout(() => setOpen(false), 150)} maxLength={500}
          />
          {text && <button type="button" className="as-clear" aria-label="مسح الاستعلام" onClick={() => { setText(''); onSubmit(''); input.current?.focus(); }}><X size={16} /></button>}
          {open && suggestions.length > 0 && (
            <ul className="as-suggest" id="as-suggest" role="listbox">
              {suggestions.map((s, i) => (
                <li key={s.insert + i} role="option" aria-selected={i === active} aria-disabled={!!s.disabled}
                  className={`as-suggest-item ${i === active ? 'is-active' : ''}`} onMouseDown={(e) => { e.preventDefault(); apply(s); }}>
                  <code className="num">{s.label}</code>
                  {s.hint && <span className="muted">{s.hint}</span>}
                  {s.disabled && <span className="as-suggest-na" title={s.disabled}>غير متاح هنا</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="btn-primary as-go" disabled={!!syntax} onClick={() => { setOpen(false); onSubmit(text); }}><Search size={16} aria-hidden="true" /> بحث</button>
      </div>
      <div className="as-bar-foot">
        <div id="as-syntax" className={`as-syntax ${syntax ? 'is-error' : ''}`} role={syntax ? 'alert' : undefined}>
          {syntax
            ? <><AlertCircle size={14} aria-hidden="true" /> صيغة غير مكتملة: {syntax.message} <span className="num">(الموضع {syntax.position + 1})</span></>
            : <span className="as-bar-hint">اضغط <kbd>Enter</kbd> للبحث · اكتب اسم حقل مثل <code dir="ltr">sentiment:</code> لعرض قيمه</span>}
        </div>
        <div className="as-examples" ref={examplesRef}>
          <button type="button" className="as-link-btn" aria-expanded={examples} aria-haspopup="true" onClick={() => setExamples((v) => !v)}>
            <Lightbulb size={14} aria-hidden="true" /> أمثلة الاستعلامات
          </button>
          {examples && (
            <div className="as-examples-pop" role="group" aria-label="أمثلة الاستعلامات" onKeyDown={(e) => { if (e.key === 'Escape') setExamples(false); }}>
              <p className="as-examples-title">اضغط مثالًا لنسخه إلى حقل البحث</p>
              {EXAMPLES.map(([q, d]) => (
                <button key={q} type="button" className="as-example" onClick={() => applyExample(q)}>
                  <code dir="auto">{q}</code><span>{d}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const EXAMPLES: Array<[string, string]> = [
  ['"التجديد التلقائي"', 'عبارة دقيقة بنفس الترتيب'],
  ['(إيجار OR ملاك) AND شكوى', 'تجميع الشروط بالأقواس'],
  ['إيجار -إعلان', 'استبعاد كلمة'],
  ['sentiment:negative classification:complaint', 'شكاوى سلبية'],
  ['followers:>10000', 'حسابات تتجاوز 10 آلاف متابع'],
  ['after:2026-10-01', 'منشور بعد تاريخ (بتوقيت الرياض)'],
];

export function SyntaxHelp() {
  const rows: Array<[string, string]> = [
    ['إيجار', 'منشورات تحتوي الكلمة (بعد توحيد الهمزات والتاء المربوطة والتشكيل)'],
    ['-إيجار', 'استبعاد — الشرطة في بداية الكلمة فقط؛ داخل الكلمة (co-op) جزء منها'],
    ['إيجار, عقد, مستأجر', 'أي كلمة من المجموعة (OR)'],
    ['"التجديد التلقائي"', 'عبارة دقيقة بنفس الترتيب'],
    ['إيجار AND عقد', 'الشرطان معًا — المسافة وحدها تعني AND أيضًا'],
    ['إيجار OR ملاك', 'أحد الشرطين'],
    ['إيجار NOT إعلان', 'استبعاد ما بعد NOT'],
    ['(إيجار OR ملاك) AND شكوى', 'الأقواس تحدد التجميع'],
    ['followers:>10000', 'مقارنة رقمية: > < >= <='],
    ['after:2026-10-01', 'تواريخ بتوقيت الرياض، شاملة لليوم'],
  ];
  return (
    <div className="as-help">
      <p className="text-sm mb-2"><b>الأسبقية:</b> الفاصلة (مجموعة كلمات) ← الاستبعاد (- و NOT) ← AND ← OR. المعاملات AND/OR/NOT بأحرف كبيرة فقط.</p>
      <table className="as-help-table"><tbody>
        {rows.map(([q, d]) => <tr key={q}><td><code dir="auto">{q}</code></td><td>{d}</td></tr>)}
      </tbody></table>
      <p className="text-xs muted mt-2">علامات الترقيم في أطراف الكلمة (؟ ! . ،) تُتجاهل. لا يُرسل أي بحث إلى X — البحث في بيانات المنصة المجمعة فقط.</p>
    </div>
  );
}
