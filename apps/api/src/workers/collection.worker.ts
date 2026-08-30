import { collectionMode, config } from '@mip/config';
import { sql } from '@mip/db';
import { xApiLogger as log } from '@mip/logger';
import type { QueryNode } from '@mip/shared';
import { compileQuery } from '../modules/queries/compiler.js';
import { collectQuery } from '../modules/collection.service.js';

const AUTO_MARKER = '[system:auto-dictionary]';
const INFLUENCER_MARKER = '[system:auto-influencer]';
let ticking = false;

/**
 * Shared by the dictionary query and the influencer query below — both are
 * one system-managed row per program, versioned only when the compiled text
 * actually changes.
 */
async function upsertSystemQuery(
  marker: string, program: ProgramRow, name: string, description: string, ast: QueryNode, compiled: string,
): Promise<boolean> {
  const [existing] = await sql<{
    id: string; compiled: string | null;
  }[]>`
    SELECT q.id, v.compiled
    FROM queries q
    LEFT JOIN query_versions v ON v.id = q.current_version_id
    WHERE q.program_id = ${program.id}::uuid
      AND q.description LIKE ${`${marker}%`}
      AND q.deleted_at IS NULL
    ORDER BY q.created_at ASC LIMIT 1`;

  if (!existing) {
    const [query] = await sql<{ id: string }[]>`
      INSERT INTO queries (
        program_id, name, description, status, polling_tier,
        poll_interval_minutes, max_results_per_call, max_pages_per_run,
        next_run_at, is_paused
      ) VALUES (
        ${program.id}::uuid, ${name}, ${description},
        'active', 'hot', ${config.AUTO_COLLECTION_INTERVAL_MINUTES},
        ${config.AUTO_COLLECTION_MAX_RESULTS}, 1,
        now() + ${config.AUTO_COLLECTION_INTERVAL_MINUTES} * interval '1 minute', false
      ) RETURNING id`;
    const [version] = await sql<{ id: string }[]>`
      INSERT INTO query_versions (
        query_id, version, ast, compiled, compiled_length, change_summary
      ) VALUES (
        ${query.id}::uuid, 1, ${JSON.stringify(ast)}::jsonb, ${compiled}, ${compiled.length},
        'إنشاء تلقائي'
      ) RETURNING id`;
    await sql`UPDATE queries SET current_version_id = ${version.id}::uuid WHERE id = ${query.id}::uuid`;
    return true;
  }

  if (existing.compiled !== compiled) {
    const [{ next }] = await sql<{ next: number }[]>`
      SELECT COALESCE(max(version), 0) + 1 AS next
      FROM query_versions WHERE query_id = ${existing.id}::uuid`;
    const [version] = await sql<{ id: string }[]>`
      INSERT INTO query_versions (
        query_id, version, ast, compiled, compiled_length, change_summary
      ) VALUES (
        ${existing.id}::uuid, ${next}, ${JSON.stringify(ast)}::jsonb, ${compiled}, ${compiled.length},
        'مزامنة تلقائية مع تحديث القاموس'
      ) RETURNING id`;
    await sql`
      UPDATE queries SET current_version_id = ${version.id}::uuid, updated_at = now(),
        next_run_at = CASE WHEN status = 'active'
          THEN now() + ${config.AUTO_COLLECTION_INTERVAL_MINUTES} * interval '1 minute'
          ELSE next_run_at END
      WHERE id = ${existing.id}::uuid`;
  }

  await sql`
    UPDATE queries SET
      poll_interval_minutes = ${config.AUTO_COLLECTION_INTERVAL_MINUTES},
      next_run_at = LEAST(COALESCE(next_run_at, now()), now() + ${config.AUTO_COLLECTION_INTERVAL_MINUTES} * interval '1 minute'),
      max_results_per_call = ${config.AUTO_COLLECTION_MAX_RESULTS},
      polling_tier = 'hot'
    WHERE id = ${existing.id}::uuid`;
  return true;
}

interface ProgramRow {
  id: string;
  key: string;
  name_ar: string;
  official_accounts: string[];
}

interface GroupRow {
  id: string;
  type: 'primary' | 'service' | 'negative';
}

/**
 * Creates one system-managed query per program. Primary terms contain exact
 * official handles/brand phrases; service terms add the approved dictionary
 * vocabulary. Negative terms are ALSO compiled into the X query itself
 * (`-"phrase"`) — every retrieved post is billed regardless of how it's later
 * classified, so excluding a confirmed-noise phrase from the request is the
 * only way to actually stop paying for it, not just hide it after the fact.
 */
export async function ensureAutomaticQueries(): Promise<number> {
  if (!config.AUTO_COLLECTION_ENABLED) return 0;
  const excludedUsers = config.AUTO_COLLECTION_EXCLUDED_USERS
    .split(',')
    .map((username) => username.trim().replace(/^@/, ''))
    .filter(Boolean);

  // Demo responses use synthetic post IDs. Never send one of those IDs as a
  // live `since_id` after the operator switches the same database to X.
  if (collectionMode === 'live') {
    const reset = await sql<{ id: string }[]>`
      UPDATE queries q
      SET since_id = NULL, next_run_at = now(), updated_at = now()
      WHERE q.description LIKE ${`${AUTO_MARKER}%`}
        AND q.since_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM api_usage u
          WHERE u.query_id = q.id AND u.mode = 'demo'
        )
        AND NOT EXISTS (
          SELECT 1 FROM api_usage u
          WHERE u.query_id = q.id
            AND u.mode = 'live'
            AND u.http_status BETWEEN 200 AND 299
        )
      RETURNING q.id`;
    if (reset.length > 0) {
      log.info({ queryIds: reset.map((row) => row.id) }, 'cleared demo watermarks before live collection');
    }
  }

  const programs = await sql<ProgramRow[]>`
    SELECT id, key, name_ar, official_accounts
    FROM programs WHERE is_active ORDER BY key`;
  let ensured = 0;
  // Shared across every program below so the union of their `from:` lists
  // covers as many distinct influencers as possible — without this, every
  // program's query greedily fills up with the same first N usernames and
  // whoever sorts last never appears in any query at all.
  const coveredInfluencers = new Set<string>();

  for (const program of programs) {
    const groups = await sql<GroupRow[]>`
      SELECT id, type::text
      FROM keyword_groups
      WHERE program_id = ${program.id}::uuid
        AND type IN ('primary', 'service')
        AND is_active
        AND EXISTS (
          SELECT 1 FROM keywords k WHERE k.group_id = keyword_groups.id AND k.is_active
        )
      ORDER BY CASE type WHEN 'primary' THEN 1 ELSE 2 END`;
    if (groups.length === 0) continue;

    // Official handles are already curated as mention-mode keywords. Exclude
    // posts authored by those accounts at X query time (not after retrieval,
    // when the post has already consumed quota). Public posts mentioning the
    // same handles continue to match normally.
    const mentionHandles = await sql<{ term: string }[]>`
      SELECT DISTINCT k.term
      FROM keywords k
      JOIN keyword_groups g ON g.id = k.group_id
      WHERE g.program_id = ${program.id}::uuid
        AND g.type = 'primary'
        AND g.is_active AND k.is_active
        AND k.match_mode = 'mention'
      ORDER BY k.term`;
    const programExcludedUsers = [...new Set([
      ...excludedUsers,
      ...program.official_accounts,
      ...mentionHandles.map(({ term }) => term),
    ].map((username) => username.trim().replace(/^@/, '')).filter(Boolean))];

    const positiveNodes: QueryNode[] = groups.map((group) => ({
      op: 'KEYWORD_GROUP', groupId: group.id,
    }));
    const positive: QueryNode = positiveNodes.length === 1
      ? positiveNodes[0]
      : { op: 'OR', children: positiveNodes };
    const baseChildren: QueryNode[] = [
      positive,
      { op: 'NOT', child: { op: 'FILTER', key: 'is:retweet' } },
      ...programExcludedUsers.map((username): QueryNode => ({
        op: 'NOT', child: { op: 'FROM', value: username },
      })),
    ];

    // Negative terms are added individually, newest-curated first, up to
    // whatever fits under X's length cap — every retrieved post is billed
    // regardless of how it's later classified, so a confirmed-noise phrase
    // only stops costing money once it's excluded from the request itself,
    // not just filtered out of the feed afterward. Whatever doesn't fit
    // still applies at classification time as before.
    const negativeTerms = await sql<{ term: string }[]>`
      SELECT k.term
      FROM keywords k
      JOIN keyword_groups g ON g.id = k.group_id
      WHERE g.program_id = ${program.id}::uuid AND g.type = 'negative'
        AND g.is_active AND k.is_active
      ORDER BY k.created_at DESC`;

    const negativeNodes: QueryNode[] = [];
    for (const { term } of negativeTerms) {
      const candidate: QueryNode = {
        op: 'AND',
        children: [...baseChildren, ...negativeNodes, { op: 'NOT', child: { op: 'PHRASE', value: term } }],
      };
      const candidateCompiled = await compileQuery(candidate);
      if (candidateCompiled.length > 512) break;
      negativeNodes.push({ op: 'NOT', child: { op: 'PHRASE', value: term } });
    }

    const ast: QueryNode = { op: 'AND', children: [...baseChildren, ...negativeNodes] };
    const compiled = await compileQuery(ast);
    if (compiled.length > 512) {
      log.error({ program: program.key, compiledLength: compiled.length }, 'automatic query exceeds X limit');
      continue;
    }

    const description = `${AUTO_MARKER} رصد تلقائي للحسابات الرسمية وكلمات القاموس المعتمدة`;
    const created = await upsertSystemQuery(
      AUTO_MARKER, program, `الرصد التلقائي — ${program.name_ar}`, description, ast, compiled,
    );
    if (created) ensured++;

    // العملاء المؤثرون: same program dictionary, but ANDed with as many
    // tracked usernames as fit — being tracked never bypasses relevance
    // filtering, it only adds `from:` on top of it. One query per program
    // (not one combined query) because classification reads a single
    // program's dictionary per query (docs/PROJECT_PLAN.md §attribution).
    const influencerEnsured = await ensureInfluencerQueryForProgram(program, baseChildren, coveredInfluencers);
    if (influencerEnsured) ensured++;
  }

  return ensured;
}

async function ensureInfluencerQueryForProgram(
  program: ProgramRow, baseChildren: QueryNode[], coveredInfluencers: Set<string>,
): Promise<boolean> {
  const influencers = await sql<{ username: string }[]>`
    SELECT username FROM tracked_influencers WHERE is_active ORDER BY created_at DESC`;
  if (influencers.length === 0) return false;

  // Not-yet-covered usernames go first so each program's query prioritises
  // filling gaps the earlier programs' queries left, rather than every
  // program racing for the same first N names.
  const ordered = [
    ...influencers.filter((i) => !coveredInfluencers.has(i.username)),
    ...influencers.filter((i) => coveredInfluencers.has(i.username)),
  ];

  // Negative exclusions are dropped here on purpose: they exist to filter
  // noise out of *broad public* search, but these are specific accounts we
  // already chose to track by name — the `from:` budget matters more than
  // reusing the same noise filter, and Stage 1 classification still applies
  // after collection either way.
  const fixedChildren = baseChildren;
  const fromNodes: QueryNode[] = [];
  for (const { username } of ordered) {
    const candidateFrom = [...fromNodes, { op: 'FROM', value: username } as QueryNode];
    const fromGroup: QueryNode = candidateFrom.length === 1 ? candidateFrom[0] : { op: 'OR', children: candidateFrom };
    const candidateCompiled = await compileQuery({ op: 'AND', children: [...fixedChildren, fromGroup] });
    if (candidateCompiled.length > 512) break; // rest covered once an earlier one frees up room, or via a future second query
    fromNodes.push({ op: 'FROM', value: username });
  }
  if (fromNodes.length === 0) {
    log.error({ program: program.key }, 'no influencer fits in the query budget alongside the program dictionary');
    return false;
  }

  const fromGroup: QueryNode = fromNodes.length === 1 ? fromNodes[0] : { op: 'OR', children: fromNodes };
  const ast: QueryNode = { op: 'AND', children: [...fixedChildren, fromGroup] };
  const compiled = await compileQuery(ast);
  if (compiled.length > 512) return false;

  for (const node of fromNodes) {
    if (node.op === 'FROM') coveredInfluencers.add(node.value);
  }

  const description = `${INFLUENCER_MARKER} رصد تغريدات العملاء المؤثرين المرتبطة ببرامجنا فقط`;
  return upsertSystemQuery(
    INFLUENCER_MARKER, program, `الرصد التلقائي (مؤثرون) — ${program.name_ar}`, description, ast, compiled,
  );
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = await sql<{ id: string }[]>`
      SELECT id FROM queries
      WHERE status = 'active' AND NOT is_paused AND deleted_at IS NULL
        AND current_version_id IS NOT NULL
        AND (next_run_at IS NULL OR next_run_at <= now())
      ORDER BY COALESCE(next_run_at, created_at) ASC
      LIMIT 10`;

    for (const candidate of due) {
      const [claimed] = await sql<{ id: string; poll_interval_minutes: number }[]>`
        UPDATE queries
        SET next_run_at = now() + ${config.AUTO_COLLECTION_MAX_BACKOFF_MINUTES} * interval '1 minute',
            last_run_at = now()
        WHERE id = ${candidate.id}::uuid
          AND status = 'active' AND NOT is_paused
          AND (next_run_at IS NULL OR next_run_at <= now())
        RETURNING id, poll_interval_minutes`;
      if (!claimed) continue;

      try {
        const result = await collectQuery(claimed.id);
        const nextInterval = config.AUTO_COLLECTION_INTERVAL_MINUTES;
        await sql`
          UPDATE queries SET
            poll_interval_minutes = ${nextInterval},
            next_run_at = now() + ${nextInterval} * interval '1 minute',
            updated_at = now()
          WHERE id = ${claimed.id}::uuid`;
        log.info({
          queryId: result.queryId,
          retrieved: result.retrieved,
          inserted: result.inserted,
          filtered: result.filtered,
          units: result.unitsConsumed,
          nextIntervalMinutes: nextInterval,
        }, 'automatic collection completed');
      } catch (error) {
        const retryInterval = config.AUTO_COLLECTION_INTERVAL_MINUTES;
        await sql`
          UPDATE queries SET
            poll_interval_minutes = ${retryInterval},
            next_run_at = now() + ${retryInterval} * interval '1 minute',
            updated_at = now()
          WHERE id = ${claimed.id}::uuid`;
        log.error({ queryId: claimed.id, err: error instanceof Error ? error.message : String(error) },
          'automatic collection failed');
      }
    }
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'automatic collection tick failed');
  } finally {
    ticking = false;
  }
}

export function startCollectionWorker(): () => void {
  if (!config.AUTO_COLLECTION_ENABLED) {
    log.info('automatic collection is disabled');
    return () => {};
  }

  void sql`
    UPDATE queries SET
      poll_interval_minutes = ${config.AUTO_COLLECTION_INTERVAL_MINUTES},
      next_run_at = LEAST(COALESCE(next_run_at, now()), now() + ${config.AUTO_COLLECTION_INTERVAL_MINUTES} * interval '1 minute'),
      updated_at = now()
    WHERE status = 'active' AND NOT is_paused AND deleted_at IS NULL`;
  const timer = setInterval(() => void tick(), config.AUTO_COLLECTION_TICK_SECONDS * 1000);
  timer.unref();
  log.info({
    tickSeconds: config.AUTO_COLLECTION_TICK_SECONDS,
    intervalMinutes: config.AUTO_COLLECTION_INTERVAL_MINUTES,
    maxResults: config.AUTO_COLLECTION_MAX_RESULTS,
    firstTickInSeconds: config.AUTO_COLLECTION_TICK_SECONDS,
  }, 'automatic collection worker started');

  return () => clearInterval(timer);
}
