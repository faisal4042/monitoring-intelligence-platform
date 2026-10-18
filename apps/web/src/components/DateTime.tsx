import { fmtDate, fmtDateTime, fmtRelative, parseInstant } from '../lib/format';

/**
 * The one way to show a timestamp: the actual Riyadh date and time first,
 * the relative age second. `title` carries extra context (e.g. collected-at).
 */
export default function DateTime({ value, relative = true, className, title }: {
  value: string | Date | null | undefined;
  relative?: boolean;
  className?: string;
  title?: string;
}) {
  const d = parseInstant(value);
  if (!d) return <span className={className}>—</span>;
  const absolute = fmtDateTime(d);
  // Past a month fmtRelative falls back to the date itself — don't say it twice.
  const age = relative ? fmtRelative(d) : null;
  const showAge = age !== null && age !== fmtDate(d);
  return (
    <time dateTime={d.toISOString()} title={title ?? absolute} className={className}>
      <span className="tabular-nums">{absolute}</span>
      {showAge && <span className="opacity-75"> · {age}</span>}
    </time>
  );
}
