/**
 * Keeps monthly partitions ahead of the clock: once at startup, then daily.
 * Not tied to any feature flag — every insert path depends on it.
 */
import { ensurePartitions } from '../lib/partitions.js';

export const DAILY_MS = 24 * 60 * 60 * 1000;

type Trigger = 'startup' | 'daily';
type PassResult = Awaited<ReturnType<typeof ensurePartitions>>;

export interface PartitionWorkerOptions {
  intervalMs?: number;
  /** The maintenance pass itself; replaceable in tests. */
  pass?: (trigger: Trigger) => Promise<PassResult>;
  /** Called after every pass; tests use it to observe the loop. */
  onPass?: (trigger: Trigger, result: PassResult) => void;
}

/**
 * Runs the startup pass — awaited, so partitions exist before any collection
 * worker inserts — then schedules the daily pass. Never rejects (failures are
 * logged by ensurePartitions). Returns a stop function.
 */
export async function startPartitionMaintenanceWorker(options: PartitionWorkerOptions = {}): Promise<() => void> {
  const { intervalMs = DAILY_MS, pass = ensurePartitions, onPass } = options;
  let running = false;

  const run = async (trigger: Trigger) => {
    if (running) return; // the previous pass is still going; the advisory lock would just queue us
    running = true;
    try {
      // The pass must run whether or not anyone observes it — never fold it
      // into an optional call like onPass?.(…, await pass()).
      const result = await pass(trigger);
      if (onPass) onPass(trigger, result);
    } finally {
      running = false;
    }
  };

  await run('startup');
  const timer = setInterval(() => void run('daily'), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
