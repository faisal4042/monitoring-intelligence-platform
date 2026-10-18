/**
 * Emergency stop. Checked on every gateway call before anything else costly.
 *
 * State lives in Postgres (durable + auditable) and is cached in-process for a
 * short window. A restart re-reads it, so an active stop is never lost by
 * bouncing a process — a common and expensive failure in designs like this.
 */
import { sql } from '@mip/db';
import { budgetLogger as log } from '@mip/logger';

export interface ActiveKill { scope: string; targetId: string | null; reason: string }

const CACHE_MS = 2000;

class KillSwitchService {
  private cache: { at: number; rows: ActiveKill[] } = { at: 0, rows: [] };

  private async load(): Promise<ActiveKill[]> {
    if (Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    const rows = await sql<ActiveKill[]>`
      SELECT scope, target_id AS "targetId", reason
      FROM kill_switches
      WHERE is_active AND (expires_at IS NULL OR expires_at > now())`;
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  /** Returns the matching stop, or null when collection may proceed. */
  async check(ctx: { programId?: string; queryId?: string; source?: string }): Promise<ActiveKill | null> {
    const rows = await this.load();
    return (
      rows.find((r) => r.scope === 'global') ??
      rows.find((r) => r.scope === 'program' && r.targetId === ctx.programId) ??
      rows.find((r) => r.scope === 'query' && r.targetId === ctx.queryId) ??
      rows.find((r) => r.scope === 'source' && r.targetId === null) ??
      null
    );
  }

  async activate(input: { scope: string; targetId?: string | null; reason: string; userId: string; expiresAt?: Date | null }) {
    const [row] = await sql`
      INSERT INTO kill_switches (scope, target_id, reason, activated_by, expires_at)
      VALUES (${input.scope}, ${input.targetId ?? null}, ${input.reason}, ${input.userId}, ${input.expiresAt ? input.expiresAt.toISOString() : null}::timestamptz)
      ON CONFLICT DO NOTHING
      RETURNING *`;
    this.cache.at = 0;
    log.warn({ scope: input.scope, targetId: input.targetId, reason: input.reason }, 'KILL SWITCH ACTIVATED');
    return row ?? null;
  }

  async deactivate(id: string, userId: string) {
    const [row] = await sql`
      UPDATE kill_switches
      SET is_active = false, deactivated_by = ${userId}, deactivated_at = now()
      WHERE id = ${id}::uuid AND is_active
      RETURNING *`;
    this.cache.at = 0;
    if (row) log.warn({ id }, 'kill switch deactivated');
    return row ?? null;
  }

  async list() {
    return sql`
      SELECT k.*, u.full_name AS activated_by_name
      FROM kill_switches k
      LEFT JOIN users u ON u.id = k.activated_by
      WHERE k.is_active AND (k.expires_at IS NULL OR k.expires_at > now())
      ORDER BY k.activated_at DESC`;
  }
}

export const killSwitchService = new KillSwitchService();
