/**
 * Template configuration → the resolved theme the layout draws with. Every
 * visual choice of a template (colours, fonts, sizes, geometry, switches,
 * labels, images) passes through here; the layout itself has no constants of
 * its own. DEFAULT_CARD_TEMPLATE reproduces the phase 2 card exactly.
 */
import { DEFAULT_CARD_TEMPLATE, resolveCardDesign, type CardStatKey, type CardTemplateConfig } from '@mip/shared';

export const arabicFamily = (font: string) => `MIPCard AR ${font}`;
export const latinFamily = (font: string) => `MIPCard LA ${font}`;
/** The CSS font-family list a template draws with: Arabic code points from one family, Latin from the other. */
export const cardFamilies = (t: Pick<CardTemplateConfig['typography'], 'arabicFont' | 'latinFont'>) =>
  `"${arabicFamily(t.arabicFont)}", "${latinFamily(t.latinFont)}"`;

/** `hex` mixed towards white by `amount` (0 = unchanged, 1 = white). */
export function tint(hex: string, amount: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}
/** `top` laid over `base` at `alpha`, as one opaque colour (no translucent overdraw to round differently). */
export function over(base: string, top: string, alpha: number) {
  const b = Number.parseInt(base.slice(1), 16), t = Number.parseInt(top.slice(1), 16);
  const ch = (s: number) => Math.round(((t >> s) & 255) * alpha + ((b >> s) & 255) * (1 - alpha)).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
export function rgba(hex: string, alpha: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Size of an identity image as the layout needs it (natural pixels), when one is loaded. */
export interface ImageSize { width: number; height: number }

export function resolveTheme(config: CardTemplateConfig = DEFAULT_CARD_TEMPLATE, images: { logo?: ImageSize | null; background?: ImageSize | null } = {}) {
  const { colors: k, typography: ty, layout: g } = config;
  const design = resolveCardDesign(config);
  const family = cardFamilies(ty);
  const font = (weight: number, size: number) => `${weight} ${size}px ${family}`;
  const sentiment = (ink: string, label: string) => ({ ink, fill: tint(ink, 0.88), label });
  const logo = design.logoShow && (config.logo.assetId || design.defaultLogo) && images.logo ? { ...config.logo, size: images.logo } : null;
  const headerHeight = Math.max(88, ty.headerTitleSize + ty.smallSize + 52, logo ? config.logo.height + 28 : 0);
  return {
    config,
    design,
    style: design.style ?? 'classic',
    family, font,
    colors: k,
    sentiment: {
      positive: sentiment(k.positive, 'إيجابي'), neutral: sentiment(k.neutral, 'محايد'),
      negative: sentiment(k.negative, 'سلبي'), unclassified: sentiment(k.unclassified, 'غير مصنف'),
    },
    relevance: {
      relevant: { ink: k.indicator, fill: tint(k.indicator, 0.9), label: 'ذو صلة' },
      other: { ink: k.muted, fill: tint(k.muted, 0.92), label: 'غير مرتبط' },
      none: { ink: '#8a6116', fill: '#fbf3e3', label: 'لم يُصنف' },
    },
    pillFill: tint(k.title, 0.93),
    divider: tint(k.border, 0.55),
    avatarTones: ['#1a3c66', '#127a82', '#23466f', '#0e2a47', '#2f5a86'],
    weights: { title: ty.titleWeight, body: ty.bodyWeight, label: Math.max(ty.bodyWeight, 500) as 500 | 600 },
    sizes: {
      headerTitle: ty.headerTitleSize, handle: ty.handleSize, name: ty.nameSize, body: ty.bodySize,
      small: ty.smallSize, stat: ty.statValueSize, section: Math.min(ty.bodySize + 2, 18),
    },
    lineHeight: {
      body: Math.round(ty.bodySize * ty.lineHeight),
      small: Math.round(ty.smallSize * Math.max(1.45, ty.lineHeight - 0.05)),
      name: Math.round(ty.nameSize * 1.45),
      handle: Math.round(ty.handleSize * 1.3),
    },
    pad: g.padding, innerPad: Math.max(12, Math.round(g.padding * 0.58)), gap: g.gap, radius: g.radius,
    headerHeight: design.style === 'nhc' ? Math.max(headerHeight, (logo ? config.logo.height : 0) + 56, 104) : headerHeight,
    footerHeight: design.style === 'nhc' ? 84 : 56,
    avatar: config.avatar,
    logo,
    background: { ...config.background, image: config.background.imageAssetId && images.background ? images.background : null },
    stats: config.stats.filter((s) => s.show).map((s) => s.key as CardStatKey),
    show: config.visibility,
    text: config.text,
    pngWidth: config.output.pngWidth,
  };
}

export type CardTheme = ReturnType<typeof resolveTheme>;
