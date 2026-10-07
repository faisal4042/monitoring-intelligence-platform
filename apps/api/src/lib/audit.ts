import net from 'node:net';
import { sql } from '@mip/db';
import type { FastifyRequest } from 'fastify';

/** Keys that must never reach the audit trail, at any depth. */
const SECRET_KEY = /pass(word)?|hash|token|secret|otp|cookie|authorization/i;

/** Drops secret-looking keys recursively; audit values are diffs, never credentials. */
export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEY.test(k))
        .map(([k, v]) => [k, scrubSecrets(v)]),
    );
  }
  return value;
}

/** The client IP as Fastify resolved it (trustProxy), only if it parses as one. */
function clientIp(req: FastifyRequest): string | null {
  const ip = req.ip?.replace(/^::ffff:/, '');
  return ip && net.isIP(ip) ? ip : null;
}

/**
 * Append-only record of every sensitive operation.
 * Required for: query changes, budget changes, kill switch, keyword changes,
 * alert changes, settings, user management and authentication
 * (docs/PROJECT_PLAN.md §51). Passwords, hashes and tokens are scrubbed.
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
    /** Who acted, when it is not the authenticated request user (logout, failed login). */
    actor?: { id: string | null; email: string | null };
  },
) {
  const user = input.actor ?? (req.user as { id?: string; email?: string } | undefined);
  const oldValue = input.oldValue ? scrubSecrets(input.oldValue) : null;
  const newValue = input.newValue ? scrubSecrets(input.newValue) : null;
  await sql`
    INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id,
                           entity_label, old_value, new_value, reason, ip_address, user_agent, severity)
    VALUES (
      ${user?.id ?? null}, ${user?.email ?? null},
      ${input.action}, ${input.entityType}, ${input.entityId ?? null}, ${input.entityLabel ?? null},
      ${oldValue ? JSON.stringify(oldValue) : null}::jsonb,
      ${newValue ? JSON.stringify(newValue) : null}::jsonb,
      ${input.reason ?? null}, ${clientIp(req)}::inet, ${req.headers['user-agent'] ?? null},
      ${input.severity ?? 'info'}
    )`;
}
