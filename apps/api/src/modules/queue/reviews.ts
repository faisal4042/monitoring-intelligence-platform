/**
 * Monitoring review at closure: compare what the AI said with what the
 * reviewer approves, validate it against the live catalogue, and keep both.
 * The AI prediction rows are never written here.
 */
import type { Transaction } from '@mip/db';
import { badRequest } from '../../lib/errors.js';

export const REVIEW_OUTCOMES = ['confirmed', 'corrected', 'irrelevant', 'no_action'] as const;
/** The platform's own enums (intent_label, sentiment_label) with their Arabic names. */
export const INTENT_LABELS: Record<string, string> = { complaint: 'شكوى', inquiry: 'استفسار', suggestion: 'اقتراح', praise: 'إشادة', news: 'خبر',
  experience: 'تجربة', warning: 'تحذير', issue: 'مشكلة', request: 'طلب', other: 'أخرى' };
export const SENTIMENT_LABELS: Record<string, string> = { very_positive: 'إيجابي جداً', positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي', very_negative: 'سلبي جداً' };
export type ReviewOutcome = typeof REVIEW_OUTCOMES[number];
/** A field left out means "I approve the AI value". */
export interface ReviewInput {
  outcome: ReviewOutcome;
  programId?: string | null; intent?: string | null; sentiment?: string | null; relevant?: boolean;
  topicId?: string | null; subtopicId?: string | null; linksConfirmed?: boolean; reason?: string;
}
interface Values {
  program_id: string | null; intent: string | null; sentiment: string | null; relevant: boolean;
  topic_id: string | null; subtopic_id: string | null; links_confirmed: boolean | null;
}
// Kept for back-compatibility of queue_items.resolution (reports and events read it).
const RESOLUTION: Record<ReviewOutcome, string> = { confirmed: 'handled', corrected: 'handled', irrelevant: 'not_actionable', no_action: 'no_action_needed' };
const FIELD: Array<[keyof Values, string]> = [['program_id', 'program'], ['intent', 'intent'], ['sentiment', 'sentiment'], ['relevant', 'relevance'],
  ['topic_id', 'topic'], ['subtopic_id', 'subtopic'], ['links_confirmed', 'links']];

/** What the AI said for this item, now. A post: classification + sentiment; a story: the clustering result. */
async function aiSnapshot(tx: Transaction, item: { interaction_type: string; post_id: string | null; post_posted_at: Date | string | null; story_id: string | null; program_id: string; story_snapshot: Record<string, unknown> | null }) {
  if (item.interaction_type === 'story') {
    const [s] = await tx`SELECT program_id,title_ar,state,post_count,family_count FROM signal_stories WHERE id=${item.story_id}::uuid`;
    const ai: Values = { program_id: s?.program_id ?? item.program_id, intent: null, sentiment: null, relevant: true, topic_id: null, subtopic_id: null, links_confirmed: true };
    return { ai, raw: { kind: 'story', ...ai, title: s?.title_ar ?? item.story_snapshot?.title ?? null, state: s?.state ?? null, postCount: s?.post_count ?? null, families: s?.family_count ?? null } };
  }
  const [c] = await tx`SELECT c.program_id,c.intent::text AS intent,c.intent_confidence::float,c.relevance::text AS relevance,
      c.relevance_confidence::float,c.model,c.human_corrected,c.stage,s.label::text AS sentiment,s.confidence::float AS sentiment_confidence,
      CASE WHEN t.level=2 THEN t.parent_id ELSE t.id END AS topic_id,CASE WHEN t.level=2 THEN t.id END AS subtopic_id
    FROM post_classifications c LEFT JOIN topics t ON t.id=c.topic_id
    LEFT JOIN post_sentiments s ON s.post_id=c.post_id AND s.posted_at=c.posted_at
    WHERE c.post_id=${item.post_id}::uuid AND c.posted_at=${item.post_posted_at}::timestamptz`;
  const ai: Values = { program_id: c?.program_id ?? null, intent: c?.intent ?? null, sentiment: c?.sentiment ?? null,
    relevant: (c?.relevance ?? 'relevant') === 'relevant', topic_id: c?.topic_id ?? null, subtopic_id: c?.subtopic_id ?? null, links_confirmed: null };
  return { ai, raw: { kind: 'post', ...ai, relevance: c?.relevance ?? null, intentConfidence: c?.intent_confidence ?? null,
    relevanceConfidence: c?.relevance_confidence ?? null, sentimentConfidence: c?.sentiment_confidence ?? null,
    model: c?.model ?? null, stage: c?.stage ?? null, humanCorrectedBefore: c?.human_corrected ?? false } };
}

/**
 * Builds the review to store with a closure, or throws a 400 with an Arabic
 * message. Values the reviewer did not send are the AI's; the program, topics
 * and subtopic must exist in the live catalogue and fit together.
 */
export async function prepareReview(tx: Transaction, item: Parameters<typeof aiSnapshot>[1], input: ReviewInput | undefined) {
  if (!input) throw badRequest('أكمل مراجعة التفاعل قبل الإغلاق: اعتمد تصنيفات الذكاء الاصطناعي أو صحّحها واختر نتيجة المراجعة');
  const story = item.interaction_type === 'story';
  const { ai, raw } = await aiSnapshot(tx, item);
  const pick = <K extends keyof Values>(k: K, v: Values[K] | undefined) => (v === undefined ? ai[k] : v);
  const approved: Values = {
    program_id: pick('program_id', input.programId),
    intent: story ? null : pick('intent', input.intent),
    sentiment: story ? null : pick('sentiment', input.sentiment),
    relevant: pick('relevant', input.relevant),
    topic_id: story ? null : pick('topic_id', input.topicId),
    subtopic_id: story ? null : pick('subtopic_id', input.subtopicId),
    links_confirmed: story ? pick('links_confirmed', input.linksConfirmed) : null,
  };
  if (!story && input.programId !== undefined && input.programId !== ai.program_id && input.topicId === undefined) {
    // A new program cannot keep the old program's topics.
    approved.topic_id = null; approved.subtopic_id = null;
  }
  if (approved.topic_id === null) approved.subtopic_id = null;
  if (approved.program_id) {
    const [p] = await tx`SELECT id FROM programs WHERE id=${approved.program_id}::uuid`;
    if (!p) throw badRequest('البرنامج المختار غير موجود');
  } else if (!story && input.programId === null) throw badRequest('اختر البرنامج الصحيح');
  if (approved.topic_id && (approved.topic_id !== ai.topic_id || approved.program_id !== ai.program_id)) {
    const [t] = await tx`SELECT 1 FROM topics WHERE id=${approved.topic_id}::uuid AND level=1 AND is_active AND program_id=${approved.program_id}::uuid`;
    if (!t) throw badRequest('التصنيف الرئيسي لا ينتمي للبرنامج المختار');
  }
  if (approved.subtopic_id && (approved.subtopic_id !== ai.subtopic_id || (approved.topic_id !== ai.topic_id || approved.program_id !== ai.program_id))) {
    const [t] = await tx`SELECT 1 FROM topics WHERE id=${approved.subtopic_id}::uuid AND level=2 AND is_active AND parent_id=${approved.topic_id}::uuid`;
    if (!t) throw badRequest('التصنيف الفرعي لا يتبع التصنيف الرئيسي المختار');
  }
  const corrected = FIELD.filter(([k]) => !(story && ['intent', 'sentiment', 'topic_id', 'subtopic_id'].includes(k))
    && !(!story && k === 'links_confirmed') && approved[k] !== ai[k]).map(([, name]) => name);
  const reason = input.reason?.trim() || null;
  const nonRelevance = corrected.filter((f) => f !== 'relevance');
  // The outcome must describe what actually happened to the values.
  if (input.outcome === 'irrelevant' && approved.relevant) throw badRequest('نتيجة "غير ذي صلة" تعني أن التفاعل لا يخص البرنامج');
  if (input.outcome !== 'irrelevant' && !approved.relevant) throw badRequest('التفاعل غير ذي صلة: اختر نتيجة "التفاعل غير ذي صلة"');
  if (input.outcome === 'confirmed' && corrected.length) throw badRequest('عدّلت بعض القيم؛ اختر نتيجة "تم تصحيح التصنيفات"');
  if (input.outcome === 'corrected' && !nonRelevance.length) throw badRequest('لم تُصحَّح أي قيمة؛ اختر "التصنيفات صحيحة" أو عدّل القيم');
  if ((corrected.length || input.outcome === 'irrelevant') && !reason) {
    throw badRequest(input.outcome === 'irrelevant' ? 'اكتب سبب اعتبار التفاعل غير ذي صلة' : 'اكتب سبب التصحيح');
  }
  return { ai: raw, approved, corrected, reason, outcome: input.outcome, resolution: RESOLUTION[input.outcome] };
}
