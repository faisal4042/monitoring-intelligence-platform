/** Explicit atomic rollout of this release only. No seed, no historical migrations. */
import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const hashes = JSON.parse(await readFile(join(root, 'release-migrations.json'), 'utf8')) as Record<string,string>;
  const names = Object.keys(hashes).sort();
  const historical = (await readdir(join(root, 'migrations'))).filter(f=>f.endsWith('.sql')&&!names.includes(f));
  const files = new Map<string,string>();
  for (const name of names) {
    const bytes = await readFile(join(root, 'migrations', name));
    if (createHash('sha256').update(bytes).digest('hex')!==hashes[name]) throw new Error('Migration checksum mismatch');
    files.set(name,bytes.toString('utf8'));
  }
  const sql = postgres(process.env.DATABASE_URL, { max:1,onnotice:()=>{},connection:{application_name:'mip-approved-release-migrations'} });
  try {
    const applied = new Set((await sql<{name:string}[]>`SELECT name FROM public._migrations`).map(r=>r.name));
    if (historical.some(n=>!applied.has(n))) throw new Error('Historical migration missing: stop; never replay historical cleanup SQL automatically');
    if ([...applied].some(n=>!historical.includes(n)&&!names.includes(n))) throw new Error('Unknown migration ledger entry: stop for schema review');
    const pending = names.filter(n=>!applied.has(n));
    console.log(JSON.stringify({ pending, mode:process.argv.includes('--apply')?'apply':'read-only-plan' }));
    if (!process.argv.includes('--apply')) return;
    if (process.env.MIP_APPROVED_RELEASE_EXECUTION!=='true') throw new Error('Explicit execution approval flag required');
    await sql.begin(async tx=>{
      await tx`SET LOCAL lock_timeout='5s'`;
      await tx`SET LOCAL statement_timeout='10min'`;
      await tx`SELECT pg_advisory_xact_lock(hashtext('mip:approved-release-migrations'))`;
      const recorded = new Set((await tx<{name:string}[]>`SELECT name FROM public._migrations`).map(r=>r.name));
      for (const name of pending) {
        if (recorded.has(name)) continue;
        await tx.unsafe(files.get(name)!);
        await tx`INSERT INTO public._migrations(name) VALUES (${name})`;
      }
    });
    console.log(JSON.stringify({ status:'COMMITTED', migrations:pending }));
  } finally { await sql.end({timeout:5}); }
}
main().catch(()=>{console.error('Release migration preflight/apply failed; stop without restarting the app. No seed executed.');process.exitCode=1;});
