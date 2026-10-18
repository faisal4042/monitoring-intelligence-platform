import { QUEUE_STATUS_LABELS } from '@mip/shared';
import type { Post } from '../../lib/types';
import { VALUE_LABELS } from '../../lib/search';

export type Interaction = Post & {
  queue_id: string | null;
  queue_status: string | null;
  assignee_name: string | null;
  human_corrected: boolean;
  relevance_confidence?: number | null;
  model?: string | null;
  sentiment_stage?: number | null;
  sentiment_model?: string | null;
  impression_count?: number | null;
  is_reply?: boolean;
  is_quote?: boolean;
  is_repost?: boolean;
};
export interface InteractionDetail {
  post: Interaction;
  why: { query_name?: string; version?: number; compiled?: string; matched_keywords?: string[]; filter_reason?: string };
  feedback: { human_value: string; reason: string | null; created_at: string }[];
  events: { action: string; reason: string | null; occurred_at: string }[];
  queueEvents?: { event_type: string; reason: string | null; created_at: string }[];
  canReadAudit: boolean;
}
export type CardDensity = 'compact' | 'expanded';
export type DetailSection = 'interaction' | 'analysis' | 'account' | 'history' | 'ticket' | 'events';
export interface InteractionActions {
  onDetails: (post: Interaction, section?: DetailSection) => void;
  onHistory?: (post: Interaction) => void;
  onTicket?: (post: Interaction) => void;
  onAddToQueue?: (post: Interaction) => void;
  onClassify?: (post: Interaction) => void;
  onExport?: (post: Interaction) => void;
}
export const interactionLabel = (value: string | null | undefined) => value ? VALUE_LABELS[value] ?? value : 'غير متوفر';
export function queueLabel(post: Interaction) {
  return post.queue_status ? QUEUE_STATUS_LABELS[post.queue_status as keyof typeof QUEUE_STATUS_LABELS] ?? post.queue_status : 'بلا تذكرة متاحة';
}
export function operationalState(post: Interaction) {
  if (post.status === 'duplicate') return { label: 'مكرر', tone: 'neutral' };
  if (post.status === 'filtered_out') return { label: 'مستبعد', tone: 'neutral' };
  if (post.queue_status) return { label: queueLabel(post), tone: post.queue_status === 'completed' ? 'success' : 'info' };
  return { label: post.stage == null || post.relevance === 'unknown' ? 'يحتاج مراجعة' : 'بلا تذكرة', tone: 'neutral' };
}
export function classificationSource(post: Interaction) {
  if (post.human_corrected || post.model?.startsWith('human_')) return 'مراجعة بشرية';
  return post.stage === 3 ? 'نموذج لغوي · المرحلة 3' : post.stage === 2 ? 'تصنيف آلي · المرحلة 2' : post.stage === 1 ? 'قواعد أولية · المرحلة 1' : 'بانتظار التصنيف';
}
/** This is relevance confidence, never topic confidence or a new human verdict. */
export function relevanceConfidence(post: Interaction): number | null {
  const value = post.relevance_confidence;
  if (post.stage == null || !post.relevance || post.human_corrected || post.model?.startsWith('human_') || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? Math.round(number * 100) : null;
}
export function availableMetrics(post: Interaction) {
  return ([
    { key: 'likes', label: 'إعجابات', value: post.like_count },
    { key: 'reposts', label: 'إعادة نشر', value: post.repost_count },
    { key: 'replies', label: 'ردود', value: post.reply_count },
    { key: 'views', label: 'مشاهدات', value: post.impression_count },
  ] as const).filter(metric => typeof metric.value === 'number' && Number.isFinite(metric.value) && metric.value >= 0);
}
export function safeExternalUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export type TextToken = { text: string; kind: 'text' | 'link' | 'mention' | 'hashtag'; href?: string };
/** Preserve the original text; isolate Latin tokens instead of reversing mixed RTL text. */
export function tokenizeInteraction(text: string): TextToken[] {
  const matcher = /https?:\/\/[^\s<>]+|@[A-Za-z0-9_]+|#[\p{L}\p{N}_]+/gu;
  const tokens: TextToken[] = []; let start = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index!;
    if (index > start) tokens.push({ text: text.slice(start, index), kind: 'text' });
    const raw = match[0];
    if (raw.startsWith('http')) {
      const clean = raw.replace(/[.,،؛!؟)\]]+$/u, '');
      const href = safeExternalUrl(clean);
      tokens.push({ text: clean, kind: href ? 'link' : 'text', href });
      if (clean.length < raw.length) tokens.push({ text: raw.slice(clean.length), kind: 'text' });
    } else tokens.push({ text: raw, kind: raw.startsWith('@') ? 'mention' : 'hashtag' });
    start = index + raw.length;
  }
  if (start < text.length) tokens.push({ text: text.slice(start), kind: 'text' });
  return tokens;
}
