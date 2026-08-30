import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { sql } from '@mip/db';
import { config } from '@mip/config';
import type { AuthUser } from '@mip/shared';
import { unauthorized, forbidden } from '../lib/errors.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (...perms: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * @fastify/jwt owns `request.user`, so the shape must be declared on its own
 * interface. Augmenting FastifyRequest directly is silently overridden.
 */
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: AuthUser;
  }
}

const ACCESS_TTL = '15m';
const REFRESH_DAYS = 14;

export async function loadUser(userId: string): Promise<AuthUser | null> {
  const [row] = await sql<{
    id: string; email: string; full_name: string; locale: string; theme: string;
    role_key: string; role_name_ar: string; permissions: string[];
  }[]>`
    SELECT u.id, u.email, u.full_name, u.locale, u.theme,
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
  };
}

export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });
export const verifyPassword = (hash: string, p: string) => argon2.verify(hash, p);

export async function issueRefreshToken(userId: string, userAgent?: string) {
  const raw = crypto.randomBytes(48).toString('base64url');
  // Only the hash is stored — a database leak must not yield usable tokens.
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400_000);
  await sql`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
    VALUES (${userId}::uuid, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz, ${userAgent ?? null})`;
  return { raw, expiresAt };
}

/**
 * Rotating refresh tokens are single-use, which races whenever two requests
 * carry the same cookie — React StrictMode's double effect, two tabs waking
 * together, or a retried request. A short grace window after rotation accepts
 * the straggler instead of logging a valid user out, while still invalidating
 * a token stolen and replayed later.
 */
const ROTATION_GRACE_SECONDS = 15;

export async function consumeRefreshToken(raw: string): Promise<string | null> {
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');

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

export default fp(async (app: FastifyInstance) => {
  await app.register(cookie);
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: ACCESS_TTL },
  });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      const payload = await req.jwtVerify<{ sub: string }>();
      const user = await loadUser(payload.sub);
      if (!user) throw unauthorized('الحساب غير نشط');
      req.user = user;
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) throw err;
      throw unauthorized('الجلسة منتهية، سجّل الدخول مرة أخرى');
    }
  });

  /**
   * Permission-based, not role-based: roles are just bundles. Critical
   * permissions (budget:write, killswitch:operate, internal_data:read) can be
   * granted per user without handing over a whole role.
   */
  app.decorate('requirePermission', (...perms: string[]) => async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    const has = perms.some((p) => req.user.permissions.includes(p));
    if (!has) throw forbidden(`تتطلب هذه العملية صلاحية: ${perms.join(' أو ')}`);
  });
});
