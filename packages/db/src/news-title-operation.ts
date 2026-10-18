import type {Sql} from 'postgres';
import {normalizeArabic} from './normalize.js';
import {verifyTarget, type OperationTarget} from './operation-target.js';

export interface BackfillOptions {
  apply?: boolean; confirmation?: string; batchSize: number; statementMs: number; lockMs: number;
  pauseMs: number; maxDurationMs: number; maxWalBytes: number; maxDatabaseBytes: number;
  maxWaitingLocks: number; maxRssBytes: number; maxReplicaLagBytes: number;
  signal?: AbortSignal; progress?: (counts: {completed:number; remaining:number; batches:number}) => void;
}
export async function runNewsTitleBackfill(sql: Sql, target: OperationTarget, opts: BackfillOptions) {
  for (const key of ['batchSize','statementMs','lockMs','pauseMs','maxDurationMs','maxWalBytes','maxDatabaseBytes','maxWaitingLocks','maxRssBytes','maxReplicaLagBytes'] as const)
    if (!Number.isSafeInteger(opts[key]) || opts[key] < (key === 'pauseMs' || key === 'maxWaitingLocks' ? 0 : 1)) throw new Error('Invalid backfill budget');
  if (opts.batchSize > 1000) throw new Error('Batch exceeds 1000');
  await verifyTarget(sql,target,'news-title-backfill',!!opts.apply,opts.confirmation);
  const started=Date.now(); let completed=0,batches=0;
  const [start]=await sql`SELECT pg_current_wal_lsn()::text AS lsn`;
  // Reserved connection keeps session advisory ownership stable. Dry run takes no lock and opens a read-only transaction.
  const session=await sql.reserve(); let locked=false;
  // postgres-js reserved connections expose no runtime begin helper; explicit boundaries keep the owner pinned.
  const transaction=async<T>(fn:(tx:typeof session)=>Promise<T>)=>{
    await session`BEGIN`;
    try{const result=await fn(session);await session`COMMIT`;return result;}
    catch(error){await session`ROLLBACK`;throw error;}
  };
  const count=async()=>{
    const [row]=await session`SELECT count(*)::text AS remaining FROM public.news_articles WHERE title_normalized IS NULL`;
    return Number(row.remaining);
  };
  try {
    await verifyTarget(session as unknown as Sql,target,'news-title-backfill',!!opts.apply,opts.confirmation);
    const columns=await session`SELECT data_type,is_nullable,collation_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='news_articles' AND column_name='title_normalized'`;
    if(columns.length!==1||columns[0].data_type!=='text'||columns[0].is_nullable!=='YES'||columns[0].collation_name!=='C')throw new Error('News normalization schema mismatch');
    if (!opts.apply) return await transaction(async tx=>{
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SELECT set_config('statement_timeout',${String(opts.statementMs)},true)`;
      const [row]=await tx`SELECT count(*)::text AS remaining FROM public.news_articles WHERE title_normalized IS NULL`;
      return {completed:0,remaining:Number(row.remaining),batches:0,status:'dry-run'};
    });
    const [visibility]=await session`SELECT rolsuper OR pg_has_role(current_user,'pg_read_all_stats','MEMBER') AS permitted
      FROM pg_roles WHERE rolname=current_user`;
    if(!visibility?.permitted)throw new Error('Backfill requires existing monitoring visibility; do not grant roles automatically');
    const [owner]=await session`SELECT pg_try_advisory_lock(hashtext('mip:news-title-backfill')) AS locked`;
    if (!owner.locked) throw new Error('Another backfill owns this database'); locked=true;
    while (true) {
      if (opts.signal?.aborted) return {completed,remaining:await count(),batches,status:'stopped'};
      if (Date.now()-started>opts.maxDurationMs) throw new Error('Backfill duration budget exceeded');
      const [budget]=await session`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),${start.lsn}::pg_lsn)::text AS wal,
        pg_database_size(current_database())::text AS bytes,
        (SELECT count(*)::integer FROM pg_locks WHERE NOT granted) AS waiting,
        COALESCE((SELECT max(pg_wal_lsn_diff(pg_current_wal_lsn(),replay_lsn)) FROM pg_stat_replication),0)::text AS lag`;
      if (Number(budget.wal)>opts.maxWalBytes || Number(budget.bytes)>opts.maxDatabaseBytes || budget.waiting>opts.maxWaitingLocks ||
        Number(budget.lag)>opts.maxReplicaLagBytes || process.memoryUsage().rss>opts.maxRssBytes) throw new Error('Backfill resource budget exceeded');
      let selected=0;
      const updated=await transaction(async tx=>{
        await tx`SELECT set_config('statement_timeout',${String(opts.statementMs)},true),set_config('lock_timeout',${String(opts.lockMs)},true)`;
        await verifyTarget(tx as unknown as Sql,target,'news-title-backfill',true,opts.confirmation);
        const rows=await tx<{id:string;title:string}[]>`SELECT id,title FROM public.news_articles WHERE title_normalized IS NULL ORDER BY id LIMIT ${opts.batchSize}`;
        selected=rows.length; let updated=0;
        for(const row of rows){
          if(opts.signal?.aborted || Date.now()-started>opts.maxDurationMs) throw new Error('Backfill stopped during batch; batch rolled back');
          updated+=(await tx`UPDATE public.news_articles SET title_normalized=${normalizeArabic(row.title)}
            WHERE id=${row.id}::uuid AND title=${row.title} AND title_normalized IS NULL RETURNING id`).length;
        }
        return updated;
      });
      if(!selected) return {completed,remaining:await count(),batches,status:'complete'};
      if(!updated) throw new Error('Backfill made no progress');
      completed+=updated;batches++;
      opts.progress?.({completed,remaining:await count(),batches});
      if(opts.pauseMs) await new Promise<void>(resolve=>{
        const stop=()=>{clearTimeout(timer);opts.signal?.removeEventListener('abort',stop);resolve();};
        const timer=setTimeout(stop,opts.pauseMs);opts.signal?.addEventListener('abort',stop,{once:true});
      });
    }
  } finally {try{if(locked)await session`SELECT pg_advisory_unlock(hashtext('mip:news-title-backfill'))`;}finally{session.release();}}
}
