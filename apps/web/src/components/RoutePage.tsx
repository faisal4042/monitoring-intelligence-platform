import { Component, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

export function RouteLoading() {
  return <div className="card m-4 p-8 text-center" dir="rtl" role="status" aria-live="polite" aria-busy="true">
    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent muted" aria-hidden="true" />
    <p className="mt-3 text-sm muted">جارٍ تحميل الصفحة…</p>
  </div>;
}

export class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <div className="card m-4 p-8 text-center space-y-4" dir="rtl" role="alert">
      <h1 className="text-lg font-bold">تعذر تحميل الصفحة</h1>
      <p className="text-sm muted">تحقق من اتصالك ثم أعد تحميل الصفحة. ستبقى على الرابط نفسه، ولن تُعاد أي عملية حفظ تلقائيًا.</p>
      <div className="flex flex-wrap justify-center gap-3">
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>إعادة تحميل الصفحة</button>
        <Link className="btn-ghost" to="/">العودة للرئيسية</Link>
      </div>
    </div>;
    return this.props.children;
  }
}

/**
 * Error isolation for one shell page. A navigation can recover independently;
 * query-string navigation belongs to the current page (filters, report builder
 * tabs), so it keeps local state instead of remounting on every push.
 */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <RouteErrorBoundary key={location.pathname}>{children}</RouteErrorBoundary>;
}

/** Kept inside auth/RBAC guards: a denied page never starts its lazy import. */
export default function RoutePage({ children }: { children: ReactNode }) {
  // A rejected page import is cached, so the explicit retry reloads the document.
  return <RouteBoundary>
    <Suspense fallback={<RouteLoading />}>{children}</Suspense>
  </RouteBoundary>;
}

/**
 * React Router renders navigations in a transition. One boundary that is
 * already showing a page lets React keep that page while the next chunk loads;
 * a fresh boundary per route would reveal its fallback instead, and React holds
 * a revealed fallback for at least 300ms. The fallback still covers first load.
 */
export function ShellOutlet() {
  return <>
    <NavigationPending />
    <Suspense fallback={<RouteLoading />}><Outlet /></Suspense>
  </>;
}

const PENDING_DELAY_MS = 150;

/** The kept page gets a progress bar when the next one is slow to arrive. */
function NavigationPending() {
  const committed = useLocation().pathname;
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setPending(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The router updates history synchronously, then renders the new page in a
    // transition; until that commits, this effect still holds the old path.
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setPending(window.location.pathname !== committed), PENDING_DELAY_MS);
    };
    document.addEventListener('click', watch, true);
    window.addEventListener('popstate', watch);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', watch, true);
      window.removeEventListener('popstate', watch);
    };
  }, [committed]);
  if (!pending) return null;
  return <div className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden" dir="rtl" role="status" aria-live="polite">
    <div className="h-full w-1/3 animate-pulse" style={{ background: 'var(--accent)' }} aria-hidden="true" />
    <span className="sr-only">جارٍ تحميل الصفحة…</span>
  </div>;
}
