import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { ChevronDown, ScrollText, Settings2 } from 'lucide-react';

const AUDIT_PAGE_SIZE = 10;

interface Health {
  database: { ok: boolean; latencyMs: number };
  collection: { mode: string; liveXApi: boolean; filteredStream: boolean; dryRun: boolean; hasToken: boolean };
  ai: { serviceUrl: string; allowInternalToExternal: boolean };
  lastSuccessfulRequest: { occurred_at: string; endpoint: string; mode: string } | null;
  lastFailedRequest: { occurred_at: string; error_code: string; error_message: string } | null;
  lastBudgetDenial: {
    occurred_at: string; reason: string; scope: string;
    current_usage: string; limit_value: string;
  } | null;
  counts: Record<string, string>;
  classificationStages: Array<{ stage: number; n: number }>;
  queue: { status: string; note: string };
}

const COUNT_LABELS: Record<string, string> = {
  posts: 'المنشورات', authors: 'الحسابات', queries: 'الاستعلامات',
  active_queries: 'استعلامات نشطة', keywords: 'الكلمات',
  api_calls: 'طلبات API', denials: 'طلبات مرفوضة', active_kills: 'إيقافات نشطة',
};

export default function Admin() {
  const { data: h } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/admin/system-health'),
    refetchInterval: 15_000,
  });
  const { data: audit } = useQuery({
    queryKey: ['audit'],
    queryFn: () => api.get<{ items: Array<Record<string, string>> }>('/admin/audit-log?limit=200'),
  });
  const [auditVisible, setAuditVisible] = useState(AUDIT_PAGE_SIZE);

  const Dot = ({ ok }: { ok: boolean }) => (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-slate-400'}`} />
  );

  // Non-null means an active, hard-limit budget is exceeded right now (not
  // just "was exceeded at some point") — see admin.routes.ts.
  const denial = h?.lastBudgetDenial;

  const REASON_AR: Record<string, string> = { HOUR: 'الحصة الساعية', DAY: 'الحصة اليومية', MONTH: 'الحصة الشهرية' };

  return (
    <div className="space-y-5">
      <div className="page-heading">
        <div>
          <h1 className="flex items-center gap-2.5"><Settings2 size={22} className="text-brand-500" /> لوحة النظام</h1>
          <p>حالة الخدمات والاستهلاك وسجل التدقيق</p>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-sm font-medium mb-3">الخدمات</div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="flex items-center gap-2"><Dot ok={!!h?.database.ok} /> قاعدة البيانات</span>
              <span className="num muted">{h?.database.latencyMs}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="flex items-center gap-2"><Dot ok /> واجهة API</span>
              <span className="muted text-xs">تعمل</span>
            </div>
            <div className="flex justify-between">
              <span className="flex items-center gap-2"><Dot ok={false} /> Worker والطوابير</span>
              <span className="muted text-xs">Phase 1.D</span>
            </div>
            <div className="flex justify-between">
              <span className="flex items-center gap-2"><Dot ok={false} /> خدمة الذكاء</span>
              <span className="muted text-xs">Phase 2</span>
            </div>
          </div>
        </div>

        <div className="card p-4">
          <div className="text-sm font-medium mb-3">وضع الجمع</div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span>الوضع</span><span className="num font-medium">{h?.collection.mode}</span></div>
            <div className="flex justify-between"><span>LIVE_X_API</span><span className="num">{String(h?.collection.liveXApi)}</span></div>
            <div className="flex justify-between"><span>X Filtered Stream</span><span className="num">{h?.collection.filteredStream ? 'لحظي' : 'متوقف'}</span></div>
            <div className="flex justify-between"><span>X_DRY_RUN</span><span className="num">{String(h?.collection.dryRun)}</span></div>
            <div className="flex justify-between"><span>مفتاح X</span><span className="num">{h?.collection.hasToken ? 'موجود' : 'غير موجود'}</span></div>
            <div className="flex justify-between text-xs pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
              <span className="muted">بيانات داخلية لمزود خارجي</span>
              <span className={`num ${h?.ai.allowInternalToExternal ? 'text-red-600' : 'text-emerald-600'}`}>
                {h?.ai.allowInternalToExternal ? 'مسموح' : 'ممنوع'}
              </span>
            </div>
          </div>
        </div>

        <div className="card p-4">
          <div className="text-sm font-medium mb-3">آخر طلبات X</div>
          <div className="text-sm space-y-3">
            <div>
              <div className="text-xs muted">آخر نجاح</div>
              <div className="text-xs">
                {h?.lastSuccessfulRequest
                  ? `${fmtDateTime(h.lastSuccessfulRequest.occurred_at)} · ${h.lastSuccessfulRequest.mode}`
                  : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs muted">آخر فشل</div>
              <div className="text-xs text-red-600">{h?.lastFailedRequest?.error_code ?? '—'}</div>
            </div>
            {denial && (
              <div className="rounded-lg bg-amber-500/15 px-2.5 py-2">
                <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  ⏸ الجمع متوقف الآن — {REASON_AR[denial.reason] ?? denial.reason} ممتلئة
                </div>
                <div className="text-xs muted mt-0.5 num">
                  {denial.current_usage}/{denial.limit_value}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {Object.entries(h?.counts ?? {}).map(([k, v]) => (
          <div key={k} className="card p-3">
            <div className="text-xs muted">{COUNT_LABELS[k] ?? k}</div>
            <div className="text-xl font-bold num">{v}</div>
          </div>
        ))}
      </div>

      {!!h?.classificationStages?.length && (
        <div className="card p-4">
          <div className="text-sm font-medium mb-1">توزيع مراحل التصنيف</div>
          <p className="text-xs muted mb-3">
            الهدف: ≤ 10% من المنشورات تصل المرحلة 3 (النموذج المكلف).
            ارتفاع النسبة مؤشر على أن المرحلة 2 تحتاج إعادة تدريب.
          </p>
          <div className="flex gap-6">
            {h.classificationStages.map((s) => (
              <div key={s.stage}>
                <div className="text-xs muted">مرحلة {s.stage}</div>
                <div className="text-lg font-bold num">{s.n}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b font-semibold flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
          <ScrollText size={16} className="text-brand-500" /> سجل التدقيق
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">الوقت</th>
                <th className="th">المستخدم</th>
                <th className="th">العملية</th>
                <th className="th">الكيان</th>
                <th className="th">الخطورة</th>
              </tr>
            </thead>
            <tbody>
              {(audit?.items ?? []).slice(0, auditVisible).map((a) => (
                <tr key={a.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="td text-xs muted">{fmtDateTime(a.occurred_at)}</td>
                  <td className="td text-xs">{a.user_email ?? '—'}</td>
                  <td className="td"><span className="num text-xs">{a.action}</span></td>
                  <td className="td text-xs">{a.entity_label ?? a.entity_type}</td>
                  <td className="td">
                    <span className={`badge ${
                      a.severity === 'critical' ? 'bg-red-500/15 text-red-600'
                        : a.severity === 'warning' ? 'bg-amber-500/15 text-amber-600'
                        : 'bg-[var(--surface-3)]'
                    }`}>{a.severity}</span>
                  </td>
                </tr>
              ))}
              {!audit?.items?.length && (
                <tr><td colSpan={5} className="td text-center muted py-8">لا توجد سجلات</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {!!audit?.items?.length && audit.items.length > auditVisible && (
          <button
            className="w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium muted hover:text-[var(--text)] hover:bg-[var(--surface-2)] border-t transition"
            style={{ borderColor: 'var(--border)' }}
            onClick={() => setAuditVisible((v) => v + AUDIT_PAGE_SIZE)}
          >
            <ChevronDown size={14} /> عرض المزيد ({audit.items.length - auditVisible} متبقٍ)
          </button>
        )}
      </div>
    </div>
  );
}
