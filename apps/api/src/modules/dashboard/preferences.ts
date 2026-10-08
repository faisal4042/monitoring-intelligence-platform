/**
 * Saved dashboard layouts: one per user for the all-programs view and one per
 * user and program. Always the signed-in user's own rows — the user id comes
 * from the session, never from the request. A layout only arranges sections;
 * it cannot widen what the API returns.
 */
import { z } from 'zod';
import { sql } from '@mip/db';

export const SECTION_IDS = ['kpis', 'trend', 'programs', 'classifications', 'sentiment', 'hashtags', 'influencers', 'stories', 'news', 'operations', 'ai_quality', 'insights'] as const;
export const KPI_KEYS = ['total', 'relevant', 'excluded', 'inquiries', 'complaints', 'active_influencers', 'approved_stories', 'unique_hashtags'] as const;
export const TREND_SERIES = ['total', 'relevant', 'complaints', 'inquiries'] as const;
export const DEFAULT_PERIODS = ['today', 'yesterday', '7d', '30d', '90d'] as const;

export const layoutSchema = z.object({
  // Order = array order; every section at most once.
  sections: z.array(z.object({ id: z.enum(SECTION_IDS), visible: z.boolean(), collapsed: z.boolean().optional() }).strict()).max(SECTION_IDS.length)
    .refine((a) => new Set(a.map((s) => s.id)).size === a.length, 'قسم مكرر'),
  // Shown KPI cards in order (the rest sit in the expandable row).
  kpis: z.array(z.enum(KPI_KEYS)).max(KPI_KEYS.length).refine((a) => new Set(a).size === a.length, 'مؤشر مكرر'),
  trendSeries: z.array(z.enum(TREND_SERIES)).min(1).max(TREND_SERIES.length).optional(),
  favorites: z.array(z.enum(SECTION_IDS)).max(SECTION_IDS.length).optional(),
  defaultPeriod: z.enum(DEFAULT_PERIODS).optional(),
  // Only meaningful on the all-programs layout: which program opens by default.
  defaultProgram: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
}).strict();
export type Layout = z.infer<typeof layoutSchema>;

export async function getPreferences(userId: string, programId: string | null) {
  const rows = await sql<{ program_id: string | null; layout: Layout; updated_at: string }[]>`SELECT program_id,layout,updated_at FROM dashboard_preferences
    WHERE user_id=${userId}::uuid AND (program_id IS NULL OR program_id=${programId}::uuid)`;
  return { all: rows.find((r) => r.program_id === null) ?? null, program: programId ? rows.find((r) => r.program_id === programId) ?? null : null };
}

export async function savePreferences(userId: string, programId: string | null, layout: Layout) {
  const value = JSON.stringify(programId ? { ...layout, defaultProgram: undefined } : layout);
  const [row] = programId
    ? await sql`INSERT INTO dashboard_preferences(user_id,program_id,layout) VALUES (${userId}::uuid,${programId}::uuid,${value}::jsonb)
        ON CONFLICT (user_id,program_id) WHERE program_id IS NOT NULL DO UPDATE SET layout=EXCLUDED.layout,updated_at=now() RETURNING program_id,layout,updated_at`
    : await sql`INSERT INTO dashboard_preferences(user_id,program_id,layout) VALUES (${userId}::uuid,NULL,${value}::jsonb)
        ON CONFLICT (user_id) WHERE program_id IS NULL DO UPDATE SET layout=EXCLUDED.layout,updated_at=now() RETURNING program_id,layout,updated_at`;
  return row;
}

export async function resetPreferences(userId: string, programId: string | null) {
  const rows = await sql`DELETE FROM dashboard_preferences WHERE user_id=${userId}::uuid
    AND ${programId ? sql`program_id=${programId}::uuid` : sql`program_id IS NULL`} RETURNING id`;
  return { removed: rows.length };
}
