import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { fmtRelative } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';
import BrandLogo from './BrandLogo';
import {
  Activity, BadgeDollarSign, Bell, BookOpenText, ChartNoAxesCombined, ChevronDown, ChevronLeft,
  CircleStop, Gauge, KeyRound, LayoutGrid, LogOut, Menu, Moon, Newspaper, PanelRightClose, PanelRightOpen,
  Radio, SearchCode, Settings2, ShieldCheck, Sparkles, Sun, Tags,
  UserCog, UsersRound, X,
} from 'lucide-react';

interface CostOverview {
  spentMonthUnits: number; monthUnitLimit: number | null;
  usagePct: number; collectionMode: string;
  killSwitches: Array<{ id: string; scope: string; reason: string }>;
  lastUpdatedAt: string | null;
}

const NAV = [
  { to: '/', label: 'لوحة التحكم', icon: Gauge, perm: null },
  { to: '/live', label: 'الرصد المباشر', icon: Radio, perm: null },
  { to: '/signals', label: 'الإشارات والقصص', icon: Sparkles, perm: PERMISSIONS.TOPICS_READ },
  { to: '/keywords', label: 'قاموس الكلمات', icon: Tags, perm: PERMISSIONS.KEYWORDS_READ },
  { to: '/queries', label: 'الاستعلامات', icon: SearchCode, perm: PERMISSIONS.QUERIES_READ },
  { to: '/classification', label: 'تصنيف التفاعلات', icon: ChartNoAxesCombined, perm: PERMISSIONS.TOPICS_READ },
  { to: '/topics', label: 'إدارة المواضيع', icon: BookOpenText, perm: PERMISSIONS.TOPICS_READ },
  { to: '/influencers', label: 'العملاء المؤثرون', icon: UsersRound, perm: PERMISSIONS.INFLUENCERS_READ },
  { to: '/news/articles', label: 'الأخبار', icon: Newspaper, perm: PERMISSIONS.NEWS_READ },
  { to: '/news/sources', label: 'مصادر الأخبار', icon: Activity, perm: PERMISSIONS.NEWS_MANAGE_SOURCES },
];

/** Grouped under one collapsible "الإدارة" entry instead of each sitting flat in the sidebar. */
const ADMIN_NAV = [
  { to: '/notifications', label: 'الإشعارات والتنبيهات', icon: Bell, perm: PERMISSIONS.ALERTS_WRITE },
  { to: '/cost', label: 'مركز التكلفة', icon: BadgeDollarSign, perm: PERMISSIONS.COST_READ },
  { to: '/users', label: 'إدارة المستخدمين', icon: UserCog, perm: PERMISSIONS.USERS_WRITE },
  { to: '/admin', label: 'لوحة النظام', icon: Settings2, perm: PERMISSIONS.ADMIN_SYSTEM },
];

const MODE_BADGE: Record<string, { text: string; cls: string; title: string }> = {
  demo: { text: 'وضع تجريبي', cls: 'status-pill--info', title: 'LIVE_X_API=false — لا يوجد أي اتصال بـ X API' },
  dry_run: { text: 'تشغيل جاف', cls: 'status-pill--warning', title: 'الاستعلامات تُبنى وتُحاسب لكن لا تُرسل' },
  live: { text: 'تشغيل حي', cls: 'status-pill--success', title: 'طلبات حقيقية تستهلك حصة فعلية' },
};

/** Header title for routes outside the sidebar lists. */
const EXTRA_TITLES: Array<[string, string]> = [
  ['/queries/new', 'منشئ الاستعلام'], ['/queries/', 'اختبار الاستعلام'], ['/account/password', 'تغيير كلمة المرور'],
];
const COLLAPSE_KEY = 'mip.sidebar.collapsed';

export default function AppShell() {
  const { user, logout, can } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [showKill, setShowKill] = useState(false);
  const [reason, setReason] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Desktop only; a per-device convenience, so local storage is enough.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* private mode */ } return !c; });

  const visibleAdminNav = ADMIN_NAV.filter((n) => !n.perm || can(n.perm));
  const isAdminActive = visibleAdminNav.some((n) => location.pathname === n.to);
  const [adminOpen, setAdminOpen] = useState(false);
  useEffect(() => { if (isAdminActive) setAdminOpen(true); }, [isAdminActive]);

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
  const barColor = pct >= 90 ? 'var(--status-danger-solid)' : pct >= 70 ? '#d97706' : 'var(--ithra-teal)';
  const allNav = [...NAV, ...ADMIN_NAV];
  const pageTitle = EXTRA_TITLES.find(([prefix]) => location.pathname.startsWith(prefix))?.[1]
    ?? allNav.filter((n) => location.pathname === n.to || location.pathname.startsWith(n.to + '/')).sort((a, b) => b.to.length - a.to.length)[0]?.label
    ?? 'منصة الرصد';

  return (
    <div className={`app-frame min-h-screen flex ${collapsed ? 'is-collapsed' : ''}`}>
      {mobileNavOpen && <button className="sidebar-backdrop" aria-label="إغلاق القائمة" onClick={() => setMobileNavOpen(false)} />}
      {/* Sidebar */}
      <aside className={`app-sidebar ${mobileNavOpen ? 'is-open' : ''}`}>
        {/* Corporate identity, then the product name. The logo keeps its clear space and never shrinks below 160px. */}
        <div className="brand-lockup">
          <div className="brand-lockup-logo"><BrandLogo width={184} /></div>
          <div className="brand-product">
            <span className="brand-product-name">منصة الرصد <span className="num">MIP</span></span>
            <span className="brand-product-tagline">منصة الرصد والتحليل</span>
          </div>
          <button className="icon-button sidebar-close" aria-label="إغلاق القائمة" onClick={() => setMobileNavOpen(false)}><PanelRightClose size={19} /></button>
        </div>

        <nav className="sidebar-nav" aria-label="التنقل الرئيسي">
          {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              onClick={() => setMobileNavOpen(false)}
              className={({ isActive }) => `sidebar-link ${isActive ? 'is-active' : ''}`}
              title={collapsed ? n.label : undefined}
            >
              <n.icon className="sidebar-link-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className="sidebar-link-label flex-1">{n.label}</span>
              <ChevronLeft className="sidebar-link-arrow" size={15} />
            </NavLink>
          ))}

          {visibleAdminNav.length > 0 && (
            <>
              <button
                type="button"
                className={`sidebar-link sidebar-group-btn ${adminOpen ? 'is-open' : ''} ${isAdminActive ? 'is-active' : ''}`}
                onClick={() => { if (collapsed) toggleCollapsed(); setAdminOpen((v) => !v); }}
                aria-expanded={adminOpen}
                title={collapsed ? 'الإدارة' : undefined}
              >
                <Settings2 className="sidebar-link-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="sidebar-link-label flex-1">الإدارة</span>
                <ChevronDown className="sidebar-group-chevron" size={16} />
              </button>
              {adminOpen && !collapsed && (
                <div className="sidebar-subnav">
                  {visibleAdminNav.map((n) => (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      onClick={() => setMobileNavOpen(false)}
                      className={({ isActive }) => `sidebar-link ${isActive ? 'is-active' : ''}`}
                    >
                      <n.icon className="sidebar-link-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
                      <span className="flex-1">{n.label}</span>
                      <ChevronLeft className="sidebar-link-arrow" size={14} />
                    </NavLink>
                  ))}
                </div>
              )}
            </>
          )}
        </nav>

        {/* Budget meter — always visible, never buried in a settings page. */}
        {cost && (
          <div className="budget-card">
            <div className="flex justify-between mb-1.5">
              <span className="muted">حصة الشهر</span>
              <span className="num font-medium">
                {cost.spentMonthUnits}/{cost.monthUnitLimit ?? '∞'}
              </span>
            </div>
            <div className="progress-track">
              <div className="h-full transition-all" style={{ width: `${Math.min(100, pct)}%`, background: barColor }} />
            </div>
          </div>
        )}

        <div className="sidebar-profile">
          <div className="profile-avatar" aria-hidden="true">{user?.fullName?.trim().charAt(0) || 'م'}</div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm truncate">{user?.fullName}</div>
            <div className="muted text-xs truncate mt-0.5">{user?.roleNameAr}</div>
          </div>
          <div className="sidebar-profile-actions">
            <button
              className="icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title="تبديل المظهر"
              aria-label="تبديل المظهر"
            >
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button
              className="icon-button"
              onClick={() => logout().then(() => navigate('/login'))}
              title="تسجيل الخروج"
              aria-label="تسجيل الخروج"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="app-content flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header
          className="app-header"
        >
          <button className="icon-button mobile-menu" aria-label="فتح القائمة" onClick={() => setMobileNavOpen(true)}><Menu size={20} /></button>
          <button className="icon-button desktop-collapse" aria-label={collapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'} aria-pressed={collapsed}
            title={collapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'} onClick={toggleCollapsed}>
            {collapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}</button>
          <div className="app-header-title" aria-live="polite"><span className="app-header-product">منصة الرصد</span><span aria-hidden="true">/</span><strong>{pageTitle}</strong></div>
          <span className={`badge mode-badge status-pill ${mode.cls}`} title={mode.title}>
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
            <span className="badge status-pill status-pill--danger-solid">
              الجمع موقوف — {globalKill.reason}
            </span>
          )}

          <div className="flex-1" />

          {/* The emergency stop stays reachable at all times, by design. */}
          {can(PERMISSIONS.KILLSWITCH_OPERATE) && (
            globalKill ? (
              <button className="btn-ghost btn-success-text" aria-label="استئناف الجمع" onClick={() => resume.mutate(globalKill.id)}>
                <ShieldCheck size={17} /> <span className="emergency-label">استئناف الجمع</span>
              </button>
            ) : (
              <button className="btn-danger" onClick={() => setShowKill(true)}>
                <CircleStop size={17} /> <span className="emergency-label">إيقاف جمع بيانات X</span>
              </button>
            )
          )}
        </header>

        <main className="app-main flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      {showKill && (
        <div className="modal-overlay" onClick={() => setShowKill(false)}>
          <div className="card modal-card p-5 w-full max-w-md" role="dialog" aria-modal="true" aria-labelledby="kill-title" onClick={(e) => e.stopPropagation()}>
            <button className="icon-button absolute top-4 end-4" aria-label="إغلاق" onClick={() => setShowKill(false)}><X size={18} /></button>
            <h3 id="kill-title" className="font-bold text-lg mb-1">إيقاف جمع بيانات X</h3>
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
