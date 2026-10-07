import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { loginSchema } from '@mip/shared';
import { config } from '@mip/config';
import {
  loadUser, publicUser, verifyPassword, hashPassword, hashRefreshToken,
  issueRefreshToken, consumeRefreshToken, signAccessToken,
} from '../plugins/auth.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { MIN_PASSWORD_LENGTH, passwordChangeInstant, revokeUserSessions } from '../lib/sessions.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const COOKIE = 'mip_rt';

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'كلمة المرور الحالية مطلوبة').max(200),
  newPassword: z.string()
    .min(MIN_PASSWORD_LENGTH, `كلمة المرور الجديدة يجب ألا تقل عن ${MIN_PASSWORD_LENGTH} حرفاً`)
    .max(200),
});

export default async function authRoutes(app: FastifyInstance) {
  const setSessionCookie = (reply: FastifyReply, raw: string, expires: Date) => reply.setCookie(COOKIE, raw, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.NODE_ENV === 'production',
    path: '/',
    expires,
  });

  app.post('/login', { config: { access: 'public' } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { email, password } = parsed.data;

    const [row] = await sql<{
      id: string; email: string; password_hash: string; is_active: boolean;
      failed_login_attempts: number; locked_until: Date | null;
    }[]>`
      SELECT id, email, password_hash, is_active, failed_login_attempts, locked_until
      FROM users WHERE email = ${email} AND deleted_at IS NULL`;

    // Only attempts against a real account are recorded — never the typed
    // identifier of a missing one (people paste passwords into email fields).
    const failed = (reason: string) => row
      ? audit(req, {
        action: 'auth.login_failed', entityType: 'user', entityId: row.id, entityLabel: row.email,
        newValue: { reason }, severity: 'warning', actor: { id: null, email: null },
      })
      : Promise.resolve();

    // Same message whether the account is missing or the password is wrong —
    // do not let the response reveal which accounts exist.
    const generic = unauthorized('البريد الإلكتروني أو كلمة المرور غير صحيحة');
    if (!row || !row.is_active) {
      await failed('inactive');
      throw generic;
    }

    if (row.locked_until && row.locked_until > new Date()) {
      await failed('locked');
      throw unauthorized(`الحساب مقفل مؤقتاً. حاول بعد ${LOCK_MINUTES} دقيقة.`);
    }

    if (!(await verifyPassword(row.password_hash, password))) {
      const attempts = row.failed_login_attempts + 1;
      await sql`
        UPDATE users
        SET failed_login_attempts = ${attempts},
            locked_until = ${attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null}::timestamptz
        WHERE id = ${row.id}::uuid`;
      await failed(attempts >= MAX_ATTEMPTS ? 'bad_password_locked' : 'bad_password');
      throw generic;
    }

    await sql`
      UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
      WHERE id = ${row.id}::uuid`;

    const user = await loadUser(row.id);
    if (!user) throw generic;

    const accessToken = signAccessToken(app, user);
    const { raw, expiresAt } = await issueRefreshToken(user.id, req.headers['user-agent'], req.ip);
    setSessionCookie(reply, raw, expiresAt);

    req.user = publicUser(user);
    await audit(req, { action: 'auth.login', entityType: 'user', entityId: user.id, entityLabel: user.email });

    return { accessToken, user: publicUser(user) };
  });

  app.post('/refresh', { config: { access: 'public' } }, async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (!raw) throw unauthorized('لا توجد جلسة');

    const userId = await consumeRefreshToken(raw);
    if (!userId) throw unauthorized('الجلسة منتهية');

    const user = await loadUser(userId);
    if (!user) throw unauthorized('الحساب غير نشط');

    const accessToken = signAccessToken(app, user);
    const { raw: next, expiresAt } = await issueRefreshToken(user.id, req.headers['user-agent'], req.ip);
    setSessionCookie(reply, next, expiresAt);

    return { accessToken, user: publicUser(user) };
  });

  app.post('/logout', { config: { access: 'public' } }, async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) {
      const userId = await consumeRefreshToken(raw);
      if (userId) {
        const [u] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}::uuid`;
        await audit(req, {
          action: 'auth.logout', entityType: 'user', entityId: userId, entityLabel: u?.email ?? null,
          actor: { id: userId, email: u?.email ?? null },
        });
      }
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', {
    onRequest: [app.authenticate],
    config: { access: 'self', allowDuringPasswordChange: true },
  }, async (req) => ({ user: req.user }));

  app.patch('/me/preferences', { onRequest: [app.authenticate], config: { access: 'self' } }, async (req) => {
    const body = req.body as { theme?: string; locale?: string };
    await sql`
      UPDATE users
      SET theme = COALESCE(${body.theme ?? null}, theme),
          locale = COALESCE(${body.locale ?? null}, locale),
          updated_at = now()
      WHERE id = ${req.user.id}::uuid`;
    const user = await loadUser(req.user.id);
    return { user: user ? publicUser(user) : null };
  });

  /**
   * The signed-in user changes their own password (also how a temporary
   * password is replaced). Every other session is revoked and every access
   * token issued before now stops working; this session continues with a
   * fresh token pair.
   */
  app.post('/me/password', {
    onRequest: [app.authenticate],
    config: { access: 'self', allowDuringPasswordChange: true },
  }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { currentPassword, newPassword } = parsed.data;

    const [row] = await sql<{ password_hash: string; email: string }[]>`
      SELECT password_hash, email FROM users WHERE id = ${req.user.id}::uuid AND deleted_at IS NULL`;
    if (!row || !(await verifyPassword(row.password_hash, currentPassword))) {
      throw badRequest('كلمة المرور الحالية غير صحيحة', 'INVALID_CURRENT_PASSWORD');
    }
    if (newPassword === currentPassword) throw badRequest('كلمة المرور الجديدة يجب أن تختلف عن الحالية');
    if (newPassword.toLowerCase().includes(row.email.split('@')[0].toLowerCase())) {
      throw badRequest('كلمة المرور يجب ألا تحتوي اسم المستخدم');
    }

    const passwordHash = await hashPassword(newPassword);
    await sql`
      UPDATE users SET password_hash = ${passwordHash}, must_change_password = false,
                       password_changed_at = ${passwordChangeInstant()}::timestamptz, updated_at = now()
      WHERE id = ${req.user.id}::uuid`;

    const current = req.cookies[COOKIE];
    const revoked = await revokeUserSessions(req.user.id, current ? hashRefreshToken(current) : null);
    await audit(req, { action: 'user.password_change', entityType: 'user', entityId: req.user.id, entityLabel: req.user.email, severity: 'warning' });
    if (revoked > 0) {
      await audit(req, {
        action: 'auth.sessions_revoked', entityType: 'user', entityId: req.user.id, entityLabel: req.user.email,
        newValue: { count: revoked, cause: 'password_change' }, severity: 'warning',
      });
    }

    // Rotate this session too: the old refresh token and access token predate the change.
    if (current) await consumeRefreshToken(current);
    const user = await loadUser(req.user.id);
    if (!user) throw unauthorized('الحساب غير نشط');
    const accessToken = signAccessToken(app, user);
    const { raw, expiresAt } = await issueRefreshToken(user.id, req.headers['user-agent'], req.ip);
    setSessionCookie(reply, raw, expiresAt);
    return { accessToken, user: publicUser(user) };
  });
}
