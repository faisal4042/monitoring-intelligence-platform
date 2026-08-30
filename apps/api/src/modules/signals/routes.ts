import type { FastifyInstance } from 'fastify';
import { sql } from '@mip/db';
import { PERMISSIONS } from '@mip/shared';
import { notFound } from '../../lib/errors.js';
import { redactSensitiveText } from '../../lib/privacy.js';
import { refreshSignalStories } from './service.js';

export default async function signalRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requirePermission(PERMISSIONS.TOPICS_READ));

  app.get('/', async (req) => {
    const q = req.query as { programId?: string; includeCandidates?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 40), 1), 100);
    const includeCandidates = q.includeCandidates === 'true';

    const [stats] = await sql`
      SELECT count(*) FILTER (WHERE state <> 'candidate')::int AS signals,
             count(*) FILTER (WHERE state = 'candidate')::int AS candidates,
             COALESCE(sum(post_count),0)::int AS posts,
             COALESCE(sum(family_count),0)::int AS families
      FROM signal_stories
      WHERE (${q.programId ?? null}::uuid IS NULL OR program_id = ${q.programId ?? null}::uuid)`;

    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT s.*, p.name_ar AS program_name, p.color AS program_color,
             t.name_ar AS topic_name, parent.name_ar AS parent_topic_name,
             previous.live_score::float AS previous_score,
             members.items AS top_members
      FROM signal_stories s
      JOIN programs p ON p.id = s.program_id
      JOIN topics t ON t.id = s.topic_id
      LEFT JOIN topics parent ON parent.id = t.parent_id
      LEFT JOIN LATERAL (
        SELECT snap.live_score
        FROM signal_story_snapshots snap
        WHERE snap.story_id = s.id AND snap.sampled_at < now() - interval '4 minutes'
        ORDER BY snap.sampled_at DESC LIMIT 1
      ) previous ON true
      LEFT JOIN LATERAL (
        WITH families AS (
          SELECT DISTINCT ON (sm.family_key) jsonb_build_object(
            'id', po.id, 'text', po.text, 'url', po.url, 'postedAt', po.posted_at,
            'username', a.username, 'displayName', a.display_name,
            'profileImageUrl', a.profile_image_url, 'sourceRole', sm.source_role,
            'familyKey', sm.family_key, 'isRepresentative', sm.is_representative,
            'sentiment', ps.label,
            'mediaImage', media.image_url,
            'engagement', COALESCE(pm.engagement, 0)
          ) AS item, sm.is_representative, po.posted_at, sm.source_role
          FROM signal_story_members sm
          JOIN posts po ON po.id = sm.post_id AND po.posted_at = sm.posted_at
          LEFT JOIN authors a ON a.id = po.author_id
          LEFT JOIN post_sentiments ps ON ps.post_id = po.id AND ps.posted_at = po.posted_at
          LEFT JOIN LATERAL (
            SELECT COALESCE(preview_image_url, url) AS image_url
            FROM post_media m
            WHERE m.post_id = po.id AND m.posted_at = po.posted_at
              AND m.type IN ('photo','video','animated_gif')
            ORDER BY m.media_key LIMIT 1
          ) media ON true
          LEFT JOIN LATERAL (
            SELECT like_count + repost_count + reply_count + quote_count AS engagement
            FROM post_metrics m
            WHERE m.post_id = po.id AND m.posted_at = po.posted_at
            ORDER BY captured_at DESC LIMIT 1
          ) pm ON true
          WHERE sm.story_id = s.id
          ORDER BY sm.family_key, sm.is_representative DESC, po.posted_at DESC
        )
        -- Picking the 3 most recent families overall could bury every
        -- influencer member behind more recent customer posts, leaving the
        -- "المؤثرون" tab empty even when influencer_count > 0. Reserve a
        -- slice for each role instead of one shared top-3.
        SELECT COALESCE(jsonb_agg(x.item ORDER BY x.is_representative DESC, x.posted_at DESC), '[]'::jsonb) AS items
        FROM (
          (SELECT item, is_representative, posted_at FROM families
             WHERE source_role = 'influencer'
             ORDER BY is_representative DESC, posted_at DESC LIMIT 3)
          UNION ALL
          (SELECT item, is_representative, posted_at FROM families
             WHERE source_role <> 'influencer'
             ORDER BY is_representative DESC, posted_at DESC LIMIT 3)
        ) x
      ) members ON true
      WHERE (${q.programId ?? null}::uuid IS NULL OR s.program_id = ${q.programId ?? null}::uuid)
        AND (${includeCandidates} OR s.state <> 'candidate')
        AND s.last_seen_at > now() - interval '7 days'
      ORDER BY s.live_score DESC, s.last_seen_at DESC
      LIMIT ${limit}`;

    const items = rows.map((row) => ({
      ...row,
      live_score: Number(row.live_score ?? 0),
      top_members: ((row.top_members ?? []) as Array<Record<string, unknown>>).map((member) => ({
        ...member,
        text: typeof member.text === 'string' ? redactSensitiveText(member.text) : member.text,
      })),
    }));
    return { stats, items };
  });

  app.get('/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    const [story] = await sql`SELECT id FROM signal_stories WHERE id = ${id}::uuid`;
    if (!story) throw notFound('القصة غير موجودة');
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT po.id, po.text, po.url, po.posted_at AS "postedAt", a.username,
             a.display_name AS "displayName", a.profile_image_url AS "profileImageUrl",
             sm.family_key AS "familyKey", sm.source_role AS "sourceRole",
             sm.similarity::float, sm.is_representative AS "isRepresentative",
             ps.label AS sentiment, media.image_url AS "mediaImage",
             COALESCE(pm.engagement, 0)::int AS engagement
      FROM signal_story_members sm
      JOIN posts po ON po.id = sm.post_id AND po.posted_at = sm.posted_at
      LEFT JOIN authors a ON a.id = po.author_id
      LEFT JOIN post_sentiments ps ON ps.post_id = po.id AND ps.posted_at = po.posted_at
      LEFT JOIN LATERAL (
        SELECT COALESCE(preview_image_url, url) AS image_url
        FROM post_media m
        WHERE m.post_id = po.id AND m.posted_at = po.posted_at
          AND m.type IN ('photo','video','animated_gif')
        ORDER BY m.media_key LIMIT 1
      ) media ON true
      LEFT JOIN LATERAL (
        SELECT like_count + repost_count + reply_count + quote_count AS engagement
        FROM post_metrics m
        WHERE m.post_id = po.id AND m.posted_at = po.posted_at
        ORDER BY captured_at DESC LIMIT 1
      ) pm ON true
      WHERE sm.story_id = ${id}::uuid
      ORDER BY sm.is_representative DESC, po.posted_at DESC`;
    return { items: rows.map((row) => ({ ...row, text: redactSensitiveText(String(row.text ?? '')) })) };
  });

  app.post('/refresh', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async () => refreshSignalStories(1000));
}
