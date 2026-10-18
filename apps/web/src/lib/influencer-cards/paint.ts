/**
 * Paints a laid-out card page onto a canvas. It only executes the display
 * list from layout.ts; it decides no geometry, so preview, PNG and PDF are
 * the same pixels at the same scale. Decorations and footer patterns are
 * drawn here, never loaded as images.
 */
import type { CardImages } from './assets';
import type { CardPage, DrawItem, Measure } from './types';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const sizeOf = (img: CanvasImageSource | null | undefined) => {
  const s = img as { width?: number; height?: number } | null | undefined;
  return s && s.width && s.height ? { w: s.width, h: s.height } : null;
};

function lattice(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, step: number, both: boolean) {
  for (let i = x - h; i < x + w + h; i += step) {
    ctx.beginPath(); ctx.moveTo(i, y + h); ctx.lineTo(i + h, y); ctx.stroke();
    if (both) { ctx.beginPath(); ctx.moveTo(i, y); ctx.lineTo(i + h, y + h); ctx.stroke(); }
  }
}

/** NHC footer: one row of large outlined leaves, tilted and cut by the strip's bottom edge, in the brand's bright green. */
function leaves(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const tilt = [-0.95, 0.75, -0.55, 1.05, -0.8, 0.5];
  ctx.lineWidth = 2.6; ctx.lineJoin = 'round';
  for (let i = 0, cx = x - 20; cx < x + w + 80; i++, cx += 104) {
    const len = 54 + (i % 3) * 8, wid = len * 0.62;
    ctx.save(); ctx.translate(cx, y + h * 0.92 + (i % 2) * 10); ctx.rotate(-Math.PI / 2 + tilt[i % tilt.length]);
    ctx.beginPath(); ctx.moveTo(-len, 0);
    ctx.quadraticCurveTo(0, -wid, len, 0); ctx.quadraticCurveTo(0, wid, -len, 0);
    ctx.stroke(); ctx.restore();
  }
}

function drawItem(ctx: CanvasRenderingContext2D, item: DrawItem, images: CardImages) {
  switch (item.kind) {
    case 'gradient': {
      ctx.save();
      const gradient = ctx.createLinearGradient(item.x, item.y, item.horizontal ? item.x + item.w : item.x, item.horizontal ? item.y : item.y + item.h);
      gradient.addColorStop(0, item.start); gradient.addColorStop(1, item.end);
      ctx.globalAlpha = item.opacity; ctx.fillStyle = gradient;
      ctx.fillRect(item.x, item.y, item.w, item.h); ctx.restore(); return;
    }
    case 'rect': {
      roundRect(ctx, item.x, item.y, item.w, item.h, item.r);
      if (item.fill) { ctx.fillStyle = item.fill; ctx.fill(); }
      if (item.stroke) {
        ctx.setLineDash(item.dash ?? []);
        ctx.strokeStyle = item.stroke; ctx.lineWidth = item.lineWidth ?? 1; ctx.stroke();
        ctx.setLineDash([]);
      }
      return;
    }
    case 'line': {
      ctx.beginPath(); ctx.moveTo(item.x1, item.y1); ctx.lineTo(item.x2, item.y2);
      ctx.strokeStyle = item.color; ctx.lineWidth = item.width; ctx.stroke();
      return;
    }
    case 'text': {
      ctx.font = item.font;
      ctx.fillStyle = item.color;
      ctx.direction = item.dir;
      ctx.textAlign = item.align;
      ctx.textBaseline = 'middle';
      ctx.fillText(item.text, item.x, item.y + item.lineHeight / 2);
      return;
    }
    case 'avatar': {
      const shape = (pad = 0) => {
        if (item.shape === 'circle') { ctx.beginPath(); ctx.arc(item.cx, item.cy, item.r + pad, 0, Math.PI * 2); }
        else roundRect(ctx, item.cx - item.r - pad, item.cy - item.r - pad, (item.r + pad) * 2, (item.r + pad) * 2, (item.r + pad) * 0.28);
      };
      ctx.save();
      shape(6); ctx.fillStyle = 'rgba(14,42,71,0.07)'; ctx.fill();
      shape(); ctx.clip();
      const img = images.avatar;
      const s = sizeOf(img);
      if (img && s) {
        // Cover: the shorter side fills the shape, centred.
        const side = Math.min(s.w, s.h);
        ctx.drawImage(img, (s.w - side) / 2, (s.h - side) / 2, side, side, item.cx - item.r, item.cy - item.r, item.r * 2, item.r * 2);
      } else {
        ctx.fillStyle = item.tone; ctx.fillRect(item.cx - item.r, item.cy - item.r, item.r * 2, item.r * 2);
        ctx.fillStyle = '#ffffff'; ctx.font = item.font;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'ltr';
        ctx.fillText(item.initial, item.cx, item.cy + 2);
      }
      ctx.restore();
      shape(); ctx.strokeStyle = item.ring; ctx.lineWidth = 4; ctx.stroke();
      return;
    }
    case 'verified': {
      ctx.save();
      ctx.beginPath(); ctx.arc(item.cx, item.cy, item.r, 0, Math.PI * 2); ctx.fillStyle = item.color; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(item.cx - item.r * 0.45, item.cy + item.r * 0.05);
      ctx.lineTo(item.cx - item.r * 0.12, item.cy + item.r * 0.38);
      ctx.lineTo(item.cx + item.r * 0.48, item.cy - item.r * 0.32);
      ctx.stroke();
      ctx.restore();
      return;
    }
    case 'image': {
      const img = images[item.key];
      const s = sizeOf(img);
      if (!img || !s) return;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      ctx.beginPath(); ctx.rect(item.x, item.y, item.w, item.h); ctx.clip();
      // contain: the whole image inside the box; cover: the box filled, centred.
      const k = item.fit === 'contain' ? Math.min(item.w / s.w, item.h / s.h) : Math.max(item.w / s.w, item.h / s.h);
      const w = s.w * k, h = s.h * k;
      ctx.drawImage(img, item.x + (item.w - w) / 2, item.y + (item.h - h) / 2, w, h);
      ctx.restore();
      return;
    }
    case 'decoration': {
      ctx.save();
      ctx.globalAlpha = item.opacity;
      ctx.beginPath(); ctx.rect(item.x, item.y, item.w, item.h); ctx.clip();
      ctx.strokeStyle = item.color; ctx.fillStyle = item.color; ctx.lineWidth = 1.2;
      if (item.style === 'dots') {
        for (let yy = item.y + 12; yy < item.y + item.h; yy += 24)
          for (let xx = item.x + 12 + (((yy - item.y) / 24) % 2) * 12; xx < item.x + item.w; xx += 24) { ctx.beginPath(); ctx.arc(xx, yy, 2, 0, Math.PI * 2); ctx.fill(); }
      } else lattice(ctx, item.x, item.y, item.w, item.h, 28, item.style === 'lattice');
      ctx.restore();
      return;
    }
    case 'pattern': {
      ctx.save();
      ctx.fillStyle = item.base; ctx.fillRect(item.x, item.y, item.w, item.h);
      if (item.style !== 'plain' && item.style !== 'vines') {
        ctx.beginPath(); ctx.rect(item.x, item.y, item.w, item.h); ctx.clip();
        ctx.strokeStyle = item.ink; ctx.lineWidth = 1.5;
        if (item.style === 'leaves') leaves(ctx, item.x, item.y, item.w, item.h);
        else lattice(ctx, item.x, item.y, item.w, item.h, 16, item.style === 'lattice');
      }
      ctx.restore();
      return;
    }
  }
}

/** Paints `page` at `scale` device pixels per CSS pixel onto a new canvas. */
export function renderPage(page: CardPage, scale: number, images: CardImages): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(page.width * scale);
  canvas.height = Math.round(page.height * scale);
  // willReadFrequently keeps the canvas on the CPU rasteriser: large canvases may otherwise go to the GPU,
  // whose output can differ by a pixel between two paints of the same page — preview and file must not.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D غير متاح في هذا المتصفح');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  for (const item of page.items) drawItem(ctx, item, images);
  return canvas;
}

/** Canvas text measurement with a cache; call only after the template's fonts loaded. */
export function createMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      cache.set(key, w);
    }
    return w;
  };
}
