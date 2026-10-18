/** Compatibility reader preserves pre-v1 grouping and row limit, including its documented pagination limitations. */
import {sql, normalizeArabic} from '@mip/db';
export async function listArticlesLegacy(opts: {
  sourceId?: string; programId?: string; limit?: number; cursor?: string; includeIrrelevant?: boolean;
  days?: number; from?: string; to?: string;
}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const days = Math.min(Math.max(opts.days ?? 30, 1), 3650);
  const from = opts.from ?? new Date(Date.now() - days * 86_400_000).toISOString();
  const to = opts.to ?? 'infinity';
  const fetchLimit = Math.min(limit * 2, 400);
  const rows = await sql<Record<string, any>[]>`
    SELECT a.*, COALESCE(a.publisher_name, s.name_ar) AS source_name,
           s.name_ar AS registry_source_name, s.name_en AS source_name_en, s.logo_url AS source_logo_url,
           s.source_type, COALESCE(a.publisher_url, s.base_url) AS source_base_url, s.source_weight,
           p.name_ar AS program_name, p.color AS program_color,
           t.name_ar AS topic_name,
           COALESCE(a.published_at, a.discovered_at) AS effective_at
    FROM news_articles a
    JOIN news_sources s ON s.id = a.source_id
    LEFT JOIN programs p ON p.id = a.program_id
    LEFT JOIN topics t ON t.id = a.topic_id
    WHERE (${opts.sourceId ?? null}::uuid IS NULL OR a.source_id = ${opts.sourceId ?? null}::uuid)
      AND (${opts.programId ?? null}::uuid IS NULL OR a.program_id = ${opts.programId ?? null}::uuid)
      AND (${opts.cursor ?? null}::timestamptz IS NULL OR COALESCE(a.published_at, a.discovered_at) < ${opts.cursor ?? null}::timestamptz)
      AND (${opts.includeIrrelevant ?? false} OR (a.is_relevant IS TRUE AND a.relevance_score >= 90))
      AND COALESCE(a.published_at, a.discovered_at) >= ${from}::timestamptz
      AND COALESCE(a.published_at, a.discovered_at) < ${to}::timestamptz
      -- A feed that stamps articles in the future is wrong, not early.
      AND COALESCE(a.published_at, a.discovered_at) <= now() + interval '1 day'
    ORDER BY COALESCE(a.published_at, a.discovered_at) DESC, s.source_weight DESC, a.discovered_at DESC
    LIMIT ${fetchLimit}`;

  // The same press release is often syndicated by several newspapers.
  // Collapse exact normalized headlines for display while retaining the
  // source count/names so duplicate coverage becomes evidence, not noise.
  const grouped = new Map<string, Record<string, any>>();
  for (const stored of rows) {
    const {title_normalized: _storageOnly, ...row} = stored;
    const key = normalizeArabic(String(row.title));
    const existing = grouped.get(key);
    if (existing) {
      const names = existing.related_source_names as string[];
      if (!names.includes(String(row.source_name))) names.push(String(row.source_name));
      existing.related_source_count = names.length;
      continue;
    }
    grouped.set(key, {
      ...row,
      related_source_count: 1,
      related_source_names: [String(row.source_name)],
    });
  }
  return [...grouped.values()].slice(0, limit);
}
