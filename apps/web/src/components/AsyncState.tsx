import type { ReactNode } from 'react';

import { Button } from './ui/Button';
/** Errors take precedence over empty data, including failed background refreshes. */
export default function AsyncState({ loading, error, empty, onRetry, children,
  loadingMessage = 'جارٍ تحميل البيانات…', errorMessage = 'تعذر تحميل البيانات. حاول مرة أخرى.',
  emptyMessage = 'لا توجد بيانات مطابقة.' }: {
  loading?: boolean; error?: unknown; empty?: boolean; onRetry?: () => unknown;
  children?: ReactNode; loadingMessage?: string; errorMessage?: string; emptyMessage?: ReactNode;
}) {
  if (error) return <div className="card p-6 text-center space-y-3" role="alert">
    <p className="text-sm text-(--status-danger)">{errorMessage}</p>
    {onRetry && <Button variant="ghost" type="button" onClick={() => { void onRetry(); }}>إعادة المحاولة</Button>}
  </div>;
  if (loading) return <div className="card p-6 text-center muted" role="status" aria-busy="true">{loadingMessage}</div>;
  if (empty) return <div className="card p-6 text-center muted" role="status">{emptyMessage}</div>;
  return <>{children}</>;
}
