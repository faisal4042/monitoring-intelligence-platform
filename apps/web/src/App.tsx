import type { ReactElement } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import LiveFeed from './pages/LiveFeed';
import Keywords from './pages/Keywords';
import Queries from './pages/Queries';
import QueryBuilder from './pages/QueryBuilder';
import QuerySandbox from './pages/QuerySandbox';
import CostCenter from './pages/CostCenter';
import InteractionClassification from './pages/InteractionClassification';
import TopicManagement from './pages/TopicManagement';
import Influencers from './pages/Influencers';
import Admin from './pages/Admin';
import Users from './pages/Users';
import Notifications from './pages/Notifications';
import Signals from './pages/Signals';
import NewsSources from './pages/NewsSources';
import NewsArticles from './pages/NewsArticles';
import ChangePassword from './pages/ChangePassword';
import RequirePermission from './components/RequirePermission';
import { PERMISSIONS as P } from '@mip/shared';

export default function App() {
  const { user, loading } = useAuth();

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
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // A temporary password unlocks nothing but replacing it (the API agrees).
  if (user.mustChangePassword) {
    return (
      <Routes>
        <Route path="/account/password" element={<ChangePassword />} />
        <Route path="*" element={<Navigate to="/account/password" replace />} />
      </Routes>
    );
  }

  // Each page declares the permission its own requests need; the API is the
  // real boundary, this only avoids rendering a page of 403s.
  const guard = (perm: string, element: ReactElement) => <RequirePermission perm={perm}>{element}</RequirePermission>;

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppShell />}>
        <Route path="/" element={guard(P.POSTS_READ, <Dashboard />)} />
        <Route path="/live" element={guard(P.POSTS_READ, <LiveFeed />)} />
        <Route path="/signals" element={guard(P.TOPICS_READ, <Signals />)} />
        <Route path="/keywords" element={guard(P.KEYWORDS_READ, <Keywords />)} />
        <Route path="/queries" element={guard(P.QUERIES_READ, <Queries />)} />
        <Route path="/queries/new" element={guard(P.QUERIES_WRITE, <QueryBuilder />)} />
        <Route path="/queries/:id/test" element={guard(P.QUERIES_READ, <QuerySandbox />)} />
        <Route path="/cost" element={guard(P.COST_READ, <CostCenter />)} />
        <Route path="/classification" element={guard(P.TOPICS_READ, <InteractionClassification />)} />
        <Route path="/topics" element={guard(P.TOPICS_READ, <TopicManagement />)} />
        <Route path="/influencers" element={guard(P.INFLUENCERS_READ, <Influencers />)} />
        <Route path="/admin" element={guard(P.ADMIN_SYSTEM, <Admin />)} />
        <Route path="/users" element={guard(P.USERS_READ, <Users />)} />
        <Route path="/notifications" element={guard(P.ALERTS_READ, <Notifications />)} />
        <Route path="/news/sources" element={guard(P.NEWS_READ, <NewsSources />)} />
        <Route path="/news/articles" element={guard(P.NEWS_READ, <NewsArticles />)} />
        <Route path="/account/password" element={<ChangePassword />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
