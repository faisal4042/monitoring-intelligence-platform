import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtNum, fmtRelative } from '../lib/format';
import Avatar from '../components/Avatar';

interface Program { id: string; name_ar: string; color: string }
interface SignalMember {
  id: string; text: string; url: string | null; postedAt: string;
  username: string | null; displayName: string | null; profileImageUrl: string | null;
  sourceRole: 'customer' | 'influencer'; familyKey: string; isRepresentative: boolean;
  sentiment: string | null; mediaImage: string | null; engagement: number;
}
interface SignalStory {
  id: string; title_ar: string; why_ar: string;
  state: 'candidate' | 'new' | 'rising' | 'steady' | 'fading';
  program_name: string; program_color: string; topic_name: string; parent_topic_name: string | null;
  first_seen_at: string; last_seen_at: string; post_count: number; family_count: number;
  author_count: number; influencer_count: number; engagement_total: number;
  posts_added_15m: number; posts_added_1h: number; live_score: number; previous_score: number | null;
  top_members: SignalMember[];
}
interface SignalResponse {
  stats: { signals: number; candidates: number; posts: number; families: number };
  items: SignalStory[];
}
type FeedMode = 'top' | 'latest' | 'influencers';

const STATE: Record<SignalStory['state'], { label: string; color: string }> = {
  candidate: { label: 'إشارة أولية', color: '#94a3b8' },
  new: { label: 'جديد', color: '#3b82f6' },
  rising: { label: 'يتصاعد', color: '#ef4444' },
  steady: { label: 'مستقر', color: '#10b981' },
  fading: { label: 'يتراجع', color: '#f59e0b' },
};

function SourceFaces({ story }: { story: SignalStory }) {
  const remaining = Math.max(0, story.family_count - story.top_members.length);
  return (
    <div className="flex items-center" dir="rtl">
      {story.top_members.slice(0, 4).map((member, index) => (
        <span key={`${member.id}-${index}`} className="-ms-1.5 rounded-full border-2" style={{ borderColor: 'var(--surface)' }}>
          <Avatar src={member.profileImageUrl} name={member.displayName} username={member.username} size={28} ring={member.sourceRole === 'influencer'} />
        </span>
      ))}
      {remaining > 0 && <span className="num z-10 grid h-8 min-w-8 place-items-center rounded-full border px-1 text-[10px] font-bold text-blue-600" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>+{remaining}</span>}
    </div>
  );
}

function shareStory(story: SignalStory) {
  const text = `${story.title_ar}\n${story.why_ar}`;
  if (navigator.share) void navigator.share({ title: story.title_ar, text });
  else void navigator.clipboard.writeText(text);
}

export default function Signals() {
  const [programId, setProgramId] = useState('');
  const [includeCandidates, setIncludeCandidates] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedMode, setFeedMode] = useState<FeedMode>('top');

  const { data: programs } = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs') });
  const { data, isLoading } = useQuery({
    queryKey: ['signals', programId, includeCandidates],
    queryFn: () => {
      const q = new URLSearchParams({ limit: '50', includeCandidates: String(includeCandidates) });
      if (programId) q.set('programId', programId);
      return api.get<SignalResponse>(`/signals?${q}`);
    },
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const items = data?.items ?? [];
    if (!items.length) setSelectedId(null);
    else if (!selectedId || !items.some((item) => item.id === selectedId)) setSelectedId(items[0].id);
  }, [data, selectedId]);

  const selected = data?.items.find((story) => story.id === selectedId) ?? data?.items[0];
  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryKey: ['signal-members', selected?.id],
    queryFn: () => api.get<{ items: SignalMember[] }>(`/signals/${selected!.id}/members`),
    enabled: Boolean(selected?.id),
    refetchInterval: 30_000,
  });

  const families = useMemo(() => {
    let source = [...(membersData?.items ?? [])];
    if (feedMode === 'influencers') source = source.filter((member) => member.sourceRole === 'influencer');
    const grouped = new Map<string, SignalMember[]>();
    for (const member of source) grouped.set(member.familyKey, [...(grouped.get(member.familyKey) ?? []), member]);
    const result = [...grouped.values()].map((group) => {
      const sorted = [...group].sort((a, b) => feedMode === 'latest'
        ? +new Date(b.postedAt) - +new Date(a.postedAt)
        : b.engagement - a.engagement || +new Date(b.postedAt) - +new Date(a.postedAt));
      return { lead: sorted[0], count: sorted.length };
    });
    return result.sort((a, b) => feedMode === 'latest'
      ? +new Date(b.lead.postedAt) - +new Date(a.lead.postedAt)
      : b.lead.engagement - a.lead.engagement || +new Date(b.lead.postedAt) - +new Date(a.lead.postedAt));
  }, [feedMode, membersData]);

  const maxScore = Math.max(1, ...(data?.items ?? []).map((story) => story.live_score));

  return (
    <div className="-m-5 h-[calc(100vh-3.5rem)] overflow-hidden" dir="ltr">
      <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1.55fr)_minmax(360px,.95fr)]">
        <section className="order-2 min-h-0 overflow-y-auto border-e lg:order-1" dir="rtl" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          {!selected && <div className="grid min-h-full place-items-center p-10 text-center" dir="rtl"><div><div className="text-lg font-bold">{isLoading ? 'جارٍ بناء القصص…' : 'لا توجد قصة مؤكدة بعد'}</div><p className="mt-2 text-sm muted">لا يظهر التفاعل المنفرد هنا حتى تؤكده مصادر مستقلة.</p></div></div>}
          {selected && (
            <>
              <div className="flex min-h-[240px] flex-col items-center justify-center border-b px-8 py-10 text-center lg:min-h-[300px]" style={{ borderColor: 'var(--border)' }}>
                <div className="mb-7 flex w-full items-center justify-center gap-4 text-xs text-blue-600">
                  <span>{fmtRelative(selected.last_seen_at)}</span>
                  <button className="rounded-full bg-blue-600 px-4 py-2 font-semibold text-white shadow-lg shadow-blue-500/20" onClick={() => shareStory(selected)}>مشاركة ↗</button>
                </div>
                <h1 className="max-w-4xl text-3xl font-black leading-tight tracking-tight lg:text-5xl">{selected.title_ar}</h1>
                <div className="mt-6 flex flex-wrap justify-center gap-2 text-xs">
                  <span className="rounded-full px-3 py-1" style={{ color: selected.program_color, background: `${selected.program_color}18` }}>{selected.program_name}</span>
                  <span className="rounded-full px-3 py-1 muted" style={{ background: 'var(--surface-2)' }}>{selected.parent_topic_name ? `${selected.parent_topic_name} / ` : ''}{selected.topic_name}</span>
                </div>
              </div>
              <div className="border-b px-6 py-4 lg:px-10" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
                <div className="mb-2 text-sm font-bold">آخر التحديثات</div>
                <div className="space-y-2 text-sm leading-6">
                  <p><span className="ms-2 inline-block h-5 w-5 rounded-md bg-blue-500/15 text-center text-[10px] text-blue-600">ج</span>{selected.why_ar}</p>
                  <p><span className="ms-2 inline-block h-5 w-5 rounded-md bg-emerald-500/15 text-center text-[10px] text-emerald-600">↗</span>أكد القصة {fmtNum(selected.family_count)} مصادر مستقلة، عبر {fmtNum(selected.author_count)} حسابات.</p>
                  <p><span className="ms-2 inline-block h-5 w-5 rounded-md bg-amber-500/15 text-center text-[10px] text-amber-600">⏳</span>أضيف {fmtNum(selected.posts_added_1h)} تفاعل خلال الساعة الأخيرة، وآخر نشاط {fmtRelative(selected.last_seen_at)}.</p>
                </div>
              </div>
              <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b px-6 py-2 backdrop-blur lg:px-10" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 90%, transparent)' }}>
                <div className="flex gap-1">
                  {([['top', 'الأعلى تفاعلاً'], ['latest', 'الأحدث'], ['influencers', 'المؤثرون']] as Array<[FeedMode, string]>).map(([value, label]) => <button key={value} onClick={() => setFeedMode(value)} className={`rounded-full border px-3 py-1.5 text-xs ${feedMode === value ? 'border-blue-500 text-blue-600' : 'muted'}`} style={{ borderColor: feedMode === value ? undefined : 'var(--border)' }}>{label}</button>)}
                </div>
                <span className="text-xs muted">{fmtNum(families.length)} مصادر</span>
              </div>
              <div>
                {membersLoading && <div className="p-10 text-center text-sm muted">جارٍ تحميل المصادر…</div>}
                {!membersLoading && families.length === 0 && <div className="p-10 text-center text-sm muted">لا توجد مصادر ضمن هذا العرض.</div>}
                {families.map(({ lead, count }) => (
                  <a key={lead.familyKey} href={lead.url ?? '#'} target="_blank" rel="noreferrer" className="block border-b px-6 py-5 transition hover:bg-[var(--surface-2)] lg:px-10" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex gap-3">
                      <Avatar src={lead.profileImageUrl} name={lead.displayName} username={lead.username} size={42} ring={lead.sourceRole === 'influencer'} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs muted"><strong className="text-sm text-[var(--text)]">{lead.displayName ?? lead.username ?? 'حساب'}</strong>{lead.username && <span dir="ltr">@{lead.username}</span>}{lead.sourceRole === 'influencer' && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-600">مؤثر</span>}</div>
                        <div className="mt-2 flex gap-4"><p className="min-w-0 flex-1 text-[15px] leading-7">{lead.text}</p>{lead.mediaImage && <img src={lead.mediaImage} alt="" loading="lazy" className="h-24 w-28 shrink-0 rounded-xl object-cover" />}</div>
                        <div className="mt-3 flex items-center gap-3 text-xs muted"><span>{fmtRelative(lead.postedAt)}</span><span className="num rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border)' }}>تفاعل {fmtNum(lead.engagement)}</span>{count > 1 && <span className="num rounded-full border px-2 py-0.5 text-blue-600" style={{ borderColor: 'var(--border)' }}>+{count - 1}</span>}</div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="order-1 flex min-h-0 flex-col lg:order-2" dir="rtl" style={{ background: 'var(--surface-2)' }}>
          <div className="shrink-0 border-b p-3" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <div className="mb-3 flex items-center justify-between"><div><h2 className="font-bold">أهم القصص الآن</h2><p className="text-xs muted">{fmtNum(data?.stats.signals)} قصة مؤكدة · {fmtNum(data?.stats.families)} مصادر</p></div><span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">تحديث كل 5 دقائق</span></div>
            <div className="flex gap-2"><select className="input min-w-0 flex-1 !py-1.5 !text-xs" value={programId} onChange={(event) => setProgramId(event.target.value)}><option value="">كل البرامج</option>{(programs?.items ?? []).map((program) => <option key={program.id} value={program.id}>{program.name_ar}</option>)}</select><label className="flex shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11px]" style={{ borderColor: 'var(--border)' }}><input type="checkbox" checked={includeCandidates} onChange={(event) => setIncludeCandidates(event.target.checked)} />الأولية</label></div>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {isLoading && <div className="p-8 text-center text-sm muted">جارٍ تحديث الترتيب…</div>}
            {(data?.items ?? []).map((story, index) => {
              const active = selected?.id === story.id;
              const image = story.top_members.find((member) => member.mediaImage)?.mediaImage;
              const state = STATE[story.state];
              return (
                <button key={story.id} onClick={() => setSelectedId(story.id)} className={`relative w-full overflow-hidden rounded-xl border p-3 text-start transition ${active ? 'ring-2 ring-blue-500' : 'hover:border-blue-400'}`} style={{ borderColor: active ? '#3b82f6' : 'var(--border)', background: 'var(--surface)' }}>
                  <div className="flex min-h-[126px] gap-3">
                    <div className="num w-7 shrink-0 text-right text-sm font-black text-blue-500">{String(index + 1).padStart(2, '0')}</div>
                    <div className="min-w-0 flex-1"><div className="mb-2 flex items-center gap-2 text-[10px] font-semibold text-blue-600"><span>{fmtRelative(story.last_seen_at)}</span><span className="rounded-full px-1.5 py-0.5" style={{ color: state.color, background: `${state.color}18` }}>{state.label}</span></div><h3 className="line-clamp-2 text-base font-black leading-6">{story.title_ar}</h3><p className="mt-1 line-clamp-2 text-xs leading-5 muted">{story.topic_name} · {story.why_ar}</p><div className="mt-3 flex items-center gap-2"><SourceFaces story={story} /><span className="text-[10px] muted">يتحدث عنها {fmtNum(story.family_count)}</span></div></div>
                    {image && <img src={image} alt="" loading="lazy" className="h-20 w-20 shrink-0 self-center rounded-xl object-cover" />}
                  </div>
                  <span className="absolute inset-x-0 bottom-0 h-[3px] bg-[var(--surface-3)]"><span className="block h-full bg-emerald-400" style={{ width: `${Math.max(8, (story.live_score / maxScore) * 100)}%` }} /></span>
                </button>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
