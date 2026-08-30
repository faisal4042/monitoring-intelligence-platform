import { config } from '@mip/config';
import { sql } from '@mip/db';
import { aiLogger as log } from '@mip/logger';

interface Candidate {
  post_id: string;
  posted_at: Date | string;
  text: string;
  x_author_id: string;
  program_id: string;
  topic_id: string;
  topic_name: string;
  embedding: string;
  is_influencer: boolean;
}

function titleFromText(text: string, topicName: string): string {
  const clean = text
    .replace(/@\w+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return topicName;
  const clipped = clean.length <= 88
    ? clean
    : `${clean.slice(0, 88).replace(/\s+\S*$/, '').trim()}…`;
  return clipped || topicName;
}

/**
 * Collapse classified interactions into dynamic stories. This is deliberately
 * local and deterministic: no additional X request and no LLM call is needed.
 */
export async function refreshSignalStories(limit = 200) {
  const candidates = await sql<Candidate[]>`
    SELECT p.id AS post_id, p.posted_at, p.text, p.x_author_id,
           c.program_id, c.topic_id, t.name_ar AS topic_name,
           pe.embedding::text AS embedding,
           (ti.id IS NOT NULL) AS is_influencer
    FROM posts p
    JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
    JOIN topics t ON t.id = c.topic_id AND t.is_active
    JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
    LEFT JOIN authors a ON a.id = p.author_id
    LEFT JOIN tracked_influencers ti ON lower(ti.username) = lower(a.username) AND ti.is_active
    LEFT JOIN signal_story_members sm ON sm.post_id = p.id AND sm.posted_at = p.posted_at
    WHERE c.relevance = 'relevant'
      AND c.topic_id IS NOT NULL
      AND p.status <> 'filtered_out'
      AND p.is_redacted = false
      AND sm.post_id IS NULL
      AND p.posted_at > now() - ${config.SIGNAL_LOOKBACK_DAYS} * interval '1 day'
    ORDER BY p.posted_at ASC
    LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;

  let created = 0;
  const touched = new Set<string>();

  for (const c of candidates) {
    const [nearest] = await sql<{ id: string; similarity: number }[]>`
      SELECT id, 1 - (centroid <=> ${c.embedding}::vector) AS similarity
      FROM signal_stories
      WHERE program_id = ${c.program_id}::uuid
        AND topic_id = ${c.topic_id}::uuid
        AND last_seen_at > now() - ${config.SIGNAL_LOOKBACK_DAYS} * interval '1 day'
      ORDER BY centroid <=> ${c.embedding}::vector
      LIMIT 1`;

    let storyId = nearest && Number(nearest.similarity) >= config.SIGNAL_CLUSTER_THRESHOLD
      ? nearest.id
      : null;
    let similarity = nearest ? Number(nearest.similarity) : 1;

    if (!storyId) {
      const [legacy] = await sql<{ name_ar: string; similarity: number }[]>`
        SELECT old.name_ar, 1 - (old.centroid <=> ${c.embedding}::vector) AS similarity
        FROM topic_merge_history mh
        JOIN topics old ON old.id = mh.source_topic_id
        WHERE mh.target_topic_id = ${c.topic_id}::uuid
          AND old.centroid IS NOT NULL
        ORDER BY old.centroid <=> ${c.embedding}::vector
        LIMIT 1`;
      const title = legacy && Number(legacy.similarity) >= 0.68
        ? legacy.name_ar
        : titleFromText(c.text, c.topic_name);

      const [story] = await sql<{ id: string }[]>`
        INSERT INTO signal_stories (
          program_id, topic_id, title_ar, why_ar, centroid,
          first_seen_at, last_seen_at
        ) VALUES (
          ${c.program_id}::uuid, ${c.topic_id}::uuid, ${title},
          'إشارة أولية؛ تنتظر مصدراً مستقلاً آخر قبل اعتمادها كقصة.',
          ${c.embedding}::vector, ${c.posted_at}::timestamptz, ${c.posted_at}::timestamptz
        ) RETURNING id`;
      storyId = story.id;
      similarity = 1;
      created++;
    }

    await sql`
      INSERT INTO signal_story_members (
        story_id, post_id, posted_at, family_key, source_role, similarity
      ) VALUES (
        ${storyId}::uuid, ${c.post_id}::uuid, ${c.posted_at}::timestamptz,
        ${c.x_author_id}, ${c.is_influencer ? 'influencer' : 'customer'}, ${similarity}
      ) ON CONFLICT (post_id, posted_at) DO NOTHING`;
    touched.add(storyId);
  }

  // Consolidate stories that arrived in separate ticks but resolve to the
  // same fine-grained issue. Exact legacy-title agreement is authoritative;
  // otherwise require semantic proximity inside the same approved topic.
  let merged = 0;
  for (let i = 0; i < 500; i++) {
    const [pair] = await sql<{ target_id: string; source_id: string }[]>`
      SELECT
        CASE WHEN a.post_count >= b.post_count THEN a.id ELSE b.id END AS target_id,
        CASE WHEN a.post_count >= b.post_count THEN b.id ELSE a.id END AS source_id
      FROM signal_stories a
      JOIN signal_stories b ON b.topic_id = a.topic_id AND b.id > a.id
      WHERE a.title_ar = b.title_ar
         OR 1 - (a.centroid <=> b.centroid) >= ${config.SIGNAL_CLUSTER_THRESHOLD}
      ORDER BY (a.title_ar = b.title_ar) DESC,
               a.centroid <=> b.centroid ASC
      LIMIT 1`;
    if (!pair) break;
    await sql`
      UPDATE signal_story_members
      SET story_id = ${pair.target_id}::uuid
      WHERE story_id = ${pair.source_id}::uuid`;
    await sql`DELETE FROM signal_stories WHERE id = ${pair.source_id}::uuid`;
    touched.add(pair.target_id);
    merged++;
  }

  // Recalculate every recent story so velocity/state decay even when no new
  // member arrived in this particular tick.
  await sql`
    WITH metrics AS (
      SELECT sm.story_id,
             count(*)::int AS post_count,
             count(DISTINCT sm.family_key)::int AS family_count,
             count(DISTINCT p.x_author_id)::int AS author_count,
             count(*) FILTER (WHERE sm.source_role = 'influencer')::int AS influencer_count,
             min(p.posted_at) AS first_seen_at,
             max(p.posted_at) AS last_seen_at,
             count(*) FILTER (WHERE p.posted_at > now() - interval '15 minutes')::int AS added_15m,
             count(*) FILTER (WHERE p.posted_at > now() - interval '1 hour')::int AS added_1h,
             COALESCE(sum(COALESCE(pm.like_count,0) + COALESCE(pm.repost_count,0)
                       + COALESCE(pm.reply_count,0) + COALESCE(pm.quote_count,0)),0)::int AS engagement,
             count(*) FILTER (WHERE ps.label IN ('negative','very_negative'))::int AS negative_count,
             avg(pe.embedding) AS average_embedding
      FROM signal_story_members sm
      JOIN posts p ON p.id = sm.post_id AND p.posted_at = sm.posted_at
      JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
      LEFT JOIN post_sentiments ps ON ps.post_id = p.id AND ps.posted_at = p.posted_at
      LEFT JOIN LATERAL (
        SELECT like_count, repost_count, reply_count, quote_count
        FROM post_metrics x
        WHERE x.post_id = p.id AND x.posted_at = p.posted_at
        ORDER BY captured_at DESC LIMIT 1
      ) pm ON true
      GROUP BY sm.story_id
    ), scored AS (
      SELECT *,
        round((
          ln(1 + family_count) * 35
          + ln(1 + author_count) * 15
          + ln(1 + engagement) * 5
          + added_1h * 8
          + least(negative_count, 3) * 4
          + greatest(0, 20 - extract(epoch FROM (now() - last_seen_at)) / 3600)
        )::numeric, 4) AS score
      FROM metrics
    )
    UPDATE signal_stories s SET
      centroid = x.average_embedding,
      first_seen_at = x.first_seen_at,
      last_seen_at = x.last_seen_at,
      post_count = x.post_count,
      family_count = x.family_count,
      author_count = x.author_count,
      influencer_count = x.influencer_count,
      engagement_total = x.engagement,
      posts_added_15m = x.added_15m,
      posts_added_1h = x.added_1h,
      live_score = x.score,
      state = CASE
        WHEN x.family_count < ${config.SIGNAL_MIN_FAMILIES} THEN 'candidate'
        WHEN x.added_1h >= 3 THEN 'rising'
        WHEN x.first_seen_at > now() - interval '2 hours' THEN 'new'
        WHEN x.last_seen_at < now() - interval '12 hours' THEN 'fading'
        ELSE 'steady'
      END,
      why_ar = CASE
        WHEN x.family_count < ${config.SIGNAL_MIN_FAMILIES}
          THEN 'إشارة أولية من مصدر واحد؛ مخفية عن القصص الرئيسية حتى يؤكدها مصدر مستقل.'
        ELSE 'تجمعت ' || x.post_count || ' تفاعلات من ' || x.family_count
          || ' مصادر مستقلة تحت سياق واحد، بعد دمج التكرار.'
      END,
      updated_at = now()
    FROM scored x
    WHERE s.id = x.story_id`;

  // Once several members form a stable centroid, refine the title from the
  // closest human-reviewed legacy issue. This avoids publishing a raw tweet
  // sentence as a headline while keeping every title inside the approved
  // taxonomy.
  await sql`
    WITH nearest AS (
      SELECT DISTINCT ON (s.id) s.id AS story_id, old.name_ar,
             1 - (s.centroid <=> old.centroid) AS similarity
      FROM signal_stories s
      JOIN topic_merge_history mh ON mh.target_topic_id = s.topic_id
      JOIN topics old ON old.id = mh.source_topic_id AND old.centroid IS NOT NULL
      WHERE s.family_count >= ${config.SIGNAL_MIN_FAMILIES}
      ORDER BY s.id, s.centroid <=> old.centroid
    )
    UPDATE signal_stories s
    SET title_ar = nearest.name_ar, updated_at = now()
    FROM nearest
    WHERE s.id = nearest.story_id AND nearest.similarity >= 0.68`;

  await sql`UPDATE signal_story_members SET is_representative = false WHERE is_representative`;
  await sql`
    UPDATE signal_story_members sm SET is_representative = true
    FROM (
      SELECT DISTINCT ON (m.story_id) m.story_id, m.post_id, m.posted_at
      FROM signal_story_members m
      JOIN posts p ON p.id = m.post_id AND p.posted_at = m.posted_at
      LEFT JOIN LATERAL (
        SELECT like_count + repost_count + reply_count + quote_count AS engagement
        FROM post_metrics x
        WHERE x.post_id = p.id AND x.posted_at = p.posted_at
        ORDER BY captured_at DESC LIMIT 1
      ) pm ON true
      ORDER BY m.story_id, COALESCE(pm.engagement,0) DESC, p.posted_at DESC
    ) best
    WHERE sm.story_id = best.story_id AND sm.post_id = best.post_id AND sm.posted_at = best.posted_at`;

  await sql`
    INSERT INTO signal_story_snapshots (story_id, post_count, family_count, live_score, state, rank)
    SELECT id, post_count, family_count, live_score, state,
           row_number() OVER (PARTITION BY program_id ORDER BY live_score DESC, last_seen_at DESC)::int
    FROM signal_stories
    WHERE last_seen_at > now() - ${config.SIGNAL_LOOKBACK_DAYS} * interval '1 day'`;

  const result = { considered: candidates.length, created, merged, updated: touched.size };
  if (candidates.length > 0) log.info(result, 'signal stories refreshed');
  return result;
}
