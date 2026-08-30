import { sql } from '@mip/db';
import type { FastifyRequest } from 'fastify';

/**
 * Append-only record of every sensitive operation.
 * Required for: query changes, budget changes, kill switch, keyword changes,
 * alert changes, settings and deletions (docs/PROJECT_PLAN.md §51).
 */
export async function audit(
  req: FastifyRequest,
  input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    entityLabel?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
    severity?: 'info' | 'warning' | 'critical';
  },
) {
  const user = req.user as { id?: string; email?: string } | undefined;
  await sql`
    INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id,
                           entity_label, old_value, new_value, reason, user_agent, severity)
    VALUES (
      ${user?.id ?? null}, ${user?.email ?? null},
      ${input.action}, ${input.entityType}, ${input.entityId ?? null}, ${input.entityLabel ?? null},
      ${input.oldValue ? JSON.stringify(input.oldValue) : null}::jsonb,
      ${input.newValue ? JSON.stringify(input.newValue) : null}::jsonb,
      ${input.reason ?? null}, ${req.headers['user-agent'] ?? null},
      ${input.severity ?? 'info'}
    )`;
}
