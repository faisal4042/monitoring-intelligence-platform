import { useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import ModalSurface from '../ModalSurface';

export default function DialogSurface({ title, onClose, children, drawer = false, busy = false, className = '' }: {
  title: string; onClose: () => void; children: ReactNode; drawer?: boolean; busy?: boolean; className?: string;
}) {
  const titleId = useId();
  return <ModalSurface labelledBy={titleId} onClose={onClose} busy={busy}
    overlayClassName={`${drawer ? 'qb-drawer-overlay' : 'qb-dialog-overlay'} ${className}`}
    panelClassName={drawer ? 'qb-drawer card' : 'qb-dialog card'}>
    <header className="qb-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} className="icon-button" aria-label="إغلاق التفاصيل" onClick={onClose}><X size={18} /></button></header>
    <div className="qb-dialog-body">{children}</div>
  </ModalSurface>;
}
