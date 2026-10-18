import type postgres from 'postgres';
/** Aggregates are calculated inside PostgreSQL; no records, credentials, or password hashes leave the server. */
export async function dataSnapshot(sql:postgres.Sql|postgres.TransactionSql) {
  const relations=await sql`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname`;
  const tables:Record<string,{count:number;sha256:string}>={};
  for(const {name} of relations){
    const quoted='"'+String(name).replaceAll('"','""')+'"';
    const [row]=await sql.unsafe(`SELECT count(*)::text AS count,encode(digest(COALESCE(string_agg(row,E'\\n' ORDER BY row),''),'sha256'),'hex') AS sha256
      FROM (SELECT row_to_json(t)::text AS row FROM public.${quoted} t) rows`);
    tables[String(name)]={count:Number(row.count),sha256:row.sha256};
  }
  return tables;
}
