import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { sql } from '@mip/db';
import { config } from '@mip/config';
import type { AuthUser } from '@mip/shared';
import { unauthorized, forbidden, HttpError } from '../lib/errors.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (...perms: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Set once an authorization check has explicitly allowed this request. */
    authzGranted: boolean;
  }
  interface FastifyContextConfig {
    /**
     * Routes without a permission check must say why:
     *  - 'public': no session at all (login, refresh, logout, health, webhooks)
     *  - 'self':   any signed-in user, acting only on their own account (/me…)
     * Every other route must pass app.requirePermission (or an authz scope
     * check) or it answers 403 — see the onRoute hook below.
     */
    access?: 'public' | 'self';
    /** A 'self' route still usable while the account must change its password. */
    allowDuringPasswordChange?: boolean;
  }
}

/**
 * @fastify/jwt owns `request.user`, so the shape must be declared on its own
 * interface. Augmenting FastifyRequest directly is silently overridden.
 */
declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** pwd: the user's password_changed_at (ms) when the token was issued, 0 if never. */
    payload: { sub: string; pwd?: number };
    user: AuthUser;
  }
}

const ACCESS_TTL = '15m';
const REFRESH_DAYS = 14;

interface LoadedUser extends AuthUser {
  /** Access tokens carrying an older `pwd` claim than this are void. */
  passwordChangedAt: Date | null;
}

export async function loadUser(userId: string): Promise<LoadedUser | null> {
  const [row] = await sql<{
    id: string; email: string; full_name: string; locale: string; theme: string;
    role_key: string; role_name_ar: string; permissions: string[];
    must_change_password: boolean; password_changed_at: Date | string | null;
  }[]>`
    SELECT u.id, u.email, u.full_name, u.locale, u.theme,
           u.must_change_password, u.password_changed_at,
           r.key AS role_key, r.name_ar AS role_name_ar,
           COALESCE(
             ARRAY(SELECT permission_key FROM role_permissions WHERE role_id = r.id)
             || ARRAY(SELECT permission_key FROM user_permissions WHERE user_id = u.id),
             '{}'
           ) AS permissions
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = ${userId}::uuid AND u.is_active AND u.deleted_at IS NULL`;

  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role_key,
    roleNameAr: row.role_name_ar,
    permissions: [...new Set(row.permissions)],
    locale: row.locale,
    theme: row.theme,
    mustChangePassword: row.must_change_password,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at) : null,
  };
}

/** The user as returned to the client — internal session fields stripped. */
export function publicUser(user: LoadedUser | AuthUser): AuthUser {
  const { passwordChangedAt: _omit, ...rest } = user as LoadedUser;
  return rest;
}

/**
 * Signs an access token bound to the user's current password generation, so a
 * later change or reset voids it exactly — not to the nearest second.
 */
export function signAccessToken(app: FastifyInstance, user: Pick<LoadedUser, 'id' | 'passwordChangedAt'>) {
  return app.jwt.sign({ sub: user.id, pwd: user.passwordChangedAt?.getTime() ?? 0 });
}

export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });
export const verifyPassword = (hash: string, p: string) => argon2.verify(hash, p);

export const hashRefreshToken = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');

export async function issueRefreshToken(userId: string, userAgent?: string, ip?: string | null) {
  const raw = crypto.randomBytes(48).toString('base64url');
  // Only the hash is stored — a database leak must not yield usable tokens.
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400_000);
  await sql`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
    VALUES (${userId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz,
            ${userAgent ?? null}, ${ip ?? null}::inet)`;
  return { raw, expiresAt };
}

/**
 * Rotating refresh tokens are single-use, which races whenever two requests
 * carry the same cookie — React StrictMode's double effect, two tabs waking
 * together, or a retried request. A short grace window after rotation accepts
 * the straggler instead of logging a valid user out, while still invalidating
 * a token stolen and replayed later. A session revocation (password reset,
 * disable) also expires the tokens, so they never get that grace — see
 * lib/sessions.ts.
 */
const ROTATION_GRACE_SECONDS = 15;

export async function consumeRefreshToken(raw: string): Promise<string | null> {
  const tokenHash = hashRefreshToken(raw);

  const [row] = await sql<{ user_id: string }[]>`
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > now()
    RETURNING user_id`;
  if (row) return row.user_id;

  const [recent] = await sql<{ user_id: string }[]>`
    SELECT user_id FROM refresh_tokens
    WHERE token_hash = ${tokenHash}
      AND expires_at > now()
      AND revoked_at IS NOT NULL
      AND revoked_at > now() - (${ROTATION_GRACE_SECONDS} || ' seconds')::interval`;
  return recent?.user_id ?? null;
}

export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

export default fp(async (app: FastifyInstance) => {
  await app.register(cookie);
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: ACCESS_TTL },
  });

  app.decorateRequest('authzGranted', false);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    let payload: { sub: string; pwd?: number };
    try {
      payload = await req.jwtVerify<{ sub: string; pwd?: number }>();
    } catch {
      throw unauthorized('الجلسة منتهية، سجّل الدخول مرة أخرى');
    }
    const user = await loadUser(payload.sub);
    if (!user) throw unauthorized('الحساب غير نشط');

    // A password change or reset voids every access token issued before it.
    if (user.passwordChangedAt && (payload.pwd ?? 0) < user.passwordChangedAt.getTime()) {
      throw unauthorized('انتهت الجلسة بعد تغيير كلمة المرور، سجّل الدخول مرة أخرى');
    }

    if (user.mustChangePassword && !req.routeOptions.config?.allowDuringPasswordChange) {
      throw new HttpError(403, 'يجب تغيير كلمة المرور المؤقتة قبل المتابعة', PASSWORD_CHANGE_REQUIRED);
    }

    req.user = publicUser(user);
  });

  /**
   * Permission-based, not role-based: roles are just bundles. Critical
   * permissions (budget:write, killswitch:operate, internal_data:read) can be
   * granted per user without handing over a whole role. Any one of `perms`
   * is enough.
   */
  app.decorate('requirePermission', (...perms: string[]) => async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    const has = perms.some((p) => req.user.permissions.includes(p));
    if (!has) throw forbidden(`تتطلب هذه العملية صلاحية: ${perms.join(' أو ')}`);
    req.authzGranted = true;
  });

  /**
   * Default deny. Every route's handler is wrapped: unless the route is
   * declared public/self, or an authorization check (requirePermission,
   * requireScope) has explicitly granted the request, it answers 403. A new
   * endpoint that forgets its permission is therefore closed, not open — and
   * routes.test.ts fails until it is classified.
   */
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    if (access === 'public' || access === 'self') return;
    const handler = route.handler;
    route.handler = async function guarded(this: unknown, req: FastifyRequest, reply: FastifyReply) {
      if (!req.authzGranted) throw forbidden('هذه العملية غير مصنّفة صلاحياً');
      return (handler as (this: unknown, req: FastifyRequest, reply: FastifyReply) => unknown).call(this, req, reply);
    };
  });
});
