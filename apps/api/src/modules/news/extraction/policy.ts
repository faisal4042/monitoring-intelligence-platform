/** Pure policies shared by extraction paths and isolated tests. */
export type ExtractionMode = 'live' | 'shadow';
export interface BreakerEvent { status: string; at: string; cid: string }
export function isBreakerOpen(events: BreakerEvent[], threshold: number, cooldownMs: number, now = Date.now()): boolean {
  const recent = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, threshold);
  return recent.length === threshold && recent.every((e) => ['empty', 'failed', 'dead'].includes(e.status))
    && now - Date.parse(recent[0].at) < cooldownMs;
}
export function retryAllowed(result: { status: string; retryable: boolean; http_status: number | null; error_kind: string | null }): boolean {
  return result.status === 'failed' && result.retryable && ![401, 403, 451].includes(result.http_status ?? 0)
    && result.error_kind !== 'forbidden';
}

// Serialize each source/mode in this process. The service adds a PostgreSQL
// session advisory lock for coordination across processes, without schema changes.
const tails = new Map<string, Promise<void>>();
export async function serializeSource<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await prior;
  try { return await work(); }
  finally { release(); if (tails.get(key) === current) tails.delete(key); }
}
