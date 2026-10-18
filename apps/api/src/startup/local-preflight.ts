import {randomUUID} from 'node:crypto';
import type {sql as databaseSql} from '@mip/db';
import {createWorkerLeaseClient} from '@mip/db';
import {WorkerOwnership} from './worker-ownership.js';
type Sql = typeof databaseSql;
/** Separate local startup guard: no fixture/operational migration guard is changed. */
export async function verifyLocalStartup(sql: Sql, rawUrl: string, env: NodeJS.ProcessEnv) {
  const u = new URL(rawUrl);
  if(!['postgres:','postgresql:'].includes(u.protocol) || u.hostname!=='127.0.0.1' || u.search || u.hash ||
    Object.keys(env).some(k=>k.startsWith('COOLIFY_') && env[k]) || env.NODE_ENV==='production') throw new Error('Refusing non-local transition target');
  const fixture = env.NODE_ENV==='test';
  if(fixture ? !(u.pathname==='/mip_cursor_startup_pre_test'||u.pathname==='/mip_cursor_startup_post_test') || u.port!=='5453'
    : u.pathname!=='/mip' || u.port!=='5433') throw new Error('Unapproved local startup target');
  const [id] = await sql`SELECT current_database() AS name, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system, pg_is_in_recovery() AS recovery`;
  if(id.recovery) throw new Error('Recovery server is not approved');
  if(fixture) {
    const [marker] = await sql`SELECT token FROM cursor_safety_fixture_marker`;
    if(!env.MIP_STARTUP_FIXTURE_MARKER || marker.token!==env.MIP_STARTUP_FIXTURE_MARKER || id.system!==env.MIP_STARTUP_FIXTURE_SYSTEM)
      throw new Error('Fixture identity mismatch');
  } else if(id.name!=='mip'||id.oid!=='16384'||id.system!=='7678829486367178790') throw new Error('Local identity mismatch');
}
export async function acquireWorkerLease(sql: Sql, options: {
  ownerId?:string; gate?: WorkerOwnership; onLost?: (reason: unknown) => void;
  intervalMs?: number; timeoutMs?: number;
  socket?: () => Promise<import('node:net').Socket>;
} = {}) {
  const ownerId=options.ownerId??randomUUID();
  const gate = options.gate ?? new WorkerOwnership();
  let closing = false, timer: ReturnType<typeof setInterval> | undefined;
  const lose = (reason: unknown) => {
    if (closing || !gate.lose(reason)) return;
    clearInterval(timer);
    // Latch and abort synchronously before notifying asynchronous shutdown code.
    queueMicrotask(() => options.onLost?.(reason));
  };
  const client = createWorkerLeaseClient(() => lose(new Error('Lease PostgreSQL connection closed')), options.socket,ownerId);
  let owner: Awaited<ReturnType<typeof client.reserve>> | undefined;
  let flight: Promise<void> | undefined;
  let pid = 0, session = '',epoch='';
  async function inspect() {
    const [r] = await owner!`SELECT pg_backend_pid() AS pid,
      (SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS session,
      EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=((hashtext('mip:local-transition-workers')::bigint >> 32) & 4294967295)::oid
        AND objid=(hashtext('mip:local-transition-workers')::bigint & 4294967295)::oid AND objsubid=1) AS owned`;
    const [f]=await owner!`SELECT owner_id::text AS owner,epoch::text,state FROM mip_fencing.lease WHERE singleton`;
    if(f.owner!==ownerId||f.epoch!==epoch||f.state!=='active')throw new Error('Fence generation lost');
    if (Number(r.pid) !== pid || r.session !== session || !r.owned) throw new Error('Lease session changed or advisory lock ownership lost');
  }
  const check = (): Promise<void> => {
    try { gate.assertActive(); } catch (error) { return Promise.reject(error); }
    if (flight) return flight;
    flight = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([inspect(),new Promise<never>((_,reject) => {
          timeout=setTimeout(() => reject(new Error('Lease ownership monitor timed out')),options.timeoutMs ?? 1000);
        })]);
        gate.assertActive();
      } catch (error) { lose(error); throw error; }
      finally { clearTimeout(timeout); flight=undefined; }
    })();
    return flight;
  };
  try {
    const [schema]=await sql`SELECT to_regclass('mip_fencing.lease') IS NOT NULL AS ready`;
    if(!schema.ready)throw new Error('FENCE_SCHEMA_NOT_READY');
    const [unsupported]=await sql`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='f'`;
    if(unsupported.n)throw new Error('FENCE_UNSUPPORTED_FOREIGN_TABLE');
    const [protocol]=await sql`SELECT version FROM mip_fencing.protocol`;
    if(protocol?.version!==1)throw new Error('FENCE_PROTOCOL_VERSION_MISMATCH');
    const [control]=await sql`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mip_fencing' AND t.tgname IN ('mip_fence_control_row','mip_fence_control_truncate') AND t.tgenabled='A'`;
    if(control.n!==6)throw new Error('FENCE_CONTROL_COVERAGE_INCOMPLETE');
    const [event]=await sql`SELECT evtenabled FROM pg_event_trigger WHERE evtname='mip_fence_new_tables'`;
    if(event?.evtenabled!=='O')throw new Error('FENCE_EVENT_GUARD_MISSING');
    const uncovered=await sql`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS(
       SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='mip_fence_statement' AND t.tgenabled='A'
       AND t.tgfoid='mip_fencing.guard_write()'::regprocedure)`;
    if(uncovered.length)throw new Error('FENCE_COVERAGE_INCOMPLETE');
    owner = await client.reserve();
    const [r] = await owner`SELECT pg_try_advisory_lock(hashtext('mip:local-transition-workers')) AS acquired,
      pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS session`;
    if (!r.acquired) throw new Error('Another transitional worker owner exists');
    pid=Number(r.pid);session=r.session;
    await owner`BEGIN`;
    try{
      await owner`SET LOCAL lock_timeout='5s'`;
      const [f]=await owner`SELECT mip_fencing.activate(${ownerId}::uuid)::text AS epoch`;
      epoch=f.epoch;await owner`COMMIT`;
    }catch(error){await owner`ROLLBACK`.catch(()=>{});throw error;}
    gate.activate();gate.verify=check;
    await check();
    timer=setInterval(() => { void check().catch(() => {}); },options.intervalMs ?? 250); timer.unref();
    let stopped: Promise<void> | undefined;
    const release = () => stopped ??= (async () => {
      closing=true;clearInterval(timer);await flight?.catch(() => {});
      try {
        if (gate.state !== 'lost') {
          await inspect();
          await owner!`SELECT mip_fencing.retire(${ownerId}::uuid,${epoch}::bigint)`;
          await owner!`SELECT pg_advisory_unlock(hashtext('mip:local-transition-workers'))`;
        }
      } finally { gate.close(); owner?.release(); await client.end({timeout:1}); }
    })();
    return Object.assign(release,{gate,check,pid,ownerId,epoch});
  } catch (error) {
    closing=true;clearInterval(timer);gate.lose(error);owner?.release();await client.end({timeout:1});throw error;
  }
}
