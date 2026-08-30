import type { FastifyInstance } from 'fastify';
import { sql } from '@mip/db';
import { loginSchema } from '@mip/shared';
import { config } from '@mip/config';
import { loadUser, verifyPassword, issueRefreshToken, consumeRefreshToken } from '../plugins/auth.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const COOKIE = 'mip_rt';

export default async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { email, password } = parsed.data;

    const [row] = await sql<{
      id: string; password_hash: string; is_active: boolean;
      failed_login_attempts: number; locked_until: Date | null;
    }[]>`
      SELECT id, password_hash, is_active, failed_login_attempts, locked_until
      FROM users WHERE email = ${email} AND deleted_at IS NULL`;

    // Same message whether the account is missing or the password is wrong —
    // do not let the response reveal which accounts exist.
    const generic = unauthorized('البريد الإلكتروني أو كلمة المرور غير صحيحة');
    if (!row || !row.is_active) throw generic;

    if (row.locked_until && row.locked_until > new Date()) {
      throw unauthorized(`الحساب مقفل مؤقتاً. حاول بعد ${LOCK_MINUTES} دقيقة.`);
    }

    if (!(await verifyPassword(row.password_hash, password))) {
      const attempts = row.failed_login_attempts + 1;
      await sql`
        UPDATE users
        SET failed_login_attempts = ${attempts},
            locked_until = ${attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null}::timestamptz
        WHERE id = ${row.id}::uuid`;
      throw generic;
    }

    await sql`
      UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
      WHERE id = ${row.id}::uuid`;

    const user = await loadUser(row.id);
    if (!user) throw generic;

    const accessToken = app.jwt.sign({ sub: user.id });
    const { raw, expiresAt } = await issueRefreshToken(user.id, req.headers['user-agent']);

    reply.setCookie(COOKIE, raw, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.NODE_ENV === 'production',
      path: '/',
      expires: expiresAt,
    });

    req.user = user;
    await audit(req, { action: 'auth.login', entityType: 'user', entityId: user.id, entityLabel: user.email });

    return { accessToken, user };
  });

  app.post('/refresh', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (!raw) throw unauthorized('لا توجد جلسة');

    const userId = await consumeRefreshToken(raw);
    if (!userId) throw unauthorized('الجلسة منتهية');

    const user = await loadUser(userId);
    if (!user) throw unauthorized('الحساب غير نشط');

    const accessToken = app.jwt.sign({ sub: user.id });
    const { raw: next, expiresAt } = await issueRefreshToken(user.id, req.headers['user-agent']);
    reply.setCookie(COOKIE, next, {
      httpOnly: true, sameSite: 'strict',
      secure: config.NODE_ENV === 'production', path: '/', expires: expiresAt,
    });

    return { accessToken, user };
  });

  app.post('/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) await consumeRefreshToken(raw);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => ({ user: req.user }));

  app.patch('/me/preferences', { onRequest: [app.authenticate] }, async (req) => {
    const body = req.body as { theme?: string; locale?: string };
    await sql`
      UPDATE users
      SET theme = COALESCE(${body.theme ?? null}, theme),
          locale = COALESCE(${body.locale ?? null}, locale),
          updated_at = now()
      WHERE id = ${req.user.id}::uuid`;
    return { user: await loadUser(req.user.id) };
  });
}
