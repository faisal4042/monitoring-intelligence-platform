import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /** Solid fill for the one state that must stand out (danger only). */
  solid?: boolean;
  /** A small leading dot in the tone colour. */
  dot?: boolean;
  icon?: ReactNode;
};

/**
 * Status badge (DESIGN.md → Components → Badges and chips): pill radius, soft
 * status background with status text. Status tones are reserved for states.
 */
export function Badge({ tone = 'neutral', solid = false, dot = false, icon, className, children, ...rest }: BadgeProps) {
  const toneCls = solid && tone === 'danger' ? 'status-pill--danger-solid' : `badge--${tone}`;
  return (
    <span className={['badge', toneCls, className].filter(Boolean).join(' ')} {...rest}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}
