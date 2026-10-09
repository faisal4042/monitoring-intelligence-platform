/**
 * Optional local-only synthetic data for looking at the dashboard in a
 * browser. Guarded to the local mip_test database; never runs at startup.
 * Every text is marked as test data so it can never pass for real monitoring.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { call, createUser, login, makeApp, sql, PASSWORD } from './harness.js';

if (new URL(process.env.DATABASE_URL!).pathname !== '/mip_test') throw new Error('Preview requires local mip_test');
const DAY = 86_400_000;
const app = await makeApp();
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(a: readonly T[]) => a[rnd(a.length)];
try {
  // Past months the test DB may not cover yet (test database only).
  for (let back = 0; back <= 3; back++) {
    const m = new Date(Date.now() - back * 30 * DAY); const y = m.getUTCFullYear(), mo = m.getUTCMonth();
    for (const t of ['posts', 'post_classifications', 'post_sentiments', 'post_metrics', 'api_usage'])
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS public.${t}_${y}_${String(mo + 1).padStart(2, '0')} PARTITION OF public.${t}
        FOR VALUES FROM ('${new Date(Date.UTC(y, mo, 1)).toISOString()}') TO ('${new Date(Date.UTC(y, mo + 1, 1)).toISOString()}')`);
  }
  const accounts: Record<string, { id: string; email: string; password: string }> = {};
  const tokens: Record<string, string> = {};
  for (const role of ['admin', 'supervisor', 'agent', 'viewer', 'analyst']) {
    const u = await createUser(role); accounts[role] = { id: u.id, email: u.email, password: PASSWORD }; tokens[role] = (await login(app, u.email)).accessToken;
  }
  const programs = await sql<{ id: string; key: string }[]>`SELECT id,key FROM programs WHERE key IN ('ejar','rega','mullak','mostadam')`;
  const run = async (method: string, path: string, body?: unknown, token = tokens.admin) => {
    const r = await call(app, token, method, path, body); if (r.statusCode >= 400) throw new Error(`${path}: ${r.body}`); return r.json();
  };
  const team = await run('POST', '/api/v1/teams', { name: `فريق معاينة اللوحة ${Date.now().toString(36)}` });
  await sql`DELETE FROM team_programs WHERE program_id=${programs.find((p) => p.key === 'ejar')!.id}`;
  await run('PUT', `/api/v1/teams/${team.id}/programs`, { programIds: [programs.find((p) => p.key === 'ejar')!.id] });
  for (const u of [accounts.agent.id, accounts.supervisor.id]) await run('POST', `/api/v1/teams/${team.id}/members`, { userId: u });

  const TOPICS: Record<string, Array<[string, string[]]>> = {
    ejar: [['العقود (اختبار)', ['توثيق العقد', 'تجديد العقد']], ['المدفوعات (اختبار)', ['الدفعات المتأخرة', 'الفواتير']]],
    rega: [['الوساطة (اختبار)', ['رخص الوساطة']], ['التراخيص (اختبار)', ['تجديد الرخصة']]],
    mullak: [['اتحاد الملاك (اختبار)', ['رسوم الصيانة']]],
    mostadam: [['الشهادات (اختبار)', ['تقييم المباني']]],
  };
  const topicIds: Record<string, string[]> = {};
  for (const p of programs) {
    topicIds[p.key] = [];
    for (const [main, subs] of TOPICS[p.key]) {
      const [t] = await sql`INSERT INTO topics(program_id,level,name_ar) VALUES (${p.id},1,${main}) RETURNING id`;
      for (const s of subs) { const [st] = await sql`INSERT INTO topics(program_id,parent_id,level,name_ar) VALUES (${p.id},${t.id},2,${s + ' (اختبار)'}) RETURNING id`; topicIds[p.key].push(st.id); }
      topicIds[p.key].push(t.id);
    }
  }
  const influencers: string[] = [];
  for (let i = 0; i < 4; i++) {
    const username = `preview_inf_${i}_${Date.now().toString(36)}`;
    await sql`INSERT INTO tracked_influencers(username) VALUES (${username})`;
    const [a] = await sql`INSERT INTO authors(x_author_id,username,display_name,followers_count) VALUES (${'pv-' + username},${username},${'حساب مؤثر تجريبي ' + (i + 1)},${i === 0 ? null : 1000 * (i + 3)}) RETURNING id`;
    influencers.push(a.id);
  }
  const TAGS = ['إيجار', 'ايجار', 'Ejar_Support', 'الوساطة_العقارية', 'ملاك', 'عقد_موحد', 'تجديد'];
  const INTENTS = ['complaint', 'inquiry', 'inquiry', 'complaint', 'praise', 'suggestion', 'news', 'request'] as const;
  const SENT = ['very_positive', 'positive', 'neutral', 'neutral', 'negative', 'very_negative', null] as const;
  const weight: Record<string, number> = { ejar: 9, rega: 4, mullak: 3, mostadam: 1 };
  let made = 0;
  const reviewable: Array<{ id: string; at: string }> = [];
  for (let d = 0; d < 75; d++) {
    for (const p of programs) {
      const n = rnd(weight[p.key] + (d < 7 ? 3 : 0)) + (p.key === 'ejar' ? 2 : 0);
      for (let i = 0; i < n; i++) {
        const id = crypto.randomUUID(); const at = new Date(Date.now() - d * DAY - rnd(20) * 3_600_000).toISOString();
        const relevance = Math.random() < 0.18 ? pick(['irrelevant', 'spam', 'advertisement'] as const) : 'relevant';
        const author = Math.random() < 0.08 ? pick(influencers) : (await sql`INSERT INTO authors(x_author_id,username) VALUES (${'pv-a-' + id},${'u' + id.slice(0, 8)}) RETURNING id`)[0].id;
        const tags = Math.random() < 0.35 ? [pick(TAGS), ...(Math.random() < 0.3 ? [pick(TAGS)] : [])] : null;
        await sql`INSERT INTO posts(id,x_post_id,x_author_id,author_id,text,text_normalized,posted_at,content_hash,status,hashtags,is_reply)
          VALUES (${id},${id},${'pv-' + id},${author},${'[بيانات اختبار] تفاعل تجريبي للمعاينة رقم ' + made},${'تفاعل تجريبي'},${at},'\\x00','classified',${tags},${Math.random() < 0.3})`;
        const intent = relevance === 'relevant' ? pick(INTENTS) : null;
        await sql`INSERT INTO post_classifications(post_id,posted_at,relevance,intent,program_id,topic_id,stage,intent_confidence)
          VALUES (${id},${at},${relevance},${intent},${p.id},${relevance === 'relevant' && Math.random() < 0.8 ? pick(topicIds[p.key]) : null},1,${0.6 + Math.random() * 0.39})`;
        const s = pick(SENT);
        if (s) await sql`INSERT INTO post_sentiments(post_id,posted_at,label,stage,confidence) VALUES (${id},${at},${s},1,0.8)`;
        if (p.key === 'ejar' && relevance === 'relevant' && d < 5 && reviewable.length < 6) reviewable.push({ id, at });
        made++;
      }
    }
  }
  // A few unclassified and filtered posts, and some news per program.
  for (let i = 0; i < 12; i++) {
    const id = crypto.randomUUID(); const at = new Date(Date.now() - rnd(30) * DAY).toISOString();
    await sql`INSERT INTO posts(id,x_post_id,x_author_id,text,text_normalized,posted_at,content_hash,status) VALUES
      (${id},${id},'pv-none',${'[بيانات اختبار] غير مصنف'},'غير مصنف',${at},'\\x00',${i % 2 ? 'filtered_out' : 'ingested'})`;
  }
  for (const p of programs) {
    const [src] = await sql`INSERT INTO news_sources(name_ar,base_url,program_id) VALUES (${'صحيفة تجريبية — ' + p.key},${`https://preview-${p.key}-${Date.now()}.test`},${p.id}) RETURNING id`;
    for (let i = 0; i < 8; i++) {
      const at = new Date(Date.now() - rnd(40) * DAY).toISOString(); const u = `https://preview-${p.key}-${Date.now()}-${i}.test/news`;
      await sql`INSERT INTO news_articles(source_id,url,canonical_url,url_hash,title,published_at,is_relevant,program_id,topic_id)
        VALUES (${src.id},${u},${u},${u},${'[بيانات اختبار] خبر تجريبي ' + (i + 1)},${at},${i % 3 !== 0},${p.id},${i % 2 ? pick(topicIds[p.key]) : null})`;
    }
    for (let i = 0; i < (p.key === 'ejar' ? 3 : 1); i++)
      await sql`INSERT INTO signal_stories(program_id,topic_id,title_ar,summary_ar,why_ar,centroid,state,first_seen_at,last_seen_at,post_count,family_count)
        VALUES (${p.id},${topicIds[p.key][0]},${'[اختبار] قصة تجريبية ' + (i + 1)},'ملخص تجريبي للقصة لأغراض المعاينة فقط','سبب تجريبي',
          array_fill(0,ARRAY[1024])::vector,${pick(['new', 'rising', 'steady'] as const)},${new Date(Date.now() - (5 + i) * DAY).toISOString()},${new Date(Date.now() - i * DAY).toISOString()},${5 + rnd(20)},${2 + rnd(4)})`;
  }
  // Human reviews through the real queue workflow (some confirm, some correct).
  for (const [i, r] of reviewable.entries()) {
    let item = await run('POST', '/api/v1/queue/items', { postId: r.id, postedAt: r.at });
    item = await run('POST', `/api/v1/queue/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: accounts.agent.id }, tokens.supervisor);
    if (i === 5) continue; // left assigned: shows in "now" figures
    if (i === 4) continue; // also left in the box
    await run('POST', `/api/v1/queue/items/${item.id}/complete`, { expectedVersion: item.version,
      review: i % 2 ? { outcome: 'confirmed' } : { outcome: 'corrected', intent: 'complaint', reason: 'تصحيح تجريبي' } }, tokens.agent).catch(async () =>
      run('POST', `/api/v1/queue/items/${item.id}/complete`, { expectedVersion: item.version, review: { outcome: 'corrected', intent: 'inquiry', reason: 'تصحيح تجريبي' } }, tokens.agent));
  }
  const file = join(tmpdir(), 'mip-dashboard-preview.json');
  await writeFile(file, JSON.stringify({ accounts, posts: made }, null, 2));
  console.log(`Synthetic dashboard preview: ${made} posts; accounts saved to ${file}`);
} finally { await app.close(); await sql.end(); }
