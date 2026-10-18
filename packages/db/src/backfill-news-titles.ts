import type {Sql} from 'postgres';
import {normalizeArabic} from './normalize.js';

/** Test-only until independently authorized for another environment. */
export async function backfillNewsTitles(sql: Sql, expectedDatabase: string, marker: string, batchSize = 100) {
  if (process.env.NODE_ENV !== 'test' || !/^mip_cursor_[a-z0-9_]+_test$/.test(expectedDatabase) ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Unsafe backfill target/options');
  const [database] = await sql`SELECT current_database() AS name`;
  if (database.name !== expectedDatabase) throw new Error('Backfill connected to the wrong database');
  const [fixture] = await sql`SELECT token FROM cursor_safety_fixture_marker`;
  if (fixture?.token !== marker) throw new Error('Independent fixture identity not proven');
  let updated = 0, batches = 0;
  while (true) {
    const rows = await sql<{id: string; title: string}[]>`SELECT id, title FROM news_articles WHERE title_normalized IS NULL ORDER BY id LIMIT ${batchSize}`;
    if (!rows.length) break;
    let progress = 0;
    for (const row of rows) {
      const result = await sql`UPDATE news_articles SET title_normalized = ${normalizeArabic(row.title)}
        WHERE id = ${row.id}::uuid AND title = ${row.title} AND title_normalized IS NULL RETURNING id`;
      progress += result.length;
    }
    batches++; updated += progress;
    if (!progress) throw new Error('Backfill made no progress; stop and retry after concurrent writers settle');
  }
  const [remaining] = await sql`SELECT count(*)::integer AS count FROM news_articles WHERE title_normalized IS NULL`;
  if (remaining.count !== 0) throw new Error('News normalization is not complete');
  return {updated, batches, remaining: remaining.count};
}
