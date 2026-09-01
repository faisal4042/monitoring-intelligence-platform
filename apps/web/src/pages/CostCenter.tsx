import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNum, fmtMoney, fmtPct, fmtDateTime } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';
import { BadgeDollarSign, Ban, SearchCode, Wallet } from 'lucide-react';

interface Overview {
  spentTodayUnits: number; spentTodayCost: number;
  spentMonthUnits: number; spentMonthCost: number;
  monthUnitLimit: number | null; monthCostLimit: number | null;
  remainingUnits: number | null; remainingCost: number | null;
  projectedMonthCost: number; projectedMonthUnits: number;
  usagePct: number; costPerRelevantPost: number | null; totalRelevant: number;
  collectionMode: string;
  pricing: { unitPrice: number; monthlyPriceUsd: number; monthlyPostQuota: number; model: string };
  killSwitches: Array<{ id: string; scope: string; reason: string; activated_at: string; activated_by_name?: string }>;
}

interface QueryRow {
  id: string; name: string; status: string; program_name: string; program_color: string;
  requests: number; units: number; cost: number; relevant: number; irrelevant: number;
  liveRequests: number; emptyRequests: number; emptyRequestPct: number | null;
  precision: number | null; noisePct: number | null; costPerRelevant: number | null; wastedCost: number;
}

interface Budget {
  id: string; scope: string; period: string; unit_limit: number | null; cost_limit: string | null;
  is_hard_limit: boolean; program_name: string | null; units_used: number | null;
}

interface Denial {
  id: number; occurred_at: string; reason: string; scope: string;
  requested_units: number; query_name: string | null; limit_value: string | null;
}

export default function CostCenter() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'queries' | 'budgets' | 'denials'>('queries');
  const [editing, setEditing] = useState<Budget | null>(null);
  const [draft, setDraft] = useState({ unitLimit: 0, costLimit: 0 });

  const { data: o } = useQuery({ queryKey: ['cost-overview'], queryFn: () => api.get<Overview>('/cost/overview'), refetchInterval: 30_000 });
  const { data: queries } = useQuery({ queryKey: ['cost-queries'], queryFn: () => api.get<{ items: QueryRow[] }>('/cost/queries') });
  const { data: budgets } = useQuery({ queryKey: ['cost-budgets'], queryFn: () => api.get<{ items: Budget[] }>('/cost/budgets') });
  const { data: denials } = useQuery({ queryKey: ['cost-denials'], queryFn: () => api.get<{ items: Denial[] }>('/cost/denials') });

  const saveBudget = useMutation({
    mutationFn: (b: Budget) => api.put(`/cost/budgets/${b.id}`, { unitLimit: draft.unitLimit, costLimit: draft.costLimit }),
    onSuccess: () => { setEditing(null); qc.invalidateQueries(); },
  });

  const pct = o?.usagePct ?? 0;
  const bar = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  const overBudget = o?.monthCostLimit != null && o.projectedMonthCost > o.monthCostLimit;

  return (
    <div className="space-y-5">
      <div className="page-heading">
        <div>
          <h1 className="flex items-center gap-2.5"><BadgeDollarSign size={22} className="text-brand-500" /> مركز التكلفة</h1>
          <p>الاستهلاك بوحدات الحصة (عدد المنشورات) — وهي العملة الحقيقية لـ X API</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card p-4">
          <div className="text-xs muted mb-1">استهلاك اليوم</div>
          <div className="text-2xl font-bold num">{fmtNum(o?.spentTodayUnits)}</div>
          <div className="text-xs muted mt-1 num">{fmtMoney(o?.spentTodayCost)}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs muted mb-1">استهلاك الشهر</div>
          <div className="text-2xl font-bold num">{fmtNum(o?.spentMonthUnits)}</div>
          <div className="text-xs muted mt-1 num">{fmtMoney(o?.spentMonthCost)}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs muted mb-1">المتبقي</div>
          <div className="text-2xl font-bold num">{o?.remainingUnits === null ? '∞' : fmtNum(o?.remainingUnits)}</div>
          <div className="text-xs muted mt-1 num">{o?.remainingCost === null ? '—' : fmtMoney(o?.remainingCost)}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs muted mb-1">التوقع لنهاية الشهر</div>
          <div className={`text-2xl font-bold num ${overBudget ? 'text-red-600 dark:text-red-400' : ''}`}>
            {fmtMoney(o?.projectedMonthCost)}
          </div>
          <div className="text-xs muted mt-1 num">{fmtNum(o?.projectedMonthUnits)} وحدة</div>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex justify-between text-sm mb-2">
          <span>استهلاك الحصة الشهرية</span>
          <span className="num font-medium">{pct.toFixed(1)}%</span>
        </div>
        <div className="h-3 rounded-full overflow-hidden" style={{ background: 'var(--surface-3)' }}>
          <div className={`h-full ${bar} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="flex justify-between text-xs muted mt-2">
          {[50, 70, 80, 90, 100].map((t) => (
            <span key={t} className={pct >= t ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}>{t}%</span>
          ))}
        </div>
        {o && (
          <p className="text-xs muted mt-3 leading-relaxed">
            سعر الوحدة <span className="num">{fmtMoney(o.pricing.unitPrice)}</span> مشتق من
            <span className="num"> ${o.pricing.monthlyPriceUsd}</span> ÷
            <span className="num"> {fmtNum(o.pricing.monthlyPostQuota)}</span> منشور.
            {o.costPerRelevantPost !== null && (
              <> · التكلفة لكل منشور مرتبط: <span className="num font-medium">{fmtMoney(o.costPerRelevantPost)}</span></>
            )}
          </p>
        )}
      </div>

      {o?.killSwitches && o.killSwitches.length > 0 && (
        <div className="card p-4 bg-red-500/5 border-red-500/30">
          <div className="font-semibold text-red-600 dark:text-red-400 mb-2">عمليات إيقاف نشطة</div>
          {o.killSwitches.map((k) => (
            <div key={k.id} className="text-sm flex justify-between py-1">
              <span>{k.scope === 'global' ? 'إيقاف شامل' : k.scope} — {k.reason}</span>
              <span className="muted text-xs">{fmtDateTime(k.activated_at)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {([['queries', 'استهلاك الاستعلامات', SearchCode], ['budgets', 'الميزانيات', Wallet], ['denials', 'الطلبات المرفوضة', Ban]] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition ${
              tab === k ? 'border-brand-600 text-brand-600 font-medium' : 'border-transparent muted hover:text-[var(--text)]'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'queries' && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[1000px]">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">الاستعلام</th>
                <th className="th">البرنامج</th>
                <th className="th">طلبات</th>
                <th className="th">طلبات فارغة</th>
                <th className="th">وحدات</th>
                <th className="th">مرتبط</th>
                <th className="th">ضجيج</th>
                <th className="th">الدقة</th>
                <th className="th">التكلفة</th>
                <th className="th">لكل مرتبط</th>
                <th className="th">الهدر</th>
              </tr>
            </thead>
            <tbody>
              {(queries?.items ?? []).map((q) => {
                const bad = q.precision !== null && q.precision < 0.4 && q.units > 0;
                return (
                  <tr key={q.id} className={`border-t ${bad ? 'bg-red-500/5' : ''}`} style={{ borderColor: 'var(--border)' }}>
                    <td className="td font-medium">{q.name}</td>
                    <td className="td">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ background: q.program_color }} />
                        <span className="text-xs">{q.program_name}</span>
                      </span>
                    </td>
                    <td className="td num">{fmtNum(q.requests)}</td>
                    <td className={`td num ${(q.emptyRequestPct ?? 0) >= 0.7 ? 'text-amber-600 dark:text-amber-400 font-semibold' : ''}`}>
                      {fmtNum(q.emptyRequests)} · {fmtPct(q.emptyRequestPct)}
                    </td>
                    <td className="td num">{fmtNum(q.units)}</td>
                    <td className="td num">{fmtNum(q.relevant)}</td>
                    <td className="td num">{fmtNum(q.irrelevant)}</td>
                    <td className={`td num ${bad ? 'text-red-600 dark:text-red-400 font-semibold' : ''}`}>{fmtPct(q.precision)}</td>
                    <td className="td num">{fmtMoney(q.cost)}</td>
                    <td className="td num">{fmtMoney(q.costPerRelevant)}</td>
                    <td className="td num text-red-600 dark:text-red-400">{fmtMoney(q.wastedCost)}</td>
                  </tr>
                );
              })}
              {!queries?.items?.length && (
                <tr><td colSpan={11} className="td text-center muted py-8">لا توجد بيانات استهلاك بعد</td></tr>
              )}
            </tbody>
          </table>
          <div className="px-4 py-3 text-xs muted border-t" style={{ borderColor: 'var(--border)' }}>
            الخلفية الحمراء تعني دقة أقل من 40%، والطلبات الفارغة المرتفعة تعني أن الجدولة تحتاج تهدئة تلقائية.
          </div>
        </div>
      )}

      {tab === 'budgets' && (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">النطاق</th>
                <th className="th">الفترة</th>
                <th className="th">حد الوحدات</th>
                <th className="th">حد التكلفة</th>
                <th className="th">المستهلك</th>
                <th className="th">النوع</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {(budgets?.items ?? []).map((b) => (
                <tr key={b.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="td">{b.program_name ?? (b.scope === 'global' ? 'عام' : b.scope)}</td>
                  <td className="td">{{ hour: 'ساعة', day: 'يوم', month: 'شهر' }[b.period] ?? b.period}</td>
                  <td className="td num">{b.unit_limit ?? '∞'}</td>
                  <td className="td num">{b.cost_limit ? `$${b.cost_limit}` : '—'}</td>
                  <td className="td num">{b.units_used ?? 0}</td>
                  <td className="td">
                    <span className={`badge ${b.is_hard_limit ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-amber-500/15 text-amber-600'}`}>
                      {b.is_hard_limit ? 'حد صلب' : 'تنبيه فقط'}
                    </span>
                  </td>
                  <td className="td text-end">
                    {can(PERMISSIONS.BUDGET_WRITE) && (
                      <button
                        className="btn-ghost !px-2 !py-1 !text-xs"
                        onClick={() => { setEditing(b); setDraft({ unitLimit: b.unit_limit ?? 0, costLimit: Number(b.cost_limit ?? 0) }); }}
                      >
                        تعديل
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!can(PERMISSIONS.BUDGET_WRITE) && (
            <div className="px-4 py-3 text-xs muted border-t" style={{ borderColor: 'var(--border)' }}>
              تعديل الميزانية يتطلب صلاحية <span className="num">budget:write</span> — وهي لا تُمنح تلقائياً لأي دور.
            </div>
          )}
        </div>
      )}

      {tab === 'denials' && (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">الوقت</th>
                <th className="th">الاستعلام</th>
                <th className="th">السبب</th>
                <th className="th">النطاق</th>
                <th className="th">الوحدات المطلوبة</th>
              </tr>
            </thead>
            <tbody>
              {(denials?.items ?? []).map((d) => (
                <tr key={d.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="td text-xs muted">{fmtDateTime(d.occurred_at)}</td>
                  <td className="td">{d.query_name ?? '—'}</td>
                  <td className="td"><span className="badge bg-red-500/15 text-red-600 dark:text-red-400">{d.reason}</span></td>
                  <td className="td text-xs">{d.scope ?? '—'}</td>
                  <td className="td num">{d.requested_units}</td>
                </tr>
              ))}
              {!denials?.items?.length && (
                <tr><td colSpan={5} className="td text-center muted py-8">لا توجد طلبات مرفوضة — الميزانية لم تُبلغ بعد</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setEditing(null)}>
          <div className="card p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold mb-4">تعديل الميزانية — {editing.scope}/{editing.period}</h3>
            <label className="block text-sm mb-1">حد الوحدات (عدد المنشورات)</label>
            <input className="input mb-3 num" type="number" value={draft.unitLimit}
                   onChange={(e) => setDraft({ ...draft, unitLimit: Number(e.target.value) })} />
            <label className="block text-sm mb-1">حد التكلفة ($)</label>
            <input className="input mb-4 num" type="number" step="0.01" value={draft.costLimit}
                   onChange={(e) => setDraft({ ...draft, costLimit: Number(e.target.value) })} />
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost" onClick={() => setEditing(null)}>إلغاء</button>
              <button className="btn-primary" disabled={saveBudget.isPending} onClick={() => saveBudget.mutate(editing)}>حفظ</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
