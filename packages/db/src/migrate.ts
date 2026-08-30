/**
 * Applies migrations/*.sql in filename order. Raw SQL rather than generated
 * DDL because the schema needs partitioning, pgvector and partial indexes
 * that a schema-diff tool cannot express.
 */
import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@mip/config';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main() {
  const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => {} });

  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    process.stdout.write(`  apply ${file} ... `);
    const text = await readFile(join(dir, file), 'utf8');
    await sql.unsafe(text);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    console.log('ok');
    count++;
  }

  console.log(count ? `\n${count} migration(s) applied.` : '\nDatabase already up to date.');
  await sql.end();
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
