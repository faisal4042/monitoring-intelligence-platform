/**
 * Identity image validation for card templates, without decoding libraries or
 * external services: the type comes from the file's magic bytes (never from a
 * declared type or file name), the dimensions from the format's header. Only
 * PNG, JPEG and still WebP are accepted; SVG, HTML, GIF, animated images and
 * anything unrecognised are refused.
 */
import { CARD_ASSET_LIMITS } from '@mip/shared';

export type CardImageType = (typeof CARD_ASSET_LIMITS.types)[number];
export interface CardImageInfo { mime: CardImageType; width: number; height: number }
export class CardImageError extends Error {}

function png(b: Buffer): CardImageInfo {
  if (b.length < 33 || b.toString('latin1', 12, 16) !== 'IHDR') throw new CardImageError('ملف PNG تالف');
  // Animated PNG (acTL before the first IDAT) is refused: the card shows a still image.
  const idat = b.indexOf('IDAT', 8, 'latin1');
  const actl = b.indexOf('acTL', 8, 'latin1');
  if (actl !== -1 && (idat === -1 || actl < idat)) throw new CardImageError('الصور المتحركة غير مدعومة');
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b: Buffer): CardImageInfo {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (marker === 0xda) break;
    i += 2 + len;
  }
  throw new CardImageError('تعذّر قراءة أبعاد صورة JPEG');
}

function webp(b: Buffer): CardImageInfo {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    if (b[20] & 0x02) throw new CardImageError('الصور المتحركة غير مدعومة');
    return { mime: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  throw new CardImageError('ملف WebP غير مدعوم');
}

/** The validated type and dimensions, or a CardImageError with an Arabic reason. */
export function inspectCardImage(b: Buffer): CardImageInfo {
  if (b.length === 0) throw new CardImageError('الملف فارغ');
  if (b.length > CARD_ASSET_LIMITS.maxBytes) throw new CardImageError(`حجم الملف يتجاوز ${CARD_ASSET_LIMITS.maxBytes / 1024 / 1024} ميغابايت`);
  let info: CardImageInfo;
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) info = png(b);
  else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) info = jpeg(b);
  else if (b.length >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') info = webp(b);
  else {
    const head = b.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg')) throw new CardImageError('ملفات SVG غير مسموحة');
    throw new CardImageError('نوع الملف غير مدعوم؛ المسموح PNG أو JPEG أو WebP');
  }
  const { minSide, maxSide } = CARD_ASSET_LIMITS;
  if (info.width < minSide || info.height < minSide || info.width > maxSide || info.height > maxSide)
    throw new CardImageError(`أبعاد الصورة يجب أن تكون بين ${minSide} و${maxSide} بكسل (الحالية ${info.width}×${info.height})`);
  return info;
}
