/**
 * Core Stage 2/3 batch: embed → match against topic centroids → (optionally)
 * ask an LLM to either place the post under an existing topic or propose a
 * new one when nothing matches well enough. Shared by the manual "تشغيل
 * التصنيف" route and the automatic worker (workers/classification.worker.ts)
 * so both paths behave identically.
 */
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { aiLogger as log } from '@mip/logger';
import { embed, label } from '../ai/client.js';

const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

// Conservative (peak, cache-miss) per-token pricing so recorded cost never
// under-states spend — see DeepSeek pricing docs.
const DEEPSEEK_INPUT_PER_TOKEN = 0.44 / 1_000_000;
const DEEPSEEK_OUTPUT_PER_TOKEN = 1.32 / 1_000_000;

export interface ClassificationRunResult {
  considered: number;
  embedded: number;
  linked: number;
  discovered: number;
  sentimentBackfilled: number;
  skipped: number;
  threshold: number;
  minMargin: number;
  model: string;
}

export interface ClassificationRunOptions {
  programId?: string;
  limit?: number;
  threshold?: number;
  discoverTopics?: boolean;
  // Deliberate, admin-triggered re-billing of posts DeepSeek already gave a
  // verdict on — for a one-time backlog sweep after a taxonomy/logic change
  // (new centroids, new topics, a fixed matching bug) makes the old "none"
  // verdicts worth re-asking. Never set this on the automatic cadence tick,
  // or the same stuck posts get re-billed to DeepSeek forever.
  forceRetry?: boolean;
}

// The automatic worker (every AUTO_CLASSIFICATION_TICK_SECONDS) and the manual
// "تشغيل التصنيف" button both call this. Without a lock they raced over the
// same candidate rows and paid DeepSeek twice for the same posts.
let running = false;

export async function runClassificationBatch(opts: ClassificationRunOptions = {}): Promise<ClassificationRunResult> {
  if (running) {
    return { considered: 0, embedded: 0, linked: 0, discovered: 0, sentimentBackfilled: 0, skipped: 0, threshold: opts.threshold ?? config.STAGE2_CONFIDENCE_THRESHOLD, minMargin: config.STAGE2_MIN_MARGIN, model: config.EMBEDDING_MODEL };
  }
  running = true;
  try {
    return await runClassificationBatchInner(opts);
  } finally {
    running = false;
  }
}

async function runClassificationBatchInner(opts: ClassificationRunOptions = {}): Promise<ClassificationRunResult> {
  if (!config.ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI) {
    throw new Error('EXTERNAL_AI_DISABLED: ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI=false');
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const threshold = opts.threshold ?? config.STAGE2_CONFIDENCE_THRESHOLD;
  const discoverTopics = opts.discoverTopics ?? false;
  const forceRetry = opts.forceRetry ?? false;
  const programId = opts.programId ?? null;

  const centroidCount = await sql<{ count: string }[]>`
    SELECT count(*) FROM topics WHERE centroid IS NOT NULL AND is_active
      AND (${programId}::uuid IS NULL OR program_id = ${programId}::uuid)`;
  const hasCentroids = Number(centroidCount[0]?.count ?? 0) > 0;
  if (!hasCentroids && !discoverTopics) {
    return { considered: 0, embedded: 0, linked: 0, discovered: 0, sentimentBackfilled: 0, skipped: 0, threshold, minMargin: config.STAGE2_MIN_MARGIN, model: config.EMBEDDING_MODEL };
  }

  // "Needs matching", not "needs embedding" — a post embedded on a previous
  // run (e.g. before a new topic existed) must stay eligible for matching
  // without paying for a second embedding call. A post that already has a
  // topic (matched cheaply via embeddings, stage 2) still needs a pass here
  // if it never got a DeepSeek-derived sentiment — that pass skips topic
  // re-matching and only asks for sentiment.
  const candidates = await sql<{
    post_id: string; posted_at: Date | string; text: string; text_normalized: string;
    x_author_id: string; embedding: string | null;
    program_id: string | null; service_id: string | null; topic_id: string | null; already_tried: boolean;
  }[]>`
    SELECT p.id AS post_id, p.posted_at, p.text, p.text_normalized, p.x_author_id,
           pe.embedding::text AS embedding,
           c.program_id, c.service_id, c.topic_id,
           (s.stage IS NOT NULL OR sm.post_id IS NOT NULL) AS already_tried
    FROM posts p
    JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
    LEFT JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
    LEFT JOIN post_sentiments s ON s.post_id = p.id AND s.posted_at = p.posted_at AND s.stage = 3
    LEFT JOIN topic_suggestion_members sm ON sm.post_id = p.id AND sm.posted_at = p.posted_at
    WHERE c.relevance = 'relevant'
      AND p.is_redacted = false
      AND (${programId}::uuid IS NULL OR c.program_id = ${programId}::uuid)
      -- s.stage IS NULL means "never got a stage-3 DeepSeek verdict yet" —
      -- once a post has one (topic assigned, or a deliberate "none"), it must
      -- never be resubmitted to the LLM again on cadence, or the same 20
      -- oldest "excluded" posts get re-billed to DeepSeek every tick forever
      -- while genuinely new posts wait behind them (FIFO order).
      AND (c.topic_id IS NULL OR s.stage IS NULL)
    -- Never-tried posts before already-tried ones, oldest-first within each
    -- group. Without the already-tried split, a pool of already-decided
    -- "excluded" posts (cheap to re-skip, but still older than anything new)
    -- fills the entire LIMIT every tick and genuinely new posts never get a
    -- turn. Without the age ordering inside each group, a "newest first"
    -- queue starves whatever isn't in the freshest N as long as new content
    -- keeps arriving — a live user report once caught a post stuck 4 days.
    ORDER BY already_tried ASC, p.posted_at ASC
    LIMIT ${limit}`;

  if (candidates.length === 0) {
    return { considered: 0, embedded: 0, linked: 0, discovered: 0, sentimentBackfilled: 0, skipped: 0, threshold, minMargin: config.STAGE2_MIN_MARGIN, model: config.EMBEDDING_MODEL };
  }

  const toEmbed = candidates.filter((c) => !c.embedding);
  let embeddingModel = config.EMBEDDING_MODEL;
  if (toEmbed.length > 0) {
    const result = await embed(toEmbed.map((c) => c.text));
    embeddingModel = result.model;
    for (let i = 0; i < toEmbed.length; i++) {
      const c = toEmbed[i];
      const vec = toVectorLiteral(result.embeddings[i]);
      c.embedding = vec;
      await sql`
        INSERT INTO post_embeddings (post_id, posted_at, embedding, model)
        VALUES (${c.post_id}::uuid, ${c.posted_at}::timestamptz, ${vec}::vector, ${embeddingModel})
        ON CONFLICT (post_id, posted_at) DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model`;
    }
  }

  // Cache per-program topic lists for the LLM step so we don't refetch per post.
  const topicListCache = new Map<string, Array<{ id: string; name_ar: string; description: string | null }>>();
  async function topicsForProgram(pid: string | null) {
    const key = pid ?? '__all__';
    if (!topicListCache.has(key)) {
      topicListCache.set(key, await sql<{ id: string; name_ar: string; description: string | null }[]>`
        SELECT t.id, t.name_ar,
               concat_ws(' — ', t.description,
                 CASE WHEN count(tk.id) > 0
                   THEN 'الكلمات المرتبطة: ' || string_agg(tk.term, '، ' ORDER BY tk.kind, tk.term)
                 END
               ) AS description
        FROM topics t
        LEFT JOIN topic_keywords tk ON tk.topic_id = t.id
        WHERE t.is_active AND (${pid}::uuid IS NULL OR t.program_id = ${pid}::uuid)
        GROUP BY t.id
        ORDER BY t.name_ar LIMIT 40`);
    }
    return topicListCache.get(key)!;
  }

  let linked = 0;
  let discovered = 0;
  let sentimentBackfilled = 0;
  for (const c of candidates) {
    if (!c.embedding) continue; // defensive — should always be set by this point

    // One candidate's failure (a slow/failed label() call, a bad DB write)
    // must never abort the rest of the batch — that's exactly how a single
    // post ends up blocking everyone behind it in the queue indefinitely.
    try {
    // Topic already decided (stage 2, embeddings) — this pass exists only to
    // backfill DeepSeek sentiment, so skip straight to the label() call
    // without re-matching or risking a topic change.
    if (c.topic_id) {
      if (!discoverTopics) continue;
      const result = await label(c.text, []);
      if (result.sentiment) {
        await sql`
          INSERT INTO post_sentiments (post_id, posted_at, label, score, stage, model)
          VALUES (${c.post_id}::uuid, ${c.posted_at}::timestamptz, ${result.sentiment}::sentiment_label,
                  ${result.sentimentScore}, 3, ${result.model})
          ON CONFLICT (post_id, posted_at) DO UPDATE SET
            label = EXCLUDED.label, score = EXCLUDED.score, stage = EXCLUDED.stage, model = EXCLUDED.model
          WHERE NOT post_sentiments.human_corrected`;
        sentimentBackfilled++;
      }
      continue;
    }

    // A near-duplicate from the same author can safely inherit a topic that a
    // human already approved. This handles reworded/reposted questions without
    // weakening the conservative global centroid threshold for unrelated text.
    const [reviewedNearDuplicate] = await sql<{
      topic_id: string; semantic_similarity: number; lexical_similarity: number;
    }[]>`
      SELECT c2.topic_id,
             1 - (${c.embedding}::vector <=> pe2.embedding) AS semantic_similarity,
             similarity(${c.text_normalized}, p2.text_normalized) AS lexical_similarity
      FROM post_classifications c2
      JOIN posts p2 ON p2.id = c2.post_id AND p2.posted_at = c2.posted_at
      JOIN post_embeddings pe2 ON pe2.post_id = p2.id AND pe2.posted_at = p2.posted_at
      JOIN topics t ON t.id = c2.topic_id AND t.is_active
      WHERE c2.human_corrected
        AND c2.relevance = 'relevant'
        AND c2.topic_id IS NOT NULL
        AND c2.program_id = ${c.program_id}::uuid
        AND p2.x_author_id = ${c.x_author_id}
        AND p2.id <> ${c.post_id}::uuid
        AND 1 - (${c.embedding}::vector <=> pe2.embedding) >= 0.72
        AND similarity(${c.text_normalized}, p2.text_normalized) >= 0.45
      ORDER BY ${c.embedding}::vector <=> pe2.embedding
      LIMIT 1`;

    if (reviewedNearDuplicate) {
      await sql`
        UPDATE post_classifications
        SET topic_id = ${reviewedNearDuplicate.topic_id}::uuid,
            stage = 2,
            model = 'human_reviewed_near_duplicate'
        WHERE post_id = ${c.post_id}::uuid
          AND posted_at = ${c.posted_at}::timestamptz
          AND topic_id IS NULL`;
      linked++;
      continue;
    }

    const nearest = await sql<{ id: string; similarity: number }[]>`
      SELECT id, 1 - (centroid <=> ${c.embedding}::vector) AS similarity
      FROM topics
      WHERE centroid IS NOT NULL AND is_active
        AND (${c.program_id}::uuid IS NULL OR program_id = ${c.program_id}::uuid)
        AND (${c.service_id}::uuid IS NULL OR service_id IS NULL OR service_id = ${c.service_id}::uuid)
      ORDER BY centroid <=> ${c.embedding}::vector
      LIMIT 2`;

    const best = nearest[0];
    const runnerUp = nearest[1];
    const margin = best ? Number(best.similarity) - Number(runnerUp?.similarity ?? 0) : 0;
    if (best && Number(best.similarity) >= threshold && margin >= config.STAGE2_MIN_MARGIN) {
      await sql`
        UPDATE post_classifications
        SET topic_id = ${best.id}::uuid, stage = 2, model = ${embeddingModel}
        WHERE post_id = ${c.post_id}::uuid AND posted_at = ${c.posted_at}::timestamptz`;
      linked++;
      continue;
    }

    // Already asked DeepSeek once and it decided "none" — the free centroid
    // check above still gives it a shot at newly created topics, but never
    // pay for the same LLM verdict twice, unless this is a deliberate retry.
    if (c.already_tried && !forceRetry) continue;

    if (!discoverTopics) continue;

    const topics = await topicsForProgram(c.program_id);
    const result = await label(c.text, topics.map((t) => ({ id: t.id, nameAr: t.name_ar, description: t.description })));
    const llmCost = result.promptTokens * DEEPSEEK_INPUT_PER_TOKEN + result.completionTokens * DEEPSEEK_OUTPUT_PER_TOKEN;

    // Sentiment rides free on the same DeepSeek call regardless of the topic
    // decision — no extra request just to avoid a second billed call.
    if (result.sentiment) {
      await sql`
        INSERT INTO post_sentiments (post_id, posted_at, label, score, stage, model)
        VALUES (${c.post_id}::uuid, ${c.posted_at}::timestamptz, ${result.sentiment}::sentiment_label,
                ${result.sentimentScore}, 3, ${result.model})
        ON CONFLICT (post_id, posted_at) DO UPDATE SET
          label = EXCLUDED.label, score = EXCLUDED.score, stage = EXCLUDED.stage, model = EXCLUDED.model
        WHERE NOT post_sentiments.human_corrected`;
    }

    // The model can name an existing topic directly (it was given the full
    // active taxonomy for this program, not just the nearest two centroids
    // like the free match above). Trusting that opinion alone would publish
    // on a bare LLM guess, so it only counts once corroborated against the
    // topic's own centroid — at STAGE3_EXISTING_MIN_SIMILARITY, not the
    // stricter blind-match STAGE2 bar (see config for why) — and only for a
    // topic id it was actually offered, never a hallucinated one.
    if (result.action === 'existing' && result.topicId && topics.some((t) => t.id === result.topicId)) {
      const [corroboration] = await sql<{ similarity: number }[]>`
        SELECT 1 - (centroid <=> ${c.embedding}::vector) AS similarity
        FROM topics WHERE id = ${result.topicId}::uuid AND centroid IS NOT NULL AND is_active`;
      if (corroboration && Number(corroboration.similarity) >= config.STAGE3_EXISTING_MIN_SIMILARITY) {
        await sql`
          UPDATE post_classifications
          SET topic_id = ${result.topicId}::uuid, stage = 3, model = ${result.model}
          WHERE post_id = ${c.post_id}::uuid AND posted_at = ${c.posted_at}::timestamptz AND topic_id IS NULL`;
        linked++;
        continue;
      }
    }

    // Picking an existing topic below the deterministic embedding threshold is
    // still only an LLM opinion. Leave it unclassified for human review rather
    // than publishing a low-confidence assignment.
    if (result.action === 'new' && result.nameAr && c.program_id) {
      // A model never publishes a topic directly. It joins a pending proposal
      // (semantic support), or creates a one-member proposal for human review.
      const [nearSuggestion] = await sql<{ id: string; similarity: number }[]>`
        SELECT id, 1 - (centroid <=> ${c.embedding}::vector) AS similarity
        FROM topic_suggestions
        WHERE status = 'pending' AND program_id = ${c.program_id}::uuid
          AND (${c.service_id}::uuid IS NULL OR service_id IS NULL OR service_id = ${c.service_id}::uuid)
        ORDER BY centroid <=> ${c.embedding}::vector
        LIMIT 1`;

      let suggestionId: string;
      if (nearSuggestion && Number(nearSuggestion.similarity) >= config.TOPIC_SUGGESTION_SIMILARITY) {
        suggestionId = nearSuggestion.id;
      } else {
        const [suggestion] = await sql<{ id: string }[]>`
          INSERT INTO topic_suggestions (
            program_id, service_id, name_ar, description, centroid, source_model
          ) VALUES (
            ${c.program_id}::uuid, ${c.service_id}::uuid, ${result.nameAr},
            ${result.description ?? null}, ${c.embedding}::vector, ${result.model}
          ) RETURNING id`;
        suggestionId = suggestion.id;
        discovered++;
      }

      await sql`
        INSERT INTO topic_suggestion_members (suggestion_id, post_id, posted_at, similarity)
        VALUES (${suggestionId}::uuid, ${c.post_id}::uuid, ${c.posted_at}::timestamptz,
                ${nearSuggestion ? Number(nearSuggestion.similarity) : 1})
        ON CONFLICT DO NOTHING`;

      // Recalculate from every supporting interaction, never from a single
      // title or one representative post once the proposal grows.
      await sql`
        UPDATE topic_suggestions ts SET
          support_count = x.member_count,
          centroid = x.average_embedding,
          updated_at = now()
        FROM (
          SELECT sm.suggestion_id, count(*)::int AS member_count, avg(pe.embedding) AS average_embedding
          FROM topic_suggestion_members sm
          JOIN post_embeddings pe ON pe.post_id = sm.post_id AND pe.posted_at = sm.posted_at
          WHERE sm.suggestion_id = ${suggestionId}::uuid
          GROUP BY sm.suggestion_id
        ) x
        WHERE ts.id = x.suggestion_id`;
    }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), postId: c.post_id }, 'classification failed for one post — skipping it');
    }
  }

  return {
    considered: candidates.length, embedded: toEmbed.length, linked, discovered, sentimentBackfilled,
    skipped: Math.max(0, candidates.length - linked - sentimentBackfilled),
    threshold, minMargin: config.STAGE2_MIN_MARGIN, model: embeddingModel,
  };
}
