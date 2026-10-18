import { parseInstant } from './format';
import type { Catalog, ExportRow } from './reports';

/** Client summaries are of the returned personal history (API cap: 100), never a global total. */
export function exportDuration(e: Pick<ExportRow, 'started_at' | 'finished_at'>): number | null {
  const start = parseInstant(e.started_at), end = parseInstant(e.finished_at);
  return start && end && end >= start ? (end.getTime() - start.getTime()) / 1000 : null;
}
export function exportActions(c: Catalog, e: ExportRow, now = Date.now()) {
  const expires = parseInstant(e.expires_at);
  return {
    download: c.canExport && e.is_owner && e.status === 'succeeded' && (!e.expires_at || (!!expires && expires.getTime() > now)),
    cancel: c.canExport && e.is_owner && !e.cancel_requested && ['queued', 'running'].includes(e.status),
    retry: c.canExport && e.is_owner && c.exportsActivated && ['failed', 'cancelled', 'expired'].includes(e.status),
  };
}
export function summarizeExports(items: ExportRow[]) {
  const durations = items.filter(e => e.status === 'succeeded').map(exportDuration).filter((n): n is number => n !== null);
  const statuses = new Map<string, number>(), types = new Map<string, number>(), days = new Map<string, number>();
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
  for (const e of items) {
    statuses.set(e.status, (statuses.get(e.status) ?? 0) + 1);
    types.set(e.report_type, (types.get(e.report_type) ?? 0) + 1);
    const date = parseInstant(e.created_at);
    if (date) { const day = dayFormat.format(date); days.set(day, (days.get(day) ?? 0) + 1); }
  }
  return { total: items.length, succeeded: statuses.get('succeeded') ?? 0, failed: statuses.get('failed') ?? 0,
    active: (statuses.get('queued') ?? 0) + (statuses.get('running') ?? 0),
    averageSeconds: durations.length ? durations.reduce((a,b) => a+b,0) / durations.length : null,
    durationCount: durations.length, statuses: [...statuses], types: [...types].sort((a,b) => b[1]-a[1]), days: [...days].sort((a,b) => a[0].localeCompare(b[0])) };
}
