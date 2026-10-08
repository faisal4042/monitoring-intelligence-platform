/**
 * Upgrade path 0035 → 0036 → 0037 → 0038 → 0039 on a database shaped like a develop
 * install: a separate local mip_upgrade_test, built up to 0035, filled with
 * queue data, then upgraded by the real migration runner. Proves no row is
 * lost or altered and that every new CHECK / FK / UNIQUE actually holds.
 */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sql} from './harness.js';
import {testDatabaseUrl} from './test-db.js';

const dbPkg=resolve(process.cwd(),'../../packages/db');
const migrations=resolve(dbPkg,'migrations');
const url=new URL(testDatabaseUrl());url.pathname='/mip_upgrade_test';
// Same guard as every test database: local host, *_test name.
assert.ok(['localhost','127.0.0.1','::1'].includes(url.hostname)&&url.pathname.endsWith('_test'));

// Same client type as @mip/db's (the test package has no direct postgres dependency).
type Sql=typeof sql;
let db:Sql;
const ids:Record<string,string>={};
const ORIGINAL=['id','interaction_type','post_id','post_posted_at','program_id','program_snapshot','team_id','status','assignee_id','version',
  'entered_at','first_assigned_at','assigned_at','first_started_at','completed_at','completed_by','last_escalated_at','resolution',
  'reassignment_count','escalation_count','updated_at','started_at','reopen_count','last_reopened_at'];
const fingerprint=async()=>{
  const cols=ORIGINAL.map(c=>`q.${c}`).join(',');
  const [r]=await db.unsafe(`SELECT
    (SELECT count(*)||':'||md5(string_agg(row_to_json(x)::text,',' ORDER BY x.id)) FROM (SELECT ${cols} FROM queue_items q) x) AS items,
    (SELECT count(*)||':'||md5(string_agg(row_to_json(e)::text,',' ORDER BY e.id)) FROM queue_events e) AS events,
    (SELECT count(*)||':'||md5(string_agg(row_to_json(n)::text,',' ORDER BY n.id)) FROM queue_notes n) AS notes,
    (SELECT count(*)||':'||md5(string_agg(row_to_json(t)::text,',' ORDER BY t.id)) FROM team_members t) AS members,
    (SELECT md5(string_agg(id||':'||role_id||':'||is_active||':'||password_hash,',' ORDER BY id)) FROM users) AS users`);
  return r;
};
const runner=()=>spawnSync('pnpm run push',{cwd:dbPkg,env:{...process.env,DATABASE_URL:url.toString()},shell:true,encoding:'utf8'});
// Each statement is its own implicit transaction, so a rejected one leaves nothing behind.
async function rejects(code:string,statement:()=>Promise<unknown>) {
  await assert.rejects(statement,(e:{code?:string})=>e.code===code,`expected SQLSTATE ${code}`);
}

before(async()=>{
  await sql.unsafe('DROP DATABASE IF EXISTS mip_upgrade_test WITH (FORCE)');
  await sql.unsafe('CREATE DATABASE mip_upgrade_test');
  // The test package does not depend on postgres directly; use the db package's copy.
  const {default:postgres}=await import(pathToFileURL(createRequire(resolve(dbPkg,'package.json')).resolve('postgres')).href);
  // max 1 like the real runner: some migrations carry their own BEGIN/COMMIT.
  db=postgres(url.toString(),{max:1,onnotice:()=>{}});
  // Build exactly what a develop install had: every migration through 0035, recorded like the runner does.
  await db`CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()){
    if(file>'0035_queue_work_cycles.sql')break;
    await db.unsafe(await readFile(resolve(migrations,file),'utf8'));
    await db`INSERT INTO _migrations(name) VALUES (${file})`;
  }
  // Queue data as 0035 knows it: assigned, in-progress (reassigned), completed-then-reopened, plus notes.
  const [role]=await db`INSERT INTO roles(key,name_ar,name_en) VALUES ('agent','موظف','Agent') ON CONFLICT (key) DO UPDATE SET name_ar=EXCLUDED.name_ar RETURNING id`;
  for(const n of ['a','b']){
    const [u]=await db`INSERT INTO users(email,full_name,password_hash,role_id) VALUES (${'up-'+n+'@mip.test'},${'U '+n},${'$argon2id$x'+n},${role.id}) RETURNING id`;
    ids[n]=u.id;
  }
  const [p]=await db`INSERT INTO programs(key,name_ar,name_en) VALUES ('up-prog','برنامج','Program') RETURNING id`;
  const [t]=await db`INSERT INTO teams(name) VALUES ('فريق الترقية') RETURNING id`;
  await db`INSERT INTO team_programs(team_id,program_id) VALUES (${t.id},${p.id})`;
  for(const u of [ids.a,ids.b])await db`INSERT INTO team_members(team_id,user_id,kind) VALUES (${t.id},${u},'agent')`;
  ids.team=t.id;ids.program=p.id;
  const snap=JSON.stringify({id:p.id,key:'up-prog',name:'برنامج',color:'#000'});
  const item=async(status:string,assignee:string|null,extra='')=>{
    const [q]=await db.unsafe(`INSERT INTO queue_items(post_id,post_posted_at,program_id,program_snapshot,team_id,status,assignee_id,version${extra?','+extra.split('=')[0]:''})
      VALUES (gen_random_uuid(),now(),$1,$2::jsonb,$3,$4,$5,3${extra?','+extra.split('=')[1]:''}) RETURNING id`,[p.id,snap,t.id,status,assignee]);
    for(const [v,type,to] of [[1,'created','new'],[2,'assigned','assigned'],[3,status==='in_progress'?'started':'assigned',status]] as const)
      await db`INSERT INTO queue_events(queue_item_id,event_type,to_status,to_assignee,version) VALUES (${q.id},${type},${to},${assignee},${v})`;
    return q.id as string;
  };
  ids.assigned=await item('assigned',ids.a);
  ids.working=await item('in_progress',ids.b,'reopen_count=1');
  await db`INSERT INTO queue_notes(queue_item_id,author_id,body) VALUES (${ids.working},${ids.b},'ملاحظة قبل الترقية')`;
});
after(async()=>{await db?.end({timeout:5});await sql.unsafe('DROP DATABASE IF EXISTS mip_upgrade_test WITH (FORCE)');await sql.end({timeout:5});});

test('the real runner upgrades 0035 → 0039 without losing or altering a row',async()=>{
  const before=await fingerprint();
  const r=runner();
  assert.equal(r.status,0,r.stderr+r.stdout);
  assert.match(r.stdout,/skip\s+0035_queue_work_cycles\.sql/);
  assert.match(r.stdout,/apply 0036_unified_queue_sections\.sql \.\.\. ok/);
  assert.match(r.stdout,/apply 0037_queue_team_transfer\.sql \.\.\. ok/);
  assert.match(r.stdout,/apply 0038_queue_reviews\.sql \.\.\. ok/);
  assert.match(r.stdout,/apply 0039_dashboard_preferences\.sql \.\.\. ok/);
  assert.deepEqual(await fingerprint(),before);
  const applied=(await db<{name:string}[]>`SELECT name FROM _migrations WHERE name>='0035' ORDER BY applied_at,name`).map(m=>m.name);
  assert.deepEqual(applied,['0035_queue_work_cycles.sql','0036_unified_queue_sections.sql','0037_queue_team_transfer.sql','0038_queue_reviews.sql','0039_dashboard_preferences.sql']);
  // Existing items get the defaults and nothing else.
  const rows=await db`SELECT section,section_hold,story_id,story_snapshot,story_item_id,merged_into_id FROM queue_items`;
  for(const row of rows)assert.deepEqual({...row},{section:'general',section_hold:null,story_id:null,story_snapshot:null,story_item_id:null,merged_into_id:null});
  // Idempotent: a second start applies nothing.
  const again=runner();assert.equal(again.status,0);assert.match(again.stdout,/already up to date/);
  assert.deepEqual(await fingerprint(),before);
});

test('every new constraint holds: CHECK, FK and UNIQUE',async()=>{
  const snap=JSON.stringify({id:ids.program,key:'up-prog',name:'برنامج',color:'#000'});
  const story=JSON.stringify({title:'قصة'});
  const insert=(cols:string,vals:string,params:Array<string|Date>)=>db.unsafe(`INSERT INTO queue_items(program_id,program_snapshot,team_id,${cols}) VALUES ($1,$2::jsonb,$3,${vals}) RETURNING id`,[ids.program,snap,ids.team,...params]);
  // Shape: a post item always has its post; a story unit always has story + snapshot and no post.
  await rejects('23514',()=>insert('interaction_type','$4',['post']));
  await rejects('23514',()=>insert('interaction_type,story_id,section','$4,gen_random_uuid(),$5',['story','story']));
  await rejects('23514',()=>insert('interaction_type,story_id,story_snapshot,section,post_id,post_posted_at','$4,gen_random_uuid(),$5::jsonb,$6,gen_random_uuid(),now()',['story',story,'story']));
  await rejects('23514',()=>insert('interaction_type,story_id,story_snapshot,section','$4,gen_random_uuid(),$5::jsonb,$6',['story',story,'general']));
  await rejects('23514',()=>insert('interaction_type','$4',['tweet']));
  // A post in the story section must point at a unit, and only then.
  await rejects('23514',()=>insert('post_id,post_posted_at,section','gen_random_uuid(),now(),$4',['story']));
  await rejects('23514',()=>insert('post_id,post_posted_at,section','gen_random_uuid(),now(),$4',['elsewhere']));
  await rejects('23514',()=>insert('post_id,post_posted_at,section_hold','gen_random_uuid(),now(),$4',['nowhere']));
  // FKs.
  await rejects('23503',()=>insert('post_id,post_posted_at,section,story_item_id','gen_random_uuid(),now(),$4,gen_random_uuid()',['story']));
  // One unit per story; one item per post.
  const storyId=crypto.randomUUID();
  const [unit]=await insert('interaction_type,story_id,story_snapshot,section','$4,$5,$6::jsonb,$7',['story',storyId,story,'story']);
  await rejects('23505',()=>insert('interaction_type,story_id,story_snapshot,section','$4,$5,$6::jsonb,$7',['story',storyId,story,'story']));
  const [post]=await db`SELECT post_id,post_posted_at FROM queue_items WHERE id=${ids.assigned}`;
  await rejects('23505',()=>insert('post_id,post_posted_at','$4,$5',[post.post_id,post.post_posted_at]));
  // A valid member item and a valid merge reference are accepted.
  const [member]=await insert('post_id,post_posted_at,section,story_item_id','gen_random_uuid(),now(),$4,$5',['story',unit.id]);
  assert.ok(member.id);
  await rejects('23514',()=>db`UPDATE queue_items SET merged_into_id=${unit.id} WHERE id=${member.id}`);
  // Events: the new types are accepted, unknown ones are not, history stays append-only.
  for(const type of ['section_changed','section_review','story_merged','transferred'])
    await db`INSERT INTO queue_events(queue_item_id,event_type,to_status,version) VALUES (${unit.id},${type},'new',${100+['section_changed','section_review','story_merged','transferred'].indexOf(type)})`;
  await rejects('23514',()=>db`INSERT INTO queue_events(queue_item_id,event_type,to_status,version) VALUES (${unit.id},'teleported','new',200)`);
  await rejects('23514',()=>db`UPDATE queue_events SET reason='x' WHERE queue_item_id=${ids.assigned}`);
  await rejects('23514',()=>db`DELETE FROM queue_notes`);
  // Alerts: one arrival per item and kind, one alert per event, real users only, bounded prefs.
  const [e1]=await db`SELECT id FROM queue_events WHERE queue_item_id=${unit.id} AND event_type='section_changed'`;
  const [e2]=await db`SELECT id FROM queue_events WHERE queue_item_id=${unit.id} AND event_type='section_review'`;
  const [a1]=await db`INSERT INTO queue_alerts(kind,queue_item_id,queue_event_id,section) VALUES ('story',${unit.id},${e1.id},'story') RETURNING id`;
  await rejects('23505',()=>db`INSERT INTO queue_alerts(kind,queue_item_id,queue_event_id,section) VALUES ('story',${unit.id},${e2.id},'story')`);
  await rejects('23505',()=>db`INSERT INTO queue_alerts(kind,queue_item_id,queue_event_id,section) VALUES ('assigned',${unit.id},${e1.id},'story')`);
  await rejects('23514',()=>db`INSERT INTO queue_alerts(kind,queue_item_id,queue_event_id,section) VALUES ('assigned',${unit.id},${e2.id},'general')`);
  await rejects('23503',()=>db`INSERT INTO queue_alert_recipients(alert_id,user_id) VALUES (${a1.id},gen_random_uuid())`);
  await db`INSERT INTO queue_alert_recipients(alert_id,user_id) VALUES (${a1.id},${ids.a})`;
  await rejects('23505',()=>db`INSERT INTO queue_alert_recipients(alert_id,user_id) VALUES (${a1.id},${ids.a})`);
  await rejects('23514',()=>db`INSERT INTO queue_alert_prefs(user_id,volume) VALUES (${ids.a},1.5)`);
});
