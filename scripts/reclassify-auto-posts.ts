import { sql } from '@mip/db';
import { config } from '@mip/config';
import { classify, loadDictionary } from '../apps/api/src/modules/classification/classifier.js';

interface PostRow {
  id: string;
  x_post_id: string;
  posted_at: Date | string;
  text: string;
  program_id: string;
  username: string | null;
}

async function main() {
  const posts = await sql<PostRow[]>`
    SELECT po.id, po.x_post_id, po.posted_at, po.text, q.program_id, a.username
    FROM posts po
    JOIN queries q ON q.id = po.query_id
    JOIN post_classifications c ON c.post_id = po.id AND c.posted_at = po.posted_at
    LEFT JOIN authors a ON a.id = po.author_id
    WHERE q.description LIKE '[system:auto-dictionary]%'
      AND po.status <> 'duplicate'
      AND c.human_corrected = false`;

  const dictionaries = new Map<string, Awaited<ReturnType<typeof loadDictionary>>>();
  const excludedUsers = new Set(config.AUTO_COLLECTION_EXCLUDED_USERS
    .split(',')
    .map((username) => username.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean));
  let relevant = 0;
  let filtered = 0;

  for (const post of posts) {
    let dictionary = dictionaries.get(post.program_id);
    if (!dictionary) {
      dictionary = await loadDictionary(post.program_id);
      dictionaries.set(post.program_id, dictionary);
    }

    const result = classify(post.text, dictionary);
    const isDemoFixture = /^180000000000000\d+$/.test(post.x_post_id);
    const isExcludedSource = Boolean(post.username && excludedUsers.has(post.username.toLowerCase()));
    if (isDemoFixture) {
      result.relevance = 'irrelevant';
      result.confidence = 1;
      result.intent = null;
      result.reasonAr = 'بيانات تجريبية قديمة — مخفية من الرصد المباشر';
      result.matchedTerms = [];
    } else if (isExcludedSource) {
      result.relevance = 'spam';
      result.confidence = 1;
      result.intent = null;
      result.reasonAr = 'مصدر مستبعد من الرصد التلقائي';
      result.matchedTerms = [];
    }
    const filterReason = isDemoFixture ? 'demo_fixture'
      : isExcludedSource ? 'excluded_source'
      : result.filterReason
      ?? (result.relevance === 'relevant' ? null : `relevance:${result.relevance}`);
    const postedAt = post.posted_at instanceof Date
      ? post.posted_at.toISOString()
      : new Date(post.posted_at).toISOString();

    await sql`
      UPDATE posts
      SET matched_keywords = ${result.matchedTerms},
          status = ${filterReason ? 'filtered_out' : 'classified'}::post_status,
          filter_reason = ${filterReason}
      WHERE id = ${post.id}::uuid AND posted_at = ${postedAt}::timestamptz`;

    await sql`
      UPDATE post_classifications
      SET relevance = ${result.relevance}::relevance_label,
          relevance_confidence = ${result.confidence},
          intent = ${result.intent}::intent_label,
          stage = ${result.stage},
          model = 'rule+heuristic',
          reason_ar = ${result.reasonAr}
      WHERE post_id = ${post.id}::uuid AND posted_at = ${postedAt}::timestamptz`;

    await sql`
      UPDATE post_sentiments
      SET label = ${result.sentiment}::sentiment_label,
          score = ${result.sentimentScore},
          confidence = ${result.confidence},
          stage = ${result.stage},
          model = 'lexicon'
      WHERE post_id = ${post.id}::uuid AND posted_at = ${postedAt}::timestamptz`;

    if (filterReason) filtered++;
    else relevant++;
  }

  console.log(JSON.stringify({ processed: posts.length, relevant, filtered }));
  await sql.end();
}

main().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exitCode = 1;
});
