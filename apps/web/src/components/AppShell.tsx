import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { fmtRelative } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';

interface CostOverview {
  spentMonthUnits: number; monthUnitLimit: number | null;
  usagePct: number; collectionMode: string;
  killSwitches: Array<{ id: string; scope: string; reason: string }>;
  lastUpdatedAt: string | null;
}

const NAV = [
  { to: '/', label: 'لوحة التحكم', icon: '▦', perm: null },
  { to: '/live', label: 'الرصد المباشر', icon: '◉', perm: null },
  { to: '/signals', label: 'الإشارات والقصص', icon: '⌁', perm: PERMISSIONS.TOPICS_READ },
  { to: '/keywords', label: 'قاموس الكلمات', icon: '⌗', perm: PERMISSIONS.KEYWORDS_READ },
  { to: '/queries', label: 'الاستعلامات', icon: '⌕', perm: PERMISSIONS.QUERIES_READ },
  { to: '/classification', label: 'تصنيف التفاعلات', icon: '◈', perm: PERMISSIONS.TOPICS_READ },
  { to: '/topics', label: 'إدارة المواضيع', icon: '◇', perm: PERMISSIONS.TOPICS_READ },
  { to: '/influencers', label: 'العملاء المؤثرون', icon: '★', perm: PERMISSIONS.INFLUENCERS_READ },
  { to: '/cost', label: 'مركز التكلفة', icon: '$', perm: PERMISSIONS.COST_READ },
  { to: '/news/articles', label: 'الأخبار', icon: '▧', perm: PERMISSIONS.NEWS_READ },
  { to: '/news/sources', label: 'مصادر الأخبار', icon: '▤', perm: PERMISSIONS.NEWS_MANAGE_SOURCES },
  { to: '/admin', label: 'لوحة النظام', icon: '⚙', perm: PERMISSIONS.ADMIN_SYSTEM },
];

const MODE_BADGE: Record<string, { text: string; cls: string; title: string }> = {
  demo: {
    text: 'وضع تجريبي',
    cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
    title: 'LIVE_X_API=false — لا يوجد أي اتصال بـ X API',
  },
  dry_run: {
    text: 'تشغيل جاف',
    cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    title: 'الاستعلامات تُبنى وتُحاسب لكن لا تُرسل',
  },
  live: {
    text: 'تشغيل حي',
    cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    title: 'طلبات حقيقية تستهلك حصة فعلية',
  },
};

export default function AppShell() {
  const { user, logout, can } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showKill, setShowKill] = useState(false);
  const [reason, setReason] = useState('');

  // fmtRelative reads Date.now() at render time — without this the "قبل X"
  // text freezes at whatever it said on the last actual data refetch.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  const { data: cost } = useQuery({
    queryKey: ['cost-overview'],
    queryFn: () => api.get<CostOverview>('/cost/overview'),
    refetchInterval: 30_000,
    enabled: can(PERMISSIONS.COST_READ),
  });

  const stopAll = useMutation({
    mutationFn: () => api.post('/cost/kill-switch', { scope: 'global', reason }),
    onSuccess: () => { setShowKill(false); setReason(''); qc.invalidateQueries(); },
  });

  const resume = useMutation({
    mutationFn: (id: string) => api.del(`/cost/kill-switch/${id}`),
    onSuccess: () => qc.invalidateQueries(),
  });

  const globalKill = cost?.killSwitches?.find((k) => k.scope === 'global');
  const mode = MODE_BADGE[cost?.collectionMode ?? 'demo'] ?? MODE_BADGE.demo;
  const pct = cost?.usagePct ?? 0;
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-e flex flex-col" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="px-4 py-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="font-bold text-lg leading-tight">منصة الرصد</div>
          <div className="text-xs muted mt-0.5">Monitoring Intelligence</div>
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive ? 'bg-brand-600 text-white' : 'hover:bg-[var(--surface-3)]'
                }`
              }
            >
              <span className="w-5 text-center opacity-80">{n.icon}</span>
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Budget meter — always visible, never buried in a settings page. */}
        {cost && (
          <div className="p-3 m-2 rounded-lg text-xs" style={{ background: 'var(--surface-2)' }}>
            <div className="flex justify-between mb-1.5">
              <span className="muted">حصة الشهر</span>
              <span className="num font-medium">
                {cost.spentMonthUnits}/{cost.monthUnitLimit ?? '∞'}
              </span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-3)' }}>
              <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
        )}

        <div className="p-3 border-t text-xs" style={{ borderColor: 'var(--border)' }}>
          <div className="font-medium truncate">{user?.fullName}</div>
          <div className="muted truncate">{user?.roleNameAr}</div>
          <div className="flex gap-1 mt-2">
            <button
              className="btn-ghost flex-1 !px-2 !py-1 !text-xs"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="تبديل المظهر"
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <button
              className="btn-ghost flex-1 !px-2 !py-1 !text-xs"
              onClick={() => logout().then(() => navigate('/login'))}
            >
              خروج
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header
          className="h-14 border-b flex items-center gap-3 px-5 shrink-0"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <span className={`badge mode-badge ${mode.cls}`} title={mode.title}>
            {cost?.collectionMode === 'live' ? (
              <span className="live-orbit-icon" aria-hidden="true">
                <span className="live-orbit-ring" />
                <span className="live-orbit-ring live-orbit-ring--inner" />
                <span className="live-orbit-sweep" />
                <span className="live-orbit-blip live-orbit-blip--one" />
                <span className="live-orbit-blip live-orbit-blip--two" />
                <span className="live-orbit-blip live-orbit-blip--three" />
                <span className="live-orbit-core" />
              </span>
            ) : (
              <span aria-hidden="true">●</span>
            )}
            <span>{mode.text}</span>
          </span>

          {cost?.lastUpdatedAt && (
            <span className="text-xs muted" title={cost.lastUpdatedAt}>
              آخر تحديث {fmtRelative(cost.lastUpdatedAt)}
            </span>
          )}

          {globalKill && (
            <span className="badge bg-red-600 text-white">
              الجمع موقوف — {globalKill.reason}
            </span>
          )}

          <div className="flex-1" />

          {/* The emergency stop stays reachable at all times, by design. */}
          {can(PERMISSIONS.KILLSWITCH_OPERATE) && (
            globalKill ? (
              <button className="btn-ghost !text-emerald-600" onClick={() => resume.mutate(globalKill.id)}>
                استئناف الجمع
              </button>
            ) : (
              <button className="btn-danger" onClick={() => setShowKill(true)}>
                ⏹ إيقاف جمع بيانات X
              </button>
            )
          )}
        </header>

        <main className="flex-1 overflow-auto p-5">
          <Outlet />
        </main>
      </div>

      {showKill && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowKill(false)}>
          <div className="card p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-1">إيقاف جمع بيانات X</h3>
            <p className="text-sm muted mb-4">
              يوقف كل عمليات الجلب فوراً. المنصة تبقى تعمل بالكامل على البيانات المخزّنة —
              التصنيف والتقارير ولوحة التحكم لا تتأثر.
            </p>
            <label className="block text-sm mb-1">السبب (إلزامي)</label>
            <input
              className="input mb-4"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثال: استهلاك غير متوقع في استعلام إيجار"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost" onClick={() => setShowKill(false)}>إلغاء</button>
              <button
                className="btn-danger"
                disabled={!reason.trim() || stopAll.isPending}
                onClick={() => stopAll.mutate()}
              >
                تأكيد الإيقاف
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
