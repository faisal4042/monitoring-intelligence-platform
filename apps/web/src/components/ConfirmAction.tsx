import { useId, useRef, useState } from 'react';
import ModalSurface from './ModalSurface';
import { useAuth } from '../lib/auth';

export interface Confirmation {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  allowed: (can: (...permissions: string[]) => boolean) => boolean;
  execute: () => Promise<unknown>;
}

export default function ConfirmAction({ action, onClose }: { action: Confirmation; onClose: () => void }) {
  const auth = useAuth();
  const allowed = () => action.allowed(auth?.can ?? (() => false));
  const id = useId();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => { if (!running.current) onClose(); };
  const confirm = async () => {
    if (running.current) return;
    if (!allowed()) { setError('لم تعد لديك صلاحية تنفيذ هذا الإجراء.'); return; }
    running.current = true;
    setBusy(true);
    setError('');
    try { await action.execute(); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'تعذر تنفيذ الإجراء.'); }
    finally { running.current = false; setBusy(false); }
  };
  return <ModalSurface labelledBy={id} onClose={close} busy={busy} overlayClassName="modal-overlay fixed inset-0 bg-black/50 grid place-items-center p-4" panelClassName="card modal-card p-5 w-full max-w-md">
    <h2 id={id} className={`font-bold mb-3 ${action.danger ? 'text-red-600' : ''}`}>{action.title}</h2>
    <p className="text-sm mb-4" id={`${id}-description`}>{action.description}</p>
    {error && <p role="alert" className="text-red-600 text-sm mb-4">{error}</p>}
    <div className="flex gap-2 justify-end">
      <button className="btn-ghost" data-dialog-initial-focus disabled={busy} onClick={close}>إلغاء</button>
      <button className={`btn-primary ${action.danger ? '!bg-red-600' : ''}`} aria-describedby={`${id}-description`} disabled={busy || !allowed()} onClick={confirm}>{busy ? 'جارٍ التنفيذ…' : action.confirmLabel}</button>
    </div>
  </ModalSurface>;
}

export function useConfirmAction() {
  const auth = useAuth();
  const [action, setAction] = useState<Confirmation | null>(null);
  const current = useRef(action);
  current.current = action;
  const request = (next: Confirmation) => {
    if (!current.current && next.allowed(auth?.can ?? (() => false))) { current.current = next; setAction(next); }
  };
  return { request, dialog: action && <ConfirmAction action={action} onClose={() => { current.current = null; setAction(null); }} /> };
}

export function useDiscardChanges(dirty: boolean, discard: () => void) {
  const confirmation = useConfirmAction();
  return {
    dialog: confirmation.dialog,
    close: () => {
      if (!dirty) { discard(); return; }
      confirmation.request({ title: 'تجاهل التعديلات غير المحفوظة؟', description: 'ستفقد التعديلات في هذه النافذة. اختر إلغاء للعودة إليها.', confirmLabel: 'تجاهل التعديلات', danger: true, allowed: () => true, execute: async () => discard() });
    },
  };
}
