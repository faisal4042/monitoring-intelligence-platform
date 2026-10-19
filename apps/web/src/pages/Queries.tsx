import { useConfirmAction } from '../components/ConfirmAction';
import AsyncState from '../components/AsyncState';
import { useActionNotice } from '../components/ActionNotice';
import { FormField, FieldInput, FieldTextarea } from '../components/FormField';
import ModalSurface, { ModalCloseButton } from '../components/ModalSurface';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtNum, fmtPct, fmtRelative } from '../lib/format';
import { queryActions, queryStateLabel, resumeDescription } from '../lib/dictionary';
import { PERMISSIONS } from '@mip/shared';
import { FlaskConical, History, Pause, Pencil, Play, Plus, RotateCcw, SearchCode, Trash2 } from 'lucide-react';

import { Button } from '../components/ui/Button';
interface Row {
  id: string; name: string; description: string | null; status: string; program_name: string; program_color: string;
  compiled: string; version: number; total_units: number; total_relevant: number;
  precision_rate: string | null; test_count: number; best_precision: number | null;
  last_run_at: string | null; is_paused: boolean; polling_tier: string; pause_reason: string | null;
  is_system: boolean; deleted_at: string | null; resume_to: 'active' | 'draft'; version_count: number;
  max_results_per_call: number;
}
interface Version {
  id: string; version: number; compiled: string; change_summary: string | null; created_at: string;
  created_by_name: string | null; tested_precision: number | null;
}

const TONE: Record<string, string> = {
  ok: 'bg-(--status-success-soft) text-(--status-success)',
  warn: 'bg-(--status-warning-soft) text-(--status-warning)',
  info: 'bg-brand-500/15 text-brand-600 dark:text-brand-400',
  muted: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
  danger: 'bg-(--status-danger-soft) text-(--status-danger)',
};

export default function Queries() {
  const { can } = useAuth();
  const confirmation = useConfirmAction();
  const notice = useActionNotice();
  const qc = useQueryClient();
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [history, setHistory] = useState<Row | null>(null);
  const queriesRead = useQuery({
    queryKey: showDeleted ? ['queries', 'deleted'] : ['queries'],
    queryFn: () => api.get<{ items: Row[] }>(`/queries${showDeleted ? '?includeDeleted=1' : ''}`),
  });
  const { data } = queriesRead;
  const refresh = () => qc.invalidateQueries();
  const run = (promise: Promise<unknown>, text: string) =>
    promise.then(() => { notice.success(text); refresh(); }).catch((e) => { notice.error(e); throw e; });

  const collect = useMutation({
    mutationFn: (id: string) => api.post<{ retrieved: number; inserted: number; duplicates: number; filtered: number; mode: string }>(`/posts/collect/${id}`),
    onSuccess: () => qc.invalidateQueries(),
  });

  const pageReads = [queriesRead];
  const readError = pageReads.find(read => read.error)?.error;

  return (
    <div className="space-y-5">{confirmation.dialog}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold"><SearchCode size={22} className="text-brand-600" /> الاستعلامات</h1>
          <p className="text-sm muted">لا يصل استعلام إلى الإنتاج قبل اجتياز اختبار بيئة التجربة بدقة ≥ 70%</p>
        </div>
        {can(PERMISSIONS.QUERIES_WRITE) && (
          <Link to="/queries/new" className="btn-primary"><Plus size={16} /> استعلام جديد</Link>
        )}
      </div>
      {notice.element}
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
        إظهار المحذوفة منطقيًا
      </label>

      {collect.data && (
        <div className="card p-3 text-sm bg-(--status-success)/5">
          تم الجمع ({collect.data.mode}): استُرجع <span className="num">{collect.data.retrieved}</span> ·
          أُضيف <span className="num">{collect.data.inserted}</span> ·
          مكرر <span className="num">{collect.data.duplicates}</span> ·
          مُصفّى <span className="num">{collect.data.filtered}</span>
        </div>
      )}
      {collect.error && (
        <div className="card p-3 text-sm bg-(--status-danger-soft) text-(--status-danger)">{(collect.error as Error).message}</div>
      )}

      <AsyncState loading={pageReads.some(read => read.isLoading)} error={readError}
        onRetry={() => Promise.all(pageReads.map(read => read.refetch()))}>
      <div className="space-y-3">
        {(data?.items ?? []).map((q) => {
          const st = queryStateLabel(q);
          const actions = queryActions(q, can);
          return (
            <div key={q.id} className={`card p-4 ${q.deleted_at ? 'opacity-70' : ''}`}>
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{q.name}</span>
                    <span className={`badge ${TONE[st.tone]}`}>{st.text}</span>
                    {q.is_system && <span className="badge bg-(--status-info-soft) text-(--status-info)" title="يُبنى تلقائيًا من قاموس البرنامج">تلقائي</span>}
                    <span className="badge bg-[var(--surface-3)] num">v{q.version}</span>
                    <span className="inline-flex items-center gap-1.5 text-xs muted">
                      <span className="w-2 h-2 rounded-full" style={{ background: q.program_color }} />
                      {q.program_name}
                    </span>
                  </div>
                  {q.status === 'paused' && q.pause_reason && !q.deleted_at && (
                    <p className="text-xs text-(--status-warning) mt-1">سبب الإيقاف: {q.pause_reason}</p>
                  )}
                  {q.deleted_at && <p className="text-xs muted mt-1">حُذف منطقيًا {fmtRelative(q.deleted_at)} — الإصدارات والمنشورات المرتبطة محفوظة.</p>}
                  <pre className="text-xs mt-2 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all"
                       style={{ background: 'var(--surface-2)', direction: 'ltr', textAlign: 'left' }}>{q.compiled}</pre>
                </div>
                <div className="flex flex-wrap justify-end gap-2 shrink-0 max-w-64">
                  {actions.test && <Link to={`/queries/${q.id}/test`} className="btn-ghost !text-xs"><FlaskConical size={14} /> اختبار</Link>}
                  {actions.collect && (
                    <Button variant="primary" type="button" className="!text-xs" disabled={collect.isPending}
                            onClick={() => confirmation.request({title:'جمع بيانات الاستعلام',description:`الجمع الآن لاستعلام «${q.name}» قد يستهلك الميزانية حسب وضع التشغيل والإعدادات الحالية.`,confirmLabel:'جمع الآن',allowed:can=>can(PERMISSIONS.QUERIES_WRITE),execute:()=>collect.mutateAsync(q.id)})}><Play size={14} /> جمع الآن</Button>
                  )}
                  {actions.edit && (
                    <Button variant="ghost" type="button" className="!text-xs" onClick={() => setEditing(q)}><Pencil size={14} /> تعديل</Button>
                  )}
                  {actions.pause && (
                    <Button variant="ghost" type="button" className="!text-xs"
                      onClick={() => confirmation.request({ title: 'إيقاف الاستعلام', description: `سيتوقف جمع «${q.name}» المجدول والمباشر فورًا، ويبقى موقوفًا بعد إعادة تشغيل الخدمات حتى يستأنفه مستخدم.`, confirmLabel: 'إيقاف', danger: true, allowed: can => can(PERMISSIONS.QUERIES_WRITE), execute: () => run(api.post(`/queries/${q.id}/pause`, { reason: 'إيقاف يدوي من صفحة الاستعلامات' }), `أُوقف «${q.name}».`) })}>
                      <Pause size={14} /> إيقاف
                    </Button>
                  )}
                  {actions.resume && (
                    <Button variant="ghost" type="button" className="!text-xs"
                      onClick={() => confirmation.request({ title: 'استئناف الاستعلام', description: resumeDescription(q.name, q), confirmLabel: q.resume_to === 'active' ? 'استئناف الجمع' : 'إعادة إلى مسودة', allowed: can => can(PERMISSIONS.QUERIES_WRITE) && (q.resume_to !== 'active' || can(PERMISSIONS.QUERY_PROMOTE)), execute: () => run(api.post(`/queries/${q.id}/resume`), q.resume_to === 'active' ? `استُؤنف «${q.name}».` : `أُعيد «${q.name}» إلى مسودة.`) })}>
                      <RotateCcw size={14} /> استئناف
                    </Button>
                  )}
                  {actions.resumeBlockedReason && <span className="text-xs muted">{actions.resumeBlockedReason}</span>}
                  {actions.remove && (
                    <Button variant="ghost" type="button" className="!text-xs text-(--status-danger)"
                      onClick={() => confirmation.request({ title: 'حذف الاستعلام منطقيًا', description: `سيُخفى «${q.name}» ولن يدخل الجمع أو الجدولة مجددًا. تبقى إصداراته (${q.version_count}) واختباراته وكل المنشورات والتقارير المرتبطة به كما هي، ويُسجَّل الإجراء في سجل التدقيق.`, confirmLabel: 'حذف منطقي', danger: true, allowed: can => can(PERMISSIONS.QUERIES_WRITE), execute: () => run(api.del(`/queries/${q.id}`), `حُذف «${q.name}» منطقيًا.`) })}>
                      <Trash2 size={14} /> حذف
                    </Button>
                  )}
                  <Button variant="ghost" type="button" className="!text-xs" onClick={() => setHistory(q)}><History size={14} /> الإصدارات</Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs muted">
                <span>الوحدات: <span className="num">{fmtNum(q.total_units)}</span></span>
                <span>مرتبط: <span className="num">{fmtNum(q.total_relevant)}</span></span>
                <span>الدقة: <span className="num">{fmtPct(q.precision_rate === null ? null : Number(q.precision_rate))}</span></span>
                <span>اختبارات: <span className="num">{q.test_count}</span></span>
                <span>آخر تشغيل: {q.last_run_at ? fmtRelative(q.last_run_at) : '—'}</span>
              </div>
            </div>
          );
        })}
        {!data?.items?.length && (
          <div className="card p-10 text-center">
            <p className="muted mb-3">لا توجد استعلامات بعد.</p>
            {can(PERMISSIONS.QUERIES_WRITE) && <Link to="/queries/new" className="btn-primary"><Plus size={16} /> أنشئ أول استعلام</Link>}
          </div>
        )}
      </div>
      </AsyncState>

      {editing && <EditQueryDialog query={editing} onClose={() => setEditing(null)}
        onSaved={(text) => { setEditing(null); notice.success(text); refresh(); }} />}
      {history && <VersionsDialog query={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** Name, description and page size. Changing the query logic is a new version built and tested in the builder. */
function EditQueryDialog({ query, onClose, onSaved }: { query: Row; onClose: () => void; onSaved: (text: string) => void }) {
  const [name, setName] = useState(query.name);
  const [description, setDescription] = useState(query.description ?? '');
  const [maxResults, setMaxResults] = useState(String(query.max_results_per_call));
  const body = {
    ...(name.trim() !== query.name ? { name: name.trim() } : {}),
    ...(description.trim() !== (query.description ?? '') ? { description: description.trim() } : {}),
    ...(Number(maxResults) !== query.max_results_per_call ? { maxResultsPerCall: Number(maxResults) } : {}),
  };
  const validMax = Number.isInteger(Number(maxResults)) && Number(maxResults) >= 10 && Number(maxResults) <= 100;
  const unchanged = Object.keys(body).length === 0;
  const save = useMutation({ mutationFn: () => api.patch(`/queries/${query.id}`, body), onSuccess: () => onSaved(`حُفظت تعديلات «${name.trim()}».`) });
  return (
    <ModalSurface label="تعديل الاستعلام" onClose={onClose} busy={save.isPending}
      overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-md space-y-4"
      as="form" onSubmit={(e) => { e.preventDefault(); if (!save.isPending && !unchanged && validMax && name.trim().length >= 2) save.mutate(); }}>
      <h3 className="font-bold">تعديل الاستعلام</h3>
      <FormField label="الاسم" required>
        <FieldInput className="input w-full" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus data-dialog-initial-focus />
      </FormField>
      <FormField label="الوصف (اختياري)">
        <FieldTextarea className="input w-full" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
      <FormField label="الحد الأقصى للنتائج في كل طلب" error={validMax ? undefined : 'بين 10 و100'}>
        <FieldInput className="input w-full num" type="number" min={10} max={100} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} dir="ltr" />
      </FormField>
      <p className="text-xs muted">تعديل منطق الاستعلام نفسه يتم بإنشاء نسخة جديدة واختبارها، ولا تُحذف أو يُعاد ترقيم الإصدارات السابقة.</p>
      {save.error && <p role="alert" className="text-sm text-(--status-danger)">{(save.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <ModalCloseButton type="button" className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton>
        <Button variant="primary" type="submit" disabled={save.isPending || unchanged || !validMax || name.trim().length < 2}>{save.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</Button>
      </div>
    </ModalSurface>
  );
}

function VersionsDialog({ query, onClose }: { query: Row; onClose: () => void }) {
  const versions = useQuery({
    queryKey: ['query-versions', query.id],
    queryFn: () => api.get<{ items: Version[] }>(`/queries/${query.id}/versions`),
  });
  return (
    <ModalSurface label={`إصدارات ${query.name}`} onClose={onClose}
      overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-2xl max-h-[85vh] overflow-y-auto space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-bold">سجل الإصدارات — {query.name}</h3>
        <ModalCloseButton type="button" className="btn-ghost !text-xs" onClick={onClose}>إغلاق</ModalCloseButton>
      </div>
      <AsyncState loading={versions.isLoading} error={versions.error} onRetry={() => versions.refetch()}>
        <ol className="space-y-2">
          {(versions.data?.items ?? []).map((v) => (
            <li key={v.id} className="rounded p-3" style={{ background: 'var(--surface-2)' }}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="badge bg-[var(--surface-3)] num">v{v.version}</span>
                {v.version === query.version && <span className="badge bg-(--status-success-soft) text-(--status-success)">الحالي</span>}
                <span className="muted">{fmtDateTime(v.created_at)}</span>
                {v.created_by_name && <span className="muted">· {v.created_by_name}</span>}
                {v.tested_precision !== null && <span className="muted">· دقة الاختبار <span className="num">{fmtPct(v.tested_precision)}</span></span>}
              </div>
              {v.change_summary && <p className="text-sm mt-1">{v.change_summary}</p>}
              <pre className="text-xs mt-2 whitespace-pre-wrap break-all" style={{ direction: 'ltr', textAlign: 'left' }}>{v.compiled}</pre>
            </li>
          ))}
        </ol>
      </AsyncState>
    </ModalSurface>
  );
}
