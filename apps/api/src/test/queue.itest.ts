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
/** Old-flow data: the retired "start" step left items 'in_progress' with a 'started' event. Built in SQL, as it exists in databases today. */
const legacyStart=async(item:{id:string})=>{
  const [row]=await sql`UPDATE queue_items SET status='in_progress',started_at=clock_timestamp(),first_started_at=coalesce(first_started_at,clock_timestamp()),
      version=version+1,updated_at=clock_timestamp() WHERE id=${item.id}::uuid AND status='assigned' RETURNING *`;
  await sql`INSERT INTO queue_events(queue_item_id,event_type,actor_id,from_status,to_status,from_assignee,to_assignee,version)
    VALUES (${item.id},'started',${row.assignee_id},'assigned','in_progress',${row.assignee_id},${row.assignee_id},${row.version})`;
  return JSON.parse(JSON.stringify(row));
};

test('review closure preserves AI, enforces reasons and taxonomy, updates views and workload, and retains immutable cycles',async()=>{
  const id=await post();
  const [topic]=await sql`INSERT INTO topics(program_id,level,name_ar) VALUES (${program},1,'Review main topic') RETURNING id`;
  const [sub]=await sql`INSERT INTO topics(program_id,parent_id,level,name_ar) VALUES (${program},${topic.id},2,'Review subtopic') RETURNING id`;
  await sql`UPDATE post_classifications SET topic_id=${sub.id},intent_confidence=0.91 WHERE post_id=${id}`;
  await sql`INSERT INTO post_sentiments(post_id,posted_at,label,confidence,stage) VALUES (${id},${stamp},'neutral',0.82,1)`;
  const original=(await sql`SELECT row_to_json(c) AS value FROM post_classifications c WHERE post_id=${id}`)[0].value;
  let item=ok(await add(id),201);
  item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));
  const detail=ok(await call(app,agent,'GET',`${base}/items/${item.id}`));
  assert.equal(detail.ai_topic_id,topic.id);assert.equal(detail.ai_subtopic_id,sub.id);assert.equal(detail.intent_confidence,0.91);
  const summary=()=>call(app,agent,'GET',base+'/summary?range=all').then(ok);
  const before=await summary();
  assert.equal((await mutate(agent,item,'complete')).statusCode,400);
  assert.equal((await mutate(agent,item,'complete',{resolution:'handled'})).statusCode,400,'old contract is rejected');
  assert.equal((await mutate(agent,item,'complete',{review:{outcome:'corrected',intent:'complaint'}})).statusCode,400);
  assert.equal((await mutate(agent,item,'complete',{review:{outcome:'confirmed',intent:'complaint',reason:'Mismatch'}})).statusCode,400);
  assert.equal((await mutate(agent,item,'complete',{review:{outcome:'corrected',programId:program2,topicId:topic.id,reason:'Wrong program'}})).statusCode,400);
  assert.equal((await mutate(other,item,'complete',{review:{outcome:'confirmed'}})).statusCode,404);
  item=ok(await mutate(agent,item,'notes',{body:'Verified against the interaction'}));
  const closeVersion=item.version;
  item=ok(await mutate(agent,item,'complete',{review:{outcome:'corrected',intent:'complaint',reason:'The interaction reports a problem'}}));
  const after=await summary();
  assert.equal(after.views.general.mine,before.views.general.mine-1);assert.equal(after.views.general.closed,before.views.general.closed+1);
  const list=(view:string)=>call(app,agent,'GET',`${base}/items?range=all&view=${view}`).then(ok);
  assert.ok(!(await list('mine')).items.some((i:{id:string})=>i.id===item.id));
  assert.ok((await list('closed')).items.some((i:{id:string})=>i.id===item.id));
  assert.equal((await sql`SELECT row_to_json(c) AS value FROM post_classifications c WHERE post_id=${id}`)[0].value.intent,original.intent);
  assert.deepEqual((await sql`SELECT row_to_json(c) AS value FROM post_classifications c WHERE post_id=${id}`)[0].value,original);
  const [review]=await sql`SELECT * FROM queue_reviews WHERE queue_item_id=${item.id}`;
  assert.equal(review.ai.intent,'inquiry');assert.equal(review.intent,'complaint');assert.equal(review.ai.intentConfidence,0.91);
  assert.deepEqual(review.corrected_fields,['intent']);assert.equal(review.cycle,1);
  await assert.rejects(sql`UPDATE queue_reviews SET reason='changed' WHERE id=${review.id}`);
  await assert.rejects(sql`DELETE FROM queue_reviews WHERE id=${review.id}`);
  assert.equal((await mutate(sup,item,'reopen')).statusCode,400);
  assert.equal((await mutate(sup,item,'reopen',{reason:'   '})).statusCode,400);
  assert.equal((await mutate(agent,item,'reopen',{reason:'Agent cannot reopen'})).statusCode,403);
  assert.equal((await mutate(sup,{...item,version:closeVersion},'reopen',{reason:'stale'})).statusCode,409);
  item=ok(await mutate(sup,item,'reopen',{reason:'Second review requested'}));
  assert.ok(new Date(item.assigned_at)>=new Date(review.completed_at),'new cycle excludes time spent closed');
  assert.ok(!(await list('closed')).items.some((i:{id:string})=>i.id===item.id));
  assert.ok((await list('mine')).items.some((i:{id:string})=>i.id===item.id));
  assert.equal((await mutate(agent,item,'complete')).statusCode,400,'every cycle needs a review');
  item=ok(await mutate(agent,item,'complete',{review:{outcome:'confirmed'}}));
  const history=ok(await call(app,agent,'GET',`${base}/items/${item.id}`));
  assert.deepEqual(history.reviews.map((r:{cycle:number})=>r.cycle),[1,2]);
  assert.equal(history.notes.length,1);assert.equal(history.reviews[0].reason,review.reason);
  const stats=ok(await call(app,agent,'GET',`${base}/stats?range=all`));
  assert.equal(stats.totals.closed_items,1);assert.equal(stats.totals.review_cycles,2);
  const work=ok(await call(app,sup,'GET',`${base}/summary?range=all`)).workload.find((w:{id:string})=>w.id===agentId);
  assert.equal(work.completed_today,1);assert.equal(work.open,0);assert.equal(work.escalated,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_alerts WHERE queue_item_id=${item.id}`)[0].n,0,'general reviews never alert');
});

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
  // The retired start step is no longer an action.
  assert.equal((await mutate(agent,assigned,'start')).statusCode,404);
  assert.equal((await mutate(agent,item,'complete',{review:{outcome:'confirmed'}})).statusCode,409,'stale version');
  assert.equal((await mutate(agent,assigned,'escalate',{reason:'x',unexpected:true})).statusCode,400);
});
test('no start step: append-only notes, escalation, deescalation, completion, reopen and historical cycles',async()=>{
  let item=ok(await add(await post()),201);
  item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));
  const detail=ok(await call(app,agent,'GET',`${base}/items/${item.id}`));assert.equal(detail.status,'assigned');assert.equal(detail.first_started_at,null);
  const started=item.first_started_at;
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
  assert.equal((await mutate(agent,item,'complete',{review:{outcome:'confirmed'}})).statusCode,409);
  item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));
  assert.equal((await mutate(agent,item,'complete')).statusCode,400);
  item=ok(await mutate(agent,item,'complete',{review:{outcome:'confirmed'}}));const completed=item.completed_at;
  assert.equal((await mutate(agent,item,'reopen',{reason:'Review requested'})).statusCode,403);
  const history=ok(await call(app,agent,'GET',base+'/items?view=completed&range=all'));assert.ok(history.items.some((i:{id:string})=>i.id===item.id));
  assert.equal((await call(app,other,'GET',`${base}/items/${item.id}`)).statusCode,404);
  assert.ok(!ok(await call(app,agent,'GET',base+'/items?range=all')).items.some((i:{id:string})=>i.id===item.id));
  // Reopen clears the current close (0035); the earlier close stays in queue_events below.
  item=ok(await mutate(sup,item,'reopen',{reason:'Review requested'}));assert.equal(item.status,'assigned');assert.ok(completed);
  assert.deepEqual([item.completed_at,item.completed_by,item.resolution],[null,null,null]);assert.equal(item.first_started_at,started);
  item=ok(await mutate(agent,item,'complete',{review:{outcome:'no_action'}}));
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
test('item details name the topic link that topic feedback would change',async()=>{
  // The drawer's topic-feedback buttons edit post_classifications.topic_id; they
  // must only be offered with the topic in view, so the details carry its name.
  const [tp]=await sql`INSERT INTO topics(program_id,level,name_ar,name_en,is_active) VALUES (${program},1,${'موضوع طابور '+crypto.randomUUID().slice(0,8)},'Queue topic',true) RETURNING id,name_ar`;
  const linked=await post();await sql`UPDATE post_classifications SET topic_id=${tp.id} WHERE post_id=${linked}`;
  const withTopic=ok(await call(app,admin,'GET',`${base}/items/${ok(await add(linked),201).id}`));
  assert.equal(withTopic.topic_id,tp.id);assert.equal(withTopic.topic_name,tp.name_ar);
  const bare=ok(await call(app,admin,'GET',`${base}/items/${ok(await add(await post()),201).id}`));
  assert.equal(bare.topic_id,null);assert.equal(bare.topic_name,null);
});

// ── Work cycles: in-progress reassignment and reopen (0035) ─────────────────
async function cycleFixture() {
  const [p]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},'Cycle program','Cycle program') RETURNING id`;
  const t=ok(await call(app,admin,'POST','/api/v1/teams',{name:'Cycle '+crypto.randomUUID()}),201).id;
  ok(await call(app,admin,'PUT',`/api/v1/teams/${t}/programs`,{programIds:[p.id]}));
  const users:Record<string,{id:string;token:string}>={};
  for(const [name,role] of [['a','agent'],['b','agent'],['sup','supervisor'],['outsider','supervisor']] as const){
    const u=await createUser(role);users[name]={id:u.id,token:(await login(app,u.email)).accessToken};
    if(name!=='outsider')ok(await call(app,admin,'POST',`/api/v1/teams/${t}/members`,{userId:u.id}));
  }
  const inProgress=async()=>{
    let item=ok(await add(await post('inquiry',{program:p.id}),users.sup.token),201);
    item=ok(await mutate(users.sup.token,item,'assign',{assigneeId:users.a.id}));
    return legacyStart(item);
  };
  return {users,inProgress};
}

test('in-progress reassignment: supervisor moves the work with a reason; history and cycles stay exact',async()=>{
  const {users:u,inProgress}=await cycleFixture();
  const item=await inProgress();
  assert.equal(item.status,'in_progress');assert.ok(item.started_at);
  const firstStart=item.first_started_at;
  // Reason is mandatory, the item is untouched without it.
  assert.equal((await mutate(u.sup.token,item,'assign',{assigneeId:u.b.id})).statusCode,400);
  assert.equal((await sql`SELECT version FROM queue_items WHERE id=${item.id}`)[0].version,item.version);
  const moved=ok(await mutate(u.sup.token,item,'assign',{assigneeId:u.b.id,reason:'إجازة طارئة'}));
  assert.equal(moved.status,'assigned');assert.equal(moved.assignee_id,u.b.id);
  assert.equal(moved.started_at,null,'the new assignee does not inherit the running cycle');
  assert.equal(new Date(moved.first_started_at).getTime(),new Date(firstStart).getTime(),'first start of the item is kept');
  assert.equal(moved.reassignment_count,1);
  const [ev]=await sql`SELECT * FROM queue_events WHERE queue_item_id=${item.id} AND version=${moved.version}`;
  assert.deepEqual({type:ev.event_type,from:ev.from_status,to:ev.to_status,fromA:ev.from_assignee,toA:ev.to_assignee,actor:ev.actor_id,reason:ev.reason},
    {type:'reassigned',from:'in_progress',to:'assigned',fromA:u.a.id,toA:u.b.id,actor:u.sup.id,reason:'إجازة طارئة'});
  assert.ok(ev.created_at);
  // The previous assignee lost it; the new one must start their own cycle.
  assert.equal((await mutate(u.a.token,moved,'complete',{review:{outcome:'confirmed'}})).statusCode,404);
  // Same assignee again is not a reassignment.
  assert.equal((await mutate(u.sup.token,moved,'assign',{assigneeId:u.b.id,reason:'x'})).statusCode,409);
  // The new assignee closes straight from the box: no start step.
  ok(await mutate(u.b.token,moved,'complete',{review:{outcome:'confirmed'}}));
  // The earlier cycle of agent a remains reconstructible from events.
  const events=(await sql`SELECT event_type,actor_id FROM queue_events WHERE queue_item_id=${item.id} ORDER BY version`)
    .map(e=>`${e.event_type}:${e.actor_id===u.a.id?'a':e.actor_id===u.b.id?'b':'sup'}`);
  assert.deepEqual(events,['created:sup','assigned:sup','started:a','reassigned:sup','completed:b']);
});

test('in-progress reassignment: admin may, agent may not, outside supervisor 404, invalid assignee 400, stale version 409',async()=>{
  const {users:u,inProgress}=await cycleFixture();
  let item=await inProgress();
  assert.equal((await mutate(u.a.token,item,'assign',{assigneeId:u.b.id,reason:'x'})).statusCode,403,'agent');
  assert.equal((await mutate(u.outsider.token,item,'assign',{assigneeId:u.b.id,reason:'x'})).statusCode,404,'other team supervisor');
  assert.equal((await mutate(u.sup.token,item,'assign',{assigneeId:otherId,reason:'x'})).statusCode,400,'not a member of this team');
  const off=await createUser('agent');
  await sql`INSERT INTO team_members(team_id,user_id,kind) SELECT team_id,${off.id},'agent' FROM queue_items WHERE id=${item.id}`;
  await sql`UPDATE users SET is_active=false WHERE id=${off.id}`;
  assert.equal((await mutate(u.sup.token,item,'assign',{assigneeId:off.id,reason:'x'})).statusCode,400,'disabled member');
  assert.equal((await mutate(u.sup.token,{...item,version:item.version-1},'assign',{assigneeId:u.b.id,reason:'x'})).statusCode,409,'stale version');
  item=ok(await mutate(admin,item,'assign',{assigneeId:u.b.id,reason:'admin rebalancing'}));
  assert.equal(item.status,'assigned');assert.equal(item.assignee_id,u.b.id);
});

test('in-progress reassignment is atomic: a failed event write leaves the item exactly as it was',async()=>{
  const {users:u,inProgress}=await cycleFixture();
  const item=await inProgress();
  await sql`INSERT INTO queue_events(queue_item_id,event_type,to_status,version) VALUES (${item.id},'note_added','in_progress',${item.version+1})`;
  assert.equal((await mutate(u.sup.token,item,'assign',{assigneeId:u.b.id,reason:'x'})).statusCode,500);
  const [now]=await sql`SELECT status,assignee_id,version,started_at,reassignment_count FROM queue_items WHERE id=${item.id}`;
  assert.deepEqual({...now,started_at:new Date(now.started_at).toISOString()},
    {status:'in_progress',assignee_id:u.a.id,version:item.version,started_at:new Date(item.started_at).toISOString(),reassignment_count:0});
});

test('reopen lifecycle: complete, reopen clears the current close, complete again; every cycle stays in events',async()=>{
  const {users:u,inProgress}=await cycleFixture();
  const started=await inProgress();
  const done1=ok(await mutate(u.a.token,started,'complete',{review:{outcome:'no_action'}}));
  assert.equal(done1.status,'completed');assert.equal(done1.completed_by,u.a.id);assert.equal(done1.resolution,'no_action_needed');
  const reopened=ok(await mutate(u.sup.token,done1,'reopen',{reason:'Review requested'}));
  assert.equal(reopened.status,'assigned');
  assert.deepEqual([reopened.completed_at,reopened.completed_by,reopened.resolution],[null,null,null],'a reopened item is not closed');
  assert.equal(reopened.reopen_count,1);assert.ok(reopened.last_reopened_at);assert.equal(reopened.started_at,null);assert.ok(reopened.assigned_at);
  assert.equal(new Date(reopened.first_started_at).getTime(),new Date(started.first_started_at).getTime());
  const done2=ok(await mutate(u.a.token,reopened,'complete',{review:{outcome:'confirmed'}}));
  assert.equal(done2.resolution,'handled');assert.equal(done2.completed_by,u.a.id);
  assert.ok(new Date(done2.completed_at)>new Date(done1.completed_at));
  // Per-cycle handling time is reconstructible: started→completed, reopened→completed.
  const ev=await sql`SELECT event_type,actor_id,resolution,created_at FROM queue_events WHERE queue_item_id=${started.id} ORDER BY version`;
  assert.deepEqual(ev.map(e=>e.event_type),['created','assigned','started','completed','reopened','completed']);
  const [c1,r,c2]=[ev[3],ev[4],ev[5]];
  assert.equal(c1.resolution,'no_action_needed');assert.equal(c1.actor_id,u.a.id);
  assert.equal(r.actor_id,u.sup.id);assert.equal(c2.resolution,'handled');
  assert.ok(new Date(c1.created_at)>=new Date(ev[2].created_at));
  assert.ok(new Date(c2.created_at)>=new Date(r.created_at));
  // The agent's history lists the item once, as completed by them.
  const hist=ok(await call(app,u.a.token,'GET',`${base}/items?range=all&view=completed`));
  assert.equal(hist.items.filter((i:{id:string})=>i.id===started.id).length,1);
});

test('0035 is additive: only new columns and a check, no row is rewritten',async()=>{
  const source=await readFile(new URL('../../../../packages/db/migrations/0035_queue_work_cycles.sql',import.meta.url),'utf8');
  const code=source.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code,/\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
  const cols=await sql`SELECT column_name FROM information_schema.columns WHERE table_name='queue_items'
    AND column_name IN ('started_at','reopen_count','last_reopened_at') ORDER BY 1`;
  assert.deepEqual(cols.map(c=>c.column_name),['last_reopened_at','reopen_count','started_at']);
});

test('self-claim is off by default, scoped to the active team, and records exactly one assignment',async()=>{
  const {users:u,inProgress}=await cycleFixture();
  let item=await inProgress();
  item=ok(await mutate(u.sup.token,item,'assign',{assigneeId:u.b.id,reason:'Prepare unassigned fixture'}));
  item=ok(await mutate(u.sup.token,item,'unassign'));
  assert.equal((await mutate(u.a.token,item,'claim')).statusCode,404);
  await sql`UPDATE settings SET value='true'::jsonb WHERE key='queue.self_claim_enabled'`;
  try {
    const unassigned=ok(await call(app,u.a.token,'GET',`${base}/items?view=unassigned&range=all`));
    assert.ok(unassigned.items.some((i:{id:string})=>i.id===item.id));
    assert.equal((await mutate(other,item,'claim')).statusCode,404);
    const race=await Promise.all([mutate(u.a.token,item,'claim'),mutate(u.b.token,item,'claim')]);
    assert.equal(race.filter(r=>r.statusCode===200).length,1);
    assert.ok(race.every(r=>[200,404,409].includes(r.statusCode)));
    assert.equal((await sql`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=${item.id} AND metadata->>'claimed'='true'`)[0].n,1);
  } finally {await sql`UPDATE settings SET value='false'::jsonb WHERE key='queue.self_claim_enabled'`;}
});

test('reopen without an active assignee returns to unassigned while retaining the previous review',async()=>{
  const {users:u,inProgress}=await cycleFixture();
  let item=await inProgress();
  item=ok(await mutate(u.a.token,item,'complete',{review:{outcome:'confirmed'}}));
  // A synthetic inactive account: never a development or production user.
  await sql`UPDATE users SET is_active=false WHERE id=${u.a.id}`;
  item=ok(await mutate(u.sup.token,item,'reopen',{reason:'Previous reviewer unavailable'}));
  assert.equal(item.status,'new');assert.equal(item.assignee_id,null);assert.equal(item.started_at,null);assert.equal(item.assigned_at,null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_reviews WHERE queue_item_id=${item.id}`)[0].n,1);
  assert.equal((await mutate(u.sup.token,item,'complete',{review:{outcome:'confirmed'}})).statusCode,409);
});

test('review workflow RBAC: close, reopen, claim, catalogue, history and stats follow role and team scope',async()=>{
  const s2=await createUser('supervisor');ok(await call(app,admin,'POST',`/api/v1/teams/${team2}/members`,{userId:s2.id}));
  const supTeam2=(await login(app,s2.email)).accessToken;
  let item=ok(await add(await post()),201);
  item=ok(await mutate(sup,item,'assign',{assigneeId:agentId}));
  // No queue permission at all: every work action and the review endpoints are denied.
  for(const token of [viewer,analyst]){
    for(const action of ['complete','reopen','claim','notes','escalate'])assert.equal((await mutate(token,item,action)).statusCode,403,`${action} must be denied`);
    for(const url of ['/review-catalog','/stats?range=all'])assert.equal((await call(app,token,'GET',base+url)).statusCode,403,url);
  }
  // Another team's agent or supervisor cannot even see it.
  assert.equal((await mutate(other,item,'complete',{review:{outcome:'confirmed'}})).statusCode,404);
  assert.equal((await mutate(supTeam2,item,'complete',{review:{outcome:'confirmed'}})).statusCode,404);
  item=ok(await mutate(agent,item,'complete',{review:{outcome:'confirmed'}}));
  // The closed item and its review history stay inside the team's scope.
  assert.equal((await call(app,other,'GET',`${base}/items/${item.id}`)).statusCode,404);
  assert.equal((await call(app,supTeam2,'GET',`${base}/items/${item.id}`)).statusCode,404);
  assert.ok(!ok(await call(app,supTeam2,'GET',`${base}/items?range=all&view=closed`)).items.some((i:{id:string})=>i.id===item.id));
  assert.equal(ok(await call(app,sup,'GET',`${base}/items/${item.id}`)).reviews.length,1);
  // Only a supervisor of the item's team reopens, and the reopen is audited with its reason.
  assert.equal((await mutate(supTeam2,item,'reopen',{reason:'Out of scope'})).statusCode,404);
  item=ok(await mutate(sup,item,'reopen',{reason:'Quality check'}));
  const [audit]=await sql`SELECT user_id,new_value FROM audit_log WHERE action='queue.reopened' AND entity_id=${item.id}`;
  assert.equal(audit.user_id,supId);assert.equal(audit.new_value.reason,'Quality check');
  // Agents see only their own figures, whatever employee they ask for.
  const mine=ok(await call(app,agent,'GET',`${base}/stats?range=all&employeeId=${otherId}`));
  assert.deepEqual(mine.employees,[]);assert.ok(mine.totals.review_cycles>=1);
  assert.equal(ok(await call(app,other,'GET',`${base}/stats?range=all&employeeId=${agentId}`)).totals.review_cycles,0);
  // Supervisors see their own teams' reviewers only.
  assert.ok(ok(await call(app,sup,'GET',`${base}/stats?range=all`)).employees.some((e:{id:string})=>e.id===agentId));
  assert.ok(!ok(await call(app,supTeam2,'GET',`${base}/stats?range=all`)).employees.some((e:{id:string})=>e.id===agentId));
  // The catalogue never exposes inactive topics.
  const catalog=ok(await call(app,agent,'GET',base+'/review-catalog'));
  const inactive=await sql`SELECT id FROM topics WHERE NOT is_active`;
  assert.ok(!catalog.topics.some((t:{id:string})=>inactive.some(r=>r.id===t.id)));
  assert.equal(catalog.selfClaim,false);
});
