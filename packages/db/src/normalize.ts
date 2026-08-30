import { createHash } from 'node:crypto';

/**
 * Arabic normalization — runs before matching, deduplication and embedding.
 * See docs/AI_PIPELINE.md §2.
 *
 * The normalized form is for machine matching only and is never displayed;
 * the original text is always what the user sees.
 */

const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g;
const TATWEEL = /\u0640/g;
const ARABIC_INDIC = /[\u0660-\u0669]/g;
const EXT_ARABIC_INDIC = /[\u06F0-\u06F9]/g;
const URL = /https?:\/\/\S+|www\.\S+/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

export function normalizeArabic(input: string): string {
  if (!input) return '';
  let t = input;

  t = t.replace(URL, ' ');
  t = t.replace(EMOJI, ' ');
  t = t.replace(DIACRITICS, '');
  t = t.replace(TATWEEL, '');

  // Unify alef forms, ta marbuta and alef maqsura — the single biggest source
  // of duplicate dictionary entries if skipped.
  t = t.replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627'); // أ إ آ ٱ -> ا
  t = t.replace(/\u0629/g, '\u0647');                      // ة -> ه
  t = t.replace(/\u0649/g, '\u064A');                      // ى -> ي
  t = t.replace(/\u0624/g, '\u0648');                      // ؤ -> و
  t = t.replace(/\u0626/g, '\u064A');                      // ئ -> ي

  t = t.replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660));
  t = t.replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06F0));

  // مشششكلة -> مششكلة  (cap runs at 2 so real doubling survives)
  t = t.replace(/(.)\1{2,}/g, '$1$1');

  t = t.replace(/[^\p{L}\p{N}\s#@_]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim().toLowerCase();

  return t;
}

/** Stable content fingerprint used for exact-duplicate detection. */
export function contentHash(text: string): Buffer {
  return createHash('sha256').update(normalizeArabic(text), 'utf8').digest();
}
