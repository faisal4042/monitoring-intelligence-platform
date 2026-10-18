import {sql} from '@mip/db';
import type {BrowsingCursor, CursorContext} from '../../lib/browsing-cursor.js';

export interface ClassificationPageOptions {
  programId: string | null; topicId: string | null; minConfidence: number; limit: number;
  context: CursorContext; cursor: Extract<BrowsingCursor, {kind: 'classification'}> | null;
}
export function classificationPageQuery(opts: ClassificationPageOptions) {
  const last = opts.cursor?.last;
  return sql<Record<string, any>[]>`
    SELECT p.id, p.text, p.posted_at, p.url, p.x_author_id, c.program_id,
           a.username, a.display_name, a.profile_image_url, a.followers_count, a.is_verified,
           t.id AS topic_id, t.name_ar AS topic_name,
           pr.name_ar AS program_name, pr.color AS program_color,
           c.stage, (1 - (pe.embedding <=> t.centroid)) AS confidence,
           to_char(p.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _cursor_time
    FROM post_classifications c
    JOIN posts p ON p.id = c.post_id AND p.posted_at = c.posted_at
    JOIN topics t ON t.id = c.topic_id
    LEFT JOIN authors a ON a.id = p.author_id
    LEFT JOIN programs pr ON pr.id = c.program_id
    LEFT JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
    WHERE c.topic_id IS NOT NULL
      AND (${opts.topicId}::uuid IS NULL OR c.topic_id = ${opts.topicId}::uuid)
      AND (${opts.programId}::uuid IS NULL OR c.program_id = ${opts.programId}::uuid)
      AND (c.human_corrected OR (1 - (pe.embedding <=> t.centroid)) >= ${opts.minConfidence})
      AND c.posted_at >= ${opts.context.window.from}::timestamptz AND c.posted_at < ${opts.context.window.to}::timestamptz
      AND (${last?.time ?? null}::timestamptz IS NULL OR
           (p.posted_at, p.id) < (${last?.time ?? null}::timestamptz, ${last?.id ?? null}::uuid))
    ORDER BY p.posted_at DESC, p.id DESC
    LIMIT ${opts.limit + 1}`;
}
