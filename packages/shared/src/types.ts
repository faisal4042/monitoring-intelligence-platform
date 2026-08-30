import { z } from 'zod';

export const QUERY_STATUSES = ['draft', 'tested', 'approved', 'active', 'paused', 'archived'] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export const POLLING_TIERS = ['hot', 'warm', 'cold', 'manual'] as const;
export type PollingTier = (typeof POLLING_TIERS)[number];

export const KEYWORD_TYPES = ['primary', 'service', 'related', 'negative', 'sensitive'] as const;
export type KeywordType = (typeof KEYWORD_TYPES)[number];

export const RELEVANCE_LABELS = ['relevant', 'irrelevant', 'advertisement', 'spam', 'unknown'] as const;
export type RelevanceLabel = (typeof RELEVANCE_LABELS)[number];

export const SENTIMENT_LABELS = ['very_positive', 'positive', 'neutral', 'negative', 'very_negative'] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

export const INTENT_LABELS = [
  'complaint', 'inquiry', 'suggestion', 'praise', 'news',
  'experience', 'warning', 'issue', 'request', 'other',
] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

export const BUDGET_SCOPES = ['global', 'program', 'query', 'purpose'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_PERIODS = ['hour', 'day', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const API_PURPOSES = ['collection', 'test', 'author_refresh', 'manual', 'backfill'] as const;
export type ApiPurpose = (typeof API_PURPOSES)[number];

/** The Budget Gate verdict. No X request happens without ALLOW. */
export type BudgetDecision =
  | { verdict: 'ALLOW'; grantedUnits: number }
  | {
      verdict: 'DENY';
      reason: 'KILL_SWITCH' | 'MONTHLY' | 'DAILY' | 'HOURLY' | 'PROGRAM' | 'QUERY' | 'PURPOSE' | 'NOT_LIVE';
      scope: string;
      usage: number;
      limit: number;
      messageAr: string;
    };

export const loginSchema = z.object({
  email: z.string().email('البريد الإلكتروني غير صالح'),
  password: z.string().min(8, 'كلمة المرور قصيرة جداً'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  roleNameAr: string;
  permissions: string[];
  locale: string;
  theme: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
