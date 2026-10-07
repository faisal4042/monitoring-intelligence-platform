/**
 * The integration tests' database: a separate `<name>_test` database on the
 * same local Postgres as development. Refuses anything that is not local and
 * not named *_test, so a test run can never touch a real database.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Reads one key from the repo's .env without loading @mip/config — that
 * module captures DATABASE_URL at import time, and it must not be imported
 * before the test URL is in place.
 */
function fromDotEnv(key: string): string | undefined {
  for (const file of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (line) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

export function testDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? fromDotEnv('DATABASE_URL');
  if (!base) throw new Error('DATABASE_URL is not set');
  const url = new URL(base);
  if (!process.env.TEST_DATABASE_URL && !url.pathname.endsWith('_test')) {
    url.pathname = `${url.pathname.replace(/^\//, '')}_test`;
  }
  assertSafe(url);
  return url.toString();
}

function assertSafe(url: URL) {
  const db = url.pathname.replace(/^\//, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`Refusing to run tests against non-local host ${url.hostname}`);
  }
  if (!db.endsWith('_test')) throw new Error(`Refusing to run tests against database "${db}" (must end with _test)`);
}
