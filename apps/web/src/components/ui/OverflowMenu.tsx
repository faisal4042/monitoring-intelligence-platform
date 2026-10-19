import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export interface OverflowItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  /** Renders the item as a link (opens in a new tab). */
  href?: string;
  tone?: 'danger';
}

/**
 * «المزيد»: secondary actions behind one button (DESIGN.md → interaction cards).
 * Menu-button pattern: arrows move, Home/End jump, Escape closes and returns focus.
 * The list is portalled and fixed so cards with overflow:hidden never clip it.
 */
export function OverflowMenu({ items, label = 'المزيد', size = 'sm' }: { items: OverflowItem[]; label?: string; size?: 'sm' | 'md' }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = true) => { setPos(null); if (restore) trigger.current?.focus(); };

  // Place under the trigger, aligned to its inline end (RTL: the left edge), flipped up near the bottom.
  useLayoutEffect(() => {
    if (!pos || !menu.current || !trigger.current) return;
    const m = menu.current.getBoundingClientRect(), t = trigger.current.getBoundingClientRect();
    const top = m.bottom > window.innerHeight - 8 ? Math.max(8, t.top - m.height - 6) : pos.top;
    const left = Math.max(8, Math.min(pos.left, window.innerWidth - m.width - 8));
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
    menu.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false); };
    const dismiss = () => close(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [pos]);

  if (items.length === 0) return null;

  const onKey = (e: KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(); }
  };
  const open = () => {
    if (pos) { close(); return; }
    const r = trigger.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.right - 224 });
  };

  return (
    <>
      <button ref={trigger} type="button" className={`btn-quiet ${size === 'sm' ? 'btn--sm' : ''}`} aria-haspopup="menu" aria-expanded={!!pos}
        aria-controls={pos ? id : undefined} onClick={open}>
        <MoreHorizontal size={16} aria-hidden="true" />{label}
      </button>
      {pos && createPortal(
        <div ref={menu} id={id} className="card overflow-menu-list" role="menu" aria-label={label} dir="rtl" style={pos} onKeyDown={onKey}>
          {items.map((it) => it.href
            ? <a key={it.key} role="menuitem" tabIndex={-1} className="overflow-menu-item" href={it.href} target="_blank" rel="noopener noreferrer" onClick={() => close(false)}>{it.icon}{it.label}</a>
            : <button key={it.key} type="button" role="menuitem" tabIndex={-1} className={`overflow-menu-item ${it.tone === 'danger' ? 'is-danger' : ''}`}
                onClick={() => { close(); it.onSelect?.(); }}>{it.icon}{it.label}</button>)}
        </div>,
        document.body,
      )}
    </>
  );
}
