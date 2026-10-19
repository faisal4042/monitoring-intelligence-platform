import { useConfirmAction } from '../components/ConfirmAction';
import AsyncState from '../components/AsyncState';
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtPct, fmtMoney, fmtNum, fmtDateTime } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';
import { ArrowRight, FlaskConical, ListChecks, Lightbulb, Rocket } from 'lucide-react';

import { Button } from '../components/ui/Button';
interface TestPost {
  id: string; text: string; author?: string; authorName?: string; followers?: number;
  label: string; confidence: number; reasonAr: string; matchedTerms: string[];
  intent: string | null; sentiment: string; createdAt: string;
  metrics: { like: number; repost: number; reply: number; quote: number };
}
interface Rec { type: string; severity: 'info' | 'warning' | 'critical'; messageAr: string }
interface TestResult {
  mode: string;
  test: { precision_score: string | null; units_consumed: number; cost_estimate: string | null; passed: boolean;
          count_relevant: number; count_irrelevant: number; count_advertisement: number;
          count_spam: number; count_unknown: number; posts_returned: number };
  posts: TestPost[];
  recommendations: Rec[];
  contribution: Record<string, { matched: number; noise: number; noiseRate: number }>;
}

const LABEL_META: Record<string, { text: string; cls: string }> = {
  relevant:      { text: 'مرتبط',   cls: 'bg-(--status-success-soft) text-(--status-success)' },
  irrelevant:    { text: 'غير مرتبط', cls: 'bg-slate-500/15 text-slate-600 dark:text-slate-400' },
  advertisement: { text: 'إعلان',   cls: 'bg-(--status-warning-soft) text-(--status-warning)' },
  spam:          { text: 'spam',    cls: 'bg-(--status-danger-soft) text-(--status-danger)' },
  unknown:       { text: 'غير محدد', cls: 'bg-(--status-warning-soft) text-(--status-warning)' },
};

export default function QuerySandbox() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const confirmation = useConfirmAction();
  const qc = useQueryClient();
  const [sampleSize, setSampleSize] = useState(25);
  const [result, setResult] = useState<TestResult | null>(null);

  const queryRead = useQuery({
    queryKey: ['query', id],
    queryFn: () => api.get<{ name: string; status: string; compiled: string; program_name: string; version: number }>(`/queries/${id}`),
  });
  const { data: query } = queryRead;
  const historyRead = useQuery({
    queryKey: ['query-tests', id],
    queryFn: () => api.get<{ items: Array<{ id: string; created_at: string; sample_size: number; precision_score: string | null; units_consumed: number; passed: boolean; version: number }> }>(`/queries/${id}/tests`),
  });
  const { data: history } = historyRead;

  const runTest = useMutation({
    mutationFn: () => api.post<TestResult>(`/queries/${id}/test`, { sampleSize }),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries(); },
  });

  const promote = useMutation({
    mutationFn: () => api.post(`/queries/${id}/promote`),
    onSuccess: () => qc.invalidateQueries(),
  });

  const precision = result?.test?.precision_score === null || result?.test?.precision_score === undefined
    ? null : Number(result.test.precision_score);

  const noisyTerms = Object.entries(result?.contribution ?? {})
    .filter(([, s]) => s.matched >= 2)
    .sort((a, b) => b[1].noiseRate - a[1].noiseRate);

  const pageReads = [queryRead, historyRead];
  const readError = pageReads.find(read => read.error)?.error;
  if (readError || pageReads.some(read => read.isLoading)) return <AsyncState
    loading={pageReads.some(read => read.isLoading)} error={readError}
    onRetry={() => Promise.all(pageReads.map(read => read.refetch()))} />;

  return (
    <div className="space-y-5 max-w-6xl">{confirmation.dialog}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link to="/queries" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"><ArrowRight size={14} /> الاستعلامات</Link>
          <h1 className="flex items-center gap-2.5 text-xl font-bold mt-1"><FlaskConical size={20} className="text-brand-600" /> اختبار الاستعلام — {query?.name}</h1>
          <p className="text-sm muted">{query?.program_name} · الإصدار {query?.version}</p>
        </div>
        <span className={`badge ${query?.status === 'active' ? 'bg-(--status-success-soft) text-(--status-success)' : 'bg-[var(--surface-3)]'}`}>
          {{ draft: 'مسودة', tested: 'مُختبَر', approved: 'معتمد', active: 'نشط', paused: 'موقوف' }[query?.status ?? ''] ?? query?.status}
        </span>
      </div>

      <div className="card p-4">
        <pre className="text-xs p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all"
             style={{ background: 'var(--surface-2)', direction: 'ltr', textAlign: 'left' }}>
          {query?.compiled}
        </pre>
      </div>

      <div className="card p-5">
        <h2 className="font-semibold mb-1">تشغيل اختبار</h2>
        <p className="text-sm muted mb-4">
          العينة تُخصم من الميزانية فعلياً وتُسجَّل في الاستهلاك — الاختبار ليس مجانياً، ويجب أن يظهر في التكلفة.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm mb-1">حجم العينة</label>
            <div className="flex gap-1">
              {[10, 25, 50, 100].map((n) => (
                <button
                  key={n}
                  onClick={() => setSampleSize(n)}
                  className={`btn !px-3 !py-1.5 num ${sampleSize === n ? 'bg-(--selected-bg) text-(--selected-fg)' : 'btn-ghost'}`}
                >{n}</button>
              ))}
            </div>
          </div>
          <Button variant="primary" type="submit"
            hidden={!can(PERMISSIONS.QUERY_TEST)} disabled={!can(PERMISSIONS.QUERY_TEST) || runTest.isPending}
            onClick={() => confirmation.request({title:'تشغيل اختبار الاستعلام',description:`اختبار «${query?.name}» بعينة ${sampleSize} قد يجمع بيانات من إكس ويستهلك الميزانية حسب وضع التشغيل.`,confirmLabel:'تشغيل الاختبار',allowed:can=>can(PERMISSIONS.QUERY_TEST),execute:()=>runTest.mutateAsync()})}>
            {runTest.isPending ? 'جارٍ الاختبار…' : 'تشغيل الاختبار'}
          </Button>
        </div>
        {runTest.error && (
          <div className="mt-3 text-sm p-3 rounded-lg bg-(--status-danger-soft) text-(--status-danger)">
            {(runTest.error as Error).message}
          </div>
        )}
      </div>

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-4">
              <div className="text-xs muted mb-1">الدقة</div>
              <div className={`text-2xl font-bold num ${precision !== null && precision >= 0.7 ? 'text-(--status-success)' : 'text-(--status-danger)'}`}>
                {fmtPct(precision)}
              </div>
              <div className="text-xs muted mt-1">الحد الأدنى للترقية 70%</div>
            </div>
            <div className="card p-4">
              <div className="text-xs muted mb-1">مرتبط</div>
              <div className="text-2xl font-bold num text-(--status-success)">{result.test.count_relevant}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs muted mb-1">إعلانات ومحتوى مزعج</div>
              <div className="text-2xl font-bold num text-(--status-warning)">
                {result.test.count_advertisement + result.test.count_spam}
              </div>
            </div>
            <div className="card p-4">
              <div className="text-xs muted mb-1">غير محدد</div>
              <div className="text-2xl font-bold num text-(--status-warning)">{result.test.count_unknown}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs muted mb-1">التكلفة</div>
              <div className="text-2xl font-bold num">{fmtMoney(Number(result.test.cost_estimate ?? 0))}</div>
              <div className="text-xs muted mt-1 num">{result.test.units_consumed} وحدة · {result.mode}</div>
            </div>
          </div>

          {result.recommendations.length > 0 && (
            <div className="card p-5">
              <h2 className="flex items-center gap-2 font-semibold mb-3"><Lightbulb size={17} className="text-brand-600" /> التوصيات</h2>
              <div className="space-y-2">
                {result.recommendations.map((r, i) => (
                  <div
                    key={i}
                    className={`text-sm p-3 rounded-lg leading-relaxed ${
                      r.severity === 'critical' ? 'bg-(--status-danger-soft) text-(--status-danger)'
                        : r.severity === 'warning' ? 'bg-(--status-warning-soft) text-(--status-warning)'
                        : 'bg-(--status-success-soft) text-(--status-success)'
                    }`}
                  >{r.messageAr}</div>
                ))}
              </div>
            </div>
          )}

          {noisyTerms.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                <div className="font-semibold">مساهمة الكلمات في الضجيج</div>
                <div className="text-xs muted">لا يكفي معرفة أن الدقة منخفضة — هذا يبيّن أي كلمة هي السبب</div>
              </div>
              <table className="w-full">
                <thead style={{ background: 'var(--surface-2)' }}>
                  <tr><th className="th">الكلمة</th><th className="th">طابقت</th><th className="th">ضجيج</th><th className="th">نسبة الضجيج</th></tr>
                </thead>
                <tbody>
                  {noisyTerms.map(([term, s]) => (
                    <tr key={term} className={`border-t ${s.noiseRate > 0.5 ? 'bg-(--status-danger)/5' : ''}`} style={{ borderColor: 'var(--border)' }}>
                      <td className="td font-medium">{term}</td>
                      <td className="td num">{s.matched}</td>
                      <td className="td num">{s.noise}</td>
                      <td className={`td num ${s.noiseRate > 0.5 ? 'text-(--status-danger) font-semibold' : ''}`}>{fmtPct(s.noiseRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b font-semibold" style={{ borderColor: 'var(--border)' }}>
              عينة النتائج ({result.posts.length})
            </div>
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {result.posts.map((p) => {
                const meta = LABEL_META[p.label] ?? LABEL_META.unknown;
                return (
                  <div key={p.id} className="p-4">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="text-sm">
                        <span className="font-medium">{p.authorName}</span>
                        <span className="muted text-xs num"> @{p.author} · {fmtNum(p.followers)} متابع</span>
                      </div>
                      <span className={`badge ${meta.cls} shrink-0`}>
                        {meta.text} <span className="num opacity-70">{fmtPct(p.confidence)}</span>
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed mb-2">{p.text}</p>
                    <div className="text-xs muted">{p.reasonAr}</div>
                    {p.matchedTerms.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {p.matchedTerms.map((t) => (
                          <span key={t} className="badge bg-[var(--surface-3)] text-xs">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card p-5 flex items-center justify-between gap-4">
            <div>
              <div className="font-semibold">ترقية إلى الإنتاج</div>
              <p className="text-sm muted">
                {precision !== null && precision >= 0.7
                  ? 'الاستعلام اجتاز الحد الأدنى للدقة ويمكن ترقيته.'
                  : 'الترقية محجوبة — الدقة أقل من 70%. عدّل الاستعلام وأعد الاختبار.'}
              </p>
            </div>
            <Button variant="primary" type="submit"
              className="shrink-0"
              hidden={!can(PERMISSIONS.QUERY_PROMOTE)} disabled={!can(PERMISSIONS.QUERY_PROMOTE) || precision === null || precision < 0.7 || promote.isPending}
              onClick={() => confirmation.request({title:'ترقية الاستعلام',description:`سيتم ترقية «${query?.name}» وفق نتيجة الاختبار وسياسة الخادم الحالية. يؤثر ذلك على قواعد الرصد.`,confirmLabel:'ترقية الاستعلام',allowed:can=>can(PERMISSIONS.QUERY_PROMOTE),execute:()=>promote.mutateAsync()})}>
              <Rocket size={16} /> ترقية للإنتاج
            </Button>
          </div>
          {promote.error && (
            <div className="text-sm p-3 rounded-lg bg-(--status-danger-soft) text-(--status-danger)">{(promote.error as Error).message}</div>
          )}
        </>
      )}

      {!!history?.items?.length && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b font-semibold flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
            <ListChecks size={16} className="text-brand-600" /> سجل الاختبارات
          </div>
          <table className="w-full">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">التاريخ</th><th className="th">الإصدار</th><th className="th">العينة</th>
                <th className="th">الدقة</th><th className="th">الوحدات</th><th className="th">النتيجة</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((t) => (
                <tr key={t.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="td text-xs muted">{fmtDateTime(t.created_at)}</td>
                  <td className="td num">v{t.version}</td>
                  <td className="td num">{t.sample_size}</td>
                  <td className="td num">{fmtPct(t.precision_score === null ? null : Number(t.precision_score))}</td>
                  <td className="td num">{t.units_consumed}</td>
                  <td className="td">
                    <span className={`badge ${t.passed ? 'bg-(--status-success-soft) text-(--status-success)' : 'bg-(--status-danger-soft) text-(--status-danger)'}`}>
                      {t.passed ? 'اجتاز' : 'لم يجتز'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
