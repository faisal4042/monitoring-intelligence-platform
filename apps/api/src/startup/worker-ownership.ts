/** Cooperative admission/cancellation only. Not a PostgreSQL fencing token. */
export class WorkerOwnership {
  state: 'pending' | 'active' | 'lost' | 'closed' = 'pending';
  reason: unknown;
  private controller = new AbortController();
  verify?: () => Promise<void>;
  get signal() { return this.controller.signal; }
  activate() {
    if (this.state !== 'pending') throw new Error('Ownership cannot be reactivated');
    this.state = 'active';
  }
  assertActive() {
    if (this.state !== 'active') throw new Error('Worker ownership is not valid: ' + this.state);
  }
  lose(reason: unknown) {
    if (this.state === 'lost' || this.state === 'closed') return false;
    this.state = 'lost'; this.reason = reason; this.controller.abort(reason); return true;
  }
  close() {
    if (this.state !== 'lost') this.state = 'closed';
    this.controller.abort();
  }
  async checkpoint() {
    this.assertActive(); await this.verify?.(); this.assertActive();
  }
}
let current: WorkerOwnership | undefined;
export function bindWorkerOwnership(gate: WorkerOwnership) {
  if (current) throw new Error('Process ownership already configured; no automatic takeover');
  current = gate;
}
export function assertWorkerAdmission() { current?.assertActive(); }
export function workerAbortSignal() { return current?.signal; }
export async function workerCheckpoint() { await current?.checkpoint(); }
