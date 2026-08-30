export const fmtNum = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US').format(n);

export const fmtCompact = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** API cost is often fractions of a cent — show enough digits to be meaningful. */
export const fmtMoney = (n: number | null | undefined, digits = 4) =>
  n === null || n === undefined ? '—' : `$${n.toFixed(digits)}`;

export const fmtPct = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '—' : `${(n * 100).toFixed(digits)}%`;

const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
export function fmtRelative(iso: string | Date | null | undefined) {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = (d.getTime() - Date.now()) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Infinity],
  ];
  let v = diff;
  for (const [unit, size] of units) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return d.toLocaleDateString('ar-SA');
}

export const fmtDateTime = (iso: string | Date | null | undefined) => {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString('ar-SA-u-nu-latn', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh',
  });
};
