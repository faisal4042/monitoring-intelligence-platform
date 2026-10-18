import { sql, normalizeArabic } from '@mip/db';
import {workerCheckpoint} from '../../startup/worker-ownership.js';
/** Same insert/dedup policy on either schema. No catch-and-retry after a failed write. */
export async function insertCompatibleArticle(values: Record<string, unknown>) {
  await workerCheckpoint();
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    // Same lock mode as INSERT. Prevent concurrent ADD COLUMN between capability check and insertion.
    await tx`LOCK TABLE public.news_articles IN ROW EXCLUSIVE MODE`;
    const columns = await tx`SELECT a.attname, a.atttypid='text'::regtype AS correct_type, c.collname
      FROM pg_attribute a LEFT JOIN pg_collation c ON c.oid=a.attcollation
      WHERE a.attrelid='public.news_articles'::regclass AND a.attname='title_normalized' AND NOT a.attisdropped`;
    if(columns.length && (!columns[0].correct_type || columns[0].collname!=='C')) throw new Error('Unexpected normalized-title schema');
    const row = {...values, ...(columns.length ? {title_normalized:normalizeArabic(String(values.title))} : {})};
    await workerCheckpoint();
    return tx`INSERT INTO public.news_articles ${tx(row as any)} ON CONFLICT (url_hash) DO NOTHING RETURNING id`;
  });
}
