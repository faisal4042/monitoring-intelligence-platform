/**
 * Per-domain concurrency=1 + minimum delay, so N sources on the same outlet
 * (or the worker's own concurrent batch) never hit one domain simultaneously.
 * In-memory only: there's a single API process today (no Redis in real use
 * anywhere in this codebase) — this is correct for that, and a known limit
 * if the platform ever runs multiple instances (each would enforce its own
 * per-domain pacing independently). Revisit only if that becomes real.
 */
const queues = new Map<string, Promise<unknown>>();
const lastRequestAt = new Map<string, number>();

export async function withDomainLock<T>(domain: string, minDelayMs: number, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(domain) ?? Promise.resolve();

  const runAfterDelay = previous.then(async () => {
    const elapsed = Date.now() - (lastRequestAt.get(domain) ?? 0);
    const wait = minDelayMs - elapsed;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt.set(domain, Date.now());
    return fn();
  });

  // Chain the next caller behind this one regardless of success/failure —
  // a rejected fetch must still release the domain slot for the next source.
  queues.set(domain, runAfterDelay.catch(() => {}));

  return runAfterDelay;
}
