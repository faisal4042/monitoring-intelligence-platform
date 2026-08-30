import { useQuery } from '@tanstack/react-query';
import ReactECharts from 'echarts-for-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { fmtNum, fmtPct, fmtMoney } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';

interface Stats {
  total: number; relevant: number; noise: number; negative: number;
  last24h: number; uniqueAuthors: number; precision: number | null; negativePct: number;
}
interface CostOverview {
  spentMonthUnits: number; spentMonthCost: number; monthUnitLimit: number | null;
  monthCostLimit: number | null; remainingUnits: number | null; projectedMonthCost: number;
  usagePct: number; costPerRelevantPost: number | null; collectionMode: string;
  pricing: { unitPrice: number; monthlyPriceUsd: number; monthlyPostQuota: number };
}
interface Program { id: string; name_ar: string; color: string; keyword_count: number; query_count: number; budget_share_pct: string | null }

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const toneCls = tone === 'bad' ? 'text-red-600 dark:text-red-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : '';
  return (
    <div className="card p-4">
      <div className="text-xs muted mb-1">{label}</div>
      <div className={`text-2xl font-bold num ${toneCls}`}>{value}</div>
      {sub && <div className="text-xs muted mt-1">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { can } = useAuth();
  const { theme } = useTheme();
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  const { data: stats } = useQuery({ queryKey: ['post-stats'], queryFn: () => api.get<Stats>('/posts/stats') });
  const { data: timeline } = useQuery({
    queryKey: ['post-timeline'],
    queryFn: () => api.get<{ items: Array<{ bucket: string; relevant: number; noise: number; negative: number }> }>('/posts/timeline?hours=72'),
  });
  const { data: cost } = useQuery({
    queryKey: ['cost-overview'],
    queryFn: () => api.get<CostOverview>('/cost/overview'),
    enabled: can(PERMISSIONS.COST_READ),
  });
  const { data: programs } = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs') });

  const axis = dark ? '#94a3b8' : '#64748b';
  const grid = dark ? '#334155' : '#e2e8f0';
  const empty = !timeline?.items?.length;

  const trendOption = {
    grid: { left: 45, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['مرتبط', 'ضجيج', 'سلبي'], textStyle: { color: axis }, top: 0 },
    xAxis: {
      type: 'category',
      data: (timeline?.items ?? []).map((i) => new Date(i.bucket).toLocaleString('ar-SA-u-nu-latn', { day: '2-digit', hour: '2-digit' })),
      axisLine: { lineStyle: { color: grid } }, axisLabel: { color: axis, fontSize: 10 },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: grid } }, axisLabel: { color: axis } },
    series: [
      { name: 'مرتبط', type: 'line', smooth: true, data: (timeline?.items ?? []).map((i) => i.relevant), itemStyle: { color: '#2563eb' }, areaStyle: { opacity: 0.12 } },
      { name: 'ضجيج', type: 'line', smooth: true, data: (timeline?.items ?? []).map((i) => i.noise), itemStyle: { color: '#94a3b8' } },
      { name: 'سلبي', type: 'line', smooth: true, data: (timeline?.items ?? []).map((i) => i.negative), itemStyle: { color: '#dc2626' } },
    ],
  };

  const programOption = {
    tooltip: { trigger: 'item' },
    legend: { orient: 'vertical', right: 0, top: 'center', textStyle: { color: axis, fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['55%', '78%'], center: ['35%', '50%'],
      label: { show: false }, itemStyle: { borderWidth: 2, borderColor: dark ? '#0f172a' : '#fff' },
      data: (programs?.items ?? []).map((p) => ({
        name: p.name_ar,
        value: Number(p.budget_share_pct ?? 0),
        itemStyle: { color: p.color },
      })),
    }],
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">لوحة التحكم</h1>
        <p className="text-sm muted">نظرة عامة على الرصد والاستهلاك</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        <Tile label="منشورات مرتبطة" value={fmtNum(stats?.relevant)} sub={`من ${fmtNum(stats?.total)} إجمالي`} />
        <Tile label="آخر 24 ساعة" value={fmtNum(stats?.last24h)} />
        <Tile
          label="نسبة السلبية"
          value={fmtPct(stats?.negativePct)}
          tone={(stats?.negativePct ?? 0) > 0.5 ? 'bad' : undefined}
        />
        <Tile
          label="دقة الرصد"
          value={fmtPct(stats?.precision)}
          sub="مرتبط ÷ (مرتبط + ضجيج)"
          tone={stats?.precision == null ? undefined : stats.precision >= 0.7 ? 'ok' : 'bad'}
        />
        {can(PERMISSIONS.COST_READ) && (
          <>
            <Tile
              label="استهلاك الشهر"
              value={`${fmtNum(cost?.spentMonthUnits)} / ${cost?.monthUnitLimit ?? '∞'}`}
              sub={fmtMoney(cost?.spentMonthCost)}
              tone={(cost?.usagePct ?? 0) >= 90 ? 'bad' : (cost?.usagePct ?? 0) >= 70 ? 'warn' : 'ok'}
            />
            <Tile
              label="التكلفة لكل منشور مرتبط"
              value={fmtMoney(cost?.costPerRelevantPost)}
              sub="مقياس الكفاءة الحقيقي"
            />
          </>
        )}
      </div>

      {/* The tier reality check, stated up front rather than buried. */}
      {can(PERMISSIONS.COST_READ) && cost && (
        <div className="card p-4 border-s-4" style={{ borderInlineStartColor: '#f59e0b' }}>
          <div className="text-sm font-medium mb-1">نموذج التسعير الحالي</div>
          <p className="text-sm muted leading-relaxed">
            الباقة المُهيّأة: <span className="num font-medium">${cost.pricing.monthlyPriceUsd}</span> شهرياً مقابل{' '}
            <span className="num font-medium">{fmtNum(cost.pricing.monthlyPostQuota)}</span> منشور
            {' '}= <span className="num font-medium">{fmtMoney(cost.pricing.unitPrice, 4)}</span> لكل منشور.
            {cost.monthUnitLimit && (
              <> الميزانية المحددة تسمح بـ <span className="num font-medium">{fmtNum(cost.monthUnitLimit)}</span> منشور شهرياً
              (~<span className="num">{Math.round(cost.monthUnitLimit / 30)}</span> يومياً لكل البرامج).</>
            )}
            {' '}هذه القيم قابلة للتعديل من الإعدادات — لا شيء منها مثبت في الكود.
          </p>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-4 lg:col-span-2">
          <h2 className="font-semibold mb-3">حجم المنشورات — آخر 72 ساعة</h2>
          {empty ? (
            <div className="h-64 grid place-items-center text-sm muted text-center px-6">
              لا توجد بيانات بعد.
              <br />
              <Link to="/queries" className="text-brand-600 hover:underline mt-2 inline-block">
                أنشئ استعلاماً واختبره ثم شغّل عملية جمع
              </Link>
            </div>
          ) : (
            <ReactECharts option={trendOption} style={{ height: 260 }} notMerge />
          )}
        </div>

        <div className="card p-4">
          <h2 className="font-semibold mb-3">حصص البرامج من الميزانية</h2>
          <ReactECharts option={programOption} style={{ height: 260 }} notMerge />
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b font-semibold" style={{ borderColor: 'var(--border)' }}>البرامج</div>
        <table className="w-full">
          <thead style={{ background: 'var(--surface-2)' }}>
            <tr>
              <th className="th">البرنامج</th>
              <th className="th">الحصة</th>
              <th className="th">الكلمات</th>
              <th className="th">الاستعلامات</th>
            </tr>
          </thead>
          <tbody>
            {(programs?.items ?? []).map((p) => (
              <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="td">
                  <span className="inline-flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
                    {p.name_ar}
                  </span>
                </td>
                <td className="td num">{p.budget_share_pct ?? '—'}%</td>
                <td className="td num">{p.keyword_count}</td>
                <td className="td num">{p.query_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
