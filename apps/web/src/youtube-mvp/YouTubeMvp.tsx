/**
 * Isolated YouTube MVP test page. Talks only to the separate YouTube test server (/yt-api → 127.0.0.1:3013) and is
 * served by vite.youtube-mvp.config.ts (127.0.0.1:5183). It is not part of MIP's app, routes or permissions.
 * Shows original YouTube data and statistics only — no sentiment, no derived metrics.
 */
import {useCallback, useEffect, useMemo, useState} from 'react';

type Json = Record<string, any>;
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`/yt-api${path}`, {...init, headers: {'Content-Type': 'application/json', ...(init?.headers ?? {})}});
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};
const riyadh = (v?: string | null) => v ? new Date(v).toLocaleString('ar-SA-u-nu-latn', {timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short'}) : '—';
const num = (v: unknown) => v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US');
const dur = (s: number | null) => s === null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const BUCKET_AR: Record<string, string> = {default: 'الحصة العامة (وحدات)', search: 'طلبات البحث', batch_stats: 'إحصاءات الدفعات'};
const MODE_AR: Record<string, string> = {mock: 'Mock — بيانات اصطناعية', dry_run: 'Dry Run — بلا طلبات فعلية', live: 'Live — YouTube API'};
const LANE_AR: Record<string, string> = {discovery: 'اكتشاف بالكلمات', channels: 'متابعة قناة', comments: 'تعليقات', stats: 'إحصاءات', retention: 'سياسة الاحتفاظ'};

export default function YouTubeMvp({client=api,canManage=true,integrated=false}:{client?:typeof api;canManage?:boolean;integrated?:boolean}={}) {
  const [status, setStatus] = useState<Json | null>(null);
  const [videos, setVideos] = useState<Json[]>([]);
  const [channels, setChannels] = useState<Json[]>([]);
  const [queries, setQueries] = useState<Json[]>([]);
  const [selected, setSelected] = useState<Json | null>(null);
  const [comments, setComments] = useState<Json[] | null>(null);
  const [message, setMessage] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const [dictionary,setDictionary]=useState<Json[]>([]);
  const [program,setProgram]=useState('');
  const [queryId, setQueryId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [newChannel, setNewChannel] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, v, c, q] = await Promise.all([client('/status'), client('/videos'), client('/channels'), client('/queries')]);
      setStatus(s); setVideos(v.items); setChannels(c.items); setQueries(q.items.filter((x:Json)=>x.is_active));
      if(integrated)setDictionary((await client('/dictionary')).items);
      setQueryId(id => id || q.items.find((x:Json)=>x.is_active)?.id || ''); setChannelId(id => id || c.items[0]?.id || '');
    } catch (e) { setMessage({kind: 'error', text: `تعذر الاتصال بخادم الاختبار: ${(e as Error).message}`}); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);

  const act = async (label: string, fn: () => Promise<Json>) => {
    setBusy(true); setMessage(null);
    try {
      const r = await fn(); const res = r.result;
      setMessage({kind: res?.error ? 'error' : 'ok', text: res ? `${label}: ${res.status} — طلبات ${res.calls}، جديد ${res.itemsNew}، محدّث ${res.itemsUpdated}${res.error ? ` — ${res.error}` : ''}` : `${label}: تم`});
      await load();
      if (selected) await openComments(selected);
    } catch (e) { setMessage({kind: 'error', text: `${label}: ${(e as Error).message}`}); }
    finally { setBusy(false); }
  };
  const run = (lane: string, targetId?: string) => act(LANE_AR[lane], () => client('/run', {method: 'POST', body: JSON.stringify({lane, targetId})}));
  const openComments = async (v: Json) => { setSelected(v); setComments(null); setComments((await client(`/videos/${v.id}/comments`)).items); };
  const toggleSwitch = () => {
    const paused = status?.controls?.paused;
    if (paused && !window.confirm(status?.mode === 'live' ? 'استئناف الجمع سيرسل طلبات حقيقية إلى YouTube API ويستهلك الحصة. متابعة؟' : 'استئناف الجمع في وضع الاختبار؟')) return;
    return act(paused ? 'استئناف الجمع' : 'إيقاف الجمع', () => client('/controls', {method: 'POST', body: JSON.stringify({paused: !paused, reason: paused ? 'manual resume from MVP page' : 'manual pause from MVP page'})}));
  };

  const threads = useMemo(() => {
    if (!comments) return [];
    const tops = comments.filter(c => !c.is_reply);
    return tops.map((t): Json => ({...t, replies: comments.filter(c => c.is_reply && c.thread_id === t.thread_id)}));
  }, [comments]);

  const paused = status?.controls?.paused;
  return (
    <div dir="rtl" className="min-h-screen p-4 md:p-6" style={{background: 'var(--color-bg, #f6f7f9)'}}>
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="card p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">رصد YouTube</h1>
            <p className="text-sm opacity-75">{integrated?'رصد الفيديو والقنوات والتعليقات ضمن المنصة':'قاعدة اختبار مستقلة'} · لا تحليل مشاعر أو مؤشرات مشتقة · تشغيل يدوي</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge" data-testid="mode">{MODE_AR[status?.mode] ?? '…'}</span>
            <span className="badge" data-testid="connection">الاتصال: {connectionAr(status?.connection)}</span>
            <span className="badge">المفتاح: {status ? (status.keyConfigured ? 'مُعرّف في Backend' : 'غير مُعرّف') : '…'}</span>
          </div>
        </header>

        {message && <div role="status" data-testid="message" className={`card p-3 text-sm ${message.kind === 'error' ? 'text-(--status-danger)' : 'text-(--status-success)'}`}>{message.text}</div>}

        <section className="grid gap-4 md:grid-cols-4">
          <div className="card p-4" data-testid="kill-switch">
            <h2 className="font-semibold mb-1">مفتاح الإيقاف (YouTube فقط)</h2>
            <p className={`text-lg font-bold ${paused ? 'text-(--status-danger)' : 'text-(--status-success)'}`}>{status ? (paused ? 'الجمع موقوف' : 'الجمع مسموح') : '…'}</p>
            <p className="text-xs opacity-75 mb-2">{status?.controls?.reason} · إخفاقات متتالية: {status?.controls?.consecutive_failures ?? 0}</p>
            <button type="button" className={paused ? 'btn btn-primary' : 'btn btn-danger'} disabled={!canManage || !status || busy} onClick={toggleSwitch}>
              {paused ? 'استئناف الجمع' : 'إيقاف الجمع'}
            </button>
          </div>
          {(status?.quota?.buckets ?? []).map((b: Json) => (
            <div key={b.bucket} className="card p-4" data-testid={`quota-${b.bucket}`}>
              <h2 className="font-semibold mb-1">{BUCKET_AR[b.bucket]}</h2>
              <p className="text-2xl font-bold">{b.used}<span className="text-sm opacity-60"> / {b.limit ?? 'بلا حد داخلي'}</span></p>
              <div className="h-2 rounded bg-black/10 my-2" aria-hidden><div className="h-2 rounded bg-(--status-success)" style={{width: `${Math.min(100, (b.used + b.reserved) / Math.max(b.limit, 1) * 100)}%`}} /></div>
              <p className="text-xs opacity-75">حد داخلي {b.limit ?? 'بلا حد داخلي'} · حد Google {num(b.googleLimit)}{b.exhausted ? ' · نفدت حصة Google اليوم' : ''}</p>
              <p className="text-xs opacity-75">يُصفّر {riyadh(status?.quota?.resetsAt)} (منتصف ليل PT)</p>
            </div>
          ))}
        </section>

        {integrated && <section className="card p-4 space-y-4" data-testid="youtube-dictionary">
          <div className="flex flex-wrap justify-between gap-3"><h2 className="font-semibold">الرصد بكلمات البرامج</h2>
          <button className="btn btn-primary" disabled={!canManage||busy} onClick={()=>act('مزامنة كلمات البرامج',()=>client('/dictionary/sync',{method:'POST',body:'{}'}))}>بناء وتحديث الاستعلامات من قاموس الكلمات</button></div>
          <p className="text-sm opacity-75">كلمات البرامج والخدمات من قاموس إكس مع استبعادات كل برنامج. الكلمات العامة مرتبطة باسم البرنامج. المزامنة لا ترسل طلبات إلى يوتيوب.</p>
          <label className="block">البرنامج <select className="input" value={program} onChange={e=>{setProgram(e.target.value);setQueryId('');}}><option value="">كل البرامج</option>{dictionary.map(p=><option key={p.key} value={p.key}>{p.name_ar}</option>)}</select></label>
          {dictionary.filter(p=>!program||p.key===program).map(p=><details key={p.key} className="rounded border p-3"><summary className="cursor-pointer font-semibold">{p.name_ar} · {p.queries.length} استعلام · {p.words.filter((w:Json)=>w.type==='negative').length} كلمة استبعاد</summary>
          <p className="text-sm my-2">الكلمات: {p.words.filter((w:Json)=>['primary','service','related'].includes(w.type)&&!['mention','from','to'].includes(w.match_mode)).map((w:Json)=>w.term).join('، ')}</p>
          <p className="text-sm my-2">الاستبعادات: {p.words.filter((w:Json)=>w.type==='negative').map((w:Json)=>w.term).join('، ')}</p>
          <p className="text-xs opacity-70">عدّل الكلمات من قاموس الكلمات ثم حدّث الاستعلامات هنا. البحث لآخر 7 أيام أول مرة مع تداخل 6 ساعات بعد ذلك، وصفحة لكل استعلام. كل تشغيل يمر بمفتاح الإيقاف والحصة.</p>
          {p.queries.map((q:Json,i:number)=><pre key={i} dir="ltr" className="whitespace-pre-wrap break-words text-xs p-2 border-b">{q.q}{!q.valid?' — يتجاوز الحد المسموح':''}</pre>)}</details>)}
        </section>}
        <section className="card p-4 space-y-3">
          <h2 className="font-semibold">تشغيل يدوي</h2>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">استعلام الاكتشاف
              <select className="input block mt-1 max-w-xl" value={queryId} onChange={e => setQueryId(e.target.value)} data-testid="query-select">
                <option value="">اختر استعلام الكلمات</option>{queries.filter(q=>!program||q.program_key===program).map(q => <option key={q.id} value={q.id}>{dictionary.find(p=>p.key===q.program_key)?.name_ar??q.program_key} · {q.q}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-primary" disabled={!canManage || busy || !queryId} onClick={() => run('discovery', queryId)} data-testid="run-discovery">اكتشاف بالكلمات</button>
            <label className="text-sm">القناة
              <select className="input block mt-1" value={channelId} onChange={e => setChannelId(e.target.value)}>
                {channels.map(c => <option key={c.id} value={c.id}>{c.title ?? c.youtube_channel_id}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-primary" disabled={!canManage || busy || !channelId} onClick={() => run('channels', channelId)} data-testid="run-channel">متابعة القناة</button>
            <button type="button" className="btn btn-ghost" disabled={!canManage || busy} onClick={() => run('stats')}>تحديث الإحصاءات</button>
            <button type="button" className="btn btn-ghost" disabled={!canManage || busy} onClick={() => run('retention')}>تطبيق سياسة الاحتفاظ (30 يومًا)</button>
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void act('إضافة قناة', () => client('/channels', {method: 'POST', body: JSON.stringify({youtubeChannelId: newChannel.trim()})})).then(() => setNewChannel('')); }}>
            <label className="text-sm">إضافة قناة بمعرّفها (UC…)
              <input className="input block mt-1" dir="ltr" value={newChannel} onChange={e => setNewChannel(e.target.value)} placeholder="UCxxxxxxxxxxxxxxxxxxxxxx" data-testid="channel-input" />
            </label>
            <button type="submit" className="btn btn-ghost" disabled={!canManage || busy || !newChannel.trim()}>إضافة</button>
          </form>
          <p className="text-xs opacity-75">كل تشغيل يمر بمفتاح الإيقاف ثم الحصة. في وضع Live يرسل طلبات حقيقية ويستهلك حصة المشروع.</p>
        </section>

        <section className="card p-4 overflow-x-auto">
          <h2 className="font-semibold mb-1">الفيديوهات المكتشفة ({videos.filter(v=>!program||v.program_key===program).length})</h2>
          {integrated&&<p className="text-sm mb-3">نتائج بحث مرشحة للمراجعة؛ ظهور الفيديو لا يؤكد ارتباطه بالبرنامج. نتائج اختبار تخفيف الاستبعادات موضحة أسفل العنوان.</p>}
          <p className="text-xs opacity-75 mb-2">الإحصاءات أدناه أرقام YouTube الأصلية كما أُعيدت من الواجهة، مع وقت قراءتها. وسم Short تقدير (المدة ≤ 3 دقائق) لعدم وجود حقل رسمي.</p>
          <table className="w-full text-sm" data-testid="videos-table">
            <thead><tr className="text-right opacity-70"><th className="p-2">العنوان</th><th className="p-2">القناة</th><th className="p-2">النشر</th><th className="p-2">المدة</th>
              <th className="p-2">مشاهدات</th><th className="p-2">إعجابات</th><th className="p-2">تعليقات</th><th className="p-2">حتى</th><th className="p-2">المصدر</th><th className="p-2"></th></tr></thead>
            <tbody>
              {videos.filter(v=>!program||v.program_key===program).map(v => (
                <tr key={v.id} className="border-t border-black/5">
                  <td className="p-2 max-w-xs">{v.status === 'active' ? (v.title ?? '—') : <em className="opacity-60">{v.status === 'unavailable' ? 'غير متاح على YouTube' : 'أُزيل النص (سياسة 30 يومًا)'}</em>}
                    <div className="text-xs opacity-60" dir="ltr">{v.youtube_video_id}</div>
                    {integrated&&<div className="text-xs mt-1">{v.program_name??'قناة'} · مرشح غير معتمد {v.search_query_name?.endsWith(':without_exclusions')?'· اختبار دون استبعادات':''}</div>}
                    {v.search_query&&<details className="text-xs mt-1"><summary>كلمات الاكتشاف</summary><p className="break-words">{v.search_query}</p></details>}</td>
                  <td className="p-2">{v.channel_title ?? v.youtube_channel_id}</td>
                  <td className="p-2 whitespace-nowrap">{riyadh(v.published_at)}</td>
                  <td className="p-2">{dur(v.duration_seconds)}{v.short_candidate && <span className="badge mr-1">Short تقديري</span>}</td>
                  <td className="p-2">{num(v.view_count)}</td><td className="p-2">{num(v.like_count)}</td><td className="p-2">{num(v.comment_count)}</td>
                  <td className="p-2 text-xs whitespace-nowrap">{riyadh(v.stats_at)}</td>
                  <td className="p-2 text-xs">{(v.discovered_via ?? []).map((x: string) => x === 'search' ? 'بحث' : 'قناة').join('، ')}</td>
                  <td className="p-2 whitespace-nowrap">
                    <button type="button" className="btn btn-ghost" onClick={() => openComments(v)} data-testid="open-comments">التعليقات ({v.stored_threads}+{v.stored_replies})</button>
                    {v.status === 'active' && <button type="button" className="btn btn-ghost" disabled={!canManage || busy || v.comments_state === 'disabled'} onClick={() => run('comments', v.id)}>{v.comments_state === 'disabled' ? 'التعليقات معطلة' : 'جمع التعليقات'}</button>}
                  </td>
                </tr>))}
              {!videos.filter(v=>!program||v.program_key===program).length && <tr><td colSpan={10} className="p-4 text-center opacity-60">لا توجد فيديوهات بعد</td></tr>}
            </tbody>
          </table>
        </section>

        {selected && (
          <section className="card p-4" data-testid="comments-panel">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">التعليقات والردود — {selected.title ?? selected.youtube_video_id}</h2>
              <button type="button" className="btn btn-ghost" onClick={() => { setSelected(null); setComments(null); }}>إغلاق</button>
            </div>
            {!comments ? <p>جارٍ التحميل…</p> : !threads.length ? <p className="opacity-60">لا توجد تعليقات محفوظة لهذا الفيديو</p> : (
              <ul className="space-y-2 max-h-[32rem] overflow-y-auto">
                {threads.map(t => (
                  <li key={t.youtube_comment_id} className="rounded border border-black/10 p-2">
                    <Comment c={t} />
                    {t.total_reply_count > 0 && <p className="text-xs opacity-60 mt-1">ردود محفوظة {t.replies.length} من {t.total_reply_count}</p>}
                    {t.replies.length > 0 && <ul className="mt-2 mr-6 space-y-1 border-r-2 border-black/10 pr-3">{t.replies.map((r: Json) => <li key={r.youtube_comment_id}><Comment c={r} /></li>)}</ul>}
                  </li>))}
              </ul>)}
          </section>)}

        <section className="grid gap-4 md:grid-cols-2">
          <div className="card p-4 overflow-x-auto">
            <h2 className="font-semibold mb-2">القنوات المتابعة ({channels.length})</h2>
            <table className="w-full text-sm" data-testid="channels-table"><thead><tr className="text-right opacity-70"><th className="p-2">القناة</th><th className="p-2">البرنامج</th><th className="p-2">الحالة</th><th className="p-2">آخر نجاح</th></tr></thead>
              <tbody>{channels.map(c => <tr key={c.id} className="border-t border-black/5"><td className="p-2">{c.title ?? '—'}<div className="text-xs opacity-60" dir="ltr">{c.youtube_channel_id}</div></td>
                <td className="p-2">{c.program_key ?? '—'}</td><td className="p-2">{c.status}{c.consecutive_failures ? ` · إخفاقات ${c.consecutive_failures}` : ''}</td><td className="p-2 text-xs">{riyadh(c.last_success_at)}</td></tr>)}
                {!channels.length && <tr><td colSpan={4} className="p-4 text-center opacity-60">لا توجد قنوات</td></tr>}</tbody></table>
          </div>
          <div className="card p-4 overflow-x-auto">
            <h2 className="font-semibold mb-2">آخر عمليات الجمع</h2>
            <table className="w-full text-sm" data-testid="runs-table"><thead><tr className="text-right opacity-70"><th className="p-2">المسار</th><th className="p-2">الوضع</th><th className="p-2">النتيجة</th><th className="p-2">طلبات/وحدات</th><th className="p-2">الوقت</th></tr></thead>
              <tbody>{(status?.runs ?? []).map((r: Json) => <tr key={r.id} className="border-t border-black/5"><td className="p-2">{LANE_AR[r.lane]}</td><td className="p-2">{r.mode}</td>
                <td className="p-2">{r.status}{r.error_message ? <div className="text-xs text-(--status-danger)">{r.error_message}</div> : null}</td><td className="p-2">{r.calls}/{r.units}</td><td className="p-2 text-xs">{riyadh(r.started_at)}</td></tr>)}</tbody></table>
          </div>
        </section>

        <section className="card p-4 overflow-x-auto">
          <h2 className="font-semibold mb-2">أخطاء الجمع والطلبات المرفوضة</h2>
          <table className="w-full text-sm" data-testid="errors-table"><thead><tr className="text-right opacity-70"><th className="p-2">الوقت</th><th className="p-2">الواجهة</th><th className="p-2">النتيجة</th><th className="p-2">HTTP</th><th className="p-2">السبب</th><th className="p-2">المحاولة</th></tr></thead>
            <tbody>{(status?.errors ?? []).map((e: Json, i: number) => <tr key={i} className="border-t border-black/5"><td className="p-2 text-xs">{riyadh(e.occurred_at)}</td><td className="p-2" dir="ltr">{e.endpoint}</td>
              <td className="p-2">{e.outcome === 'denied' ? 'مرفوض قبل الإرسال' : 'خطأ'}</td><td className="p-2">{e.http_status ?? '—'}</td><td className="p-2" dir="ltr">{e.error_reason}</td><td className="p-2">{e.attempt}</td></tr>)}
              {!(status?.errors ?? []).length && <tr><td colSpan={6} className="p-4 text-center opacity-60">لا أخطاء مسجلة</td></tr>}</tbody></table>
        </section>
      </div>
    </div>
  );
}

function Comment({c}: {c: Json}) {
  return (
    <div>
      <div className="text-xs opacity-70">{c.author_display_name ?? '—'} · {riyadh(c.published_at)} · إعجابات {num(c.like_count)}</div>
      <p className="text-sm">{c.status === 'active' ? c.text_display : <em className="opacity-60">أُزيل النص (سياسة الاحتفاظ أو غير متاح)</em>}</p>
    </div>
  );
}

function connectionAr(c?: string) {
  if (!c) return '…';
  if (c === 'mock') return 'محاكاة (لا اتصال بـ Google)';
  if (c === 'dry_run') return 'Dry Run (لا اتصال بـ Google)';
  if (c === 'not_tested') return 'لم يُختبر بعد';
  if (c === 'ok') return 'متصل';
  return `خطأ: ${c.replace(/^error:/, '')}`;
}
