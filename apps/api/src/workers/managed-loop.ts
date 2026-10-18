import {assertWorkerAdmission, workerAbortSignal} from '../startup/worker-ownership.js';
/** One timer per lane in this process; stop prevents new passes and drains the accepted pass. */
export type WorkerStop = () => Promise<void>;
const owners = new Set<string>();
export function managedLoop(name: string, work: (signal?: AbortSignal) => Promise<unknown>, onError: (error: unknown) => void,
  milliseconds: number, immediate = false) {
  if (owners.has(name)) throw new Error(`Worker already started: ${name}`);
  owners.add(name);
  let stopped = false, active: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = Promise.resolve().then(() => { assertWorkerAdmission();return work(workerAbortSignal()); }).then(() => {}, onError).finally(() => { active = null; });
    return active;
  };
  const timer = setInterval(() => void tick(), milliseconds); timer.unref();
  if (immediate) void tick();
  let stopPromise: Promise<void> | undefined;
  const stop: WorkerStop = () => stopPromise ??= (async () => { stopped = true; clearInterval(timer); try { await active; } finally { owners.delete(name); } })();
  return { tick, stop };
}
