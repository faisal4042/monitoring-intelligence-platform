import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, FileDown, Info, Save } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { fmtDateTime, fmtNum } from '../../lib/format';
import {
  EXPORTS_OFF_TEXT, FILTER_LABELS, FILTER_OPTIONS, FORMAT_LABELS, PERIOD_PRESETS, tablesReady,
  type Catalog, type CatalogType, type ExportFormat, type ReportFilters, type ReportRequest, type TemplateRow,
} from '../../lib/reports';

import { Button } from '../ui/Button';
interface Program { id: string; name_ar: string; color: string | null }
interface Preview { columns: Array<{key: string; label: string; type: string}>; rows: unknown[][]; estimate: number | null; period: {from: string; to: string} }

/** Builder state is plain data so a template can be loaded into it and saved back without loss. */
export interface BuilderState { request: ReportRequest; format: ExportFormat; jsonMode: 'flat' | 'structured'; zip: boolean }
export const initialBuilder = (t: CatalogType): BuilderState => ({
  request: {type: t.key, period: {range: '30d'}, filters: {}, columns: t.columns.filter((c) => c.default && c.allowed).map((c) => c.key), headerLang: 'ar'},
  format: 'xlsx', jsonMode: 'flat', zip: false,
});

function cell(v: unknown, type: string) {
  if (v === null || v === undefined || v === '') return <span className="rc-null">—</span>;
  if (type === 'datetime') return fmtDateTime(String(v));
  if (type === 'bool') return v === true || v === 't' ? 'نعم' : 'لا';
  if (type === 'int' || type === 'number' || type === 'minutes') return <span className="num">{fmtNum(Number(v))}</span>;
  return <bdi>{String(v).length > 140 ? String(v).slice(0, 140) + '…' : String(v)}</bdi>;
}

export default function ReportBuilder({ catalog, type, state, setState, onExported, onTemplateSaved }: {
  catalog: Catalog; type: CatalogType; state: BuilderState; setState: (s: BuilderState) => void;
  onExported: () => void; onTemplateSaved: (t: TemplateRow) => void;
}) {
  const req = state.request;
  const setReq = (patch: Partial<ReportRequest>) => setState({...state, request: {...req, ...patch}});
  const setFilter = (k: keyof ReportFilters, v: string[] | boolean | undefined) => setReq({filters: {...req.filters, [k]: v}});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [shared, setShared] = useState(false);
  const [previewPage,setPreviewPage]=useState(1);
  const requestKey=useRef(JSON.stringify(req));
  requestKey.current=JSON.stringify(req);
  useEffect(() => { setPreview(null);setPreviewPage(1); }, [JSON.stringify(req)]); // eslint-disable-line react-hooks/exhaustive-deps

  const programs = useQuery({queryKey: ['programs'], queryFn: () => api.get<{items: Program[]}>('/programs'), enabled: type.filters.includes('program'), staleTime: 300_000});
  const previewM = useMutation({mutationFn: (input:ReportRequest) => api.post<Preview>('/reports/preview', input), onSuccess: (data,input) => {if(JSON.stringify(input)===requestKey.current)setPreview(data);}});
  const exportM = useMutation({
    mutationFn: () => api.post('/reports/exports', {request: req, options: {format: state.format, ...(state.format === 'json' || state.format === 'jsonl' ? {jsonMode: state.jsonMode} : {}), ...(state.zip && ['csv', 'tsv', 'jsonl'].includes(state.format) ? {zip: true} : {})},
      idempotencyKey: `ui-${crypto.randomUUID()}`}),
    onSuccess: onExported,
  });
  const templateM = useMutation({
    mutationFn: () => api.post<TemplateRow>('/reports/templates', {name: templateName.trim(), visibility: shared ? 'shared' : 'private',
      definition: {request: req, options: {format: state.format, ...(['json','jsonl'].includes(state.format)?{jsonMode:state.jsonMode}:{}), ...(['csv','tsv','jsonl'].includes(state.format)?{zip:state.zip}:{})}}}),
    onSuccess: (t) => { setTemplateName(''); onTemplateSaved(t); },
  });

  const selected = req.columns;
  const columns = type.columns;
  const move = (key: string, dir: -1 | 1) => {
    const i = selected.indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= selected.length) return;
    const next = [...selected]; [next[i], next[j]] = [next[j], next[i]]; setReq({columns: next});
  };
  const toggleCol = (key: string) => setReq({columns: selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]});
  const groups = useMemo(() => [...new Set(columns.map((c) => c.group))], [columns]);
  const optionsFor = (f: string) => f === 'program' ? (programs.data?.items ?? []).map((p) => ({value: p.id, ar: p.name_ar}))
    : f === 'status' ? (type.key === 'queue_items' ? FILTER_OPTIONS.queueStatus : FILTER_OPTIONS.ticketStatus) : FILTER_OPTIONS[f] ?? [];
  const error = (previewM.error ?? exportM.error ?? templateM.error) as ApiError | null;
  const custom = req.period.range === 'custom';

  return (
    <div className="rc-builder">
      <section className="rc-panel" aria-labelledby="rc-scope-h">
        <button type="button" className="rc-link" onClick={()=>setReq({period:{range:'30d'},filters:{}})}>إعادة ضبط الفلاتر</button>
        <h3 id="rc-scope-h" className="rc-panel-title">النطاق</h3>
        <div className="rc-row">
          {programs.error && <p className="rc-error" role="alert">تعذر تحميل خيارات البرامج. <button type="button" className="rc-link" onClick={()=>programs.refetch()}>إعادة المحاولة</button></p>}
          <label className="rc-field"><span>الفترة <small>({type.dateLabelAr}، بتوقيت الرياض)</small></span>
            <select className="input" value={req.period.range ?? '30d'} onChange={(e) => setReq({period: e.target.value === 'custom' ? {range: 'custom', from: '', to: ''} : {range: e.target.value}})}>
              {PERIOD_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.ar}</option>)}
            </select>
          </label>
          {custom && <>
            <label className="rc-field"><span>من</span><input type="date" className="input num" value={req.period.from ?? ''} onChange={(e) => setReq({period: {...req.period, from: e.target.value}})} /></label>
            <label className="rc-field"><span>إلى</span><input type="date" className="input num" value={req.period.to ?? ''} onChange={(e) => setReq({period: {...req.period, to: e.target.value}})} /></label>
          </>}
        </div>
        {type.filters.filter((f) => f !== 'review' && f !== 'topic' && f !== 'assignee').map((f) => {
          const opts = optionsFor(f);
          if (!opts.length) return null;
          const val = (req.filters[f as keyof ReportFilters] as string[] | undefined) ?? [];
          return (
            <fieldset key={f} className="rc-filter">
              <legend>{FILTER_LABELS[f]} <small>{val.length ? `${val.length} مختار` : 'الكل'}</small></legend>
              <div className="rc-chips">
                {opts.map((o) => (
                  <button key={o.value} type="button" className="rc-chip" aria-pressed={val.includes(o.value)}
                    onClick={() => setFilter(f as keyof ReportFilters, val.includes(o.value) ? val.filter((x) => x !== o.value) : [...val, o.value])}>{o.ar}</button>
                ))}
              </div>
            </fieldset>
          );
        })}
        {type.filters.includes('review') && (
          <label className="rc-check"><input type="checkbox" checked={!!req.filters.review} onChange={(e) => setFilter('review', e.target.checked || undefined)} /> التذاكر التي تحتاج مراجعة فقط</label>
        )}
      </section>

      <section className="rc-panel" aria-labelledby="rc-cols-h">
        <div className="rc-panel-head">
          <h3 id="rc-cols-h" className="rc-panel-title">الأعمدة <small className="num">{selected.length}</small></h3>
          <div className="rc-seg" role="group" aria-label="لغة العناوين">
            <button type="button" aria-pressed={req.headerLang === 'ar'} onClick={() => setReq({headerLang: 'ar'})}>عربي</button>
            <button type="button" aria-pressed={req.headerLang === 'en'} onClick={() => setReq({headerLang: 'en'})}>English</button>
          </div>
        </div>
        {selected.length > 0 && (
          <ol className="rc-order" aria-label="ترتيب الأعمدة المختارة">
            {selected.map((key, i) => {
              const c = columns.find((x) => x.key === key);
              if(!c)return null;
              return (
                <li key={key}>
                  <span className="rc-order-n num">{i + 1}</span><span className="rc-order-label">{req.headerLang === 'en' ? c.en : c.ar}</span>
                  <button type="button" className="rc-icon" aria-label={`تقديم ${c.ar}`} disabled={i === 0} onClick={() => move(key, -1)}><ArrowUp size={14} /></button>
                  <button type="button" className="rc-icon" aria-label={`تأخير ${c.ar}`} disabled={i === selected.length - 1} onClick={() => move(key, 1)}><ArrowDown size={14} /></button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="rc-col-groups">
          {groups.map((g) => (
            <div key={g} className="rc-col-group">
              {columns.filter((c) => c.group === g).map((c) => (
                <label key={c.key} className={`rc-col ${!c.allowed ? 'is-locked' : ''}`} title={!c.allowed ? 'يتطلب صلاحية إضافية' : undefined}>
                  <input type="checkbox" checked={selected.includes(c.key)} disabled={!c.allowed} onChange={() => toggleCol(c.key)} />
                  <span>{c.ar}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="rc-panel rc-run" aria-labelledby="rc-run-h">
        <h3 id="rc-run-h" className="rc-panel-title">المعاينة والتصدير</h3>
        <div className="rc-row">
          <label className="rc-field"><span>الصيغة</span>
            <select className="input" value={state.format} onChange={(e) => setState({...state, format: e.target.value as ExportFormat})}>
              {catalog.formats.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
            </select>
          </label>
          {(state.format === 'json' || state.format === 'jsonl') && (
            <label className="rc-field"><span>بنية السجلات</span>
              <select className="input" value={state.jsonMode} onChange={(e) => setState({...state, jsonMode: e.target.value as 'flat' | 'structured'})}>
                <option value="flat">مسطحة (Power BI / Excel)</option><option value="structured">منظمة بالمجموعات (تكامل الأنظمة)</option>
              </select>
            </label>
          )}
          {['csv', 'tsv', 'jsonl'].includes(state.format) && (
            <label className="rc-check"><input type="checkbox" checked={state.zip} onChange={(e) => setState({...state, zip: e.target.checked})} /> ملف ZIP مقسّم (للتقارير الكبيرة)</label>
          )}
        </div>
        <div className="rc-actions">
          <Button variant="ghost" type="button" disabled={!selected.length || previewM.isPending} onClick={() => previewM.mutate(req)}><Eye size={16} aria-hidden="true" /> {previewM.isPending ? 'جارٍ التحضير…' : 'معاينة وتقدير'}</Button>
          <Button variant="primary" type="button" disabled={!selected.length || !catalog.canExport || !catalog.exportsActivated || exportM.isPending}
            title={!catalog.exportsActivated ? EXPORTS_OFF_TEXT : !catalog.canExport ? 'يتطلب صلاحية تصدير التقارير' : undefined}
            onClick={() => exportM.mutate()}><FileDown size={16} aria-hidden="true" /> إنشاء التصدير</Button>
        </div>
        {exportM.isSuccess && <p className="rc-ok" role="status">أُضيف التصدير إلى السجل. يُنشأ الملف في الخلفية دون تحميل البيانات في المتصفح.</p>}
        {!catalog.exportsActivated && <p className="rc-note"><Info size={14} aria-hidden="true" /> {tablesReady(catalog) ? EXPORTS_OFF_TEXT : 'المعاينة متاحة الآن؛ إنشاء الملفات والقوالب والجدولة يتطلب تفعيل الترحيل 0047.'}</p>}
        {tablesReady(catalog) && (
          <details className="rc-save-details"><summary>حفظ إعدادات التقرير كقالب</summary><div className="rc-save">
            <input className="input" value={templateName} maxLength={120} onChange={(e) => setTemplateName(e.target.value)} placeholder="اسم القالب" aria-label="اسم القالب" />
            {catalog.canShareTemplates && <label className="rc-check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> مشترك</label>}
            <Button variant="ghost" type="button" disabled={!templateName.trim() || templateM.isPending} onClick={() => templateM.mutate()}><Save size={15} aria-hidden="true" /> حفظ كقالب</Button>
          </div></details>
        )}
        {error && <p className="rc-error" role="alert">{error.message}</p>}
      </section>

      {!preview && <section className="rc-panel rc-preview" aria-label="مساحة المعاينة">{previewM.isPending ? <div className="rc-skeleton" role="status" aria-label="جارٍ تحضير المعاينة" aria-busy="true"/> : <div className="rc-state"><Eye size={26} aria-hidden="true"/><h3>معاينة بيانات التقرير</h3><p>اضبط الفترة والأعمدة ثم اختر «معاينة وتقدير». المعاينة للقراءة فقط ولا تُنشئ ملفًا.</p></div>}</section>}
      {preview && (
        <section className="rc-panel rc-preview" aria-label="معاينة أول السجلات">
          <div className="rc-panel-head">
            <h3 className="rc-panel-title">معاينة أول <span className="num">{fmtNum(preview.rows.length)}</span> سجل</h3>
            <p className="rc-estimate">{preview.estimate === null ? 'تعذر تقدير العدد خلال المهلة' : <>العدد المتوقع في الملف: <b className="num">{fmtNum(preview.estimate)}</b> {type.aggregated ? 'صف مجمّع' : 'سجل'}</>}
              <span className="rc-period"> · {fmtDateTime(preview.period.from)} ← {fmtDateTime(preview.period.to)}</span></p>
          </div>
          {preview.rows.length === 0 ? <p className="rc-empty">لا توجد سجلات تطابق النطاق والفلاتر.</p> : (
            <div className="rc-table-wrap" tabIndex={0} role="region" aria-label="جدول المعاينة">
              <table className="rc-table">
                <thead><tr>{preview.columns.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
                <tbody>{preview.rows.slice((previewPage-1)*10,previewPage*10).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{cell(v, preview.columns[j].type)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="rc-pagination"><span>عينة المعاينة حتى 50 سجلًا؛ الملف الكامل عبر التصدير.</span>{preview.rows.length>10&&<div><Button variant="ghost" type="submit" disabled={previewPage===1} onClick={()=>setPreviewPage(previewPage-1)}>السابق</Button><span>{fmtNum(previewPage)} / {fmtNum(Math.ceil(preview.rows.length/10))}</span><Button variant="ghost" type="submit" disabled={previewPage>=Math.ceil(preview.rows.length/10)} onClick={()=>setPreviewPage(previewPage+1)}>التالي</Button></div>}</div>
        </section>
      )}
    </div>
  );
}
