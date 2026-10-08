import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {call,createUser,login,makeApp,sql,type App} from './harness.js';
import {intakeQueue} from '../workers/queue-intake.worker.js';

let app:App;let admin:string,sup:string,sup2:string,agent:string,other:string,viewer:string,analyst:string;
let adminId:string,agentId:string,otherId:string,supId:string;
let team:string,team2:string,program:string,program2:string;
const now=new Date();const stamp=now.toISOString();
const base='/api/v1/queue';
const post=async(intent='inquiry',extra:{program?:string;redacted?:boolean;status?:string;collected?:string;relevance?:string;duplicate?:boolean}={})=>{
  const id=crypto.randomUUID();
  await sql`INSERT INTO posts(id,x_post_id,x_author_id,text,text_normalized,posted_at,collected_at,content_hash,is_redacted,status,duplicate_of_id)
    VALUES (${id},${id},'queue-test','Queue test interaction','queue test interaction',${stamp},${extra.collected??stamp},'\\x00',
      ${extra.redacted??false},${extra.status??'classified'},${extra.duplicate?crypto.randomUUID():null})`;
  await sql`INSERT INTO post_classifications(post_id,posted_at,relevance,intent,program_id,stage)
    VALUES (${id},${stamp},${extra.relevance??'relevant'},${intent},${extra.program??program},1)`;
  return id;
};
const add=async(postId:string,token=admin)=>call(app,token,'POST',base+'/items',{postId,postedAt:stamp});
const mutate=async(token:string,item:{id:string;version:number},action:string,extra:object={})=>call(app,token,'POST',`${base}/items/${item.id}/${action}`,{expectedVersion:item.version,...extra});
const ok=(res:Awaited<ReturnType<typeof call>>,code=200)=>{assert.equal(res.statusCode,code,res.body);return res.json();};

before(async()=>{
  app=await makeApp();
  const tokens:Record<string,string>={};const ids:Record<string,string>={};
  for(const role of ['admin','supervisor','agent','viewer','analyst']){const u=await createUser(role);tokens[role]=(await login(app,u.email)).accessToken;ids[role]=u.id;}
  admin=tokens.admin;sup=tokens.supervisor;agent=tokens.agent;viewer=tokens.viewer;analyst=tokens.analyst;
  adminId=ids.admin;agentId=ids.agent;supId=ids.supervisor;
  const o=await createUser('agent');otherId=o.id;other=(await login(app,o.email)).accessToken;
  const s=await createUser('supervisor');sup2=(await login(app,s.email)).accessToken;
  // Independent programs/teams prevent unrelated fixture data from entering intake.
  for(const n of [1,2]){
    const [p]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},${'Queue Test '+n},${'Queue Test '+n}) RETURNING id`;
    const t=ok(await call(app,admin,'POST','/api/v1/teams',{name:'Queue Test '+crypto.randomUUID()}),201).id;
    ok(await call(app,admin,'PUT',`/api/v1/teams/${t}/programs`,{programIds:[p.id]}));
    if(n===1){program=p.id;team=t;}else{program2=p.id;team2=t;}
  }
  for(const [id,t] of [[agentId,team],[otherId,team2],[supId,team],[s.id,team]])ok(await call(app,admin,'POST',`/api/v1/teams/${t}/members`,{userId:id}));
});
after(async()=>{
  await sql`UPDATE settings SET value='false'::jsonb WHERE key='queue.intake_enabled'`;
  await sql`UPDATE settings SET value='null'::jsonb WHERE key='queue.intake_starts_at'`;
  await app.close();await sql.end({timeout:5});
});

test('migration only adds queue objects/settings; initial rollout evidence has no intake/backfill',async()=>{
  const source=await readFile(new URL('../../../../packages/db/migrations/0034_monitoring_queue.sql',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:DROP|TRUNCATE)\s|\bUPDATE\s+(?:posts|users)|\bINSERT\s+INTO\s+queue_items/i);
  const settings=ok(await call(app,admin,'GET',base+'/intake-settings'));assert.equal(settings.enabled,false);assert.equal(settings.startsAt,null);
  const id=await post();const before=await sql`SELECT count(*)::int AS n FROM queue_items`;
  assert.equal((await intakeQueue()).created,0);assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items`)[0].n,before[0].n);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items WHERE post_id=${id}`)[0].n,0);
});
test('manual add, program snapshot, audit, unique protection, forbidden and out-of-team IDs',async()=>{
  const id=await post();const item=ok(await add(id,sup),201);
  assert.equal(item.program_id,program);assert.equal(item.team_id,team);assert.ok(item.program_snapshot.name);
  assert.equal((await add(id)).statusCode,409);
  assert.equal((await add(await post('inquiry',{program:program2}),sup)).statusCode,404);
  assert.equal((await add(await post(),agent)).statusCode,403);
  assert.equal((await add(crypto.randomUUID())).statusCode,404);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='queue.manual_add' AND entity_id=${item.id}`)[0].n,1);
  assert.deepEqual((await sql`SELECT event_type FROM queue_events WHERE queue_item_id=${item.id}`).map(e=>e.event_type),['created']);
});
test('intake boundary, intents, exclusions, idempotency, concurrent/manual race',async()=>{
  const boundary=new Date(Date.now()+1000).toISOString();
  ok(await call(app,admin,'PUT',base+'/intake-settings',{enabled:true,startsAt:boundary}));
  const eligible=[await post('inquiry',{collected:boundary}),await post('complaint',{collected:boundary})];
  const excluded=[await post('praise',{collected:boundary}),await post('inquiry',{collected:boundary,relevance:'irrelevant'}),
    await post('inquiry',{collected:boundary,redacted:true}),await post('inquiry',{collected:boundary,status:'filtered_out'}),
    await post('inquiry',{collected:boundary,status:'duplicate'}),await post('inquiry',{collected:boundary,duplicate:true}),
    await post('inquiry',{collected:new Date(Date.parse(boundary)-1).toISOString()})];
  const race=await post('complaint',{collected:boundary});
  const results=await Promise.all([intakeQueue(),intakeQueue(),add(race)]);
  assert.ok([201,409].includes((results[2] as Awaited<ReturnType<typeof call>>).statusCode));
  await intakeQueue();
  for(const id of [...eligible,race])assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items WHERE post_id=${id}`)[0].n,1);
  for(const id of excluded)assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items WHERE post_id=${id}`)[0].n,0);
  assert.equal((await intakeQueue()).created,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items q LEFT JOIN queue_events e ON e.queue_item_id=q.id AND e.event_type='created' WHERE e.id IS NULL`)[0].n,0);
  assert.equal((await call(app,admin,'PUT',base+'/intake-settings',{enabled:true,startsAt:'2020-01-01T00:00:00Z'})).statusCode,400);
  assert.equal((await call(app,sup,'PUT',base+'/intake-settings',{enabled:false,startsAt:boundary})).statusCode,403);
  ok(await call(app,admin,'PUT',base+'/intake-settings',{enabled:false,startsAt:boundary}));
});
test('queue RBAC SQL scopes; item, notes, events and filtered IDs cannot bypass ownership',async()=>{
  const a=ok(await add(await post()),201);const b=ok(await add(await post('inquiry',{program:program2})),201);
  const assigned=ok(await mutate(sup,a,'assign',{assigneeId:agentId}));
  for(const token of [viewer,analyst]){
    assert.equal((await call(app,token,'GET',base+'/items')).statusCode,403);
    assert.equal((await call(app,token,'GET',`${base}/items/${a.id}`)).statusCode,403);
  }
  assert.equal((await call(app,agent,'GET',`${base}/items/${b.id}`)).statusCode,404);
  assert.equal((await call(app,other,'GET',`${base}/items/${a.id}`)).statusCode,404);
  assert.equal((await call(app,sup,'GET',`${base}/items/${b.id}`)).statusCode,404);
  assert.equal((await mutate(agent,b,'notes',{body:'outside'})).statusCode,404);
  assert.equal((await mutate(agent,assigned,'assign',{assigneeId:agentId})).statusCode,403);
  const list=ok(await call(app,agent,'GET',base+`/items?range=all&teamId=${team2}`));assert.equal(list.items.length,0);
  ok(await call(app,admin,'GET',`${base}/items/${b.id}`));
});
test('optimistic concurrent assignment succeeds once; stale version and invalid transition 409',async()=>{
  const item=ok(await add(await post()),201);
  const res=await Promise.all([mutate(sup,item,'assign',{assigneeId:agentId}),mutate(sup2,item,'assign',{assigneeId:agentId})]);
  assert.deepEqual(res.map(r=>r.statusCode).sort(),[200,409]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=${item.id} AND event_type='assigned'`)[0].n,1);
  const assigned=ok(res.find(r=>r.statusCode===200)!);
  assert.equal((await mutate(agent,assigned,'complete',{resolution:'handled'})).statusCode,409);
  assert.equal((await mutate(sup,assigned,'start')).statusCode,403);
  assert.equal((await mutate(agent,assigned,'start',{unexpected:true})).statusCode,400);
  assert.equal((await mutate(agent,item,'start')).statusCode,409);
});
test('explicit start, append-only notes, escalation, deescalation, completion, reopen and historical cycles',async()=>{
  let item=ok(await add(await post()),201);
  item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));
  const detail=ok(await call(app,agent,'GET',`${base}/items/${item.id}`));assert.equal(detail.status,'assigned');assert.equal(detail.first_started_at,null);
  item=ok(await mutate(agent,item,'start'));const started=item.first_started_at;
  item=ok(await mutate(agent,item,'notes',{body:'Internal note only'}));
  const [note]=await sql`SELECT id FROM queue_notes WHERE queue_item_id=${item.id}`;
  const [event]=await sql`SELECT * FROM queue_events WHERE queue_item_id=${item.id} AND event_type='note_added'`;
  assert.doesNotMatch(JSON.stringify(event),/Internal note only/);
  await assert.rejects(sql`UPDATE queue_notes SET body='changed' WHERE id=${note.id}`);
  await assert.rejects(sql`DELETE FROM queue_notes WHERE id=${note.id}`);
  await assert.rejects(sql`UPDATE queue_events SET reason='changed' WHERE id=${event.id}`);
  await assert.rejects(sql`DELETE FROM queue_events WHERE id=${event.id}`);
  assert.equal((await mutate(agent,item,'escalate',{})).statusCode,400);
  item=ok(await mutate(agent,item,'escalate',{reason:'Needs supervisor'}));
  assert.equal((await mutate(agent,item,'complete',{resolution:'handled'})).statusCode,409);
  item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));
  item=ok(await mutate(agent,item,'start'));
  assert.equal((await mutate(agent,item,'complete')).statusCode,400);
  item=ok(await mutate(agent,item,'complete',{resolution:'handled'}));const completed=item.completed_at;
  assert.equal((await mutate(agent,item,'reopen')).statusCode,403);
  const history=ok(await call(app,agent,'GET',base+'/items?view=completed&range=all'));assert.ok(history.items.some((i:{id:string})=>i.id===item.id));
  assert.equal((await call(app,other,'GET',`${base}/items/${item.id}`)).statusCode,404);
  assert.ok(!ok(await call(app,agent,'GET',base+'/items?range=all')).items.some((i:{id:string})=>i.id===item.id));
  item=ok(await mutate(sup,item,'reopen'));assert.equal(item.status,'in_progress');assert.equal(item.completed_at,completed);assert.equal(item.first_started_at,started);
  item=ok(await mutate(agent,item,'complete',{resolution:'no_action_needed'}));
  const events=await sql`SELECT event_type,resolution FROM queue_events WHERE queue_item_id=${item.id} ORDER BY version`;
  assert.equal(events.filter(e=>e.event_type==='completed').length,2);
  assert.deepEqual(events.filter(e=>e.event_type==='completed').map(e=>e.resolution),['handled','no_action_needed']);
});
test('unassign and reassign maintain first assignment and count exact reassigned events',async()=>{
  const a=await createUser('agent');ok(await call(app,admin,'POST',`/api/v1/teams/${team}/members`,{userId:a.id}));
  let item=ok(await add(await post()),201);item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));const first=item.first_assigned_at;
  item=ok(await mutate(sup,item,'assign',{assigneeId:a.id}));assert.equal(item.reassignment_count,1);
  item=ok(await mutate(sup,item,'unassign'));assert.equal(item.status,'new');assert.equal(item.assignee_id,null);
  item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));assert.equal(item.first_assigned_at,first);
});
test('event insert failure rolls back queue mutation and note together',async()=>{
  let item=ok(await add(await post()),201);item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));
  // Force an event version collision; immutable fixture models a failed event write.
  await sql`INSERT INTO queue_events(queue_item_id,event_type,to_status,version) VALUES (${item.id},'note_added','assigned',${item.version+1})`;
  assert.equal((await mutate(agent,item,'notes',{body:'Must roll back'})).statusCode,500);
  assert.equal((await sql`SELECT version FROM queue_items WHERE id=${item.id}`)[0].version,item.version);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_notes WHERE queue_item_id=${item.id}`)[0].n,0);
});
test('team memberships: one active agent team; supervisor many; moves preserve history and scope',async()=>{
  assert.equal((await call(app,admin,'POST',`/api/v1/teams/${team2}/members`,{userId:agentId})).statusCode,409);
  ok(await call(app,admin,'POST',`/api/v1/teams/${team2}/members`,{userId:agentId,move:true}));
  const history=await sql`SELECT team_id,left_at FROM team_members WHERE user_id=${agentId}`;
  assert.ok(history.some(m=>m.team_id===team&&m.left_at));assert.ok(history.some(m=>m.team_id===team2&&!m.left_at));
  ok(await call(app,admin,'POST',`/api/v1/teams/${team2}/members`,{userId:supId}));
  assert.equal((await sql`SELECT count(*)::int AS n FROM team_members WHERE user_id=${supId} AND left_at IS NULL`)[0].n,2);
  assert.equal((await call(app,sup,'POST','/api/v1/teams',{name:'Forbidden'})).statusCode,403);
  ok(await call(app,admin,'POST',`/api/v1/teams/${team2}/members/remove`,{userId:supId}));
  ok(await call(app,admin,'POST',`/api/v1/teams/${team}/members`,{userId:agentId,move:true}));
  const item=ok(await add(await post('inquiry',{program:program2})),201);
  assert.equal((await call(app,sup,'GET',`${base}/items/${item.id}`)).statusCode,404);
});
test('date basis and stable ascending keyset; microseconds and new arrivals do not repeat pages',async()=>{
  const ids=[];for(let i=0;i<3;i++)ids.push(ok(await add(await post()),201).id);
  const entered='2026-10-07T21:00:00.123456Z';
  // Operational test fixtures only: midnight in Riyadh, distinct microseconds retained by cursor.
  await sql`UPDATE queue_items SET entered_at=${entered} WHERE id=ANY(${ids}::uuid[])`;
  const query=`range=custom&from=2026-10-08&to=2026-10-08&programId=${program}&limit=1`;
  const first=ok(await call(app,sup,'GET',`${base}/items?${query}&basis=entered`));assert.equal(first.items.length,1);
  const seen=[first.items[0].id];let cursor=first.nextCursor;
  while(cursor){const next=ok(await call(app,sup,'GET',`${base}/items?${query}&cursor=${cursor}`));seen.push(...next.items.map((i:{id:string})=>i.id));cursor=next.nextCursor;}
  assert.equal(new Set(seen).size,seen.length);for(const id of ids)assert.ok(seen.includes(id));
  const posted=ok(await call(app,sup,'GET',`${base}/items?${query}&basis=posted`));
  const shouldInclude=Date.parse(stamp)>=Date.parse('2026-10-07T21:00:00Z')&&Date.parse(stamp)<Date.parse('2026-10-08T21:00:00Z');
  assert.equal(posted.items.length>0,shouldInclude);
  assert.equal((await call(app,sup,'GET',base+'/items?cursor=garbage')).statusCode,400);
});

test('role changes cannot bypass active team membership cardinality or kind',async()=>{
  const member=await createUser('supervisor');
  for(const t of [team,team2])ok(await call(app,admin,'POST',`/api/v1/teams/${t}/members`,{userId:member.id}));
  const [role]=await sql`SELECT id FROM roles WHERE key='agent'`;
  assert.equal((await call(app,admin,'PUT',`/api/v1/admin/users/${member.id}/role`,{roleId:role.id})).statusCode,409);
  for(const t of [team,team2])ok(await call(app,admin,'POST',`/api/v1/teams/${t}/members/remove`,{userId:member.id}));
  ok(await call(app,admin,'PUT',`/api/v1/admin/users/${member.id}/role`,{roleId:role.id}));
  ok(await call(app,admin,'POST',`/api/v1/teams/${team}/members`,{userId:member.id}));
  assert.equal((await call(app,admin,'POST',`/api/v1/teams/${team2}/members`,{userId:member.id})).statusCode,409);
  assert.equal((await sql`SELECT count(*)::int AS n FROM team_members WHERE user_id=${member.id} AND left_at IS NOT NULL`)[0].n,2);
});
