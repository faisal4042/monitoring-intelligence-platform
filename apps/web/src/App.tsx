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
import Signals from './pages/Signals';
import NewsSources from './pages/NewsSources';
import NewsArticles from './pages/NewsArticles';

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

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/live" element={<LiveFeed />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/keywords" element={<Keywords />} />
        <Route path="/queries" element={<Queries />} />
        <Route path="/queries/new" element={<QueryBuilder />} />
        <Route path="/queries/:id/test" element={<QuerySandbox />} />
        <Route path="/cost" element={<CostCenter />} />
        <Route path="/classification" element={<InteractionClassification />} />
        <Route path="/topics" element={<TopicManagement />} />
        <Route path="/influencers" element={<Influencers />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/news/sources" element={<NewsSources />} />
        <Route path="/news/articles" element={<NewsArticles />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
