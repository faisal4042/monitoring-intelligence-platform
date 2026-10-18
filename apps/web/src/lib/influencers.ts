/** Types, labels and small helpers shared by the influencer hub (pages/Influencers.tsx). */
import { useEffect, useState } from 'react';

export type HubTab = 'posts' | 'accounts' | 'analytics' | 'cards';
export const HUB_TABS: Array<{ key: HubTab; label: string }> = [
  { key: 'posts', label: 'المنشورات المرصودة' },
  { key: 'accounts', label: 'إدارة حسابات المؤثرين' },
  { key: 'analytics', label: 'التحليلات' },
  { key: 'cards', label: 'إعدادات بطاقات المؤثرين' },
];

export interface RangeMeta { preset: string; from: string | null; to: string | null; fromDate: string | null; toDate: string | null }

interface OverviewFigures {
  active: number; posts: number; relevant: number; programs: number; topics: number;
  with_program: number; with_topic: number; with_sentiment: number; classified: number;
}
export interface HubOverview {
  range: RangeMeta; tracked: number; neverSeen: number;
  now: OverviewFigures; before: OverviewFigures | null;
}

export interface Account {
  id: string; username: string; notes: string | null; created_at: string;
  x_author_id: string | null; display_name: string | null; profile_image_url: string | null;
  author_bio: string | null; followers_count: number | null; is_verified: boolean | null;
  period_posts: number; total_posts: number; last_seen_at: string | null;
}
export interface AccountPage { items: Account[]; total: number; page: number; pageSize: number; range: RangeMeta }
export type AccountSort = 'period_posts' | 'total_posts' | 'last_seen_at' | 'followers' | 'username' | 'created_at';
export type AccountStatus = 'all' | 'active' | 'inactive' | 'unseen';
export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  all: 'كل الحسابات', active: 'نشطة خلال الفترة', inactive: 'بلا نشاط في الفترة', unseen: 'لم يُرصد لها منشور بعد',
};

export interface HubAnalytics {
  range: RangeMeta;
  granularity: 'hour' | 'day' | 'week';
  trend: Array<{ bucket: string; posts: number; relevant: number; accounts: number }>;
  top: Array<{ id: string; username: string; display_name: string | null; profile_image_url: string | null; followers_count: number | null;
    is_verified: boolean | null; posts: number; relevant: number; last_post_at: string; program_name: string | null; program_color: string | null }>;
  programs: Array<{ id: string; name_ar: string; color: string | null; posts: number; accounts: number }>;
  unlinkedPosts: number;
  topics: Array<{ id: string; name: string; program_name: string | null; posts: number; accounts: number }>;
  topicSample: { relevant: number; withTopic: number };
  sentiment: { positive: number; neutral: number; negative: number; unclassified: number; sample: number; reliable: boolean };
  minSentimentSample: number;
}

/** Relevance labels as the classifier writes them; null = not classified yet. */
export const RELEVANCE: Record<string, { text: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  relevant: { text: 'مرتبط', tone: 'ok' },
  irrelevant: { text: 'غير مرتبط', tone: 'muted' },
  advertisement: { text: 'إعلان', tone: 'warn' },
  spam: { text: 'سبام', tone: 'bad' },
  unknown: { text: 'غير محدد', tone: 'warn' },
};
export const SENTIMENT: Record<string, { text: string; tone: 'ok' | 'muted' | 'warn' | 'bad' }> = {
  very_positive: { text: 'إيجابي جداً', tone: 'ok' },
  positive: { text: 'إيجابي', tone: 'ok' },
  neutral: { text: 'محايد', tone: 'muted' },
  negative: { text: 'سلبي', tone: 'warn' },
  very_negative: { text: 'سلبي جداً', tone: 'bad' },
};

/** Splits on commas, whitespace or newlines and strips a leading @ — matches pasting a whole watchlist at once. */
export function parseUsernames(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.replace(/^@/, '').trim()).filter(Boolean))];
}

/** Change vs the previous window, or null when there is nothing to compare with. */
export function change(now: number, before: number | null | undefined) {
  if (before === null || before === undefined) return null;
  if (before === 0) return now === 0 ? { kind: 'same' as const, pct: 0 } : { kind: 'new' as const, pct: null };
  const pct = Math.round(((now - before) / before) * 100);
  return { kind: pct === 0 ? 'same' as const : pct > 0 ? 'up' as const : 'down' as const, pct };
}

/** A value that settles `ms` after the last change — for search boxes that hit the API. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
