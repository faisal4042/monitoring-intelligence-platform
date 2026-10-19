import { useConfirmAction } from './ConfirmAction';
import ModalSurface, { ModalCloseButton } from './ModalSurface';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { PERMISSIONS } from '@mip/shared';
import AlertCenter from './AlertCenter';
import AgentStatusControl from './AgentStatusControl';
import BrandLogo from './BrandLogo';
import SystemStatus from './SystemStatus';
import { Button } from './ui/Button';
import { canAccessRoute } from '../lib/route-access';
import {
  BadgeDollarSign, Bell, BookOpenText, ChartNoAxesCombined, ChevronDown, ChevronLeft,
  CircleStop, FileBarChart, FolderKanban, Gauge, KeyRound, LayoutGrid, LogOut, Megaphone, Menu, MessageCircle, MonitorDot, MonitorPlay, Moon, Newspaper,
  PanelRightClose, PanelRightOpen, Radio, Rss, ScanSearch, SearchCode, ServerCog, Settings2, SlidersHorizontal, Sparkles, Sun, Tags, Ticket,
  UserCog, UsersRound, X,
} from 'lucide-react';

interface CostOverview {
  spentMonthUnits: number; monthUnitLimit: number | null;
  usagePct: number; collectionMode: string;
  killSwitches: Array<{ id: string; scope: string; reason: string }>;
  lastUpdatedAt: string | null;
}

interface NavItem { to: string; label: string; icon: typeof Gauge }

/** The sidebar in four task groups, then the collapsible "الإدارة" group. One icon per destination. */
const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  { title: 'العمل اليومي', items: [
    { to: '/queue', label: 'طابور الرصد', icon: LayoutGrid },
    { to: '/queue/board', label: 'لوحة فرق الرصد', icon: MonitorDot },
    { to: '/tickets', label: 'التذاكر', icon: Ticket },
  ] },
  { title: 'الرصد', items: [
    { to: '/live', label: 'رصد إكس', icon: Radio },
    { to: '/youtube', label: 'رصد يوتيوب', icon: MonitorPlay },
    { to: '/news/articles', label: 'الأخبار', icon: Newspaper },
    { to: '/influencers', label: 'العملاء المؤثرون', icon: Megaphone },
  ] },
  { title: 'التحليل', items: [
    { to: '/dashboard', label: 'لوحة التحكم', icon: Gauge },
    { to: '/signals', label: 'الإشارات والقصص', icon: Sparkles },
    { to: '/advanced-search', label: 'البحث المتقدم', icon: ScanSearch },
    { to: '/reports', label: 'مركز التقارير', icon: FileBarChart },
  ] },
  { title: 'الإعداد', items: [
    { to: '/keywords', label: 'قاموس الكلمات', icon: Tags },
    { to: '/queries', label: 'الاستعلامات', icon: SearchCode },
    { to: '/classification', label: 'تصنيف التفاعلات', icon: ChartNoAxesCombined },
    { to: '/topics', label: 'إدارة المواضيع', icon: BookOpenText },
    { to: '/news/sources', label: 'مصادر الأخبار', icon: Rss },
  ] },
];

/** Grouped under one collapsible "الإدارة" entry instead of each sitting flat in the sidebar. */
const ADMIN_NAV: NavItem[] = [
  { to: '/programs', label: 'إدارة البرامج', icon: FolderKanban },
  { to: '/teams', label: 'فرق الرصد', icon: UsersRound },
  { to: '/queue/settings', label: 'إعدادات موظفي الطابور', icon: SlidersHorizontal },
  { to: '/notifications', label: 'الإشعارات والتنبيهات', icon: Bell },
  { to: '/cost', label: 'مركز التكلفة', icon: BadgeDollarSign },
  { to: '/users', label: 'إدارة المستخدمين', icon: UserCog },
  { to: '/admin', label: 'لوحة النظام', icon: ServerCog },
];

/** Header title for routes outside the sidebar lists. */
const EXTRA_TITLES: Array<[string, string]> = [
  ['/queries/new', 'منشئ الاستعلام'], ['/queries/', 'اختبار الاستعلام'], ['/account/password', 'تغيير كلمة المرور'],
  ['/account/whatsapp', 'تنبيهاتي على واتساب'],
];
const COLLAPSE_KEY = 'mip.sidebar.collapsed';

export default function AppShell() {
  const { user, logout, can } = useAuth();
  const confirmation = useConfirmAction();
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

  const visibleAdminNav = ADMIN_NAV.filter((n) => canAccessRoute(n.to, user?.permissions ?? []));
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

  // Only to show the «my WhatsApp alerts» shortcut to registered recipients; silent when the feature is not installed.
  const { data: waMe } = useQuery({ queryKey: ['wa-me'], queryFn: () => api.get<{ registered: boolean }>('/whatsapp/me'), retry: false, staleTime: 10 * 60_000 });
  const { data: cost, isError: costFailed } = useQuery({
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
  const pct = cost?.usagePct ?? 0;
  const barColor = pct >= 90 ? 'var(--status-danger-solid)' : pct >= 70 ? 'var(--status-warning)' : 'var(--accent)';
  // Agents who only work their own queue see it as «مهامي».
  const queueLabel = can(PERMISSIONS.QUEUE_SUPERVISE, PERMISSIONS.QUEUE_VIEW_ALL) ? 'طابور الرصد' : 'مهامي';
  const navLabel = (n: NavItem) => (n.to === '/queue' ? queueLabel : n.label);
  const permissions = user?.permissions ?? [];
  const visibleGroups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => canAccessRoute(n.to, permissions)) })).filter((g) => g.items.length > 0);
  const allNav = [...NAV_GROUPS.flatMap((g) => g.items), ...ADMIN_NAV];
  const pageMatch = allNav.filter((n) => location.pathname === n.to || location.pathname.startsWith(n.to + '/')).sort((a, b) => b.to.length - a.to.length)[0];
  const pageTitle = EXTRA_TITLES.find(([prefix]) => location.pathname.startsWith(prefix))?.[1]
    ?? (pageMatch ? navLabel(pageMatch) : 'منصة الرصد');
  const requestResume = (id: string) => confirmation.request({
    title: 'استئناف جمع بيانات إكس',
    description: 'إزالة الإيقاف العام تسمح باستئناف الجمع وفق الميزانية والإعدادات الحالية، وقد تستهلك تكلفة تشغيلية.',
    confirmLabel: 'استئناف الجمع',
    allowed: (c) => c(PERMISSIONS.KILLSWITCH_OPERATE),
    execute: () => resume.mutateAsync(id),
  });

  return (
    <div className={`app-frame min-h-screen flex ${collapsed ? 'is-collapsed' : ''}`}>
      {confirmation.dialog}
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
          {visibleGroups.map((g) => (
            <div key={g.title} className="sidebar-group" role="group" aria-labelledby={`nav-group-${g.title}`}>
              <div id={`nav-group-${g.title}`} className="sidebar-group-title">{g.title}</div>
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/queue'}
                  onClick={() => setMobileNavOpen(false)}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'is-active' : ''}`}
                  title={collapsed ? navLabel(n) : undefined}
                >
                  <n.icon className="sidebar-link-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
                  <span className="sidebar-link-label flex-1">{navLabel(n)}</span>
                  <ChevronLeft className="sidebar-link-arrow" size={15} />
                </NavLink>
              ))}
            </div>
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

        {/* Budget meter — only when a monthly limit is set; usage without a limit lives in the status panel. */}
        {cost && cost.monthUnitLimit != null && (
          <div className="budget-card">
            <div className="flex justify-between mb-1.5">
              <span className="muted">حصة الشهر</span>
              <span className="num">
                {cost.spentMonthUnits} من {cost.monthUnitLimit}
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
            {waMe?.registered && (
              <button className="icon-button" onClick={() => navigate('/account/whatsapp')} title="تنبيهاتي على واتساب" aria-label="تنبيهاتي على واتساب">
                <MessageCircle size={17} />
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => navigate('/account/password')}
              title="تغيير كلمة المرور"
              aria-label="تغيير كلمة المرور"
            >
              <KeyRound size={17} />
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
          {/* One system-status indicator for X collection; details and resume live in its panel. */}
          {can(PERMISSIONS.COST_READ) && (
            <SystemStatus
              mode={cost?.collectionMode}
              failed={costFailed}
              stop={globalKill ?? null}
              lastRequestAt={cost?.lastUpdatedAt}
              spentMonthUnits={cost?.spentMonthUnits}
              monthUnitLimit={cost?.monthUnitLimit}
              onResume={globalKill && can(PERMISSIONS.KILLSWITCH_OPERATE) ? () => requestResume(globalKill.id) : undefined}
            />
          )}

          <div className="flex-1" />

          {/* Availability: only people who receive queue work have a status. */}
          {can(PERMISSIONS.QUEUE_WORK) && <AgentStatusControl />}
          {/* Influencer/story alerts: only for users who work the queue. */}
          {can(PERMISSIONS.QUEUE_WORK, PERMISSIONS.QUEUE_SUPERVISE, PERMISSIONS.QUEUE_VIEW_ALL) && <AlertCenter />}

          {/* The emergency stop stays reachable whenever collection is running, by design. */}
          {can(PERMISSIONS.KILLSWITCH_OPERATE) && !globalKill && (
            <Button variant="danger" icon={<CircleStop size={17} aria-hidden="true" />} aria-label="إيقاف جمع بيانات إكس" onClick={() => setShowKill(true)}>
              <span className="emergency-label">إيقاف جمع بيانات إكس</span>
            </Button>
          )}
        </header>

        <main className="app-main flex-1 overflow-auto">
          {import.meta.env.VITE_UNIFIED_STAGING === 'true' && <div role="status" className="mb-4 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            بيئة اختبار معزولة · نسخة مستقلة من البيانات المحلية · الجمع الخارجي معطّل
          </div>}
          {import.meta.env.VITE_ISOLATED_UNIFIED==='true'&&<div role="status" className="mx-4 mt-3 rounded-lg border p-3 text-sm">بيئة محلية مستقلة — يوتيوب مهيأ للاتصال الفعلي. التغييرات هنا لا تنتقل إلى البيئة الأساسية، وبقية الاتصالات الخارجية متوقفة.</div>}
          <Outlet />
        </main>
      </div>

      {showKill && (
        <ModalSurface label={'إيقاف جمع بيانات إكس'} onClose={() => setShowKill(false)} busy={stopAll.isPending} overlayClassName="modal-overlay" panelClassName="card modal-card p-5 w-full max-w-md" as="div">
            <ModalCloseButton className="icon-button absolute top-4 end-4" aria-label="إغلاق" onClick={() => setShowKill(false)}><X size={18} /></ModalCloseButton>
            <h3 id="kill-title" className="font-bold text-lg mb-1">إيقاف جمع بيانات إكس</h3>
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
              autoFocus data-dialog-initial-focus
            />
            <div className="flex gap-2 justify-end">
              <ModalCloseButton className="btn-ghost" onClick={() => setShowKill(false)}>إلغاء</ModalCloseButton>
              <Button variant="danger" type="submit"
                disabled={!reason.trim() || stopAll.isPending}
                onClick={() => stopAll.mutate()}>
                تأكيد الإيقاف
              </Button>
            </div>
          </ModalSurface>
      )}
    </div>
  );
}
