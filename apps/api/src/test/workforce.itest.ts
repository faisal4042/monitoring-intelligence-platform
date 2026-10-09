/**
 * Queue workforce: availability, time records, per-agent settings and
 * automatic assignment. Local *_test database only (see harness.ts); no
 * worker is started and nothing here can reach the X API.
 */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {call,createUser,login,makeApp,sql,type App} from './harness.js';
import {runAssignmentPass,statusTime,sweepStatuses,timeTotals} from '../modules/queue/workforce.js';
import {intakeQueue} from '../workers/queue-intake.worker.js';

let app:App;
let admin:string,sup:string,supOther:string,viewer:string;
let supId:string;
let team:string,team2:string,program:string,programB:string,program2:string;
const W='/api/v1/workforce',Q='/api/v1/queue';
const ok=(res:Awaited<ReturnType<typeof call>>,code=200)=>{assert.equal(res.statusCode,code,res.body);return res.json();};
interface Agent {id:string;token:string}
const agents:Agent[]=[];
async function newAgent(t=team):Promise<Agent>{
  const u=await createUser('agent');const token=(await login(app,u.email)).accessToken;
  ok(await call(app,admin,'POST',`/api/v1/teams/${t}/members`,{userId:u.id}));
  const a={id:u.id,token};agents.push(a);return a;
}
const setStatus=(a:Agent,status:string)=>call(app,a.token,'POST',W+'/status',{status});
const open=(userId:string)=>sql<{id:string;section:string;priority:string}[]>`SELECT id,section,priority FROM queue_items
  WHERE assignee_id=${userId}::uuid AND status IN ('assigned','in_progress') ORDER BY assigned_at,id`;
const autoAssign=(on:boolean)=>sql`UPDATE settings SET value=${on?'true':'false'}::jsonb WHERE key='queue.auto_assign_enabled'`;

/** An unassigned queue item. Post items get a real post + classification (intent); story units have no post. */
async function item(o:{t?:string;p?:string;section?:'general'|'influencer'|'story';intent?:string;minutesAgo?:number;priority?:'normal'|'high'}={}) {
  const t=o.t??team,p=o.p??program,section=o.section??'general',ago=o.minutesAgo??0;
  const snapshot=JSON.stringify({id:p,key:'wf',name:'Workforce',color:'#0aa'});
  let row:{id:string;version:number};
  if(section==='story'){
    [row]=await sql`INSERT INTO queue_items(interaction_type,story_id,story_snapshot,program_id,program_snapshot,team_id,section,entered_at,priority)
      VALUES ('story',${crypto.randomUUID()},${JSON.stringify({title:'Story'})}::jsonb,${p},${snapshot}::jsonb,${t},'story',
        clock_timestamp()-make_interval(mins=>${ago}),${o.priority??'normal'}) RETURNING id,version`;
  } else {
    const {id,at}=await rawPost(p,o.intent);
    [row]=await sql`INSERT INTO queue_items(post_id,post_posted_at,program_id,program_snapshot,team_id,section,entered_at,priority)
      VALUES (${id},${at},${p},${snapshot}::jsonb,${t},${section},clock_timestamp()-make_interval(mins=>${ago}),${o.priority??'normal'}) RETURNING id,version`;
  }
  await sql`INSERT INTO queue_events(queue_item_id,event_type,to_status,version) VALUES (${row.id},'created','new',1)`;
  return row.id;
}
/** A classified post that is not in the queue yet. */
async function rawPost(p=program,intent='inquiry'){
  const id=crypto.randomUUID();const at=new Date().toISOString();
  await sql`INSERT INTO posts(id,x_post_id,x_author_id,text,text_normalized,posted_at,collected_at,content_hash,status)
    VALUES (${id},${id},'wf-test','Workforce test','workforce test',${at},${at},'\\x00','classified')`;
  await sql`INSERT INTO post_classifications(post_id,posted_at,relevance,intent,program_id,stage) VALUES (${id},${at},'relevant',${intent},${p},1)`;
  return {id,at};
}
const iso=(v:unknown)=>new Date(v as string).toISOString();
const itemRow=async(id:string)=>(await sql`SELECT * FROM queue_items WHERE id=${id}::uuid`)[0];

before(async()=>{
  app=await makeApp();
  const login2=async(role:string)=>{const u=await createUser(role);return {id:u.id,token:(await login(app,u.email)).accessToken};};
  const a=await login2('admin');admin=a.token;
  const s=await login2('supervisor');sup=s.token;supId=s.id;
  const s2=await login2('supervisor');supOther=s2.token;
  viewer=(await login2('viewer')).token;
  const programs:string[]=[];
  for(let i=0;i<3;i++){const [p]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},${'WF '+i},${'WF '+i}) RETURNING id`;programs.push(p.id);}
  [program,programB,program2]=programs;
  team=ok(await call(app,admin,'POST','/api/v1/teams',{name:'WF '+crypto.randomUUID()}),201).id;
  team2=ok(await call(app,admin,'POST','/api/v1/teams',{name:'WF2 '+crypto.randomUUID()}),201).id;
  ok(await call(app,admin,'PUT',`/api/v1/teams/${team}/programs`,{programIds:[program,programB]}));
  ok(await call(app,admin,'PUT',`/api/v1/teams/${team2}/programs`,{programIds:[program2]}));
  ok(await call(app,admin,'POST',`/api/v1/teams/${team}/members`,{userId:supId}));
  ok(await call(app,admin,'POST',`/api/v1/teams/${team2}/members`,{userId:s2.id}));
  await autoAssign(false);
});
after(async()=>{
  // Leave the shared test database as the other suites expect it.
  await autoAssign(false);
  for(const a of agents)await sql`UPDATE agent_status_periods SET ended_at=clock_timestamp(),end_source='system',end_reason='test cleanup' WHERE user_id=${a.id}::uuid AND ended_at IS NULL`;
  await app.close();
});

test('status transitions record previous/new status, server times, duration and source; history is append-only',async()=>{
  const a=await newAgent();
  assert.equal(ok(await call(app,a.token,'GET',W+'/me')).status.status,'offline','signing in never starts a shift');
  ok(await setStatus(a,'available'));
  const again=ok(await setStatus(a,'available'));assert.equal(again.changed,false,'same status is a no-op (retries/double clicks)');
  ok(await setStatus(a,'break'));
  ok(await setStatus(a,'meeting'));
  assert.equal((await setStatus(a,'lunch')).statusCode,400);
  const rows=await sql`SELECT status,previous_status,source,ended_at,end_source,duration_seconds FROM agent_status_periods WHERE user_id=${a.id}::uuid ORDER BY started_at`;
  assert.deepEqual(rows.map(r=>[r.status,r.previous_status,r.source]),[['available','offline','agent'],['break','available','agent'],['meeting','break','agent']]);
  assert.ok(rows[0].ended_at&&rows[1].ended_at&&!rows[2].ended_at);assert.equal(rows[0].end_source,'agent');
  assert.ok(Number(rows[0].duration_seconds)>=0);
  // Consecutive periods share their boundary exactly: no gap, no overlap.
  const bounds=await sql`SELECT started_at,ended_at FROM agent_status_periods WHERE user_id=${a.id}::uuid ORDER BY started_at`;
  assert.equal(iso(bounds[0].ended_at),iso(bounds[1].started_at));
  await assert.rejects(sql`DELETE FROM agent_status_periods WHERE user_id=${a.id}::uuid`);
  await assert.rejects(sql`UPDATE agent_status_periods SET status='available' WHERE user_id=${a.id}::uuid AND status='break'`);
  ok(await setStatus(a,'offline'));
});

test('supervisor status changes need a reason, are audited, and stay inside the supervisor scope',async()=>{
  const a=await newAgent();
  assert.equal((await call(app,sup,'POST',`${W}/agents/${a.id}/status`,{status:'available'})).statusCode,400);
  ok(await call(app,sup,'POST',`${W}/agents/${a.id}/status`,{status:'training',reason:'Onboarding session'}));
  const [p]=await sql`SELECT source,reason,actor_id FROM agent_status_periods WHERE user_id=${a.id}::uuid AND ended_at IS NULL`;
  assert.equal(p.source,'supervisor');assert.equal(p.reason,'Onboarding session');assert.equal(p.actor_id,supId);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='workforce.status_set' AND entity_id=${a.id}::uuid`)[0].n,1);
  assert.equal((await call(app,supOther,'POST',`${W}/agents/${a.id}/status`,{status:'away',reason:'x'})).statusCode,404,'another team');
  const b=await newAgent();
  assert.equal((await call(app,b.token,'POST',`${W}/agents/${a.id}/status`,{status:'away',reason:'x'})).statusCode,403,'agents set only their own');
  assert.equal((await call(app,viewer,'POST',W+'/status',{status:'available'})).statusCode,403);
});

test('silent sessions and forgotten ends of shift are closed by the system at the right time',async()=>{
  const silent=await newAgent();const long=await newAgent();
  // Opened 40 min ago, last heartbeat 30 min ago (timeout 10): ends at the last heartbeat.
  await sql`INSERT INTO agent_status_periods(user_id,status,previous_status,started_at,source) VALUES (${silent.id},'available','offline',clock_timestamp()-interval '40 minutes','agent')`;
  await sql`INSERT INTO agent_presence(user_id,last_heartbeat_at) VALUES (${silent.id},clock_timestamp()-interval '30 minutes')`;
  // Opened 13 h ago and still "alive": ends at the 12 h limit.
  await sql`INSERT INTO agent_status_periods(user_id,status,previous_status,started_at,source) VALUES (${long.id},'meeting','offline',clock_timestamp()-interval '13 hours','agent')`;
  await sql`INSERT INTO agent_presence(user_id,last_heartbeat_at) VALUES (${long.id},clock_timestamp())`;
  await sweepStatuses();
  const [s1,s2]=await sql`SELECT status,source,reason,end_source,ended_at,started_at FROM agent_status_periods WHERE user_id=${silent.id}::uuid ORDER BY started_at`;
  assert.equal(s1.end_source,'system');
  const hb=(await sql`SELECT last_heartbeat_at FROM agent_presence WHERE user_id=${silent.id}::uuid`)[0].last_heartbeat_at;
  assert.equal(iso(s1.ended_at),iso(hb),'ended at the last sign of life, not at the sweep');
  assert.equal(s2.status,'offline');assert.equal(s2.source,'system');assert.ok(s2.reason.length>0);
  const [l1]=await sql`SELECT extract(epoch FROM ended_at-started_at)::int AS secs FROM agent_status_periods WHERE user_id=${long.id}::uuid ORDER BY started_at LIMIT 1`;
  assert.equal(l1.secs,12*3600);
  const before=await sql`SELECT count(*)::int AS n FROM agent_status_periods WHERE user_id=ANY(${[silent.id,long.id]}::uuid[])`;
  await sweepStatuses();
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM agent_status_periods WHERE user_id=ANY(${[silent.id,long.id]}::uuid[])`,before,'idempotent');
  // A heartbeat keeps a status alive but never starts one.
  const idle=await newAgent();
  ok(await call(app,idle.token,'POST',W+'/heartbeat'));
  assert.equal((await sql`SELECT count(*)::int AS n FROM agent_status_periods WHERE user_id=${idle.id}::uuid`)[0].n,0);
});

test('time is split by Asia/Riyadh day across midnight and totals separate logged from operational time',async()=>{
  const a=await newAgent();
  // 23:00 → 01:30 Riyadh (20:00 → 22:30 UTC): 1 h on day one, 1.5 h on day two.
  await sql`INSERT INTO agent_status_periods(user_id,status,previous_status,started_at,ended_at,source,end_source) VALUES
    (${a.id},'available','offline','2026-09-01T20:00:00Z','2026-09-01T22:30:00Z','agent','agent'),
    (${a.id},'break','available','2026-09-01T22:30:00Z','2026-09-01T23:00:00Z','agent','agent'),
    (${a.id},'offline','break','2026-09-01T23:00:00Z','2026-09-02T05:00:00Z','agent','agent')`;
  const rows=await statusTime([a.id],'2026-09-01T00:00:00Z','2026-09-03T00:00:00Z');
  const get=(day:string,status:string)=>rows.find(r=>r.day===day&&r.status===status)?.seconds??0;
  assert.equal(get('2026-09-01','available'),3600);assert.equal(get('2026-09-02','available'),5400);
  assert.equal(get('2026-09-02','break'),1800);
  const t=await timeTotals([a.id],'2026-09-01T00:00:00Z','2026-09-03T00:00:00Z');
  assert.equal(t.totals[a.id].available,9000);assert.equal(t.totals[a.id].logged,10800,'logged = every status except offline');
  assert.equal(t.totals[a.id].operational,9000,'operational = configured statuses (available)');
  assert.equal(t.totals[a.id].offline,6*3600);
  // Clipping to the window never invents or drops time.
  const day2=await timeTotals([a.id],'2026-09-01T21:00:00Z','2026-09-02T21:00:00Z');
  assert.equal(day2.totals[a.id].available,5400);
});

test('corrections need workforce:correct, keep before/after, reject overlaps and are audited',async()=>{
  const a=await newAgent();
  const [p]=await sql`INSERT INTO agent_status_periods(user_id,status,previous_status,started_at,ended_at,source,end_source) VALUES
    (${a.id},'break','available','2026-09-05T08:00:00Z','2026-09-05T09:00:00Z','agent','agent'),
    (${a.id},'available','break','2026-09-05T09:00:00Z','2026-09-05T10:00:00Z','agent','agent') RETURNING id`;
  const body={status:'meeting',reason:'Was in the weekly meeting'};
  assert.equal((await call(app,sup,'POST',`${W}/periods/${p.id}/correct`,body)).statusCode,403,'supervisors need the special permission');
  const fixed=ok(await call(app,admin,'POST',`${W}/periods/${p.id}/correct`,body));assert.equal(fixed.status,'meeting');
  const [c]=await sql`SELECT old_value,new_value,reason FROM agent_status_corrections WHERE period_id=${p.id}::uuid`;
  assert.equal(c.old_value.status,'break');assert.equal(c.new_value.status,'meeting');
  assert.equal((await sql`SELECT corrected_count FROM agent_status_periods WHERE id=${p.id}::uuid`)[0].corrected_count,1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='workforce.period_corrected' AND entity_id=${p.id}::uuid`)[0].n,1);
  assert.equal((await call(app,admin,'POST',`${W}/periods/${p.id}/correct`,{endedAt:'2026-09-05T09:30:00Z',reason:'overlap'})).statusCode,409);
  assert.equal((await call(app,admin,'POST',`${W}/periods/${p.id}/correct`,{endedAt:'2026-09-05T07:00:00Z',reason:'backwards'})).statusCode,400);
  assert.equal((await call(app,admin,'POST',`${W}/periods/${p.id}/correct`,{status:'available'})).statusCode,400,'reason required');
  await assert.rejects(sql`UPDATE agent_status_corrections SET reason='x' WHERE period_id=${p.id}::uuid`);
});

test('no "start" step: assigned work closes with a review, escalates and reopens back to the box',async()=>{
  const a=await newAgent();
  const id=await item();
  let it=ok(await call(app,sup,'POST',`${Q}/items/${id}/assign`,{expectedVersion:1,assigneeId:a.id}));
  assert.equal((await call(app,a.token,'POST',`${Q}/items/${id}/start`,{expectedVersion:it.version})).statusCode,404,'the start action is gone');
  it=ok(await call(app,a.token,'POST',`${Q}/items/${id}/complete`,{expectedVersion:it.version,review:{outcome:'confirmed'}}));
  assert.equal(it.status,'completed');
  const [rv]=await sql`SELECT assigned_at,started_at,completed_at FROM queue_reviews WHERE queue_item_id=${id}::uuid`;
  assert.ok(rv.assigned_at);assert.equal(rv.started_at,null);
  it=ok(await call(app,sup,'POST',`${Q}/items/${id}/reopen`,{expectedVersion:it.version,reason:'Second look'}));
  assert.equal(it.status,'assigned');assert.equal(it.assignee_id,a.id);assert.ok(new Date(it.assigned_at)>=new Date(rv.completed_at));
  it=ok(await call(app,a.token,'POST',`${Q}/items/${id}/escalate`,{expectedVersion:it.version,reason:'Needs a supervisor'}));
  it=ok(await call(app,sup,'POST',`${Q}/items/${id}/complete`,{expectedVersion:it.version,review:{outcome:'corrected',intent:'complaint',reason:'Actually a complaint'}}));
  assert.deepEqual((await sql`SELECT cycle FROM queue_reviews WHERE queue_item_id=${id}::uuid ORDER BY cycle`).map(r=>r.cycle),[1,2]);
  // Legacy in_progress work (from the old flow) is still open work that closes the same way.
  const legacy=await item();
  let l=ok(await call(app,sup,'POST',`${Q}/items/${legacy}/assign`,{expectedVersion:1,assigneeId:a.id}));
  await sql`UPDATE queue_items SET status='in_progress',started_at=clock_timestamp(),first_started_at=clock_timestamp(),version=version+1 WHERE id=${legacy}::uuid`;
  await sql`INSERT INTO queue_events(queue_item_id,event_type,actor_id,from_status,to_status,version) VALUES (${legacy},'started',${a.id},'assigned','in_progress',${l.version+1})`;
  l=ok(await call(app,a.token,'POST',`${Q}/items/${legacy}/complete`,{expectedVersion:l.version+1,review:{outcome:'confirmed'}}));
  assert.equal(l.status,'completed');
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=${legacy}::uuid AND event_type='started'`)[0].n,1,'old started events stay');
});

test('automatic assignment: only Available agents, within the box limit, immediately on every trigger',async()=>{
  await autoAssign(true);
  try {
    const a=await newAgent();
    ok(await call(app,sup,'PUT',`${W}/settings/agents/${a.id}`,{maxOpen:2}));
    const ids=[await item({minutesAgo:3}),await item({minutesAgo:2}),await item({minutesAgo:1})];
    for(const s of ['break','meeting','training','away','offline']){
      ok(await setStatus(a,s));await runAssignmentPass({trigger:'test'});
      assert.equal((await open(a.id)).length,0,`nothing while ${s}`);
    }
    ok(await setStatus(a,'available'));
    assert.deepEqual((await open(a.id)).map(r=>r.id),ids.slice(0,2),'on Available: oldest first, up to the limit');
    const ev=(await sql`SELECT actor_id,metadata FROM queue_events WHERE queue_item_id=${ids[0]}::uuid AND event_type='assigned'`)[0];
    assert.equal(ev.actor_id,null);assert.equal(ev.metadata.auto,true);assert.equal(ev.metadata.trigger,'status_available');
    // Closing frees a slot: the next item arrives in the same request.
    const first=await itemRow(ids[0]);
    ok(await call(app,a.token,'POST',`${Q}/items/${ids[0]}/complete`,{expectedVersion:first.version,review:{outcome:'confirmed'}}));
    assert.deepEqual((await open(a.id)).map(r=>r.id).sort(),[ids[1],ids[2]].sort());
    // A new item while the box is full waits; raising the limit assigns it.
    const fresh=await item();await intakeQueue();
    assert.equal((await itemRow(fresh)).status,'new');
    ok(await call(app,sup,'PUT',`${W}/settings/agents/${a.id}`,{maxOpen:3}));
    assert.equal((await itemRow(fresh)).assignee_id,a.id);
    // Escalating frees the slot too (escalated work waits on the supervisor).
    const another=await item();
    const r=await itemRow(ids[1]);
    ok(await call(app,a.token,'POST',`${Q}/items/${ids[1]}/escalate`,{expectedVersion:r.version,reason:'Policy question'}));
    assert.equal((await itemRow(another)).assignee_id,a.id);
    // A new item when there is room is assigned on arrival (intake trigger).
    ok(await setStatus(a,'break'));
    const b=await newAgent();ok(await setStatus(b,'available'));
    const src=await rawPost();
    const arrival=ok(await call(app,sup,'POST',Q+'/items',{postId:src.id,postedAt:src.at}),201).id;
    assert.equal((await itemRow(arrival)).assignee_id,b.id,'a new item is assigned on arrival, only to the Available agent');
    ok(await setStatus(b,'offline'));
  } finally { await autoAssign(false); }
});

test('assignment respects programs, interaction types, lanes and high-priority permission per agent',async()=>{
  await autoAssign(true);
  try {
    const t=ok(await call(app,admin,'POST','/api/v1/teams',{name:'WF rules '+crypto.randomUUID()}),201).id;
    const [p1]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},'R1','R1') RETURNING id`;
    const [p2]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},'R2','R2') RETURNING id`;
    ok(await call(app,admin,'PUT',`/api/v1/teams/${t}/programs`,{programIds:[p1.id,p2.id]}));
    const a=await newAgent(t);
    ok(await call(app,admin,'PUT',`${W}/settings/agents/${a.id}`,{programIds:[p1.id],intents:['complaint'],sections:['general','influencer'],acceptsHighPriority:false,maxOpen:10}));
    const wrongProgram=await item({t,p:p2.id,intent:'complaint'});
    const wrongIntent=await item({t,p:p1.id,intent:'inquiry'});
    const wrongLane=await item({t,p:p1.id,section:'story'});
    const high=await item({t,p:p1.id,intent:'complaint',priority:'high'});
    const right=await item({t,p:p1.id,intent:'complaint'});
    const influencer=await item({t,p:p1.id,intent:'complaint',section:'influencer'});
    ok(await setStatus(a,'available'));
    assert.deepEqual((await open(a.id)).map(r=>r.id).sort(),[right,influencer].sort());
    for(const id of [wrongProgram,wrongIntent,wrongLane,high])assert.equal((await itemRow(id)).status,'new');
    // Programs outside the agent's team are refused at save time.
    assert.equal((await call(app,admin,'PUT',`${W}/settings/agents/${a.id}`,{programIds:[program2]})).statusCode,400);
    // Changing allowed types triggers a pass at once.
    ok(await call(app,admin,'PUT',`${W}/settings/agents/${a.id}`,{intents:null,programIds:null}));
    assert.equal((await itemRow(wrongIntent)).assignee_id,a.id);assert.equal((await itemRow(wrongProgram)).assignee_id,a.id);
    assert.equal((await itemRow(high)).status,'new','high priority still refused');
    ok(await setStatus(a,'offline'));
  } finally { await autoAssign(false); }
});

test('lane order stories > influencers > general, starvation prevention, and high priority first',async()=>{
  await autoAssign(true);
  try {
    const t=ok(await call(app,admin,'POST','/api/v1/teams',{name:'WF lanes '+crypto.randomUUID()}),201).id;
    const [p]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},'L','L') RETURNING id`;
    ok(await call(app,admin,'PUT',`/api/v1/teams/${t}/programs`,{programIds:[p.id]}));
    const a=await newAgent(t);
    ok(await call(app,admin,'PUT',`${W}/settings/agents/${a.id}`,{maxOpen:1}));
    const general=await item({t,p:p.id,minutesAgo:20});
    const influencer=await item({t,p:p.id,section:'influencer',minutesAgo:10});
    const story=await item({t,p:p.id,section:'story',minutesAgo:5});
    const starving=await item({t,p:p.id,minutesAgo:120});
    const highGeneral=await item({t,p:p.id,priority:'high'});
    const order:string[]=[];
    ok(await setStatus(a,'available'));
    for(let i=0;i<5;i++){
      const [cur]=await open(a.id);if(!cur)break;order.push(cur.id);
      const row=await itemRow(cur.id);
      ok(await call(app,a.token,'POST',`${Q}/items/${cur.id}/complete`,{expectedVersion:row.version,review:{outcome:'confirmed'}}));
    }
    assert.deepEqual(order,[highGeneral,starving,story,influencer,general],'high, then starving (≥45 min), then lanes, then age');
    ok(await setStatus(a,'offline'));
  } finally { await autoAssign(false); }
});

test('concurrent passes and status changes never double-assign or overflow a box',async()=>{
  await autoAssign(true);
  try {
    const t=ok(await call(app,admin,'POST','/api/v1/teams',{name:'WF race '+crypto.randomUUID()}),201).id;
    const [p]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},'C','C') RETURNING id`;
    ok(await call(app,admin,'PUT',`/api/v1/teams/${t}/programs`,{programIds:[p.id]}));
    ok(await call(app,admin,'PUT',`${W}/settings/teams/${t}`,{maxOpen:3}));
    const crew=await Promise.all([1,2,3,4].map(()=>newAgent(t)));
    const ids=await Promise.all(Array.from({length:20},(_,i)=>item({t,p:p.id,minutesAgo:i})));
    await autoAssign(false);
    for(const a of crew)ok(await setStatus(a,'available'));
    await autoAssign(true);
    // Many "workers" and API triggers at once.
    await Promise.all([
      ...Array.from({length:8},(_,i)=>runAssignmentPass({trigger:`race-${i}`})),
      ...crew.map(a=>call(app,a.token,'POST',W+'/status',{status:'available'})),
    ]);
    const rows=await sql<{id:string;assignee_id:string|null;status:string}[]>`SELECT id,assignee_id,status FROM queue_items WHERE id=ANY(${ids}::uuid[])`;
    const assigned=rows.filter(r=>r.assignee_id);
    assert.equal(assigned.length,12,'4 agents × limit 3');
    for(const a of crew)assert.equal(assigned.filter(r=>r.assignee_id===a.id).length,3);
    const events=await sql<{n:number}[]>`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=ANY(${ids}::uuid[]) AND event_type='assigned' GROUP BY queue_item_id`;
    assert.ok(events.every(e=>e.n===1),'one assignment event per item');
    // A retried pass with nothing eligible changes nothing.
    assert.equal((await runAssignmentPass({trigger:'retry'})).assigned.length,0);
    for(const a of crew)ok(await setStatus(a,'offline'));
  } finally { await autoAssign(false); }
});

test('transfers, reopen to the pool and supervisor redistribution keep history and attribute work to the right agent',async()=>{
  const a=await newAgent();const b=await newAgent();
  const id=await item();
  let it=ok(await call(app,sup,'POST',`${Q}/items/${id}/assign`,{expectedVersion:1,assigneeId:a.id}));
  const ev=(await sql`SELECT metadata FROM queue_events WHERE queue_item_id=${id}::uuid AND event_type='assigned'`)[0];
  assert.deepEqual(ev.metadata.override,['not_available'],'manual assignment to someone not Available is recorded');
  await new Promise(r=>setTimeout(r,30));
  it=ok(await call(app,sup,'POST',`${Q}/items/${id}/assign`,{expectedVersion:it.version,assigneeId:b.id}));
  const handedAt=new Date(it.assigned_at);
  it=ok(await call(app,b.token,'POST',`${Q}/items/${id}/complete`,{expectedVersion:it.version,review:{outcome:'confirmed'}}));
  const [rv]=await sql`SELECT reviewer_id,assigned_at FROM queue_reviews WHERE queue_item_id=${id}::uuid`;
  assert.equal(rv.reviewer_id,b.id);assert.equal(iso(rv.assigned_at),handedAt.toISOString(),'clock restarts for the new holder');
  const board=ok(await call(app,sup,'GET',`${W}/board?range=today`));
  const pa=board.agents.find((x:{id:string})=>x.id===a.id),pb=board.agents.find((x:{id:string})=>x.id===b.id);
  assert.equal(pa.performance.completedItems,0);assert.equal(pb.performance.completedItems,1);
  assert.equal(pa.performance.firstAssignedItems,1,'queue wait belongs to the first owner');
  // Reopen into the pool when the assignee left the team.
  ok(await call(app,admin,'POST',`/api/v1/teams/${team}/members/remove`,{userId:b.id}));
  it=ok(await call(app,sup,'POST',`${Q}/items/${id}/reopen`,{expectedVersion:it.version,reason:'Customer replied'}));
  assert.equal(it.status,'new');
  // Redistribution: release an agent's open work back to the pool, with reason and audit.
  const x=await item(),y=await item();
  for(const i of [x,y])ok(await call(app,sup,'POST',`${Q}/items/${i}/assign`,{expectedVersion:1,assigneeId:a.id}));
  assert.equal((await call(app,sup,'POST',`${W}/agents/${a.id}/release`,{})).statusCode,400);
  const res=ok(await call(app,sup,'POST',`${W}/agents/${a.id}/release`,{reason:'Agent went home sick'}));
  assert.equal(res.released,2);
  for(const i of [x,y]){const r=await itemRow(i);assert.equal(r.status,'new');assert.equal(r.assignee_id,null);}
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=ANY(${[x,y]}::uuid[]) AND event_type='unassigned' AND reason='Agent went home sick'`)[0].n,2);
  assert.equal((await call(app,supOther,'POST',`${W}/agents/${a.id}/release`,{reason:'not mine'})).statusCode,404);
});

test('settings inherit system → team → agent, show where each value comes from, and are audited',async()=>{
  const a=await newAgent();
  ok(await call(app,sup,'PUT',`${W}/settings/teams/${team}`,{maxOpen:7,sections:['general']}));
  ok(await call(app,sup,'PUT',`${W}/settings/agents/${a.id}`,{sections:['general','story']}));
  const view=ok(await call(app,sup,'GET',`${W}/settings?teamId=${team}`));
  const mine=view.agents.find((x:{id:string})=>x.id===a.id);
  assert.deepEqual(mine.effective.maxOpen,{value:7,from:'team'});
  assert.deepEqual(mine.effective.sections,{value:['general','story'],from:'agent'});
  assert.equal(mine.effective.autoAssign.from,'system');
  ok(await call(app,sup,'PUT',`${W}/settings/agents/${a.id}`,{sections:null}));
  const back=ok(await call(app,sup,'GET',`${W}/settings?teamId=${team}`)).agents.find((x:{id:string})=>x.id===a.id);
  assert.deepEqual(back.effective.sections,{value:['general'],from:'team'},'null returns to the inherited value');
  assert.ok((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='workforce.agent_settings_change' AND entity_id=${a.id}::uuid`)[0].n>=2);
  assert.equal((await call(app,supOther,'PUT',`${W}/settings/agents/${a.id}`,{maxOpen:1})).statusCode,404);
  assert.equal((await call(app,supOther,'PUT',`${W}/settings/teams/${team}`,{maxOpen:1})).statusCode,404);
  ok(await call(app,sup,'PUT',`${W}/settings/teams/${team}`,{maxOpen:null,sections:null}));
});

test('RBAC: board, settings, time and system settings are for supervisors; agents see only their own figures',async()=>{
  const a=await newAgent();
  for(const url of [W+'/board',W+'/settings',W+'/time',W+'/system-settings',`${W}/periods?employeeId=${a.id}`])
    assert.equal((await call(app,a.token,'GET',url)).statusCode,403,url);
  assert.equal((await call(app,viewer,'GET',W+'/me')).statusCode,403);
  const me=ok(await call(app,a.token,'GET',W+'/me'));
  assert.equal(me.team.team_id,team);assert.ok('performance' in me&&'time' in me);
  const board=ok(await call(app,supOther,'GET',W+'/board'));
  assert.ok(!board.agents.some((x:{id:string})=>x.id===a.id),'another team stays invisible');
  assert.equal((await call(app,sup,'PUT',W+'/system-settings',{autoAssignEnabled:true,laneOrder:['story','influencer','general'],
    starvationMinutes:45,defaultMaxOpen:5,heartbeatTimeoutMinutes:10,maxStatusHours:12,operationalStatuses:['available']})).statusCode,403,'settings:write only');
  const sys=ok(await call(app,admin,'GET',W+'/system-settings'));
  assert.equal(sys.autoAssignEnabled,false);
  assert.equal((await call(app,admin,'PUT',W+'/system-settings',{...sys,laneOrder:['story','story','general']})).statusCode,400);
  assert.equal((await call(app,admin,'PUT',W+'/system-settings',{...sys,operationalStatuses:['offline']})).statusCode,400);
  ok(await call(app,admin,'PUT',W+'/system-settings',{...sys,starvationMinutes:30}));
  ok(await call(app,admin,'PUT',W+'/system-settings',{...sys}));
  assert.ok((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='workforce.system_settings_change'`)[0].n>=2);
  // Priority is a supervisor's call with a reason.
  const id=await item();
  assert.equal((await call(app,a.token,'POST',`${Q}/items/${id}/priority`,{expectedVersion:1,priority:'high',reason:'x'})).statusCode,403);
  assert.equal((await call(app,sup,'POST',`${Q}/items/${id}/priority`,{expectedVersion:1,priority:'high'})).statusCode,400);
  const p=ok(await call(app,sup,'POST',`${Q}/items/${id}/priority`,{expectedVersion:1,priority:'high',reason:'VIP customer'}));
  assert.equal(p.priority,'high');
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=${id}::uuid AND event_type='priority_changed'`)[0].n,1);
});

test('logout ends availability; the board reports statuses, load and time totals',async()=>{
  const u=await createUser('agent');ok(await call(app,admin,'POST',`/api/v1/teams/${team}/members`,{userId:u.id}));
  const s=await login(app,u.email);const a={id:u.id,token:s.accessToken};agents.push(a);
  ok(await setStatus(a,'available'));
  const board=ok(await call(app,sup,'GET',`${W}/board?teamId=${team}`));
  const row=board.agents.find((x:{id:string})=>x.id===a.id);
  assert.equal(row.status,'available');assert.ok(row.status_since);assert.equal(typeof row.maxOpen,'number');
  assert.ok('waiting' in board.backlog&&'overdue' in board.backlog&&Array.isArray(board.bySection)&&Array.isArray(board.byProgram));
  assert.ok('available' in board.timeTotals&&'meeting' in board.timeTotals);
  await call(app,null,'POST','/api/v1/auth/logout',undefined,s.refreshCookie);
  const [cur]=await sql`SELECT status FROM agent_status_periods WHERE user_id=${a.id}::uuid AND ended_at IS NULL`;
  assert.equal(cur.status,'offline');
});
