import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export interface Notice { kind: 'success' | 'error'; text: string }

/** Page-level result message for a completed (or failed) action. Success fades after a few seconds. */
export function useActionNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((next: Notice) => {
    clearTimeout(timer.current);
    setNotice(next);
    if (next.kind === 'success') timer.current = setTimeout(() => setNotice(null), 6000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    success: (text: string) => show({ kind: 'success', text }),
    error: (error: unknown) => show({ kind: 'error', text: error instanceof Error ? error.message : String(error) }),
    element: notice && <ActionNotice notice={notice} onClose={() => setNotice(null)} />,
  };
}

export default function ActionNotice({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const ok = notice.kind === 'success';
  return (
    <div role={ok ? 'status' : 'alert'}
      className={`card p-3 text-sm flex items-start justify-between gap-3 ${ok ? 'bg-(--status-success-soft) text-(--status-success)' : 'bg-(--status-danger-soft) text-(--status-danger)'}`}>
      <span>{notice.text}</span>
      <button type="button" className="shrink-0 opacity-70 hover:opacity-100" onClick={onClose} aria-label="إغلاق الرسالة"><X size={14} /></button>
    </div>
  );
}
