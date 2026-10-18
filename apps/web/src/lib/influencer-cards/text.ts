/**
 * Line breaking for the card. Words wrap at spaces; a word wider than the box
 * (a long link, a hashtag run, an unbroken string) is broken between grapheme
 * clusters so nothing ever runs past the edge. Paragraph breaks in the source
 * text are kept. Measuring uses the real font (see fonts.ts) — never before it
 * has loaded.
 */
import type { Measure, TextDir } from './types';

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s: string) => (segmenter ? [...segmenter.segment(s)].map((g) => g.segment) : Array.from(s));

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏ]/;

/** Base direction from the first strong character, like dir="auto"; Arabic when there is none. */
export function baseDir(text: string): TextDir {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return 'rtl';
}

/** Splits a word that does not fit into pieces that do (at least one grapheme each). */
function breakWord(word: string, maxWidth: number, font: string, measure: Measure): string[] {
  const out: string[] = [];
  let piece = '';
  for (const g of graphemes(word)) {
    if (piece && measure(piece + g, font) > maxWidth) { out.push(piece); piece = g; }
    else piece += g;
  }
  if (piece) out.push(piece);
  return out;
}

/** Whitespace collapsed inside paragraphs; at most one empty line between paragraphs. */
export function normalizeText(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((p) => p.replace(/[\t  ]+/g, ' ').trim())
    .filter((p, i, all) => p !== '' || (i > 0 && all[i - 1] !== ''))
    .filter((p, i, all) => !(p === '' && i === all.length - 1));
}

/**
 * Wrapped lines, each measuring at most `maxWidth`. With `maxLines`, the last
 * kept line ends with an ellipsis so a cut is visible, never silent.
 */
export function wrapText(text: string, maxWidth: number, font: string, measure: Measure, maxLines = Infinity): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  for (const paragraph of normalizeText(text)) {
    if (paragraph === '') { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(' ')) {
      const parts = measure(word, font) > maxWidth ? breakWord(word, maxWidth, font, measure) : [word];
      for (const part of parts) {
        const test = line ? `${line} ${part}` : part;
        if (line && measure(test, font) > maxWidth) { lines.push(line); line = part; }
        else line = test;
      }
    }
    if (line) lines.push(line);
  }
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && measure(`${last}…`, font) > maxWidth) last = graphemes(last).slice(0, -1).join('');
  kept[maxLines - 1] = `${last}…`;
  return { lines: kept, truncated: true };
}

/** One line, shortened with an ellipsis if it does not fit. */
export function fitLine(text: string, maxWidth: number, font: string, measure: Measure): string {
  return wrapText(text.replace(/\s+/g, ' '), maxWidth, font, measure, 1).lines[0] ?? '';
}
