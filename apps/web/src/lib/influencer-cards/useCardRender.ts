/**
 * Everything a card needs before it can be drawn, in order: the template's
 * fonts, then its images (avatar, logo, background), then the layout. Used by
 * the export dialog and the template studio alike, so both draw the same way.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { resolveCardDesign, type CardTemplateConfig } from '@mip/shared';
import { loadCardAsset, loadCardAvatar, loadDefaultCardLogo, loadFooterVines, type CardImages } from './assets';
import { loadCardFonts } from './fonts';
import { layoutCard } from './layout';
import { createMeasure } from './paint';
import type { CardData, CardFormat, CardLayout } from './types';

const sizeOf = (img: ImageBitmap | null | undefined) => (img ? { width: img.width, height: img.height } : null);

export function useCardRender(data: CardData | undefined, template: CardTemplateConfig | undefined, format: CardFormat, opts: { avatar?: CanvasImageSource | null } = {}) {
  const ty = template?.typography;
  const fonts = useQuery({
    queryKey: ['influencer-card-fonts', ty?.arabicFont, ty?.latinFont],
    enabled: Boolean(ty),
    queryFn: () => loadCardFonts(ty!).then(() => true),
    staleTime: Infinity, retry: false,
  });
  const avatarPath = data?.account.avatar ?? null;
  const avatar = useQuery({
    queryKey: ['influencer-card-avatar', avatarPath],
    enabled: Boolean(data) && opts.avatar === undefined,
    queryFn: () => loadCardAvatar(avatarPath),
    staleTime: 10 * 60_000,
  });
  const logoId = template?.logo.assetId ?? null;
  const defaultLogo = Boolean(template && resolveCardDesign(template).defaultLogo && !logoId);
  const bgId = template?.background.imageAssetId ?? null;
  const style = template ? resolveCardDesign(template).style ?? 'classic' : 'classic';
  const logo = useQuery({ queryKey: ['influencer-card-asset', defaultLogo ? `bundled-default-${style}` : logoId], enabled: Boolean(logoId) || defaultLogo, queryFn: () => defaultLogo ? loadDefaultCardLogo(style) : loadCardAsset(logoId), staleTime: Infinity });
  const background = useQuery({ queryKey: ['influencer-card-asset', bgId], enabled: Boolean(bgId), queryFn: () => loadCardAsset(bgId), staleTime: Infinity });
  const vines = template?.background.footerPattern === 'vines';
  const footer = useQuery({ queryKey: ['influencer-card-asset', 'bundled-footer-vines'], enabled: vines, queryFn: loadFooterVines, staleTime: Infinity });

  // A fresh measure per font pair: widths are only valid for the faces they were measured with.
  const measure = useMemo(() => (fonts.isSuccess ? createMeasure() : null), [fonts.isSuccess, ty?.arabicFont, ty?.latinFont]);
  const imagesLoading = (opts.avatar === undefined && avatar.isLoading) || ((Boolean(logoId) || defaultLogo) && logo.isLoading) || (Boolean(bgId) && background.isLoading) || (vines && footer.isLoading);
  const images = useMemo<CardImages>(() => ({
    avatar: opts.avatar !== undefined ? opts.avatar : avatar.data ?? null,
    logo: logo.data ?? null, background: background.data ?? null, footer: vines ? footer.data ?? null : null,
  }), [opts.avatar, avatar.data, logo.data, background.data, vines, footer.data]);
  const layout = useMemo<CardLayout | null>(() => (data && template && measure && !imagesLoading
    ? layoutCard(data, { format, measure, template, images: { logo: sizeOf(logo.data), background: sizeOf(background.data) } })
    : null), [data, template, measure, format, imagesLoading, logo.data, background.data]);

  return {
    layout, images,
    loading: fonts.isLoading || imagesLoading,
    error: (fonts.error as Error | null)?.message ?? null,
    /** A logo or background the template names but that could not be loaded (the card is drawn without it). */
    missingImages: [logoId && logo.isSuccess && !logo.data ? 'الشعار' : null, bgId && background.isSuccess && !background.data ? 'صورة الخلفية' : null].filter(Boolean) as string[],
  };
}
