/**
 * Card typefaces, all SIL Open Font License 1.1 and bundled (font-files.ts):
 * IBM Plex Sans Arabic, Cairo and Tajawal for Arabic; IBM Plex Sans Arabic,
 * Inter and Cairo for Latin. No CDN, no fonts installed on the viewer's
 * machine, no commercial face.
 *
 * A template picks one Arabic and one Latin font. Each is registered as its
 * own family restricted by unicode-range — the Arabic family covers only
 * Arabic code points, the Latin family only Latin ones — so the canvas font
 * list `"<Arabic family>", "<Latin family>"` draws every character in the font
 * chosen for its script. Layout must not run before loadCardFonts() resolves:
 * measuring with a fallback face is what made the legacy card clip text.
 */
import type { CardTemplateConfig } from '@mip/shared';
import { CARD_FONT_FILES } from './font-files';
import { arabicFamily, latinFamily } from './theme';

export { cardFamilies } from './theme';

// Unicode ranges as published by @fontsource (unicode.json).
const RANGES: Record<'arabic' | 'latin' | 'latin-ext', string> = {
  arabic: 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};

export class CardFontError extends Error {}

const loaded = new Map<string, Promise<void>>();

function register(family: string, font: string, subsets: Array<keyof typeof RANGES>) {
  let p = loaded.get(family);
  if (!p) {
    p = (async () => {
      const files = CARD_FONT_FILES.filter((f) => f.font === font && subsets.includes(f.subset));
      if (!files.length) throw new Error(`no files for ${font}`);
      const faces = files.map((f) => new FontFace(family, `url(${f.url}) format('woff2')`, { weight: String(f.weight), unicodeRange: RANGES[f.subset], display: 'block' }));
      await Promise.all(faces.map((face) => face.load()));
      for (const face of faces) document.fonts.add(face);
    })();
    loaded.set(family, p);
    p.catch(() => loaded.delete(family));
  }
  return p;
}

/** Loads (once) the two families a template uses; rejects — and allows a retry — if any file fails. */
export async function loadCardFonts(t: Pick<CardTemplateConfig['typography'], 'arabicFont' | 'latinFont'>): Promise<void> {
  try {
    await Promise.all([register(arabicFamily(t.arabicFont), t.arabicFont, ['arabic']), register(latinFamily(t.latinFont), t.latinFont, ['latin', 'latin-ext'])]);
    if (!document.fonts.check(`400 16px "${arabicFamily(t.arabicFont)}"`, 'بطاقة') || !document.fonts.check(`400 16px "${latinFamily(t.latinFont)}"`, 'Card'))
      throw new Error('font not usable');
  } catch (e) {
    throw new CardFontError(`تعذّر تحميل خط البطاقة، لذلك لن تُصدَّر بخط بديل (${(e as Error).message}).`);
  }
}
