import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNum, fmtPct, fmtRelative } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';

interface Row {
  id: string; name: string; status: string; program_name: string; program_color: string;
  compiled: string; version: number; total_units: number; total_relevant: number;
  precision_rate: string | null; test_count: number; best_precision: number | null;
  last_run_at: string | null; is_paused: boolean; polling_tier: string;
}

const STATUS: Record<string, { text: string; cls: string }> = {
  draft:    { text: 'مسودة',  cls: 'bg-slate-500/15 text-slate-600 dark:text-slate-400' },
  tested:   { text: 'مُختبَر', cls: 'bg-brand-500/15 text-brand-600 dark:text-brand-400' },
  approved: { text: 'معتمد',  cls: 'bg-violet-500/15 text-violet-600' },
  active:   { text: 'نشط',    cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  paused:   { text: 'موقوف',  cls: 'bg-amber-500/15 text-amber-600' },
  archived: { text: 'مؤرشف',  cls: 'bg-slate-500/15 text-slate-500' },
};

export default function Queries() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['queries'], queryFn: () => api.get<{ items: Row[] }>('/queries') });

  const collect = useMutation({
    mutationFn: (id: string) => api.post<{ retrieved: number; inserted: number; duplicates: number; filtered: number; mode: string }>(`/posts/collect/${id}`),
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">الاستعلامات</h1>
          <p className="text-sm muted">لا يصل استعلام إلى الإنتاج قبل اجتياز اختبار Sandbox بدقة ≥ 70%</p>
        </div>
        {can(PERMISSIONS.QUERIES_WRITE) && (
          <Link to="/queries/new" className="btn-primary">+ استعلام جديد</Link>
        )}
      </div>

      {collect.data && (
        <div className="card p-3 text-sm bg-emerald-500/5">
          تم الجمع ({collect.data.mode}): استُرجع <span className="num">{collect.data.retrieved}</span> ·
          أُضيف <span className="num">{collect.data.inserted}</span> ·
          مكرر <span className="num">{collect.data.duplicates}</span> ·
          مُصفّى <span className="num">{collect.data.filtered}</span>
        </div>
      )}
      {collect.error && (
        <div className="card p-3 text-sm bg-red-500/10 text-red-600">{(collect.error as Error).message}</div>
      )}

      <div className="space-y-3">
        {(data?.items ?? []).map((q) => {
          const st = STATUS[q.status] ?? STATUS.draft;
          return (
            <div key={q.id} className="card p-4">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{q.name}</span>
                    <span className={`badge ${st.cls}`}>{st.text}</span>
                    <span className="badge bg-[var(--surface-3)] num">v{q.version}</span>
                    <span className="inline-flex items-center gap-1.5 text-xs muted">
                      <span className="w-2 h-2 rounded-full" style={{ background: q.program_color }} />
                      {q.program_name}
                    </span>
                  </div>
                  <pre className="text-xs mt-2 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all"
                       style={{ background: 'var(--surface-2)', direction: 'ltr', textAlign: 'left' }}>{q.compiled}</pre>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Link to={`/queries/${q.id}/test`} className="btn-ghost !text-xs">اختبار</Link>
                  {q.status === 'active' && can(PERMISSIONS.QUERIES_WRITE) && (
                    <button className="btn-primary !text-xs" disabled={collect.isPending}
                            onClick={() => collect.mutate(q.id)}>جمع الآن</button>
                  )}
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
            {can(PERMISSIONS.QUERIES_WRITE) && <Link to="/queries/new" className="btn-primary">أنشئ أول استعلام</Link>}
          </div>
        )}
      </div>
    </div>
  );
}
