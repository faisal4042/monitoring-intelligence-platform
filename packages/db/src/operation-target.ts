/** Deliberately imports no config, dotenv, or application database singleton. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Sql} from 'postgres';
import {assertCursorTestTarget} from './cursor-test-target.js';

export interface OperationTarget {
  mode: 'fixture' | 'operational'; url: string; database: string; systemIdentifier: string;
  databaseOid: string; marker?: string; approvalFile?: string;
}
export function validateTarget(target: OperationTarget) {
  if (!target.url || !target.database || !/^\d+$/.test(target.systemIdentifier) || !/^\d+$/.test(target.databaseOid)) throw new Error('Explicit database and server identity required');
  let url:URL;try{url=new URL(target.url);}catch{throw new Error('Invalid explicit target');}
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname !== '/' + target.database || url.hash || url.search) throw new Error('Invalid explicit target');
  if (target.mode === 'fixture') {
    assertCursorTestTarget(target.url, target.database);
    if (!target.marker) throw new Error('Fixture marker required');
  } else if (target.mode !== 'operational' || !target.approvalFile) throw new Error('Operational approval file required');
  return url;
}
export function targetConfirmation(target: OperationTarget, operation: string) {
  const url = validateTarget(target);
  return createHash('sha256').update(JSON.stringify({operation, host:url.hostname, port:url.port || '5432',
    database:target.database, systemIdentifier:target.systemIdentifier, databaseOid:target.databaseOid})).digest('hex');
}
export async function verifyTarget(sql: Sql, target: OperationTarget, operation: string, apply: boolean, confirmation?: string) {
  const url = validateTarget(target);
  if (apply && confirmation !== targetConfirmation(target, operation)) throw new Error('Explicit target confirmation required');
  if (target.mode === 'operational') {
    const approval = JSON.parse(await readFile(target.approvalFile!, 'utf8'));
    if (approval.version !== 1 || approval.operation !== operation || approval.confirmation !== targetConfirmation(target, operation) ||
      !approval.approvedBy || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now()) throw new Error('Operational approval invalid or expired');
    // A URL option cannot silently downgrade verification; the CLI supplies ssl:'verify-full'.
    const [tls] = await sql`SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()`;
    if (!tls?.ssl || url.hostname === '') throw new Error('Verified TLS required for operational target');
  }
  const [row] = await sql`SELECT current_database() AS database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier, pg_is_in_recovery() AS recovery`;
  if (row.database !== target.database || row.oid !== target.databaseOid || row.system_identifier !== target.systemIdentifier || row.recovery) throw new Error('Server/database identity mismatch or replica target');
  if (target.mode === 'fixture') {
    const rows = await sql`SELECT token FROM public.cursor_safety_fixture_marker`;
    if (rows.length !== 1 || rows[0].token !== target.marker) throw new Error('Fixture identity mismatch');
  }
}
export function operationTargetFromEnv(): OperationTarget {
  const mode = process.env.MIP_OPERATION_MODE;
  if (mode !== 'fixture' && mode !== 'operational') throw new Error('Explicit operation mode required');
  return {mode, url:process.env.DATABASE_URL ?? '', database:process.env.MIP_TARGET_DATABASE ?? '',
    systemIdentifier:process.env.MIP_TARGET_SYSTEM_IDENTIFIER ?? '', databaseOid:process.env.MIP_TARGET_DATABASE_OID ?? '',
    marker:process.env.CURSOR_TEST_MARKER, approvalFile:process.env.MIP_OPERATION_APPROVAL_FILE};
}
