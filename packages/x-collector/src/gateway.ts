/**
 * ═══════════════════════════════════════════════════════════════════
 * THE SINGLE DOOR TO THE X API.
 *
 * Nothing else in this codebase may perform an HTTP request to X.
 * Every call passes, in order:
 *
 *   1. ENV flag       — LIVE_X_API=false makes a real call unreachable
 *   2. Kill switch    — global / program / query
 *   3. Budget gate    — ALLOW or DENY, atomically reserved
 *   4. Dry run        — everything real except the request itself
 *   5. Rate limit
 *   6. The request
 *   7. Usage accounting — always, including on failure
 *
 * See docs/X_API_STRATEGY.md and docs/ARCHITECTURE.md §4.1.
 * ═══════════════════════════════════════════════════════════════════
 */
import { config, collectionMode } from '@mip/config';
import { xApiLogger as log } from '@mip/logger';
import type { ApiPurpose } from '@mip/shared';
import { budgetService } from './budget.service.js';
import { killSwitchService } from './killswitch.service.js';
import { usageService } from './usage.service.js';
import { getPricing, getFieldSelection } from './settings.js';
import { MockXClient } from './mock-client.js';
import { RealXClient } from './real-client.js';
import type { SearchRequest, XPost, XUser, GatewayResult } from './types.js';

const mock = new MockXClient();
const real = new RealXClient();

export class XApiGateway {
  async searchRecent(req: SearchRequest): Promise<GatewayResult<XPost[]>> {
    const started = Date.now();
    const pricing = await getPricing();
    const fields = await getFieldSelection();
    const requestedUnits = req.maxResults;

    // ── 1. Kill switch ────────────────────────────────────────────
    const kill = await killSwitchService.check({
      programId: req.programId,
      queryId: req.queryId,
    });
    if (kill) {
      await usageService.recordDenial({
        queryId: req.queryId, programId: req.programId, purpose: req.purpose,
        reason: 'KILL_SWITCH', scope: kill.scope, requestedUnits,
      });
      log.warn({ scope: kill.scope, reason: kill.reason }, 'blocked by kill switch');
      return {
        ok: false,
        denied: {
          verdict: 'DENY', reason: 'KILL_SWITCH', scope: kill.scope,
          usage: 0, limit: 0,
          messageAr: `الجمع موقوف: ${kill.reason}`,
        },
      };
    }

    // ── 2. Budget gate ────────────────────────────────────────────
    // Reserves the worst case up front; the unused remainder is released
    // after the response is known. Over-spend is therefore impossible,
    // not merely unlikely.
    const decision = await budgetService.authorize({
      queryId: req.queryId,
      programId: req.programId,
      purpose: req.purpose,
      requestedUnits,
      unitPrice: pricing.unitPrice,
    });

    if (decision.verdict === 'DENY') {
      await usageService.recordDenial({
        queryId: req.queryId, programId: req.programId, purpose: req.purpose,
        reason: decision.reason, scope: decision.scope,
        currentUsage: decision.usage, limitValue: decision.limit, requestedUnits,
      });
      log.warn({ reason: decision.reason, scope: decision.scope }, 'blocked by budget gate');
      return { ok: false, denied: decision };
    }

    const relCtx = {
      queryId: req.queryId, programId: req.programId,
      purpose: req.purpose, unitPrice: pricing.unitPrice,
    };

    try {
      // ── 3. Demo mode ────────────────────────────────────────────
      if (collectionMode === 'demo') {
        const posts = await mock.searchRecent(req);
        await this.release(decision.grantedUnits, posts.length, relCtx);
        await usageService.record({
          endpoint: 'search_recent', purpose: req.purpose,
          queryId: req.queryId, queryVersionId: req.queryVersionId,
          programId: req.programId, testId: req.testId,
          unitsConsumed: posts.length, unitPrice: 0, costEstimate: 0,
          httpStatus: 200, latencyMs: Date.now() - started,
          mode: 'demo', triggeredBy: req.triggeredBy,
        });
        return { ok: true, data: posts, unitsConsumed: posts.length, mode: 'demo' };
      }

      // ── 4. Dry run ──────────────────────────────────────────────
      if (collectionMode === 'dry_run') {
        log.info(
          {
            query: req.query, sinceId: req.sinceId,
            wouldConsume: requestedUnits,
            estimatedCost: (requestedUnits * pricing.unitPrice).toFixed(4),
          },
          'DRY RUN: this query would run',
        );
        await this.release(decision.grantedUnits, 0, relCtx);
        await usageService.record({
          endpoint: 'search_recent', purpose: req.purpose,
          queryId: req.queryId, queryVersionId: req.queryVersionId,
          programId: req.programId, testId: req.testId,
          unitsConsumed: 0, unitPrice: pricing.unitPrice, costEstimate: 0,
          httpStatus: null, latencyMs: Date.now() - started,
          mode: 'dry_run', triggeredBy: req.triggeredBy,
        });
        return { ok: true, data: [], unitsConsumed: 0, mode: 'dry_run' };
      }

      // ── 5. Live ─────────────────────────────────────────────────
      const res = await real.searchRecent(req, fields);
      const consumed = res.posts.length;
      await this.release(decision.grantedUnits, consumed, relCtx);

      await usageService.record({
        endpoint: 'search_recent', purpose: req.purpose,
        queryId: req.queryId, queryVersionId: req.queryVersionId,
        programId: req.programId, testId: req.testId,
        unitsConsumed: consumed,
        unitPrice: pricing.unitPrice,
        costEstimate: consumed * pricing.unitPrice,
        httpStatus: res.status,
        latencyMs: Date.now() - started,
        rateLimitRemaining: res.rateLimitRemaining,
        mode: 'live', triggeredBy: req.triggeredBy,
      });

      return { ok: true, data: res.posts, unitsConsumed: consumed, mode: 'live', newestId: res.newestId };
    } catch (err) {
      // A failed request consumed no quota — release the whole reservation.
      await this.release(decision.grantedUnits, 0, relCtx);
      const message = err instanceof Error ? err.message : String(err);

      await usageService.record({
        endpoint: 'search_recent', purpose: req.purpose,
        queryId: req.queryId, programId: req.programId, testId: req.testId,
        unitsConsumed: 0, unitPrice: pricing.unitPrice, costEstimate: 0,
        httpStatus: (err as { status?: number }).status ?? null,
        errorCode: (err as { code?: string }).code ?? 'REQUEST_FAILED',
        errorMessage: message,
        latencyMs: Date.now() - started,
        mode: collectionMode, triggeredBy: req.triggeredBy,
      });

      log.error({ err: message, queryId: req.queryId }, 'X API request failed');
      return { ok: false, error: message };
    }
  }

  async getUsers(ids: string[], purpose: ApiPurpose = 'author_refresh'): Promise<GatewayResult<XUser[]>> {
    if (ids.length === 0) return { ok: true, data: [], unitsConsumed: 0, mode: collectionMode };

    const kill = await killSwitchService.check({});
    if (kill) {
      return {
        ok: false,
        denied: {
          verdict: 'DENY', reason: 'KILL_SWITCH', scope: kill.scope,
          usage: 0, limit: 0, messageAr: `الجمع موقوف: ${kill.reason}`,
        },
      };
    }

    // User lookups do not consume post quota on most tiers, but they still
    // consume request budget — so they still pass the gate.
    const pricing = await getPricing();
    const decision = await budgetService.authorize({
      purpose, requestedUnits: 0, unitPrice: pricing.unitPrice,
    });
    if (decision.verdict === 'DENY') return { ok: false, denied: decision };

    if (collectionMode === 'demo') {
      return { ok: true, data: await mock.getUsers(ids), unitsConsumed: 0, mode: 'demo' };
    }
    if (collectionMode === 'dry_run') {
      log.info({ count: ids.length }, 'DRY RUN: would fetch user profiles');
      return { ok: true, data: [], unitsConsumed: 0, mode: 'dry_run' };
    }

    const fields = await getFieldSelection();
    const users = await real.getUsers(ids, fields);
    return { ok: true, data: users, unitsConsumed: 0, mode: 'live' };
  }

  /** Give back the difference between the reservation and actual usage. */
  private async release(
    granted: number,
    actual: number,
    ctx: { queryId?: string; programId?: string; purpose: ApiPurpose; unitPrice: number },
  ) {
    const unused = granted - actual;
    if (unused > 0) await budgetService.release(unused, ctx);
  }
}

export const xApiGateway = new XApiGateway();
