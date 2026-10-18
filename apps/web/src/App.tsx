import { lazy, type ReactElement } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import AppShell from './components/AppShell';
import { ROUTE_ACCESS, homeRoute } from './lib/route-access';
import RequirePermission from './components/RequirePermission';

import RoutePage, { RouteBoundary, ShellOutlet } from './components/RoutePage';
import { routeModule, useIntentPrefetch, type RouteModule } from './lib/route-prefetch';

const Login = lazy(() => import('./pages/Login'));
const ChangePassword = lazy(() => import('./pages/ChangePassword'));

// Shell pages, in route order. Each loads on first visit, or on clear intent
// to visit it (see useIntentPrefetch), and only if ROUTE_ACCESS allows it.
const SHELL_PAGES: readonly (readonly [string, RouteModule])[] = [
  ['/queue', routeModule(() => import('./pages/MonitoringQueue'))],
  ['/queue/board', routeModule(() => import('./pages/QueueBoard'))],
  ['/queue/settings', routeModule(() => import('./pages/QueueWorkforceSettings'))],
  ['/teams', routeModule(() => import('./pages/Teams'))],
  ['/programs', routeModule(() => import('./pages/Programs'))],
  ['/dashboard', routeModule(() => import('./pages/Dashboard'))],
  ['/live', routeModule(() => import('./pages/LiveFeed'))],
  ['/signals', routeModule(() => import('./pages/Signals'))],
  ['/keywords', routeModule(() => import('./pages/Keywords'))],
  ['/queries', routeModule(() => import('./pages/Queries'))],
  ['/queries/new', routeModule(() => import('./pages/QueryBuilder'))],
  ['/queries/:id/test', routeModule(() => import('./pages/QuerySandbox'))],
  ['/cost', routeModule(() => import('./pages/CostCenter'))],
  ['/classification', routeModule(() => import('./pages/InteractionClassification'))],
  ['/topics', routeModule(() => import('./pages/TopicManagement'))],
  ['/influencers', routeModule(() => import('./pages/Influencers'))],
  ['/advanced-search', routeModule(() => import('./pages/AdvancedSearch'))],
  ['/tickets', routeModule(() => import('./pages/Tickets'))],
  ['/reports', routeModule(() => import('./pages/Reports'))],
  ['/youtube', routeModule(() => import('./pages/YouTubeMonitoring'))],
  ['/admin', routeModule(() => import('./pages/Admin'))],
  ['/users', routeModule(() => import('./pages/Users'))],
  ['/notifications', routeModule(() => import('./pages/Notifications'))],
  ['/news/sources', routeModule(() => import('./pages/NewsSources'))],
  ['/news/articles', routeModule(() => import('./pages/NewsArticles'))],
];

export default function App() {
  const { user, loading } = useAuth();
  const home = import.meta.env.VITE_ISOLATED_UNIFIED==='true' && user?.permissions.includes('posts:read')
    ? '/dashboard?period=all' : homeRoute(user?.permissions ?? []);
  useIntentPrefetch(SHELL_PAGES, user && !user.mustChangePassword ? user.permissions : NO_PERMISSIONS);

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-sm muted">جارٍ التحميل…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<RoutePage><Login /></RoutePage>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // A temporary password unlocks nothing but replacing it (the API agrees).
  if (user.mustChangePassword) {
    return (
      <Routes>
        <Route path="/account/password" element={<RoutePage><ChangePassword /></RoutePage>} />
        <Route path="*" element={<Navigate to="/account/password" replace />} />
      </Routes>
    );
  }

  // Each page declares the permission its own requests need; the API is the
  // real boundary, this only avoids rendering a page of 403s.
  const guard = (path: string, element: ReactElement) => <RequirePermission perm={ROUTE_ACCESS[path] ?? []}><RouteBoundary>{element}</RouteBoundary></RequirePermission>;

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppShell />}>
        <Route element={<ShellOutlet />}>
          {SHELL_PAGES.map(([path, Page]) => <Route key={path} path={path} element={guard(path, <Page />)} />)}
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/account/password" element={<RouteBoundary><ChangePassword /></RouteBoundary>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

const NO_PERMISSIONS: readonly string[] = [];
