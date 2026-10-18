/** Response shapes of /dashboard/* (and the two health sources the dashboard reads). */
import type { Kpi, Meta } from '../../lib/dashboard';

export interface Drill { title: string; params: Record<string, string> }
export type OnDrill = (d: Drill) => void;
/** The slice of a react-query result a panel needs. */
export type Q<T> = { data?: T & Meta; isLoading: boolean; error: unknown };

export type KpiData = { kpis: Kpi[]; context: { unclassified: number; humanReviewed: number; negative?: number; sentimentSample?: number;
  negativePrev?: number | null; sentimentSamplePrev?: number | null } };

export type TrendRow = { bucket: string; total: number; relevant: number; complaints: number; inquiries: number; negative?: number };
export type Granularity = 'hour' | 'day' | 'week';
export type TrendData = { granularity: Granularity; items: TrendRow[]; previous: TrendRow[] };

export type ProgramRow = { id: string; key: string; name_ar: string; color: string | null; posts: number; relevant: number; complaints: number; inquiries: number;
  negative: number; sentiment_sample: number; active_influencers: number | null; stories: number };
export type ProgramsData = { items: ProgramRow[]; unlinked: number };

export type TopicRow = { id: string; name: string; parentName: string | null; count: number; previous: number | null; complaints: number };
export type ClassData = { sample: { relevant: number; with_intent: number; with_topic: number };
  intents: Array<{ intent: string; count: number; previous: number | null }>; topics: TopicRow[]; subtopics: TopicRow[] };

export type SentGroups = { positive: number; neutral: number; negative: number; unclassified: number };
export type SentRow = { id: string; name_ar: string; g: string; n: number };
export type SentData = { granularity: Granularity; current: SentGroups; previous: SentGroups | null; byProgram: SentRow[]; byTopic: SentRow[];
  trend: Array<{ bucket: string; negative: number; sample: number }> };

export type Tag = { key: string; tag: string; posts: number; previous: number | null; complaints: number; isNew: boolean | null };
export type TagData = { unique: number; uniquePrevious: number | null; usages: number; newCount: number | null; top: Tag[]; newTags: Tag[]; complaintTags: Tag[];
  byProgram: Array<{ key: string; id: string; name_ar: string; color: string | null; posts: number }> };

export type InsightsData = { items: Array<{ key: string; severity: 'warning' | 'info'; title: string; detail: string; rule: string; drill?: Record<string, string> }>; comparable: boolean };

export type InfRow = { id: string; username: string; display_name: string | null; profile_image_url: string | null; followers_count: number | null; posts: number;
  relevant: number; complaints: number; dominant_sentiment: string | null; sentiment_sample: number; program_name: string | null; last_seen_at: string | null };
export type InfData = { tracked: number; active: number; activePrevious: number | null; posts: number; relevantPosts: number; relevantPostsPrevious: number | null;
  top: InfRow[]; complaintTop: Array<{ id: string; username: string; complaints: number }>;
  byProgram: Array<{ id: string; name_ar: string; color: string | null; accounts: number; posts: number }>; minSentimentSample: number };

export type StoryRow = { id: string; title_ar: string; summary: string | null; state: string; post_count: number; family_count: number;
  first_seen_at: string; last_seen_at: string; updated_at: string; program_name: string; color: string | null };
export type StoriesData = { approvedTotal: number; liveNow: number; active: number; created: number; activePrevious: number | null; createdPrevious: number | null; items: StoryRow[] };

export type NewsData = { total: number; relevant: number; totalPrevious: number | null; relevantPrevious: number | null;
  bySource: Array<{ source: string; articles: number; relevant: number }>;
  latest: Array<{ id: string; title: string; url: string; published_at: string; source: string; program_name: string | null }>;
  topics: Array<{ id: string; name_ar: string; articles: number }> };

export type YouTubeData = { activated: false } | { activated: true; videos: number; relevant: number; needsReview: number;
  relevantPrevious: number | null; comments: number; commentsPrevious: number | null; views: number;
  top: Array<{ id: string; youtube_video_id: string; title: string | null; channel_title: string | null; published_at: string;
    program_name: string | null; views: number | null; comments: number | null }>;
  channels: Array<{ channel: string; videos: number }>;
  byProgram: Array<{ key: string; name_ar: string; videos: number }> };

export type Ops = { scope: string; warnMinutes: number; snapshot: Record<'unassigned' | 'assigned' | 'escalated' | 'overdue', number>;
  period: { closed_items: number; review_cycles: number; reopened: number; avg_wait_assign_min: number | null; avg_assignment_to_close_min: number | null; avg_close_tat_min: number | null };
  employees: Array<{ id: string; full_name: string; open: number; closed_items: number; review_cycles: number; corrected: number; avg_assignment_to_close_min: number | null }> };

export type AiField = { field: string; sample: number; agreed: number; rate: number | null };
export type Ai = { reviewed: number; cycles: number; outcomes: Record<'confirmed' | 'corrected' | 'irrelevant' | 'no_action', number>; correctionRate: number | null;
  overall: { sample: number; agreed: number; rate: number | null } | null; overallPrevious: { sample: number; rate: number | null } | null;
  fields: AiField[]; byProgram: Array<{ id: string; name_ar: string; color: string | null; reviewed: number; comparable: number; agreed: number; rate: number | null }>;
  mostCorrected: Array<{ field: string; ai_value: string; ai_label: string | null; corrections: number }> };

/** Public /health: database, X stream and the newest collected post. */
export type Health = { ok: boolean; mode: string; time: string;
  xStream: { state: string; rules: number; connectedAt: string | null; lastEventAt: string | null; hasError: boolean };
  collectionLatency: { latest_seconds: number | null; latest_collected_at: string; latest_posted_at: string } | null };
/** /news/sources rows, reduced to the health fields the dashboard reads. */
export type NewsSourceHealth = { id: string; is_active: boolean; health_state: 'healthy' | 'degraded' | 'failed'; last_checked_at: string | null; consecutive_failures: number };
