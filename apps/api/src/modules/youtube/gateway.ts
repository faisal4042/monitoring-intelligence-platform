/**
 * The only path to a YouTube request. Per attempt, in order:
 *   1 YouTube kill switch (youtube_collector_controls.paused)  2 quota reservation  3 mode
 *   (dry_run: nothing sent, the planned call is recorded; mock: synthetic transport; live: LiveTransport)
 *   4 settle quota + record the call (no key, no content)  5 error policy: retry 5xx/network with backoff;
 *   quotaExceeded → bucket exhausted for the PT day; 401/403 → pause (key/IP problem); repeated failures → pause.
 * Live mode needs YOUTUBE_MODE=live AND YOUTUBE_LIVE_APPROVED=1 AND a LiveTransport AND the switch resumed.
 */
import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';
import {backoffMs, classifyError, ENDPOINTS, MAX_ATTEMPTS, redactKey, type EndpointName, type ErrorClass} from './endpoints.js';
import type {Mode, QuotaManager} from './quota.js';
import type {Params, Transport} from './transport.js';
import {workerCheckpoint} from '../../startup/worker-ownership.js';

export const FAILURE_THRESHOLD = 5;
export type CallResult =
  | {ok: true; body: any; dryRun: boolean}
  | {ok: false; kind: 'paused' | 'denied'; reason: string}
  | {ok: false; kind: 'error'; errorClass: ErrorClass; status: number | null; reason: string; message?: string | null};

/** maxAttempts (1..MAX_ATTEMPTS) caps retries; the first live probe uses 1 so at most one request can ever be sent. */
export interface GatewayOptions { mode: Mode; transport: Transport | null; liveApproved?: boolean; maxAttempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }

export class YouTubeGateway {
  readonly mode: Mode;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly sql: YouTubeSql, private readonly quota: QuotaManager, private readonly opts: GatewayOptions) {
    this.mode = opts.mode;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    if (opts.mode === 'live') {
      if (!opts.liveApproved) throw new Error('YOUTUBE_LIVE_NOT_APPROVED: live mode requires YOUTUBE_LIVE_APPROVED=1');
      if (opts.transport?.kind !== 'live') throw new Error('live mode requires the live transport');
    }
    if (opts.mode === 'mock' && opts.transport?.kind !== 'mock') throw new Error('mock mode requires the mock transport');
    if (opts.mode === 'dry_run' && opts.transport) throw new Error('dry-run mode must not have a transport');
  }

  async controls() {
    const [c] = await this.sql<{paused: boolean; reason: string; consecutive_failures: number; changed_at: Date}[]>`
      SELECT paused, reason, consecutive_failures, changed_at FROM youtube_collector_controls WHERE singleton`;
    return c;
  }
  async setPaused(paused: boolean, reason: string) {
    await this.sql`UPDATE youtube_collector_controls SET paused = ${paused}, reason = ${reason.slice(0, 300)},
                   consecutive_failures = CASE WHEN ${paused} THEN consecutive_failures ELSE 0 END, changed_at = now() WHERE singleton`;
  }

  async call(endpoint: EndpointName, params: Params, runId: string | null): Promise<CallResult> {
    const spec = ENDPOINTS[endpoint];
    if (!spec) return {ok: false, kind: 'denied', reason: 'ENDPOINT_NOT_ALLOWED'};
    for (let attempt = 1; ; attempt++) {
      await workerCheckpoint();
      const c = await this.controls();
      if (c.paused) {
        await this.record(runId, endpoint, 0, 'denied', null, 'KILL_SWITCH', 0, attempt);
        return {ok: false, kind: 'paused', reason: c.reason};
      }
      const r = await this.quota.reserve(spec.bucket, spec.units, this.mode);
      if (!r.ok) {
        await this.record(runId, endpoint, 0, 'denied', null, r.reason, 0, attempt);
        return {ok: false, kind: 'denied', reason: r.reason};
      }
      if (this.mode === 'dry_run') {
        await this.quota.settle(r.reservation, spec.units);    // projected consumption, in the dry-run ledger only
        await this.record(runId, endpoint, spec.units, 'dry_run', null, null, 0, attempt);
        return {ok: true, body: null, dryRun: true};
      }
      const started = Date.now();
      let status: number | null = null, body: any = null, reason: string | null = null, message: string | null = null, noRetry = false;
      try {
        ({status, body} = await this.opts.transport!.request(endpoint, params));
        reason = status >= 200 && status < 300 ? null : String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? `http_${status}`);
        message = status >= 200 && status < 300 ? null : (body?.error?.message ?? null);
      } catch (e: any) {
        status = e?.status ?? null; reason = e?.reason ?? 'network'; noRetry = !!e?.noRetry;
      }
      // From here on the request has been sent: bookkeeping failures must never lose the response
      // (live test 2, 2026-10-16: a call-log insert failure discarded Google's answer).
      await this.afterSend(() => this.quota.settle(r.reservation, spec.units), endpoint, status, reason, message);
      const latency = Date.now() - started;
      if (status !== null && status >= 200 && status < 300) {
        await this.afterSend(() => this.record(runId, endpoint, spec.units, this.mode === 'mock' ? 'mock' : 'ok', status, null, latency, attempt), endpoint, status, reason, message);
        await this.sql`UPDATE youtube_collector_controls SET consecutive_failures = 0 WHERE singleton AND consecutive_failures <> 0`;
        return {ok: true, body, dryRun: false};
      }
      const errorClass: ErrorClass = noRetry ? 'forbidden' : classifyError(status, reason);
      // Google's message explains 403s (e.g. which originating IP violated the key restriction); stored redacted.
      const detail = redactKey(`${reason ?? 'unknown'}${message ? `: ${String(message).slice(0, 400)}` : ''}`);
      await this.afterSend(() => this.record(runId, endpoint, spec.units, 'error', status, detail, latency, attempt), endpoint, status, reason, message);
      if (errorClass === 'retry' && attempt < Math.min(Math.max(this.opts.maxAttempts ?? MAX_ATTEMPTS, 1), MAX_ATTEMPTS)) { await this.sleep(backoffMs(attempt, this.opts.random)); continue; }
      if (errorClass === 'quota') await this.quota.markExhausted(spec.bucket, this.mode);
      if (errorClass === 'forbidden') await this.setPaused(true, `auto: ${reason} (HTTP ${status ?? '-'}) — check key, IP restriction, API enablement`);
      if (errorClass === 'retry' || errorClass === 'bad_request') await this.countFailure();
      return {ok: false, kind: 'error', errorClass, status, reason: reason ?? 'unknown', message: message ? redactKey(String(message).slice(0, 400)) : null};
    }
  }

  /** Post-send bookkeeping: on failure, the response summary goes to stderr (no key, no content) and the call continues. */
  private async afterSend(step: () => Promise<unknown>, endpoint: EndpointName, status: number | null, reason: string | null, message: string | null) {
    try { await step(); }
    catch (e) {
      console.error('YT_CALL_LOG_FAILED ' + redactKey(JSON.stringify({endpoint, status, reason, message: message?.slice(0, 400) ?? null,
        logError: String((e as Error)?.message ?? e).slice(0, 200)})));
    }
  }

  private async countFailure() {
    const [c] = await this.sql<{n: number}[]>`UPDATE youtube_collector_controls SET consecutive_failures = consecutive_failures + 1
                                              WHERE singleton RETURNING consecutive_failures AS n`;
    if (c.n >= FAILURE_THRESHOLD) await this.setPaused(true, `auto: ${c.n} consecutive failed calls`);
  }

  private async record(runId: string | null, endpoint: EndpointName, units: number, outcome: string, status: number | null,
    reason: string | null, latency: number, attempt: number) {
    await this.sql`INSERT INTO youtube_api_calls (run_id, endpoint, bucket, units, mode, outcome, http_status, error_reason, latency_ms, attempt)
      VALUES (${runId}, ${endpoint}, ${ENDPOINTS[endpoint].bucket}, ${units}, ${this.mode}, ${outcome}, ${status}, ${reason}, ${latency}, ${attempt})`;
  }
}
