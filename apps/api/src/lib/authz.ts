/**
 * Resource-scoped authorization. A permission says *what* a user may do; a
 * scope says *over which records*: their own, their team's, or all of them.
 *
 * Today every interaction rule has only an `all` grant (posts:read), so the
 * scope always resolves to 'all' and behaviour is unchanged. The queue phase
 * adds `own` / `team` permissions to a rule and a matching SQL predicate in
 * scopePredicate() — routes already ask for a scope, so nothing else changes.
 */
import type { FastifyRequest } from 'fastify';
import type { Permission } from '@mip/shared';
import { PERMISSIONS } from '@mip/shared';
import { forbidden, unauthorized } from './errors.js';

export type Scope = 'own' | 'team' | 'all';

/** Which permission grants each scope of a resource. Broader scopes win. */
export type ScopeRule = Partial<Record<Scope, Permission>>;

/** Interactions (posts). Queue phase: add own/team permissions here. */
export const INTERACTIONS: ScopeRule = { all: PERMISSIONS.POSTS_READ };

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
