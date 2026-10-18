type Stop = () => void;
type Gates = { QUEUE_WORKER_ENABLED?: boolean; WORKFORCE_WORKER_ENABLED?: boolean };

/** Gates all maintenance passes, not just intake or automatic assignment. */
export function startQueueWorkers(gates: Gates, factories: { queue: () => Stop; workforce: () => Stop }) {
  return {
    queue: gates.QUEUE_WORKER_ENABLED === true ? factories.queue() : null,
    workforce: gates.WORKFORCE_WORKER_ENABLED === true ? factories.workforce() : null,
  };
}
