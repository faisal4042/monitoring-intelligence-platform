import horizontalColor from '../assets/brand/ithra-horizontal-color.png';
import horizontalNegative from '../assets/brand/ithra-horizontal-negative.png';
import stackedNegative from '../assets/brand/ithra-stacked-negative.png';

/**
 * The official Ithra United logo files, unmodified (docs/ithra-branding.md).
 * Full colour on white / light neutral, negative on Deep Navy — the theme
 * (or `onNavy`) picks the file in CSS. Width never goes below the guide's
 * on-screen minimum: horizontal 160px, stacked 110px.
 */
const MIN = { horizontal: 160, stacked: 110 } as const;
const ALT = 'إثراء المتحدة لخدمات الأعمال — Ithra United Business Services';

export default function BrandLogo({ variant = 'horizontal', width, onNavy = false, className = '' }: {
  variant?: 'horizontal' | 'stacked'; width: number; onNavy?: boolean; className?: string;
}) {
  const w = Math.max(width, MIN[variant]);
  if (variant === 'stacked') {
    // Only the negative stacked file is supplied, so it is used on navy only.
    return <img className={`brand-logo ${className}`} src={stackedNegative} width={w} alt={ALT} draggable={false} />;
  }
  return <span className={`brand-logo-set ${onNavy ? 'brand-logo--on-navy' : ''} ${className}`}>
    <img className="brand-logo brand-logo--color" src={horizontalColor} width={w} alt={ALT} draggable={false} />
    <img className="brand-logo brand-logo--negative" src={horizontalNegative} width={w} alt={ALT} draggable={false} />
  </span>;
}
