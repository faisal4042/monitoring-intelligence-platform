import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import ModalSurface, { ModalCloseButton } from '../ModalSurface';

/**
 * Side sheet for the search page (filters, saved searches). Built on the shared
 * ModalSurface: focus trap, Escape and focus return come from there. Opens on
 * the inline end, away from the platform sidebar, like the queue drawer.
 */
export default function SearchDrawer({ title, icon, badge, onClose, footer, children, id }: {
  title: string; icon?: ReactNode; badge?: ReactNode; onClose: () => void; footer?: ReactNode; children: ReactNode; id: string;
}) {
  return (
    <ModalSurface labelledBy={`${id}-title`} onClose={onClose} overlayClassName="as-drawer-overlay" panelClassName="as-drawer" as="section">
      <header className="as-drawer-head">
        <h2 id={`${id}-title`} className="as-drawer-title">{icon}{title}{badge}</h2>
        <ModalCloseButton type="button" className="icon-button" aria-label="إغلاق" onClick={onClose}><X size={17} /></ModalCloseButton>
      </header>
      <div className="as-drawer-body">{children}</div>
      {footer && <footer className="as-drawer-foot">{footer}</footer>}
    </ModalSurface>
  );
}
