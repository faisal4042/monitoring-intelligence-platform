/**
 * Conservative detection of POTENTIAL external-CRM ticket numbers in free text.
 * Organisation tickets are known to start with 2, but the prefix alone proves
 * nothing and no official verification API is wired, so every hit is only a
 * candidate and must be shown as «غير متحقق». The guards keep out the obvious
 * look-alikes: national/iqama IDs (10 digits), Saudi phone numbers (05… local,
 * 9665…/009665… international), fractions of longer runs, years and amounts.
 */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const normalizeDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));

export function potentialTicketNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const normalized = normalizeDigits(text);
  const out: string[] = [];
  for (const m of normalized.matchAll(/(\d{6,})/g)) {
    const run = m[1];
    // Starts with 2 by the organisation's convention; 6–9 digits so a 10-digit
    // iqama (which also starts with 2) and 12-digit international phones never match.
    if (!run.startsWith('2') || run.length > 9) continue;
    const before = normalized.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
    const after = normalized.slice((m.index ?? 0) + run.length, (m.index ?? 0) + run.length + 12);
    if (/[\d+.,/-]\s?$/.test(before)) continue;            // part of a longer run, a date or a decimal
    if (/^(966|00966)/.test(run.slice(0, 5)) || /966\s?$/.test(before)) continue; // phone context
    if (/^\s*(ريال|ر\.س|ر٫س|SAR)/.test(after)) continue;   // an amount, not a reference
    if (!out.includes(run)) out.push(run);
    if (out.length >= 3) break;
  }
  return out;
}
