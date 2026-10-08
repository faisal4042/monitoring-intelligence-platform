/**
 * Unified dashboard: filtering, definitions, effective classification, scope
 * and preferences, on the guarded *_test database with synthetic rows only.
 *
 * Each run creates its own programs, so program-scoped figures are exact.
 * All-programs figures are checked against a direct SQL count of the same
 * window (other suites share the database).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedDateKey } from '@mip/shared';
// The harness must be the first import that reaches @mip/db (it points every pool at *_test).
import { analyticsSql, call, createUser, login, makeApp, sql, type App } from './harness.js';
import { cached, cacheKeyFor } from '../modules/dashboard/base.js';
import { parseFilters } from '../modules/dashboard/filters.js';

let app: App;
const tok: Record<string, string> = {}; const uid: Record<string, string> = {};
const RUN = Date.now().toString(36);
const base = '/api/v1/dashboard';
const DAY = 86_400_000;
const day = (offset: number) => zonedDateKey(new Date(Date.now() + offset * DAY));
// Current = the 7 days ending three days ago; previous = the 7 days before.
const D = -3;
const window = `from=${day(D - 6)}&to=${day(D)}`;
const at = (offset: number, hour = 12) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00+03:00`;
let A: { id: string; key: string }, B: { id: string; key: string };
let topic: string, sub: string, team: string, influencerId: string, inflAuthor: string;
const ids: Record<string, string> = {};

const get = (who: string, path: string) => call(app, tok[who], 'GET', base + path);
const ok = async (res: Awaited<ReturnType<typeof call>> | Promise<Awaited<ReturnType<typeof call>>>, code = 200) => {
  const r = await res; assert.equal(r.statusCode, code, r.body); return r.json();
};
const q = (program: string | null, extra = '') => `?${window}${program ? `&program=${program}` : ''}${extra}`;

interface P { program: string | null; at: string; intent?: string | null; relevance?: string | null; sentiment?: string | null;
  topicId?: string | null; hashtags?: string[] | null; text?: string; status?: string; redacted?: boolean; author?: string }
async function post(p: P) {
  const id = crypto.randomUUID();
  const author = p.author ?? (await sql<{ id: string }[]>`INSERT INTO authors(x_author_id,username) VALUES (${'dash-' + id},${'u' + id.slice(0, 8)}) RETURNING id`)[0].id;
  await sql`INSERT INTO posts(id,x_post_id,x_author_id,author_id,text,text_normalized,posted_at,content_hash,status,is_redacted,hashtags)
    VALUES (${id},${id},${'dash-' + id},${author},${p.text ?? 'منشور اختبار'},${p.text ?? 'منشور اختبار'},${p.at},'\\x00',
      ${p.status ?? 'classified'},${p.redacted ?? false},${p.hashtags ?? null})`;
  if (p.relevance !== null && p.status !== 'filtered_out')
    await sql`INSERT INTO post_classifications(post_id,posted_at,relevance,intent,program_id,topic_id,stage)
      VALUES (${id},${p.at},${p.relevance ?? 'relevant'},${p.intent ?? null},${p.program},${p.topicId ?? null},1)`;
  if (p.sentiment) await sql`INSERT INTO post_sentiments(post_id,posted_at,label,stage) VALUES (${id},${p.at},${p.sentiment},1)`;
  return id;
}

before(async () => {
  app = await makeApp();
  // The guarded test DB only covers months from when it was created; add the past months this suite uses.
  for (const offset of [D - 13, 0]) {
    const m = new Date(Date.now() + offset * DAY); const y = m.getUTCFullYear(), mo = m.getUTCMonth();
    for (const t of ['posts', 'post_classifications', 'post_sentiments', 'post_metrics', 'api_usage']) {
      const s = new Date(Date.UTC(y, mo, 1)).toISOString(), e = new Date(Date.UTC(y, mo + 1, 1)).toISOString();
      const name = `${t}_${y}_${String(mo + 1).padStart(2, '0')}`;
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS public.${name} PARTITION OF public.${t} FOR VALUES FROM ('${s}') TO ('${e}')`);
    }
  }
  for (const role of ['admin', 'supervisor', 'agent', 'viewer', 'analyst']) {
    const u = await createUser(role); tok[role] = (await login(app, u.email)).accessToken; uid[role] = u.id;
  }
  const s2 = await createUser('supervisor'); tok.sup2 = (await login(app, s2.email)).accessToken; uid.sup2 = s2.id;
  const a2 = await createUser('agent'); tok.agent2 = (await login(app, a2.email)).accessToken; uid.agent2 = a2.id;
  const mk = async (n: string) => (await sql<{ id: string; key: string }[]>`INSERT INTO programs(key,name_ar,name_en,color)
    VALUES (${`dash_${n}_${RUN}`},${'برنامج اختبار ' + n},${'Dashboard ' + n},'#0ea5e9') RETURNING id,key`)[0];
  A = await mk('a'); B = await mk('b');
  [{ id: topic }] = await sql`INSERT INTO topics(program_id,level,name_ar) VALUES (${A.id},1,'العقود') RETURNING id`;
  [{ id: sub }] = await sql`INSERT INTO topics(program_id,parent_id,level,name_ar) VALUES (${A.id},${topic},2,'توثيق العقد') RETURNING id`;
  team = (await ok(call(app, tok.admin, 'POST', '/api/v1/teams', { name: 'Dashboard ' + RUN }), 201)).id;
  await ok(call(app, tok.admin, 'PUT', `/api/v1/teams/${team}/programs`, { programIds: [A.id] }));
  for (const u of [uid.agent, uid.supervisor]) await ok(call(app, tok.admin, 'POST', `/api/v1/teams/${team}/members`, { userId: u }));
  // A second team (program B) with its own supervisor and agent: must never see A's queue figures.
  const team2 = (await ok(call(app, tok.admin, 'POST', '/api/v1/teams', { name: 'Dashboard B ' + RUN }), 201)).id;
  await ok(call(app, tok.admin, 'PUT', `/api/v1/teams/${team2}/programs`, { programIds: [B.id] }));
  for (const u of [uid.sup2, uid.agent2]) await ok(call(app, tok.admin, 'POST', `/api/v1/teams/${team2}/members`, { userId: u }));

  const username = `dash_inf_${RUN}`;
  [{ id: influencerId }] = await sql`INSERT INTO tracked_influencers(username) VALUES (${username}) RETURNING id`;
  [{ id: inflAuthor }] = await sql`INSERT INTO authors(x_author_id,username,display_name) VALUES (${'dash-inf-' + RUN},${username},'حساب مؤثر') RETURNING id`;

  // Program A, current window.
  ids.c1 = await post({ program: A.id, at: at(D - 3), intent: 'complaint', sentiment: 'negative', topicId: sub, hashtags: ['إيجار', 'ايجار'], author: inflAuthor });
  ids.c2 = await post({ program: A.id, at: at(D - 3, 15), intent: 'complaint', sentiment: 'positive', topicId: sub, hashtags: ['إيجار'], author: inflAuthor });
  ids.c3 = await post({ program: A.id, at: at(D - 1), intent: 'complaint' });
  ids.i1 = await post({ program: A.id, at: at(D - 1), intent: 'inquiry', sentiment: 'neutral', text: 'سؤال #Rent_2026 ثم #rent_2026 مرة أخرى' });
  ids.i2 = await post({ program: A.id, at: at(D), intent: 'inquiry', sentiment: 'neutral' });
  ids.spam = await post({ program: A.id, at: at(D - 2), relevance: 'spam', hashtags: ['إعلان'] });
  ids.filtered = await post({ program: null, at: at(D - 2), status: 'filtered_out', relevance: null });
  // Not counted anywhere: a duplicate and a redacted post.
  await post({ program: A.id, at: at(D - 2), intent: 'complaint', status: 'duplicate' });
  await post({ program: A.id, at: at(D - 2), intent: 'complaint', redacted: true });
  // A post with no classification at all (not filtered): total but unclassified.
  ids.unclassified = await post({ program: null, at: at(D - 2), relevance: null });
  // Program A, previous window.
  await post({ program: A.id, at: at(D - 10), intent: 'complaint' });
  await post({ program: A.id, at: at(D - 10), intent: 'inquiry' });
  // Program B: 10 complaints now vs 5 before — enough for the complaints rule.
  for (let i = 0; i < 10; i++) await post({ program: B.id, at: at(D - 2), intent: 'complaint', sentiment: i < 2 ? 'negative' : 'neutral' });
  for (let i = 0; i < 5; i++) await post({ program: B.id, at: at(D - 9), intent: 'complaint' });

  // Stories: one approved and active in the window, one candidate (never counted).
  const story = (state: string, first: string) => sql`INSERT INTO signal_stories(program_id,topic_id,title_ar,summary_ar,why_ar,centroid,state,first_seen_at,last_seen_at,post_count,family_count)
    VALUES (${A.id},${topic},'تأخر توثيق العقود','ملخص','لماذا',array_fill(0,ARRAY[1024])::vector,${state},${first},${at(D - 1)},2,${state === 'candidate' ? 1 : 2}) RETURNING id`;
  [{ id: ids.story }] = await story('rising', at(D - 4));
  await story('candidate', at(D - 4));
  await sql`INSERT INTO signal_story_members(story_id,post_id,posted_at,family_key) VALUES (${ids.story},${ids.c1},${at(D - 3)},'f1'),(${ids.story},${ids.c2},${at(D - 3, 15)},'f2')`;

  // News for A: two in the window (one relevant), one outside.
  const [src] = await sql`INSERT INTO news_sources(name_ar,base_url,program_id) VALUES ('مصدر اختبار',${'https://dash-' + RUN + '.test'},${A.id}) RETURNING id`;
  for (const [i, when, rel] of [[1, at(D - 2), true], [2, at(D - 1), false], [3, at(D - 20), true]] as const)
    await sql`INSERT INTO news_articles(source_id,url,canonical_url,url_hash,title,published_at,is_relevant,program_id)
      VALUES (${src.id},${`https://dash-${RUN}.test/${i}`},${`https://dash-${RUN}.test/${i}`},${`dash-${RUN}-${i}`},${'خبر ' + i},${when},${rel},${A.id})`;

  // A human review: i2 is closed with its type corrected to complaint.
  let item = await ok(call(app, tok.admin, 'POST', '/api/v1/queue/items', { postId: ids.i2, postedAt: at(D) }), 201);
  item = await ok(call(app, tok.supervisor, 'POST', `/api/v1/queue/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: uid.agent }));
  item = await ok(call(app, tok.agent, 'POST', `/api/v1/queue/items/${item.id}/start`, { expectedVersion: item.version }));
  item = await ok(call(app, tok.agent, 'POST', `/api/v1/queue/items/${item.id}/complete`,
    { expectedVersion: item.version, review: { outcome: 'corrected', intent: 'complaint', reason: 'النص شكوى' } }));
  ids.item = item.id; ids.itemVersion = String(item.version);
});
after(async () => { await app.close(); await analyticsSql.end({ timeout: 5 }); await sql.end({ timeout: 5 }); });

const kpi = (body: { kpis: Array<{ key: string; value: number | null; previous: number | null; available: boolean }> }, key: string) => body.kpis.find((k) => k.key === key)!;

test('program view: exact KPIs, effective (human) classification, previous period, no other program leaks', async () => {
  const a = await ok(get('admin', '/overview' + q(A.key)));
  assert.equal(a.program.id, A.id);
  assert.equal(kpi(a, 'total').value, 6, 'duplicates, redacted and unlinked posts excluded');
  assert.equal(kpi(a, 'relevant').value, 5);
  assert.equal(kpi(a, 'excluded').value, 1, 'spam (the filtered post has no program)');
  assert.equal(kpi(a, 'complaints').value, 4, 'three AI complaints plus the human-corrected inquiry');
  assert.equal(kpi(a, 'inquiries').value, 1);
  assert.equal(kpi(a, 'complaints').previous, 1); assert.equal(kpi(a, 'inquiries').previous, 1); assert.equal(kpi(a, 'total').previous, 2);
  assert.equal(kpi(a, 'active_influencers').value, 1, 'two posts by one account count once');
  assert.equal(kpi(a, 'approved_stories').value, 1, 'the candidate is not a story');
  assert.equal(kpi(a, 'unique_hashtags').value, 2);
  assert.equal(a.context.humanReviewed, 1);
  // Windows: equal length and adjacent.
  assert.equal(Date.parse(a.previous.to), Date.parse(a.current.from));
  assert.equal(Date.parse(a.current.to) - Date.parse(a.current.from), Date.parse(a.previous.to) - Date.parse(a.previous.from));
  const b = await ok(get('admin', '/overview' + q(B.key)));
  assert.equal(kpi(b, 'total').value, 10); assert.equal(kpi(b, 'complaints').value, 10); assert.equal(kpi(b, 'inquiries').value, 0);
  assert.equal(kpi(b, 'approved_stories').value, 0); assert.equal(kpi(b, 'active_influencers').value, 0);
  // The AI prediction is untouched by the review.
  assert.equal((await sql`SELECT intent::text FROM post_classifications WHERE post_id=${ids.i2}`)[0].intent, 'inquiry');
  // Narrowing filters combine.
  assert.equal(kpi(await ok(get('admin', '/overview' + q(A.key, '&influencersOnly=true'))), 'total').value, 2);
  assert.equal(kpi(await ok(get('admin', '/overview' + q(A.key, '&intent=complaint&sentiment=negative'))), 'total').value, 1);
  assert.equal(kpi(await ok(get('admin', '/overview' + q(A.key, `&topicId=${topic}`))), 'total').value, 2);
  assert.equal(kpi(await ok(get('admin', '/overview' + q(A.key, '&sentiment=unclassified&relevantOnly=true'))), 'total').value, 1);
});

test('all programs: total equals a direct count; each post counted once; program rows add up without overlap', async () => {
  const all = await ok(get('admin', '/overview' + q(null)));
  const [direct] = await sql`SELECT count(*)::int AS n FROM posts WHERE NOT is_redacted AND status<>'duplicate'
    AND posted_at>=${all.current.from}::timestamptz AND posted_at<${all.current.to}::timestamptz`;
  assert.equal(kpi(all, 'total').value, direct.n);
  const programs = await ok(get('admin', '/programs' + q(null)));
  const rowA = programs.items.find((p: { id: string }) => p.id === A.id), rowB = programs.items.find((p: { id: string }) => p.id === B.id);
  assert.equal(rowA.posts, 6); assert.equal(rowA.complaints, 4); assert.equal(rowA.stories, 1); assert.equal(rowA.active_influencers, 1);
  assert.equal(rowB.posts, 10); assert.equal(rowB.negative, 2); assert.equal(rowB.sentiment_sample, 10);
  const sum = programs.items.reduce((n: number, p: { posts: number }) => n + p.posts, 0);
  assert.equal(sum + programs.unlinked, kpi(all, 'total').value, 'one program per post: rows + unlinked = total');
});

test('classifications: real topics, subtopics with parents, complaints per topic, human values used', async () => {
  const c = await ok(get('admin', '/classifications' + q(A.key)));
  assert.deepEqual(c.intents.map((i: { intent: string; count: number }) => [i.intent, i.count]), [['complaint', 4], ['inquiry', 1]]);
  assert.equal(c.intents.find((i: { intent: string }) => i.intent === 'complaint').previous, 1);
  assert.deepEqual(c.topics.map((t: { id: string; count: number; complaints: number }) => [t.id, t.count, t.complaints]), [[topic, 2, 2]]);
  assert.equal(c.subtopics[0].id, sub); assert.equal(c.subtopics[0].parentName, 'العقود');
  assert.equal(c.sample.relevant, 5); assert.equal(c.sample.with_topic, 2);
});

test('sentiment: unclassified kept apart, shares over classified only, by program', async () => {
  const s = await ok(get('admin', '/sentiments' + q(A.key)));
  assert.deepEqual(s.current, { positive: 1, neutral: 2, negative: 1, unclassified: 1 });
  assert.deepEqual(s.previous, { positive: 0, neutral: 0, negative: 0, unclassified: 2 });
  const all = await ok(get('admin', '/sentiments' + q(null)));
  const bNeg = all.byProgram.find((r: { id: string; g: string }) => r.id === B.id && r.g === 'negative');
  assert.equal(bNeg.n, 2);
});

test('hashtags: Arabic forms unified, English case folded, once per post, new vs previous, program-scoped drill-down', async () => {
  const h = await ok(get('admin', '/hashtags' + q(A.key)));
  assert.equal(h.unique, 2, 'spam hashtags are outside the relevant set');
  const ejar = h.top.find((t: { key: string }) => t.key === 'ايجار');
  assert.equal(ejar.posts, 2, 'two spellings in one post count once'); assert.equal(ejar.complaints, 2); assert.equal(ejar.isNew, true);
  const rent = h.top.find((t: { key: string }) => t.key === 'rent_2026');
  assert.equal(rent.posts, 1, 'repeated in the same text, counted once'); assert.equal(rent.previous, 0);
  const drill = await ok(get('admin', '/interactions' + q(A.key, '&hashtag=' + encodeURIComponent('ايجار'))));
  assert.equal(drill.total, ejar.posts);
  assert.equal((await ok(get('admin', '/hashtags' + q(B.key)))).unique, 0);
});

test('influencers: tracked vs active, unique accounts, no invented followers or sentiment on a small sample', async () => {
  const r = await ok(get('admin', '/influencers' + q(A.key)));
  assert.ok(r.tracked >= 1); assert.equal(r.active, 1); assert.equal(r.posts, 2); assert.equal(r.relevantPosts, 2);
  assert.equal(r.top.length, 1); assert.equal(r.top[0].id, influencerId); assert.equal(r.top[0].posts, 2);
  assert.equal(r.top[0].followers_count, null); assert.equal(r.top[0].dominant_sentiment, null, 'sample below minimum');
  assert.equal(r.top[0].program_name, 'برنامج اختبار a');
  const drill = await ok(get('admin', '/interactions' + q(A.key, `&influencerId=${influencerId}`)));
  assert.equal(drill.total, 2);
  assert.equal((await ok(get('admin', '/influencers' + q(B.key)))).active, 0);
});

test('stories and news: approved only, own date bases, news kept apart from X posts', async () => {
  const s = await ok(get('admin', '/stories' + q(A.key)));
  assert.equal(s.approvedTotal, 1); assert.equal(s.active, 1); assert.equal(s.created, 1); assert.equal(s.items[0].family_count, 2);
  const m = await ok(get('admin', '/interactions' + q(A.key, `&storyId=${ids.story}`)));
  assert.equal(m.total, 2); assert.equal(m.story.postCount, 2);
  const n = await ok(get('admin', '/news' + q(A.key)));
  assert.equal(n.total, 2, 'the article outside the window is excluded'); assert.equal(n.relevant, 1);
  assert.equal(n.latest.length, 1); assert.equal(n.bySource[0].articles, 2);
  assert.equal(kpi(await ok(get('admin', '/overview' + q(A.key))), 'total').value, 6, 'news never adds to X totals');
});

test('trends: buckets per day, series sum to the KPIs, a clicked point drills to the same count', async () => {
  const t = await ok(get('admin', '/trends' + q(A.key)));
  assert.equal(t.granularity, 'day'); assert.equal(t.items.length, 7); assert.equal(t.previous.length, 7);
  const sum = (k: string) => t.items.reduce((n: number, i: Record<string, number>) => n + i[k], 0);
  assert.equal(sum('total'), 6); assert.equal(sum('complaints'), 4); assert.equal(sum('inquiries'), 1);
  const point = t.items.find((i: { complaints: number }) => i.complaints === 2);
  const drill = await ok(get('admin', '/interactions' + q(A.key, `&bucket=${encodeURIComponent(point.bucket)}&unit=day&series=complaints`)));
  assert.equal(drill.total, 2);
  // Same figure from the overview drill-down.
  assert.equal((await ok(get('admin', '/interactions' + q(A.key, '&series=complaints')))).total, 4);
});

test('queue performance and AI agreement: scoped, reopen gives no double credit, non-comparable fields excluded', async () => {
  // Reviews are period events by review time (today), not by the post's publication date.
  const recent = `?from=${day(-30)}&to=${day(0)}&program=${A.key}`;
  assert.equal((await ok(get('supervisor', '/ai-quality' + q(A.key)))).reviewed, 0, 'no review happened in the past window');
  let ai = await ok(get('supervisor', '/ai-quality' + recent));
  assert.equal(ai.reviewed, 1); assert.equal(ai.cycles, 1); assert.equal(ai.outcomes.corrected, 1);
  const field = (r: typeof ai, name: string) => r.fields.find((x: { field: string }) => x.field === name);
  assert.deepEqual([field(ai, 'intent').sample, field(ai, 'intent').agreed], [1, 0]);
  assert.deepEqual([field(ai, 'program').sample, field(ai, 'program').agreed], [1, 1]);
  assert.equal(field(ai, 'subtopic').sample, 0, 'the AI gave no subtopic: not comparable'); assert.equal(field(ai, 'subtopic').rate, null);
  assert.equal(ai.mostCorrected[0].field, 'intent'); assert.equal(ai.mostCorrected[0].ai_value, 'inquiry');
  // Reopen and close again as confirmed: one item, two cycles; agreement follows the latest review.
  let item = await ok(call(app, tok.supervisor, 'POST', `/api/v1/queue/items/${ids.item}/reopen`, { expectedVersion: Number(ids.itemVersion), reason: 'مراجعة ثانية' }));
  item = await ok(call(app, tok.agent, 'POST', `/api/v1/queue/items/${ids.item}/complete`, { expectedVersion: item.version, review: { outcome: 'confirmed' } }));
  ai = await ok(get('supervisor', '/ai-quality' + `?from=${day(-30)}&to=${day(0)}&program=${A.key}`));
  assert.equal(ai.reviewed, 1); assert.equal(ai.cycles, 2); assert.deepEqual([field(ai, 'intent').sample, field(ai, 'intent').agreed], [1, 1]);
  const ops = await ok(get('supervisor', '/operations' + `?from=${day(-30)}&to=${day(0)}&program=${A.key}`));
  assert.equal(ops.period.closed_items, 1); assert.equal(ops.period.review_cycles, 2); assert.equal(ops.period.reopened, 1);
  assert.equal(ops.snapshot.in_progress, 0);
  const emp = ops.employees.find((e: { id: string }) => e.id === uid.agent);
  assert.equal(emp.closed_items, 1); assert.equal(emp.review_cycles, 2); assert.ok(emp.avg_review_handling_min !== undefined);
  // Agent: own figures only, no employee table. Other team's supervisor and agent: nothing of A.
  const mine = await ok(get('agent', '/operations' + `?from=${day(-30)}&to=${day(0)}`));
  assert.equal(mine.scope, 'own'); assert.deepEqual(mine.employees, []); assert.ok(mine.period.closed_items >= 1);
  for (const who of ['sup2', 'agent2']) {
    const other = await ok(get(who, '/ai-quality' + `?from=${day(-30)}&to=${day(0)}&program=${A.key}`));
    assert.equal(other.reviewed, 0, who);
    const otherOps = await ok(get(who, '/operations' + `?from=${day(-30)}&to=${day(0)}`));
    assert.ok(!otherOps.employees.some((e: { id: string }) => e.id === uid.agent), who);
  }
});

test('RBAC: dashboard needs posts:read; sections need their own permission; queue sections need queue scope', async () => {
  for (const who of ['viewer', 'analyst']) {
    await ok(get(who, '/overview' + q(A.key)));
    assert.equal((await get(who, '/operations' + q(A.key))).statusCode, 403, who);
    assert.equal((await get(who, '/ai-quality' + q(A.key))).statusCode, 403, who);
  }
  // Agents hold no influencers:read: the section is refused and its KPI is withheld, not zero.
  assert.equal((await get('agent', '/influencers' + q(A.key))).statusCode, 403);
  const agentView = await ok(get('agent', '/overview' + q(A.key)));
  assert.equal(kpi(agentView, 'active_influencers').available, false); assert.equal(kpi(agentView, 'active_influencers').value, null);
  assert.equal((await get('agent', '/interactions' + q(A.key, `&influencerId=${influencerId}`))).statusCode, 400);
  const meta = await ok(get('agent', '/meta'));
  assert.equal(meta.capabilities.influencers, false); assert.equal(meta.capabilities.queueScope, 'own');
  assert.ok(meta.programs.some((p: { id: string }) => p.id === A.id));
  assert.equal((await call(app, null, 'GET', base + '/overview')).statusCode, 401);
});

test('validation: unknown params, programs, dates and injection attempts are rejected or inert', async () => {
  assert.equal((await get('admin', '/overview?program=' + encodeURIComponent("x' OR 1=1--"))).statusCode, 400);
  assert.equal((await get('admin', '/overview?program=nope_' + RUN)).statusCode, 400);
  assert.equal((await get('admin', '/overview?range=365d')).statusCode, 400);
  assert.equal((await get('admin', '/overview?from=2026-02-30')).statusCode, 400);
  assert.equal((await get('admin', `/overview?from=${day(0)}&to=${day(-5)}`)).statusCode, 400);
  assert.equal((await get('admin', '/overview?userId=' + uid.viewer)).statusCode, 400, 'strict: unknown keys');
  assert.equal((await get('admin', '/overview?topicId=1;DROP TABLE posts')).statusCode, 400);
  const inert = await ok(get('admin', '/interactions' + q(A.key, '&hashtag=' + encodeURIComponent("a'); DROP TABLE posts;--"))));
  assert.equal(inert.total, 0);
  assert.ok((await sql`SELECT to_regclass('public.posts') AS t`)[0].t);
  // Default period when none is given: the last 30 days.
  assert.equal((await ok(get('admin', '/overview'))).range.preset, '30d');
  await ok(get('admin', '/overview?range=90d'));
});

test('insights: explainable rules with minimum samples', async () => {
  const b = await ok(get('admin', '/insights' + q(B.key)));
  const rise = b.items.find((i: { key: string }) => i.key === 'complaints_rise');
  assert.ok(rise, 'B: 10 vs 5 complaints'); assert.match(rise.title, /100/); assert.match(rise.detail, /10/);
  const a = await ok(get('admin', '/insights' + q(A.key)));
  assert.ok(!a.items.some((i: { key: string }) => i.key === 'complaints_rise'), 'A: 4 vs 1 is below the minimum sample');
  // Viewers get no queue-based insight.
  assert.ok(!(await ok(get('viewer', '/insights' + q(A.key)))).items.some((i: { key: string }) => i.key.startsWith('queue') || i.key.startsWith('ai_')));
  assert.equal((await ok(get('admin', '/insights?range=all'))).comparable, false);
});

test('preferences: per user and scope, validated, isolated, resettable', async () => {
  const layout = { sections: [{ id: 'hashtags', visible: true }, { id: 'trend', visible: false }], kpis: ['complaints', 'total'], defaultPeriod: '7d', defaultProgram: A.key };
  await ok(call(app, tok.viewer, 'PUT', base + '/preferences', { layout }));
  await ok(call(app, tok.viewer, 'PUT', base + '/preferences', { program: A.key, layout: { ...layout, kpis: ['inquiries'] } }));
  const mine = await ok(get('viewer', `/preferences?program=${A.key}`));
  assert.deepEqual(mine.all.layout.kpis, ['complaints', 'total']); assert.deepEqual(mine.program.layout.kpis, ['inquiries']);
  assert.equal(mine.program.layout.defaultProgram, undefined, 'only the all-programs layout picks a default program');
  // Another user sees nothing of it and cannot target it.
  assert.deepEqual(await ok(get('analyst', `/preferences?program=${A.key}`)), { all: null, program: null });
  assert.equal((await call(app, tok.analyst, 'PUT', base + '/preferences', { userId: uid.viewer, layout })).statusCode, 400);
  // Invalid layouts are refused.
  for (const bad of [{ ...layout, sections: [{ id: 'secret', visible: true }] }, { ...layout, kpis: ['total', 'total'] },
    { ...layout, sections: [{ id: 'trend', visible: true }, { id: 'trend', visible: false }] }, { ...layout, extra: 1 }])
    assert.equal((await call(app, tok.viewer, 'PUT', base + '/preferences', { layout: bad })).statusCode, 400);
  await ok(call(app, tok.viewer, 'DELETE', base + `/preferences?program=${A.key}`));
  const after = await ok(get('viewer', `/preferences?program=${A.key}`));
  assert.equal(after.program, null); assert.ok(after.all, 'resetting one scope keeps the other');
  assert.equal((await sql`SELECT count(*)::int AS n FROM dashboard_preferences WHERE user_id=${uid.analyst}`)[0].n, 0);
});

test('cache: keys carry the section and every result-changing filter; a filter change never reuses a result', async () => {
  const fa = await parseFilters({ program: A.key, from: day(D - 6), to: day(D) });
  const fb = await parseFilters({ program: B.key, from: day(D - 6), to: day(D) });
  const fc = await parseFilters({ program: A.key, from: day(D - 6), to: day(D), intent: 'complaint' });
  assert.notEqual(cacheKeyFor('overview', fa), cacheKeyFor('overview', fb));
  assert.notEqual(cacheKeyFor('overview', fa), cacheKeyFor('overview', fc));
  assert.notEqual(cacheKeyFor('overview:true:true', fa), cacheKeyFor('overview:false:true', fa), 'permission flags are part of the key');
  let calls = 0;
  const compute = async () => ++calls;
  assert.equal(await cached('t', fa, compute, 60_000), 1);
  assert.equal(await cached('t', fa, compute, 60_000), 1, 'hit');
  assert.equal(await cached('t', fb, compute, 60_000), 2, 'other program');
  assert.equal(await cached('t', { ...fa, fresh: true }, compute, 60_000), 3, 'manual refresh bypasses');
});
