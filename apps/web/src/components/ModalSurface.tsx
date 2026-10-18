import { createContext, useContext, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties, type FormEventHandler, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissModal, registerModal } from '../lib/modal-focus';

const BusyContext = createContext(false);
export function ModalCloseButton(props: ComponentPropsWithoutRef<'button'>) {
  const busy = useContext(BusyContext);
  return <button {...props} disabled={props.disabled || busy} />;
}

/** Presentation-only modal shell. Portals keep nested layers independent of inert parents. */
export default function ModalSurface({ label, labelledBy, onClose, busy = false, dismissible = true,
  overlayClassName = 'modal-overlay', panelClassName = 'card modal-card p-5 w-full max-w-md',
  overlayStyle, panelStyle, as = 'section', onSubmit, returnFocus, children }: {
  label?: string; labelledBy?: string; onClose: () => void; busy?: boolean; dismissible?: boolean;
  overlayClassName?: string; panelClassName?: string; overlayStyle?: CSSProperties; panelStyle?: CSSProperties;
  as?: 'section' | 'div' | 'form'; onSubmit?: FormEventHandler; children: ReactNode;
  returnFocus?: HTMLElement | null;
}) {
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  const opener = useRef(returnFocus ?? (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null));
  const options = useRef({ onClose, busy, dismissible }); options.current = { onClose, busy, dismissible };
  useLayoutEffect(() => registerModal({ root: root.current!, panel: panel.current!, opener: opener.current,
    dismiss: () => options.current.onClose(), busy: () => options.current.busy || !options.current.dismissible }), []);
  const Tag = as;
  const content = <div ref={root} data-modal-layer className={overlayClassName}
    style={{ position: 'fixed', inset: 0, zIndex: 1000, ...overlayStyle }}
    onClick={event => { if (event.target === event.currentTarget && root.current) dismissModal(root.current); }}
    onSubmitCapture={event => {
      if (busy && root.current?.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); }
    }}>
    <Tag ref={panel as React.Ref<HTMLDivElement & HTMLFormElement>} role="dialog" aria-modal="true"
      aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-busy={busy || undefined}
      dir="rtl" tabIndex={-1} className={panelClassName} style={panelStyle} onSubmit={onSubmit}>
      <BusyContext.Provider value={busy}>{children}</BusyContext.Provider>
    </Tag>
  </div>;
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
