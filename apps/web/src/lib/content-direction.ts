/** Leading account mentions and URLs do not decide the language of a message. */
export function contentDirection(text: string): 'rtl' | 'ltr' | 'auto' {
  const prose = text.replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/g, '');
  const firstLetter = prose.match(/\p{L}/u)?.[0];
  if (!firstLetter) return 'auto';
  return /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(firstLetter) ? 'rtl' : 'ltr';
}
