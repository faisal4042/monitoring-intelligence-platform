import type { ApiPurpose, BudgetDecision } from '@mip/shared';

export interface SearchRequest {
  query: string;
  maxResults: number;
  sinceId?: string | null;
  purpose: ApiPurpose;
  queryId?: string;
  queryVersionId?: string;
  programId?: string;
  testId?: string;
  triggeredBy?: string;
}

export interface FilteredStreamRule {
  value: string;
  tag: string;
}

export interface FilteredStreamMatch {
  id: string;
  tag?: string;
}

export interface FilteredStreamEvent {
  post: XPost;
  matchingRules: FilteredStreamMatch[];
}

export interface XMedia {
  mediaKey: string;
  type: string;
  url?: string;
  previewImageUrl?: string;
  width?: number;
  height?: number;
}

export interface XPost {
  id: string;
  text: string;
  createdAt: string;
  authorId: string;
  lang?: string;
  conversationId?: string;
  referencedType?: 'replied_to' | 'quoted' | 'retweeted';
  referencedId?: string;
  possiblySensitive?: boolean;
  hashtags: string[];
  mentions: string[];
  urls: string[];
  metrics: { like: number; repost: number; reply: number; quote: number; impression?: number };
  author?: XUser;
  media: XMedia[];
}

export interface XUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  followersCount: number;
  followingCount: number;
  tweetCount: number;
  verified?: boolean;
  createdAt?: string;
}

export type GatewayResult<T> =
  | { ok: true; data: T; unitsConsumed: number; mode: string; newestId?: string }
  | { ok: false; denied: Extract<BudgetDecision, { verdict: 'DENY' }>; error?: never }
  | { ok: false; error: string; denied?: never };

export interface FieldSelection {
  tweetFields: string[];
  userFields: string[];
  expansions: string[];
  mediaFields: string[];
}

export interface Pricing {
  unitPrice: number;
  monthlyPriceUsd: number;
  monthlyPostQuota: number;
  model: string;
}
