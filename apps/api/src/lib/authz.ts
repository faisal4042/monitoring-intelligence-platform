/**
 * Resource-scoped authorization. A permission says *what* a user may do; a
 * scope says *over which records*: their own, their team's, or all of them.
 *
 * Source interactions keep their posts:read grant. Operational queue access
 * uses own/team/all SQL predicates, including immutable completion history.
 */
import type { FastifyRequest } from 'fastify';
import type { Permission } from '@mip/shared';
import { PERMISSIONS } from '@mip/shared';
import { sql } from '@mip/db';
import { forbidden, unauthorized } from './errors.js';

export type Scope = 'own' | 'team' | 'all';

/** Which permission grants each scope of a resource. Broader scopes win. */
export type ScopeRule = Partial<Record<Scope, Permission>>;

/** Source interactions keep their existing independent permission. */
export const INTERACTIONS: ScopeRule = { all: PERMISSIONS.POSTS_READ };
export const QUEUE: ScopeRule = {
  own: PERMISSIONS.QUEUE_WORK, team: PERMISSIONS.QUEUE_SUPERVISE, all: PERMISSIONS.QUEUE_VIEW_ALL,
};
export interface QueueActor { id: string; permissions: string[] }

/** SQL fragment for the queue_items alias q. Never trust client team/owner IDs. */
export function queueScope(actor: QueueActor, mutation = false) {
  const scope = resolveScope(actor.permissions, QUEUE);
  if (scope === 'all') return sql`true`;
  if (scope === 'team') return sql`EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id
    WHERE tm.user_id=${actor.id}::uuid AND tm.team_id=q.team_id AND tm.kind='supervisor'
      AND tm.left_at IS NULL AND t.is_active)`;
  if (scope === 'own') return mutation
    ? sql`q.assignee_id=${actor.id}::uuid AND q.status<>'completed'`
    : sql`((q.assignee_id=${actor.id}::uuid AND q.status<>'completed') OR EXISTS
        (SELECT 1 FROM queue_events qe WHERE qe.queue_item_id=q.id AND qe.event_type='completed' AND qe.actor_id=${actor.id}::uuid))`;
  return sql`false`;
}

/** SQL fragment for a teams alias t, used for intake routing and directory choices. */
export function queueTeamScope(actor: QueueActor) {
  if (actor.permissions.includes(PERMISSIONS.QUEUE_VIEW_ALL)) return sql`true`;
  return sql`EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=t.id
    AND tm.user_id=${actor.id}::uuid AND tm.kind='supervisor' AND tm.left_at IS NULL)`;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireScope: the widest scope this user holds for the route's resource. */
    authzScope?: Scope;
  }
}

const ORDER: Scope[] = ['all', 'team', 'own'];

/** The widest scope the user's permissions grant under a rule, or null. */
export function resolveScope(permissions: readonly string[], rule: ScopeRule): Scope | null {
  for (const scope of ORDER) {
    const perm = rule[scope];
    if (perm && permissions.includes(perm)) return scope;
  }
  return null;
}

/**
 * preHandler: 403 unless the user holds some scope of the rule; otherwise
 * records it on the request for the handler's query.
 */
export function requireScope(rule: ScopeRule) {
  return async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    const scope = resolveScope(req.user.permissions, rule);
    if (!scope) {
      const needed = Object.values(rule).filter(Boolean).join(' أو ');
      throw forbidden(`تتطلب هذه العملية صلاحية: ${needed}`);
    }
    req.authzScope = scope;
    req.authzGranted = true;
  };
}

/**
 * Whether a scope may see a record, given who owns it. Handlers that load a
 * single record by id call this and answer 404 — not 403 — when it is false,
 * so an out-of-scope id is indistinguishable from a missing one.
 *
 * Ownership data (assignee, team) arrives with the queue; until then only the
 * 'all' scope exists and every record is visible to it.
 */
export function canSeeRecord(scope: Scope | undefined, _owner?: { assigneeId?: string | null; teamId?: string | null }): boolean {
  return scope === 'all';
}
