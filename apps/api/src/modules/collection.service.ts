import { sql, normalizeArabic, contentHash } from '@mip/db';
import { xApiGateway } from '@mip/x-collector';
import { loadDictionary, classify } from './classification/classifier.js';
import { containsSensitiveData } from '../lib/privacy.js';

export interface CollectionSummary {
  queryId: string;
  queryName: string;
  mode: string;
  retrieved: number;
  inserted: number;
  duplicates: number;
  contentDuplicates: number;
  filtered: number;
  unitsConsumed: number;
}

export class CollectionError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

const X_QUERY_MAX_LENGTH = 512;

function excludeOfficialAuthors(compiled: string, officialAccounts: string[]): string {
  let safeQuery = compiled.trim();
  for (const account of officialAccounts) {
    const username = account.trim().replace(/^@/, '');
    if (!username) continue;
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|\\s)-from:${escaped}(?:\\s|$)`, 'i').test(safeQuery)) continue;
    safeQuery += ` -from:${username}`;
  }
  return safeQuery;
}

export async function collectQuery(queryId: string, triggeredBy?: string): Promise<CollectionSummary> {
  const [query] = await sql<{
    id: string; program_id: string; name: string; status: string;
    current_version_id: string; max_results_per_call: number; since_id: string | null;
    official_accounts: string[];
  }[]>`
    SELECT q.id, q.program_id, q.name, q.status::text, q.current_version_id,
           q.max_results_per_call, q.since_id, p.official_accounts
    FROM queries q
    JOIN programs p ON p.id = q.program_id
    WHERE q.id = ${queryId}::uuid AND q.deleted_at IS NULL`;
  if (!query) throw new CollectionError('الاستعلام غير موجود', 'NOT_FOUND');
  if (query.status !== 'active') {
    throw new CollectionError('الاستعلام غير مفعّل', 'NOT_ACTIVE');
  }

  const [version] = await sql<{ id: string; compiled: string }[]>`
    SELECT id, compiled FROM query_versions WHERE id = ${query.current_version_id}::uuid`;
  if (!version) throw new CollectionError('لا توجد نسخة فعالة للاستعلام', 'NO_VERSION');

  const safeCompiled = excludeOfficialAuthors(version.compiled, query.official_accounts);
  if (safeCompiled.length > X_QUERY_MAX_LENGTH) {
    throw new CollectionError(
      'تعذر تشغيل الاستعلام بأمان: إضافة استبعاد الحسابات الرسمية تجاوزت حد X',
      'OFFICIAL_EXCLUSIONS_EXCEED_QUERY_LIMIT',
    );
  }

  await sql`UPDATE queries SET last_run_at = now() WHERE id = ${query.id}::uuid`;

  const result = await xApiGateway.searchRecent({
    query: safeCompiled,
    maxResults: query.max_results_per_call,
    sinceId: query.since_id,
    purpose: 'collection',
    queryId: query.id,
    queryVersionId: version.id,
    programId: query.program_id,
    triggeredBy,
  });

  if (!result.ok) {
    const message = result.denied ? result.denied.messageAr : result.error;
    throw new CollectionError(message ?? 'فشل الجمع', result.denied?.reason);
  }

  const dict = await loadDictionary(query.program_id);
  let inserted = 0;
  let duplicates = 0;
  let contentDuplicates = 0;
  let filtered = 0;

  for (const post of result.data) {
    const normalized = normalizeArabic(post.text);
    const hash = contentHash(post.text);
    const containsPii = containsSensitiveData(post.text);
    const classification = classify(post.text, dict);
    if (post.possiblySensitive) {
      classification.relevance = 'irrelevant';
      classification.confidence = 0.99;
      classification.intent = null;
      classification.sentiment = 'neutral';
      classification.sentimentScore = 0;
      classification.stage = 1;
      classification.filterReason = 'x_possibly_sensitive';
      classification.reasonAr = 'صنّفه X كمحتوى حساس — مستبعد تلقائيًا';
    }
    const filterReason = classification.filterReason
      ?? (classification.relevance === 'relevant' ? null : `relevance:${classification.relevance}`);

    let authorId: string | null = null;
    if (post.author) {
      const [author] = await sql<{ id: string }[]>`
        INSERT INTO authors (x_author_id, username, display_name, description,
                             profile_image_url, followers_count, following_count,
                             tweet_count, is_verified, profile_fetched_at, last_seen_at)
        VALUES (${post.author.id}, ${post.author.username}, ${post.author.name}, ${post.author.description ?? null},
                ${post.author.profileImageUrl ?? null}, ${post.author.followersCount}, ${post.author.followingCount},
                ${post.author.tweetCount}, ${post.author.verified ?? null}, now(), now())
        ON CONFLICT (x_author_id) DO UPDATE SET
          followers_count = EXCLUDED.followers_count,
          last_seen_at = now(),
          total_post_count = authors.total_post_count + 1
        RETURNING id`;
      authorId = author.id;
    }

    const postedAt = new Date(post.createdAt).toISOString();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO posts (x_post_id, author_id, x_author_id, text, text_normalized, lang,
                         posted_at, url, conversation_id, hashtags, mentions, urls, has_media,
                         query_id, query_version_id, matched_keywords, content_hash,
                         status, filter_reason, contains_pii)
      VALUES (${post.id}, ${authorId}, ${post.authorId}, ${post.text}, ${normalized}, ${post.lang ?? 'ar'},
              ${postedAt}::timestamptz, ${`https://x.com/i/status/${post.id}`}, ${post.conversationId ?? null},
              ${post.hashtags}, ${post.mentions}, ${post.urls}, ${post.media.length > 0},
              ${query.id}::uuid, ${version.id}::uuid, ${classification.matchedTerms}, ${hash},
              ${filterReason ? 'filtered_out' : 'classified'}::post_status, ${filterReason}, ${containsPii})
      ON CONFLICT (x_post_id, posted_at) DO NOTHING
      RETURNING id`;

    if (!row) { duplicates++; continue; }

    // The photo/video URL arrived free in this same response (expansions=
    // attachments.media_keys) — store it now so the UI never has to ask X again.
    for (const m of post.media) {
      await sql`
        INSERT INTO post_media (media_key, post_id, posted_at, type, url, preview_image_url, width, height)
        VALUES (${m.mediaKey}, ${row.id}::uuid, ${postedAt}::timestamptz, ${m.type},
                ${m.url ?? null}, ${m.previewImageUrl ?? null}, ${m.width ?? null}, ${m.height ?? null})
        ON CONFLICT DO NOTHING`;
    }

    const [priorSameContent] = await sql<{ id: string; x_author_id: string }[]>`
      SELECT id, x_author_id FROM posts
      WHERE content_hash = ${hash} AND id <> ${row.id}::uuid
      ORDER BY posted_at ASC LIMIT 1`;

    if (priorSameContent) {
      await sql`
        UPDATE posts
        SET duplicate_of_id = ${priorSameContent.id}::uuid,
            duplicate_type = ${priorSameContent.x_author_id === post.authorId ? 'exact' : 'campaign'},
            status = 'duplicate'::post_status
        WHERE id = ${row.id}::uuid AND posted_at = ${postedAt}::timestamptz`;
      contentDuplicates++;
      continue;
    }

    inserted++;
    if (filterReason) filtered++;

    await sql`
      INSERT INTO post_classifications (post_id, posted_at, relevance, relevance_confidence,
                                        intent, program_id, stage, model, reason_ar)
      VALUES (${row.id}::uuid, ${postedAt}::timestamptz, ${classification.relevance}::relevance_label,
              ${classification.confidence}, ${classification.intent}::intent_label,
              ${query.program_id}::uuid, ${classification.stage},
              ${'rule+heuristic'}, ${classification.reasonAr})
      ON CONFLICT DO NOTHING`;

    await sql`
      INSERT INTO post_sentiments (post_id, posted_at, label, score, confidence, stage, model)
      VALUES (${row.id}::uuid, ${postedAt}::timestamptz, ${classification.sentiment}::sentiment_label,
              ${classification.sentimentScore}, ${classification.confidence}, ${classification.stage}, ${'lexicon'})
      ON CONFLICT DO NOTHING`;

    await sql`
      INSERT INTO post_metrics (post_id, posted_at, like_count, repost_count, reply_count, quote_count)
      VALUES (${row.id}::uuid, ${postedAt}::timestamptz, ${post.metrics.like}, ${post.metrics.repost},
              ${post.metrics.reply}, ${post.metrics.quote})
      ON CONFLICT DO NOTHING`;
  }

  if (result.newestId || result.data.length > 0) {
    const newest = result.newestId ?? result.data[0]?.id;
    if (newest) await sql`UPDATE queries SET since_id = ${newest} WHERE id = ${query.id}::uuid`;
  }

  const relevantCount = inserted - filtered;
  await sql`
    UPDATE queries SET
      last_success_at = now(),
      total_relevant = total_relevant + ${relevantCount},
      total_irrelevant = total_irrelevant + ${filtered},
      precision_rate = CASE WHEN total_relevant + total_irrelevant + ${inserted} > 0
        THEN (total_relevant + ${relevantCount})::numeric
             / NULLIF(total_relevant + total_irrelevant + ${inserted}, 0)
        ELSE NULL END
    WHERE id = ${query.id}::uuid`;

  return {
    queryId: query.id,
    queryName: query.name,
    mode: result.mode,
    retrieved: result.data.length,
    inserted,
    duplicates,
    contentDuplicates,
    filtered,
    unitsConsumed: result.unitsConsumed,
  };
}
