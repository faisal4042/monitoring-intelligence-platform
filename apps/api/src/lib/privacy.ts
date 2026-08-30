const EMAIL = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const SAUDI_PHONE = /(?:\+?966[\s-]?|0)?5\d(?:[\s-]?\d){7}/g;
const SAUDI_PHONE_AR = /(?:\+?٩٦٦[\s-]?|٠)?٥[٠-٩](?:[\s-]?[٠-٩]){7}/g;
const SAUDI_ID = /\b[12]\d{9}\b/g;
const SAUDI_ID_AR = /(?:^|\s)[١٢][٠-٩]{9}(?=\s|$)/g;
const SAUDI_IBAN = /\bSA\d{2}(?:[\s-]?[A-Z0-9]){18,22}\b/gi;
const URL = /https?:\/\/\S+/g;

export function containsSensitiveData(text: string): boolean {
  const patterns = [EMAIL, SAUDI_PHONE, SAUDI_PHONE_AR, SAUDI_ID, SAUDI_ID_AR, SAUDI_IBAN];
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** Mask direct identifiers while keeping the interaction useful for analysis. */
export function redactSensitiveText(text: string, options: { redactUrls?: boolean } = {}): string {
  let redacted = text
    .replace(EMAIL, '[بريد محجوب]')
    .replace(SAUDI_PHONE, '[جوال محجوب]')
    .replace(SAUDI_PHONE_AR, '[جوال محجوب]')
    .replace(SAUDI_ID, '[هوية محجوبة]')
    .replace(SAUDI_ID_AR, ' [هوية محجوبة]')
    .replace(SAUDI_IBAN, '[آيبان محجوب]');
  if (options.redactUrls) redacted = redacted.replace(URL, '[رابط محجوب]');
  return redacted.slice(0, 12_000);
}

export function redactRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => ({
    ...row,
    ...(typeof row.text === 'string' ? { text: redactSensitiveText(row.text) } : {}),
  }));
}
