import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'quiet';
export type ButtonSize = 'md' | 'sm';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  quiet: 'btn-quiet',
};

type BaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (lucide, 16–18px). */
  icon?: ReactNode;
  /** Shows a busy state and blocks clicks; the label stays for screen readers. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

/** A labelled button, or an icon-only button that must carry an Arabic aria-label. */
export type ButtonProps =
  | (BaseProps & { children: ReactNode })
  | (BaseProps & { children?: undefined; icon: ReactNode; 'aria-label': string });

/**
 * The platform button (DESIGN.md → Components → Buttons): primary, ghost,
 * danger and quiet, in 40px (md) or 32px (sm, 40px on touch screens).
 */
export function Button({ variant = 'ghost', size = 'md', icon, loading = false, className, children, type = 'button', disabled, ref, ...rest }: ButtonProps) {
  const iconOnly = children === undefined || children === null;
  const cls = [VARIANT[variant], size === 'sm' && 'btn--sm', iconOnly && 'btn--icon', loading && 'is-loading', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {icon}
      {children}
    </button>
  );
}
