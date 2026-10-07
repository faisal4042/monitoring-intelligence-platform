/**
 * Keeps monthly partitions ahead of the clock: once at startup, then daily.
 * Not tied to any feature flag — every insert path depends on it.
 */
import { ensurePartitions } from '../lib/partitions.js';

export const DAILY_MS = 24 * 60 * 60 * 1000;

let running = false;

type PassResult = Awaited<ReturnType<typeof ensurePartitions>>;

async function run(trigger: 'startup' | 'daily', onPass?: (trigger: string, result: PassResult) => void) {
  if (running) return; // the previous pass is still going; the advisory lock would just queue us
  running = true;
  try {
    onPass?.(trigger, await ensurePartitions(trigger));
  } finally {
    running = false;
  }
}

/**
 * Runs the startup pass — awaited, so partitions exist before any collection
 * worker inserts — then schedules the daily pass. Never rejects (failures are
 * logged by ensurePartitions). `intervalMs` and `onPass` exist for tests.
 */
export async function startPartitionMaintenanceWorker(
  intervalMs = DAILY_MS,
  onPass?: (trigger: string, result: PassResult) => void,
): Promise<() => void> {
  await run('startup', onPass);
  const timer = setInterval(() => void run('daily', onPass), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
