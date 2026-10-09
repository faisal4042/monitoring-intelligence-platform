/**
 * Unified queue: three sections without overlap, stories as one work unit,
 * and in-app alerts for influencer/story sections only — routed by scope,
 * deduplicated by event, announced once.
 */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {call,createUser,login,makeApp,sql,type App} from './harness.js';
import {intakeQueue} from '../workers/queue-intake.worker.js';
import {alertForEvents} from '../modules/queue/sections.js';

let app:App;
const tok:Record<string,string>={};const uid:Record<string,string>={};
let team:string,team2:string,program:string,program2:string,topic:string,topic2:string;
const base='/api/v1/queue';
const RUN=Date.now().toString(36);let seq=0;
let boundary:string;

const ok=(res:Awaited<ReturnType<typeof call>>,code=200)=>{assert.equal(res.statusCode,code,res.body);return res.json();};
const get=(who:string,url:string)=>call(app,tok[who],'GET',url);
async function author(influencer:boolean) {
  const name=`sec_${RUN}_${++seq}`;
  const [a]=await sql`INSERT INTO authors(x_author_id,username,display_name) VALUES (${name},${name},${'حساب '+seq}) RETURNING id`;
  if(influencer)await sql`INSERT INTO tracked_influencers(username) VALUES (${name})`;
  return {id:a.id as string,name};
}
async function post(opts:{influencer?:boolean;program?:string;intent?:string;author?:{id:string;name:string};status?:string;redacted?:boolean;duplicate?:boolean;relevance?:string}={}) {
  const id=crypto.randomUUID();const at=new Date().toISOString();
  const a=opts.author??await author(opts.influencer??false);
  await sql`INSERT INTO posts(id,x_post_id,x_author_id,author_id,text,text_normalized,posted_at,collected_at,content_hash,status,is_redacted,duplicate_of_id)
    VALUES (${id},${id},${a.name},${a.id}::uuid,'تفاعل اختبار الأقسام','تفاعل اختبار الاقسام',${at},${boundary},'\\x00',${opts.status??'classified'},
      ${opts.redacted??false},${opts.duplicate?crypto.randomUUID():null})`;
  await sql`INSERT INTO post_classifications(post_id,posted_at,relevance,intent,program_id,topic_id,stage)
    VALUES (${id},${at},${opts.relevance??'relevant'},${opts.intent??'complaint'},${opts.program??program},${(opts.program??program)===program?topic:topic2},1)`;
  return {id,at};
}
async function story(prog=program,state='new') {
  const [s]=await sql`INSERT INTO signal_stories(program_id,topic_id,title_ar,why_ar,centroid,state,first_seen_at,last_seen_at,post_count,family_count)
    VALUES (${prog},${prog===program?topic:topic2},${'قصة اختبار '+(++seq)},'سبب الاختبار',array_fill(0::real,ARRAY[1024])::vector,${state},now(),now(),2,2)
    RETURNING id`;
  return s.id as string;
}
const join=(storyId:string,p:{id:string;at:string},rep=false)=>sql`INSERT INTO signal_story_members(story_id,post_id,posted_at,family_key,is_representative)
  VALUES (${storyId},${p.id},${p.at},${'f'+p.id},${rep})`;
const itemOf=async(postId:string)=>(await sql`SELECT * FROM queue_items WHERE post_id=${postId}::uuid`)[0];
const unitOf=async(storyId:string)=>(await sql`SELECT * FROM queue_items WHERE interaction_type='story' AND story_id=${storyId}::uuid`)[0];
const alertsFor=async(itemId:string)=>sql`SELECT a.kind,r.user_id FROM queue_alerts a JOIN queue_alert_recipients r ON r.alert_id=a.id WHERE a.queue_item_id=${itemId}::uuid`;
const list=async(who:string,section:string,extra=`&programId=${program}`)=>ok(await get(who,`${base}/items?range=all&view=all&limit=100&section=${section}${extra}`)).items as Array<Record<string,unknown>>;

test('reopening influencer work alerts only its assignee once and never duplicates arrival',async()=>{
  const p=await post({influencer:true});
  let item=ok(await call(app,tok.admin,'POST',base+'/items',{postId:p.id,postedAt:p.at}),201);
  item=ok(await call(app,tok.supervisor,'POST',`${base}/items/${item.id}/assign`,{expectedVersion:item.version,assigneeId:uid.agent}));
  item=ok(await call(app,tok.agent,'POST',`${base}/items/${item.id}/complete`,{expectedVersion:item.version,review:{outcome:'confirmed'}}));
  item=ok(await call(app,tok.supervisor,'POST',`${base}/items/${item.id}/reopen`,{expectedVersion:item.version,reason:'Additional monitoring review'}));
  const events=await sql`SELECT id FROM queue_events WHERE queue_item_id=${item.id} AND event_type='reopened'`;
  await sql.begin(tx=>alertForEvents(tx,events.map(e=>e.id)));
  const rows=await alertsFor(item.id);
  assert.deepEqual(rows.filter(r=>r.kind==='reopened').map(r=>r.user_id),[uid.agent]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_alerts WHERE queue_item_id=${item.id} AND kind='influencer'`)[0].n,1);
});

before(async()=>{
  app=await makeApp();
  for(const role of ['admin','supervisor','agent','viewer','analyst']){const u=await createUser(role);tok[role]=(await login(app,u.email)).accessToken;uid[role]=u.id;}
  const s2=await createUser('supervisor');tok.sup2=(await login(app,s2.email)).accessToken;uid.sup2=s2.id;
  const s3=await createUser('supervisor');tok.sup3=(await login(app,s3.email)).accessToken;uid.sup3=s3.id;
  const a2=await createUser('agent');tok.agent2=(await login(app,a2.email)).accessToken;uid.agent2=a2.id;
  for(const n of [1,2]){
    const [p]=await sql`INSERT INTO programs(key,name_ar,name_en) VALUES (${crypto.randomUUID()},${'Sections '+n},${'Sections '+n}) RETURNING id`;
    const [tp]=await sql`INSERT INTO topics(program_id,level,name_ar) VALUES (${p.id},1,${'موضوع '+n}) RETURNING id`;
    const t=ok(await call(app,tok.admin,'POST','/api/v1/teams',{name:'Sections '+crypto.randomUUID()}),201).id;
    ok(await call(app,tok.admin,'PUT',`/api/v1/teams/${t}/programs`,{programIds:[p.id]}));
    if(n===1){program=p.id;team=t;topic=tp.id;}else{program2=p.id;team2=t;topic2=tp.id;}
  }
  // sup3 supervises both teams; agent2 works in team 2.
  for(const [id,t] of [[uid.agent,team],[uid.supervisor,team],[uid.sup2,team2],[uid.sup3,team],[uid.sup3,team2],[uid.agent2,team2]])ok(await call(app,tok.admin,'POST',`/api/v1/teams/${t}/members`,{userId:id}));
  boundary=new Date(Date.now()+500).toISOString();
  ok(await call(app,tok.admin,'PUT',base+'/intake-settings',{enabled:true,startsAt:boundary}));
  await new Promise(r=>setTimeout(r,600));
  // Leave nothing from earlier suites unannounced for these users.
  for(const who of ['admin','supervisor','agent','sup2','sup3','agent2'])ok(await call(app,tok[who],'POST',base+'/alerts/claim',{initial:true}));
});
after(async()=>{
  await sql`UPDATE settings SET value='false'::jsonb WHERE key='queue.intake_enabled'`;
  await sql`UPDATE settings SET value='null'::jsonb WHERE key='queue.intake_starts_at'`;
  await app.close();await sql.end({timeout:5});
});

test('0036 and 0037 are additive: constraints only widen, no row is rewritten or removed',async()=>{
  for(const file of ['0036_unified_queue_sections.sql','0037_queue_team_transfer.sql']){
    const source=await readFile(new URL(`../../../../packages/db/migrations/${file}`,import.meta.url),'utf8');
    const code=source.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(code,/\b(?:TRUNCATE|DELETE|UPDATE|INSERT)\b|DROP\s+(?:TABLE|COLUMN|INDEX)/i,file);
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items WHERE section NOT IN ('general','influencer','story')`)[0].n,0);
});

test('placement: general, influencer and story items each land in exactly one section',async()=>{
  const general=await post();const infl=await post({influencer:true});
  const s=await story();const member=await post();await join(s,member,true);
  const inflMember=await post({influencer:true});await join(s,inflMember);
  await intakeQueue();
  assert.equal((await itemOf(general.id)).section,'general');
  assert.equal((await itemOf(infl.id)).section,'influencer');
  // Posts of an approved story with a unit are worked through the story — no own item.
  assert.equal(await itemOf(member.id),undefined);
  assert.equal(await itemOf(inflMember.id),undefined);
  const unit=await unitOf(s);assert.equal(unit.section,'story');assert.equal(unit.status,'new');

  const sections={general:await list('admin','general'),influencer:await list('admin','influencer'),story:await list('admin','story')};
  const seen=new Map<string,string>();
  for(const [name,items] of Object.entries(sections))for(const it of items){
    const key=String(it.post_id??it.story_id);assert.ok(!seen.has(key),`${key} in ${seen.get(key)} and ${name}`);seen.set(key,name);
  }
  assert.equal(seen.get(general.id),'general');assert.equal(seen.get(infl.id),'influencer');assert.equal(seen.get(s),'story');
  assert.ok(!seen.has(member.id)&&!seen.has(inflMember.id));
  const card=sections.story.find(i=>i.story_id===s)!;
  assert.equal(card.story_title,unit.story_snapshot.title);assert.equal(card.story_post_count,2);
});

test('no duplicates in the database after repeated and concurrent passes',async()=>{
  const p=await post({influencer:true});const s=await story();const m=await post();await join(s,m,true);
  await Promise.all([intakeQueue(),intakeQueue(),intakeQueue()]);await intakeQueue();
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items WHERE post_id=${p.id}::uuid`)[0].n,1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_items WHERE interaction_type='story' AND story_id=${s}::uuid`)[0].n,1);
  const dupPosts=await sql`SELECT post_id FROM queue_items WHERE post_id IS NOT NULL GROUP BY post_id HAVING count(*)>1`;
  const dupStories=await sql`SELECT story_id FROM queue_items WHERE interaction_type='story' GROUP BY story_id HAVING count(*)>1`;
  assert.equal(dupPosts.length+dupStories.length,0);
});

test('section counts agree with the lists, never overlap, and follow the filters',async()=>{
  await post({program:program2});await post({program:program2,influencer:true});await intakeQueue();
  for(const programId of [program,program2]){
    const summary=ok(await get('admin',`${base}/summary?range=all&programId=${programId}`));
    for(const section of ['general','influencer','story']){
      const items=await list('admin',section,`&programId=${programId}`);
      const total=Object.values(summary.sections[section] as Record<string,number>).reduce((a,b)=>a+b,0);
      assert.equal(total,items.length,`${section} ${programId}`);
    }
    const all=ok(await get('admin',`${base}/items?range=all&view=all&programId=${programId}&limit=100`)).items;
    const sum=Object.values(summary.sections as Record<string,Record<string,number>>).flatMap(s=>Object.values(s)).reduce((a,b)=>a+b,0);
    assert.equal(sum,all.length);
  }
  // A supervisor's counts cover their team only.
  const sup=ok(await get('supervisor',`${base}/summary?range=all&programId=${program2}`));
  assert.equal(Object.values(sup.counts as Record<string,number>).reduce((a,b)=>a+b,0),0);
});

test('a post moving into a story keeps its id, status, assignee and full history',async()=>{
  const p=await post();await intakeQueue();
  let item=await itemOf(p.id);assert.equal(item.section,'general');
  item=ok(await call(app,tok.supervisor,'POST',`${base}/items/${item.id}/assign`,{expectedVersion:item.version,assigneeId:uid.agent}));
  // The story it belongs to is approved later.
  const s=await story();await join(s,p,true);await intakeQueue();
  const moved=await itemOf(p.id);const unit=await unitOf(s);
  assert.equal(moved.id,item.id);assert.equal(moved.section,'story');assert.equal(moved.story_item_id,unit.id);
  assert.equal(moved.status,'assigned');assert.equal(moved.assignee_id,uid.agent);
  const events=(await sql`SELECT event_type,metadata FROM queue_events WHERE queue_item_id=${item.id}::uuid ORDER BY version`);
  assert.deepEqual(events.map(e=>e.event_type),['created','assigned','section_changed']);
  assert.equal(events[2].metadata.from,'general');assert.equal(events[2].metadata.to,'story');
  // Still the agent's card (they hold it), shown once, in the story section, naming its story.
  const mine=ok(await get('agent',`${base}/items?range=all&section=story`)).items;
  assert.equal(mine.filter((i:{id:string})=>i.id===item.id).length,1);
  assert.equal(mine.find((i:{id:string})=>i.id===item.id).parent_story_title,unit.story_snapshot.title);
  assert.equal((await list('admin','general')).filter(i=>i.id===item.id).length,0);
  // The unit's drawer lists it with its own status.
  const detail=ok(await get('admin',`${base}/items/${unit.id}`));
  assert.equal(detail.members.find((m:{post_id:string})=>m.post_id===p.id).item_status,'assigned');
  // The agent can still finish their work.
  ok(await call(app,tok.agent,'POST',`${base}/items/${item.id}/complete`,{expectedVersion:moved.version,review:{outcome:'confirmed'}}));
});

test('a move into another team’s story is held for review, never made silently',async()=>{
  const p=await post();await intakeQueue();const item=await itemOf(p.id);
  // Program 2's team owns the story the post is clustered into.
  const s=await story(program2);await join(s,p,true);
  const other=await post({program:program2});await join(s,other);
  await intakeQueue();
  const after=await itemOf(p.id);
  assert.equal(after.team_id,team);assert.equal(after.section,'general');assert.equal(after.story_item_id,null);
  assert.equal(after.section_hold,'story');
  assert.deepEqual((await sql`SELECT event_type FROM queue_events WHERE queue_item_id=${item.id}::uuid ORDER BY version`).map(e=>e.event_type),['created','section_review']);
  await intakeQueue();
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=${item.id}::uuid`)[0].n,2,'held once, not every pass');
  assert.ok(ok(await get('supervisor',`${base}/summary?range=all`)).held>=1);
  assert.equal((await unitOf(s)).team_id,team2);
});

test('story merges are followed: the surviving unit keeps the work, the merged one disappears from the board',async()=>{
  const a=await story();const pa=await post();await join(a,pa,true);
  const b=await story();const pb=await post();await join(b,pb,true);
  await intakeQueue();const ua=await unitOf(a),ub=await unitOf(b);
  // What the clustering job does on merge.
  await sql`UPDATE signal_story_members SET story_id=${b}::uuid WHERE story_id=${a}::uuid`;
  await sql`DELETE FROM signal_stories WHERE id=${a}::uuid`;
  await intakeQueue();
  const merged=(await sql`SELECT * FROM queue_items WHERE id=${ua.id}::uuid`)[0];
  assert.equal(merged.merged_into_id,ub.id);
  assert.equal((await list('admin','story')).filter(i=>i.id===ua.id).length,0);
  assert.equal(ok(await get('admin',`${base}/items/${ub.id}`)).merged.length,1);
  assert.equal((await call(app,tok.supervisor,'POST',`${base}/items/${ua.id}/assign`,{expectedVersion:merged.version,assigneeId:uid.agent})).statusCode,409);
  // A unit whose story merged into one without a unit is re-pointed instead.
  const c=await story();const pc=await post();await join(c,pc,true);await intakeQueue();const uc=await unitOf(c);
  const target=await story();await sql`UPDATE signal_story_members SET story_id=${target}::uuid WHERE story_id=${c}::uuid`;
  await sql`DELETE FROM signal_stories WHERE id=${c}::uuid`;await intakeQueue();
  const repointed=(await sql`SELECT * FROM queue_items WHERE id=${uc.id}::uuid`)[0];
  assert.equal(repointed.story_id,target);assert.equal(repointed.merged_into_id,null);
});

test('alerts: influencer and story arrivals reach scoped users only; general never alerts',async()=>{
  const infl=await post({influencer:true});const general=await post();
  const s=await story();const m=await post();await join(s,m,true);
  await intakeQueue();
  const iItem=await itemOf(infl.id),gItem=await itemOf(general.id),unit=await unitOf(s);
  const who=async(id:string)=>(await alertsFor(id)).map(r=>r.user_id).sort();
  const expected=[uid.admin,uid.supervisor].sort();
  // Everyone else holding queue:view_all from earlier suites may also receive; ours must be exact on scope.
  for(const id of [iItem.id,unit.id]){
    const got=await who(id);
    for(const u of expected)assert.ok(got.includes(u),`recipient missing for ${id}`);
    for(const u of [uid.agent,uid.viewer,uid.analyst,uid.sup2])assert.ok(!got.includes(u),'out-of-scope recipient');
  }
  assert.deepEqual(await who(gItem.id),[]);
  assert.deepEqual((await alertsFor(iItem.id)).map(a=>a.kind)[0],'influencer');
  assert.deepEqual((await alertsFor(unit.id)).map(a=>a.kind)[0],'story');

  // Claim: fresh once; polling again returns nothing new.
  const first=ok(await call(app,tok.supervisor,'POST',base+'/alerts/claim',{}));
  const ids=first.fresh.map((f:{item_id:string})=>f.item_id);
  assert.ok(ids.includes(iItem.id)&&ids.includes(unit.id));
  assert.equal(ok(await call(app,tok.supervisor,'POST',base+'/alerts/claim',{})).fresh.length,0);
  // A reload (initial claim) never replays; the bell still lists them unread.
  assert.equal(ok(await call(app,tok.supervisor,'POST',base+'/alerts/claim',{initial:true})).fresh.length,0);
  const bell=ok(await get('supervisor',base+'/alerts'));
  assert.ok(bell.items.some((a:{item_id:string;read_at:null}) =>a.item_id===iItem.id&&a.read_at===null));
  assert.ok(bell.unreadBySection.influencer>=1&&bell.unreadBySection.story>=1);
  // The other team's supervisor and roles without queue access get nothing.
  assert.ok(!ok(await get('sup2',base+'/alerts')).items.some((a:{item_id:string})=>[iItem.id,unit.id].includes(a.item_id)));
  for(const role of ['viewer','analyst'])assert.equal((await get(role,base+'/alerts')).statusCode,403);
  // Agents see unassigned arrivals nowhere.
  assert.ok(!ok(await get('agent',base+'/alerts')).items.some((a:{item_id:string})=>[iItem.id,unit.id].includes(a.item_id)));
});

test('alerts: no double alert when influencer and story overlap, none for a story growing, none twice after restart',async()=>{
  // Influencer post first (alerts as influencer), then its story is approved.
  const p=await post({influencer:true});await intakeQueue();const item=await itemOf(p.id);
  assert.equal((await alertsFor(item.id)).filter(a=>a.user_id===uid.supervisor).length,1);
  const s=await story();await join(s,p,true);await intakeQueue();
  const unit=await unitOf(s);assert.equal((await itemOf(p.id)).section,'story');
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_alerts WHERE queue_item_id=${item.id}::uuid`)[0].n,1,'no new influencer alert on the move');
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_alerts WHERE queue_item_id=${unit.id}::uuid`)[0].n,1,'one story alert');
  // An influencer post of an already-approved story: story only, no influencer alert at all.
  const late=await post({influencer:true});await join(s,late);await intakeQueue();
  assert.equal(await itemOf(late.id),undefined);
  const before=(await sql`SELECT count(*)::int AS n FROM queue_alerts`)[0].n;
  // More posts join the story: counts move, no alert.
  for(let i=0;i<3;i++){const x=await post();await join(s,x);}
  await sql`UPDATE signal_stories SET post_count=post_count+3 WHERE id=${s}::uuid`;
  await intakeQueue();
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_alerts`)[0].n,before);
  // "Restart": every pass and every event replayed again creates nothing.
  await intakeQueue();await intakeQueue();
  const events=(await sql`SELECT id FROM queue_events WHERE queue_item_id IN (${item.id}::uuid,${unit.id}::uuid)`).map(e=>e.id);
  assert.equal(await sql.begin(tx=>alertForEvents(tx,events)),0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_alerts`)[0].n,before);
});

test('alerts: assignment of influencer/story work tells the assignee only; read state is per user',async()=>{
  const p=await post({influencer:true});const g=await post();await intakeQueue();
  let item=await itemOf(p.id);const gItem=await itemOf(g.id);
  item=ok(await call(app,tok.supervisor,'POST',`${base}/items/${item.id}/assign`,{expectedVersion:item.version,assigneeId:uid.agent}));
  ok(await call(app,tok.supervisor,'POST',`${base}/items/${gItem.id}/assign`,{expectedVersion:gItem.version,assigneeId:uid.agent}));
  const agentAlerts=(await alertsFor(item.id)).filter(a=>a.kind==='assigned');
  assert.deepEqual(agentAlerts.map(a=>a.user_id),[uid.agent]);
  assert.equal((await alertsFor(gItem.id)).length,0,'general assignment never alerts');
  const fresh=ok(await call(app,tok.agent,'POST',base+'/alerts/claim',{})).fresh;
  assert.equal(fresh.filter((f:{item_id:string;kind:string})=>f.item_id===item.id&&f.kind==='assigned').length,1);

  // Reading is per user.
  const supAlert=ok(await get('supervisor',base+'/alerts')).items.find((a:{item_id:string;kind:string})=>a.item_id===item.id&&a.kind==='influencer');
  ok(await call(app,tok.supervisor,'POST',`${base}/alerts/${supAlert.id}/read`,{}));
  const adminView=ok(await get('admin',base+'/alerts')).items.find((a:{id:string})=>a.id===supAlert.id);
  assert.equal(adminView.read_at,null);
  // Another user's alert id is invisible (404), and read-all stays within the caller.
  assert.equal((await call(app,tok.sup2,'POST',`${base}/alerts/${supAlert.id}/read`,{})).statusCode,404);
  const unreadAdmin=ok(await get('admin',base+'/alerts')).unread;
  ok(await call(app,tok.supervisor,'POST',base+'/alerts/read-all',{}));
  assert.equal(ok(await get('supervisor',base+'/alerts')).unread,0);
  assert.equal(ok(await get('admin',base+'/alerts')).unread,unreadAdmin);
});

test('alerts: what arrived while offline stays in the bell but is never sounded late',async()=>{
  const p=await post({influencer:true});await intakeQueue();const item=await itemOf(p.id);
  await sql`UPDATE queue_alerts SET created_at=now()-interval '10 minutes' WHERE queue_item_id=${item.id}::uuid`;
  const claim=ok(await call(app,tok.admin,'POST',base+'/alerts/claim',{}));
  assert.ok(!claim.fresh.some((f:{item_id:string})=>f.item_id===item.id));
  assert.ok(ok(await get('admin',base+'/alerts')).items.some((a:{item_id:string;read_at:null})=>a.item_id===item.id&&a.read_at===null));
});

test('alert preferences are per user and validated',async()=>{
  assert.deepEqual(ok(await get('agent',base+'/alerts/prefs')),{soundEnabled:true,toastsEnabled:true,volume:0.6});
  ok(await call(app,tok.agent,'PUT',base+'/alerts/prefs',{soundEnabled:false,toastsEnabled:true,volume:0.3}));
  assert.deepEqual(ok(await get('agent',base+'/alerts/prefs')),{soundEnabled:false,toastsEnabled:true,volume:0.3});
  assert.equal(ok(await get('supervisor',base+'/alerts/prefs')).soundEnabled,true);
  assert.equal((await call(app,tok.agent,'PUT',base+'/alerts/prefs',{soundEnabled:true,toastsEnabled:true,volume:4})).statusCode,400);
  assert.equal((await get('viewer',base+'/alerts/prefs')).statusCode,403);
});

test('eligibility: influencers enter with any relevant intent; general keeps inquiries and complaints; exclusions hold',async()=>{
  const praise=await post({influencer:true,intent:'praise'});
  const news=await post({influencer:true,intent:'news'});
  const citizenPraise=await post({intent:'praise'});
  const excluded=[await post({influencer:true,intent:'praise',status:'duplicate'}),await post({influencer:true,intent:'praise',duplicate:true}),
    await post({influencer:true,intent:'praise',redacted:true}),await post({influencer:true,intent:'praise',status:'filtered_out'}),
    await post({influencer:true,intent:'praise',relevance:'irrelevant'})];
  await intakeQueue();
  assert.equal((await itemOf(praise.id)).section,'influencer');
  assert.equal((await itemOf(news.id)).section,'influencer');
  assert.equal(await itemOf(citizenPraise.id),undefined,'general stays inquiries/complaints only');
  for(const p of excluded)assert.equal(await itemOf(p.id),undefined);
  // The account stops being tracked: a praise item cannot fall into general, so it stays where it is.
  const author=(await sql`SELECT a.username FROM posts p JOIN authors a ON a.id=p.author_id WHERE p.id=${praise.id}::uuid`)[0].username;
  await sql`UPDATE tracked_influencers SET is_active=false WHERE username=${author}`;
  await intakeQueue();
  assert.equal((await itemOf(praise.id)).section,'influencer');
  assert.equal((await list('admin','general')).filter(i=>i.post_id===praise.id).length,0);
});

test('story merge keeps each story history, notes, assignment and completion; work follows without double credit',async()=>{
  const a=await story();const pa=await post();await join(a,pa,true);
  const b=await story();const pb=await post();await join(b,pb,true);
  await intakeQueue();
  let ua=await unitOf(a);const ub=await unitOf(b);
  ua=ok(await call(app,tok.supervisor,'POST',`${base}/items/${ua.id}/assign`,{expectedVersion:ua.version,assigneeId:uid.agent}));
  ua=ok(await call(app,tok.agent,'POST',`${base}/items/${ua.id}/notes`,{expectedVersion:ua.version,body:'ملاحظة قبل الدمج'}));
  const eventsBefore=(await sql`SELECT id,event_type,version FROM queue_events WHERE queue_item_id=${ua.id}::uuid ORDER BY version`);
  const notesBefore=(await sql`SELECT id,body FROM queue_notes WHERE queue_item_id=${ua.id}::uuid`);
  await sql`UPDATE signal_story_members SET story_id=${b}::uuid WHERE story_id=${a}::uuid`;
  await sql`DELETE FROM signal_stories WHERE id=${a}::uuid`;
  await intakeQueue();
  const merged=(await sql`SELECT * FROM queue_items WHERE id=${ua.id}::uuid`)[0];
  // Nothing of A is lost: same events (plus the merge), same notes, same assignee and cycle.
  const eventsAfter=(await sql`SELECT id,event_type,version FROM queue_events WHERE queue_item_id=${ua.id}::uuid ORDER BY version`);
  assert.deepEqual(eventsAfter.slice(0,eventsBefore.length).map(e=>e.id),eventsBefore.map(e=>e.id));
  assert.equal(eventsAfter.at(-1)!.event_type,'story_merged');
  assert.deepEqual((await sql`SELECT id,body FROM queue_notes WHERE queue_item_id=${ua.id}::uuid`).map(n=>n.id),notesBefore.map(n=>n.id));
  assert.equal(merged.assignee_id,uid.agent);assert.equal(merged.status,'assigned');assert.equal(merged.merged_into_id,ub.id);
  // The surviving, unowned story is handed to the same agent by an audited assignment.
  const target=(await sql`SELECT * FROM queue_items WHERE id=${ub.id}::uuid`)[0];
  assert.equal(target.assignee_id,uid.agent);assert.equal(target.status,'assigned');
  const handoff=(await sql`SELECT event_type,reason,metadata FROM queue_events WHERE queue_item_id=${ub.id}::uuid ORDER BY version`).at(-1)!;
  assert.equal(handoff.event_type,'assigned');assert.equal(handoff.metadata.fromItem,ua.id);
  // Workload counts the live unit once, never the frozen merged one.
  const workload=async()=>ok(await get('supervisor',`${base}/summary?range=all`)).workload.find((x:{id:string})=>x.id===uid.agent);
  const open=(await sql`SELECT count(*)::int AS n FROM queue_items WHERE assignee_id=${uid.agent}::uuid AND status IN ('assigned','in_progress') AND merged_into_id IS NULL AND team_id=${team}::uuid`)[0].n;
  assert.equal((await workload()).open,open);
  assert.equal((await workload()).escalated,(await sql`SELECT count(*)::int AS n FROM queue_items WHERE assignee_id=${uid.agent}::uuid AND status='escalated' AND merged_into_id IS NULL AND team_id=${team}::uuid`)[0].n);
  // Completing the surviving unit is one completion; the merged unit never completes on its own.
  let t2=target;
  const doneBefore=(await workload()).completed_today;
  t2=ok(await call(app,tok.agent,'POST',`${base}/items/${ub.id}/complete`,{expectedVersion:t2.version,review:{outcome:'confirmed'}}));
  await intakeQueue();
  assert.equal((await workload()).completed_today,doneBefore+1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_events WHERE queue_item_id=${ua.id}::uuid AND event_type='completed'`)[0].n,0);
  // The surviving story lists the merged one, whose drawer still has its own history.
  assert.equal(ok(await get('admin',`${base}/items/${ub.id}`)).merged[0].id,ua.id);
  const old=ok(await get('admin',`${base}/items/${ua.id}`));
  assert.equal(old.notes.length,1);assert.ok(old.events.some((e:{event_type:string})=>e.event_type==='note_added'));
});

test('transfer between teams: scope, validation, conflict, audit, placement and alerts',async()=>{
  // A post held in team 1 because its story belongs to team 2.
  const p=await post({influencer:true});await intakeQueue();let item=await itemOf(p.id);
  item=ok(await call(app,tok.supervisor,'POST',`${base}/items/${item.id}/assign`,{expectedVersion:item.version,assigneeId:uid.agent}));
  const s=await story(program2);await join(s,p,true);const other=await post({program:program2});await join(s,other);
  await intakeQueue();item=await itemOf(p.id);assert.equal(item.section_hold,'story');
  const unit=await unitOf(s);
  assert.equal(ok(await get('supervisor',`${base}/items/${item.id}`)).hold_team_id,team2);
  const body=(over:object={})=>({expectedVersion:item.version,teamId:team2,assigneeId:uid.agent2,reason:'القصة يتابعها فريق آخر',...over});
  const transfer=(who:string,over:object={})=>call(app,tok[who],'POST',`${base}/items/${item.id}/transfer`,body(over));
  assert.equal((await transfer('agent')).statusCode,403,'agents cannot transfer');
  assert.equal((await transfer('viewer')).statusCode,403);
  assert.equal((await transfer('supervisor')).statusCode,404,'target team outside the supervisor scope');
  assert.equal((await transfer('sup2')).statusCode,404,'source item outside the supervisor scope');
  assert.equal((await transfer('sup3',{expectedVersion:item.version-1})).statusCode,409);
  assert.equal((await transfer('sup3',{assigneeId:uid.agent})).statusCode,400,'assignee must belong to the target team');
  assert.equal((await transfer('sup3',{reason:'  '})).statusCode,400,'reason is required');
  assert.equal((await transfer('sup3',{teamId:team})).statusCode,400,'same team is an assignment, not a transfer');
  assert.equal((await itemOf(p.id)).version,item.version,'refused transfers change nothing');

  const moved=ok(await transfer('sup3'));
  assert.equal(moved.team_id,team2);assert.equal(moved.assignee_id,uid.agent2);assert.equal(moved.status,'assigned');
  assert.equal(moved.section,'story');assert.equal(moved.story_item_id,unit.id);assert.equal(moved.section_hold,null);
  const ev=(await sql`SELECT * FROM queue_events WHERE queue_item_id=${item.id}::uuid ORDER BY version`).at(-1)!;
  assert.equal(ev.event_type,'transferred');assert.equal(ev.from_assignee,uid.agent);assert.equal(ev.to_assignee,uid.agent2);
  assert.equal(ev.metadata.fromTeam,team);assert.equal(ev.metadata.toTeam,team2);assert.equal(ev.reason,'القصة يتابعها فريق آخر');
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='queue.transfer' AND entity_id=${item.id}::uuid`)[0].n,1);
  // The previous assignee loses it; the new one sees it with its whole history.
  assert.equal((await get('agent',`${base}/items/${item.id}`)).statusCode,404);
  assert.ok(ok(await get('agent2',`${base}/items/${item.id}`)).events.some((e:{event_type:string})=>e.event_type==='section_review'));
  // A story-section handover is an assignment alert for the new assignee only.
  assert.deepEqual((await sql`SELECT r.user_id FROM queue_alerts a JOIN queue_alert_recipients r ON r.alert_id=a.id
    WHERE a.queue_event_id=${ev.id}::uuid`).map(r=>r.user_id),[uid.agent2]);
  // The worker leaves it where the transfer put it.
  await intakeQueue();assert.equal((await itemOf(p.id)).version,moved.version);

  // A general item transfers silently; completed items and story units do not transfer.
  const g=await post();await intakeQueue();const gi=await itemOf(g.id);
  const gm=ok(await call(app,tok.admin,'POST',`${base}/items/${gi.id}/transfer`,{expectedVersion:gi.version,teamId:team2,assigneeId:uid.agent2,reason:'إعادة توزيع'}));
  assert.equal(gm.section,'general');
  assert.equal((await sql`SELECT count(*)::int AS n FROM queue_alerts WHERE queue_item_id=${gi.id}::uuid`)[0].n,0);
  assert.equal((await call(app,tok.sup3,'POST',`${base}/items/${unit.id}/transfer`,{expectedVersion:unit.version,teamId:team,assigneeId:uid.agent,reason:'x'})).statusCode,409);
  const done=ok(await call(app,tok.agent2,'POST',`${base}/items/${gi.id}/complete`,{expectedVersion:gm.version,review:{outcome:'confirmed'}}));
  assert.equal((await call(app,tok.admin,'POST',`${base}/items/${gi.id}/transfer`,{expectedVersion:done.version,teamId:team,assigneeId:uid.agent,reason:'x'})).statusCode,409);
});
