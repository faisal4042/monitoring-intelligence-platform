/**
 * العملاء المؤثرون — accounts tracked by username. Being on this list only
 * adds `from:username` to the automatic query; it never bypasses program
 * keyword matching (docs/PROJECT_PLAN.md scope extension 2026-08-28).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { PERMISSIONS } from '@mip/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const usernameSchema = z.string().trim().min(1).max(50).transform((v) => v.replace(/^@/, ''));
const addSchema = z.object({
  usernames: z.array(usernameSchema).min(1).max(200),
  notes: z.string().max(500).optional(),
});

export default async function influencersRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ)],
  }, async () => ({
    items: await sql`
      SELECT ti.id, ti.username, ti.x_user_id, ti.notes, ti.is_active, ti.created_at,
             a.x_author_id, a.display_name, a.profile_image_url, a.followers_count, a.is_verified,
             a.description AS author_bio,
             (SELECT count(*) FROM posts p WHERE p.x_author_id = a.x_author_id)::int AS post_count,
             (SELECT max(p.posted_at) FROM posts p WHERE p.x_author_id = a.x_author_id) AS last_seen_at
      FROM tracked_influencers ti
      LEFT JOIN authors a ON a.username = ti.username
      WHERE ti.is_active
      ORDER BY ti.created_at DESC`,
  }));

  /** Accepts one or many usernames at once — pasting a whole watchlist is the common case. */
  app.post('/', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_WRITE)],
  }, async (req) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { usernames, notes } = parsed.data;

    const added: string[] = [];
    for (const username of usernames) {
      const [row] = await sql<{ username: string }[]>`
        INSERT INTO tracked_influencers (username, notes, added_by)
        VALUES (${username}, ${notes ?? null}, ${req.user.id}::uuid)
        ON CONFLICT (username) DO UPDATE SET is_active = true
        RETURNING username`;
      if (row) added.push(row.username);
    }

    await audit(req, {
      action: 'influencer.add', entityType: 'influencer',
      entityLabel: added.length === 1 ? added[0] : `${added.length} حسابات`,
      newValue: { usernames: added },
    });
    return { added };
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await sql<{ username: string }[]>`
      UPDATE tracked_influencers SET is_active = false, updated_at = now()
      WHERE id = ${id}::uuid RETURNING username`;
    if (!row) throw notFound('الحساب غير موجود في القائمة');
    await audit(req, {
      action: 'influencer.remove', entityType: 'influencer', entityLabel: row.username,
    });
    return { ok: true };
  });
}
