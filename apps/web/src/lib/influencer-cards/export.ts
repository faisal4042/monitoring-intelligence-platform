/**
 * PNG and PDF output. Both paint the layout with paint.ts — the same function
 * the preview uses — so a file shows exactly what the preview showed.
 *   PNG: the continuous card (format 'png') at 2× or 3×.
 *   PDF: A4 portrait or landscape, one image per page at 2× (≈192 dpi), with
 *        the layout's link areas as real link annotations (X links only).
 * jsPDF is loaded on demand, so it never weighs on pages that do not export.
 */
import type { CardImages } from './assets';
import { safePostUrl, safeProfileUrl } from './layout';
import { renderPage } from './paint';
import type { CardLayout } from './types';

/** Largest canvas side and area browsers reliably allocate. */
const MAX_SIDE = 32_000;
const MAX_AREA = 250_000_000;

/** The largest scale a page can be painted at, or 0 when even 1× is too big. */
export function maxScale(layout: CardLayout): number {
  let s = Infinity;
  for (const p of layout.pages) s = Math.min(s, MAX_SIDE / p.width, MAX_SIDE / p.height, Math.sqrt(MAX_AREA / (p.width * p.height)));
  return s >= 1 ? Math.floor(s * 100) / 100 : 0;
}

const toBlob = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob>((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('تعذّر إنشاء الصورة'))), type));

export async function exportPng(layout: CardLayout, scale: number, images: CardImages): Promise<Blob> {
  if (layout.format !== 'png' || layout.pages.length !== 1) throw new Error('صورة PNG تُبنى من تخطيط البطاقة المتصل');
  if (scale > maxScale(layout)) throw new Error('البطاقة أطول من أن تُحفظ صورة واحدة بهذه الدقة؛ اختر دقة أقل أو صدّرها PDF.');
  return toBlob(renderPage(layout.pages[0], scale, images), 'image/png');
}

/** A4 in PDF points. */
const A4_PT = { w: 595.28, h: 841.89 };

export async function exportPdf(layout: CardLayout, images: CardImages, scale = 2): Promise<Blob> {
  if (layout.format === 'png') throw new Error('ملف PDF يُبنى من تخطيط A4');
  const landscape = layout.format === 'a4-landscape';
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4', compress: true });
  const pageW = landscape ? A4_PT.h : A4_PT.w;
  const pageH = landscape ? A4_PT.w : A4_PT.h;
  layout.pages.forEach((page, i) => {
    if (i > 0) pdf.addPage('a4', landscape ? 'landscape' : 'portrait');
    const k = pageW / page.width;
    pdf.addImage(renderPage(page, scale, images), 'PNG', 0, 0, pageW, pageH, undefined, 'FAST');
    for (const l of page.links) {
      const url = safePostUrl(l.url) ?? safeProfileUrl(l.url);
      if (url) pdf.link(l.x * k, l.y * k, l.w * k, l.h * k, { url });
    }
  });
  pdf.setProperties({ title: 'بطاقة مؤثر', creator: 'MIP' });
  return pdf.output('blob');
}

/** `influencer-card-<handle>-<YYYY-MM-DD>.<ext>`; the handle is reduced to safe characters. */
export function cardFileName(username: string, ext: 'png' | 'pdf', now = new Date()) {
  const handle = username.replace(/[^A-Za-z0-9_]/g, '') || 'account';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(now);
  return `influencer-card-${handle}-${day}.${ext}`;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
