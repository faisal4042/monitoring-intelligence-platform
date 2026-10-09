/** Read-only, snapshot-consistent inventories and SHA-256 multisets of every row.
 * Never emits raw data. Restores/upgrades project the original columns so additive
 * schema changes do not conceal edits to historical fields. */
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';

type Table = { schema: string; name: string; columns: string[]; rows: number; sha256: string; file: string };
type Manifest = { tables: Table[]; constraints: unknown[]; migrations: string[]; database: string };
type ForeignKey = { schema: string; table_name: string; name: string; definition: string; validated: boolean };
const [mode, outputArg, baselineArg] = process.argv.slice(2);
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const additions = new Set(['public._migrations', 'public.roles', 'public.permissions', 'public.role_permissions', 'public.settings']);

async function compareRows(oldPath: string, newPath: string, allowAdditions: boolean) {
  const oldLines = createInterface({ input: createReadStream(oldPath), crlfDelay: Infinity });
  const newLines = createInterface({ input: createReadStream(newPath), crlfDelay: Infinity });
  const oldIt = oldLines[Symbol.asyncIterator]();
  const newIt = newLines[Symbol.asyncIterator]();
  try {
    let a = await oldIt.next();
    let b = await newIt.next();
    while (!a.done) {
      if (b.done || b.value > a.value) throw new Error('Historical row deleted or changed');
      if (b.value < a.value) {
        if (!allowAdditions) throw new Error('Unexpected added row');
        b = await newIt.next();
        continue;
      }
      a = await oldIt.next(); b = await newIt.next();
    }
    if (!b.done && !allowAdditions) throw new Error('Unexpected added row');
  } finally { oldLines.close(); newLines.close(); }
}

async function main() {
  if (!['capture', 'verify'].includes(mode) || !outputArg || (mode === 'verify' && !baselineArg)) {
    throw new Error('Usage: data-integrity.ts capture OUTPUT | verify OUTPUT BASELINE');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const output = resolve(outputArg);
  const baseline = baselineArg ? JSON.parse(await readFile(join(resolve(baselineArg), 'manifest.json'), 'utf8')) as Manifest : null;
  await mkdir(output); // Exclusive destination; never overwrite an earlier inventory.
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {},
    connection: { default_transaction_read_only: true, TimeZone: 'UTC', DateStyle: 'ISO,YMD' } });
  try {
    const manifest = await sql.begin('isolation level repeatable read read only', async tx => {
      const snapshot = process.env.MIP_BACKUP_SNAPSHOT;
      if (snapshot) {
        if (!/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/.test(snapshot)) throw new Error('Invalid snapshot');
        await tx.unsafe(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
      }
      const [{ database }] = await tx<{ database: string }[]>`SELECT current_database() AS database`;
      const inventory = await tx<{ schema: string; name: string }[]>`
        SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','internal') AND c.relkind IN ('r','p') AND NOT c.relispartition
        ORDER BY n.nspname,c.relname`;
      const tables: Table[] = [];
      const selected = baseline?.tables ?? inventory;
      for (const table of selected) {
        if (!inventory.some(t => t.schema === table.schema && t.name === table.name)) throw new Error('Original table missing');
        const columns = 'columns' in table ? table.columns : (await tx<{ name: string }[]>`
          SELECT a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${table.schema} AND c.relname=${table.name}
          AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`).map(c => c.name);
        const file = `${tables.length.toString().padStart(4, '0')}.rows.sha256`;
        const stream = createWriteStream(join(output, file), { flags: 'wx', mode: 0o600 });
        const hash = createHash('sha256');
        let rows = 0;
        // Only hashes cross the connection; sorting preserves duplicate multiplicity.
        const query = `SELECT hash FROM (SELECT encode(digest(row_to_json(t)::text,'sha256'),'hex') AS hash FROM
          (SELECT ${columns.map(quote).join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) t) h ORDER BY hash COLLATE "C"`;
        try {
          for await (const batch of tx.unsafe(query).cursor(1000)) {
            for (const row of batch) {
              const line = `${row.hash}\n`;
              hash.update(line); rows++;
              if (!stream.write(line)) await once(stream, 'drain');
            }
          }
          stream.end(); await once(stream, 'finish');
        } catch (err) { stream.destroy(); throw err; }
        tables.push({ schema: table.schema, name: table.name, columns, rows, sha256: hash.digest('hex'), file });
      }
      const constraints = await tx<ForeignKey[]>`SELECT n.nspname AS schema,c.relname AS table_name,k.conname AS name,
        pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated FROM pg_constraint k
        JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE k.contype='f' AND n.nspname IN ('public','internal') AND NOT c.relispartition ORDER BY 1,2,3`;
      const migrations = (await tx<{ name: string }[]>`SELECT name FROM public._migrations ORDER BY name`).map(r => r.name);
      return { database, tables, constraints, migrations };
    });
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    if (baseline) {
      for (const table of baseline.tables) {
        const current = manifest.tables.find(t => t.schema === table.schema && t.name === table.name)!;
        await compareRows(join(resolve(baselineArg!), table.file), join(output, current.file),
          process.env.MIP_ALLOW_ADDITIVE_METADATA === 'true' && additions.has(`${table.schema}.${table.name}`));
      }
      for (const fk of baseline.constraints as { schema: string; table_name: string; name: string; definition: string; validated: boolean }[]) {
        if (!(manifest.constraints as typeof fk[]).some(x => x.schema===fk.schema && x.table_name===fk.table_name &&
          x.name===fk.name && x.definition===fk.definition && x.validated===fk.validated)) throw new Error('Original foreign key changed or missing');
      }
    }
    console.log(JSON.stringify({ status: baseline ? 'VERIFIED' : 'CAPTURED', tables: manifest.tables.length,
      rows: manifest.tables.reduce((n,t) => n+t.rows,0) }));
  } finally { await sql.end({ timeout: 5 }); }
}
main().catch(() => { console.error('Integrity check FAILED; no data values emitted.'); process.exitCode=1; });
