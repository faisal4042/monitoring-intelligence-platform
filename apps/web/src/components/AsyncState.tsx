import type { ReactNode } from 'react';

/** Errors take precedence over empty data, including failed background refreshes. */
export default function AsyncState({ loading, error, empty, onRetry, children,
  loadingMessage = 'جارٍ تحميل البيانات…', errorMessage = 'تعذر تحميل البيانات. حاول مرة أخرى.',
  emptyMessage = 'لا توجد بيانات مطابقة.' }: {
  loading?: boolean; error?: unknown; empty?: boolean; onRetry?: () => unknown;
  children?: ReactNode; loadingMessage?: string; errorMessage?: string; emptyMessage?: ReactNode;
}) {
  if (error) return <div className="card p-6 text-center space-y-3" role="alert">
    <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
    {onRetry && <button type="button" className="btn-ghost" onClick={() => { void onRetry(); }}>إعادة المحاولة</button>}
  </div>;
  if (loading) return <div className="card p-6 text-center muted" role="status" aria-busy="true">{loadingMessage}</div>;
  if (empty) return <div className="card p-6 text-center muted" role="status">{emptyMessage}</div>;
  return <>{children}</>;
}
