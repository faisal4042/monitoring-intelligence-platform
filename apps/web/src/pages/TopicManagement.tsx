import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNum, fmtPct, fmtRelative } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';
import { BookOpenText, Plus, X } from 'lucide-react';
import Avatar from '../components/Avatar';

interface Program { id: string; name_ar: string; color: string }
interface TopicKeyword { id: string; term: string; kind: 'alias' | 'include' | 'exclude' }
interface ManagedTopic {
  id: string; program_id: string; service_id: string | null; parent_id: string | null;
  level: number; name_ar: string; description: string | null; source: string;
  is_active: boolean; has_centroid: boolean; program_name: string; program_color: string;
  service_name: string | null; parent_name: string | null; post_count: number;
  human_reviewed_count: number; automatic_count: number; last_activity_at: string | null;
  avg_similarity: number | null; children_count: number; keywords: TopicKeyword[];
  merged_into_id: string | null; merged_into_name: string | null;
}
interface TopicInteraction {
  id: string; text: string; posted_at: string; url: string; program_id: string | null;
  username: string | null; display_name: string | null; profile_image_url: string | null;
  human_corrected: boolean; model: string | null; similarity: number | null;
}
interface AuditItem {
  id: number; occurred_at: string; user_email: string | null; action: string;
  entity_label: string | null; old_value: unknown; new_value: unknown;
  reason: string | null; severity: string;
}

const keywordLabels = { alias: 'مرادف', include: 'تضمين', exclude: 'استبعاد' } as const;
const actionLabels: Record<string, string> = {
  'topic.create': 'إنشاء الموضوع', 'topic.update': 'تعديل الموضوع',
  'topic.archive': 'أرشفة الموضوع', 'topic.restore': 'استعادة الموضوع',
  'topic.merge': 'دمج موضوع', 'topic.keyword_add': 'إضافة كلمة',
  'topic.keyword_remove': 'حذف كلمة', 'topic.centroid_update': 'تحديث البصمة الدلالية',
  'classification.topic_feedback': 'تصحيح ارتباط تفاعل',
};

export default function TopicManagement() {
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.TOPICS_MANAGE);
  const qc = useQueryClient();
  const [programId, setProgramId] = useState('');
  const [includeArchived, setIncludeArchived] = useState(true);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'interactions' | 'audit'>('details');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editParentId, setEditParentId] = useState('');
  const [keywordTerm, setKeywordTerm] = useState('');
  const [keywordKind, setKeywordKind] = useState<TopicKeyword['kind']>('alias');
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [showMerge, setShowMerge] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createParentId, setCreateParentId] = useState('');

  const { data: programs } = useQuery({
    queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs'),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['topic-management', programId, includeArchived, reviewOnly],
    queryFn: () => {
      const params = new URLSearchParams({ includeArchived: String(includeArchived), reviewOnly: String(reviewOnly) });
      if (programId) params.set('programId', programId);
      return api.get<{ items: ManagedTopic[] }>(`/topic-management?${params}`);
    },
  });
  const topics = data?.items ?? [];
  const selected = topics.find((topic) => topic.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected && topics.length) setSelectedId(topics[0].id);
  }, [selected, topics]);
  useEffect(() => {
    if (!selected) return;
    setEditName(selected.name_ar);
    setEditDescription(selected.description ?? '');
    setEditParentId(selected.parent_id ?? '');
    setMergeTargetId('');
  }, [selected?.id]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return topics;
    return topics.filter((topic) =>
      topic.name_ar.toLowerCase().includes(needle)
      || topic.description?.toLowerCase().includes(needle)
      || topic.keywords.some((keyword) => keyword.term.toLowerCase().includes(needle)),
    );
  }, [topics, search]);
  const roots = filtered.filter((topic) => !topic.parent_id);
  const orphanChildren = filtered.filter((topic) => topic.parent_id && !filtered.some((candidate) => candidate.id === topic.parent_id));
  const activeTopics = topics.filter((topic) => topic.is_active);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['topic-management'] });
    qc.invalidateQueries({ queryKey: ['topics'] });
    qc.invalidateQueries({ queryKey: ['classification-interactions'] });
  };
  const saveTopic = useMutation({
    mutationFn: () => api.patch<{ needsCentroid: boolean }>(`/topics/${selectedId}/manage`, {
      nameAr: editName, description: editDescription || null, parentId: editParentId || null,
    }),
    onSuccess: refresh,
  });
  const computeCentroid = useMutation({ mutationFn: () => api.post(`/topics/${selectedId}/centroid`), onSuccess: refresh });
  const archiveTopic = useMutation({
    mutationFn: (id: string) => api.post(`/topics/${id}/archive`),
    onSuccess: refresh,
  });
  const restoreTopic = useMutation({
    mutationFn: (id: string) => api.post(`/topics/${id}/restore`),
    onSuccess: refresh,
  });
  const mergeTopic = useMutation({
    mutationFn: () => api.post(`/topics/${selectedId}/merge`, { targetTopicId: mergeTargetId }),
    onSuccess: () => { setShowMerge(false); setSelectedId(mergeTargetId); refresh(); },
  });
  const addKeyword = useMutation({
    mutationFn: () => api.post(`/topics/${selectedId}/keywords`, { term: keywordTerm, kind: keywordKind }),
    onSuccess: () => { setKeywordTerm(''); refresh(); },
  });
  const removeKeyword = useMutation({
    mutationFn: (keywordId: string) => api.del(`/topics/${selectedId}/keywords/${keywordId}`),
    onSuccess: refresh,
  });
  const createTopic = useMutation({
    mutationFn: () => api.post<{ id: string }>('/topics', {
      programId, parentId: createParentId || undefined,
      nameAr: createName, description: createDescription || undefined,
    }),
    onSuccess: (created) => {
      setShowCreate(false); setCreateName(''); setCreateDescription(''); setCreateParentId('');
      setSelectedId(created.id); refresh();
    },
  });
  const feedback = useMutation({
    mutationFn: ({ postId, targetId }: { postId: string; targetId?: string }) =>
      api.post(`/classification/interactions/${postId}/topic-feedback`, { correct: false, correctTopicId: targetId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topic-interactions'] }); refresh(); },
  });

  const { data: similar } = useQuery({
    queryKey: ['topic-similar', selectedId],
    queryFn: () => api.get<{ items: { id: string; name_ar: string; is_active: boolean; similarity: number }[] }>(`/topics/${selectedId}/similar`),
    enabled: !!selectedId && !!selected?.has_centroid,
  });
  const { data: interactions, isLoading: interactionsLoading } = useQuery({
    queryKey: ['topic-interactions', selectedId],
    queryFn: () => api.get<{ items: TopicInteraction[] }>(`/topics/${selectedId}/interactions`),
    enabled: !!selectedId && tab === 'interactions',
  });
  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: ['topic-audit', selectedId],
    queryFn: () => api.get<{ items: AuditItem[] }>(`/topics/${selectedId}/audit`),
    enabled: !!selectedId && tab === 'audit',
  });

  const mutationError = saveTopic.error || computeCentroid.error || archiveTopic.error || restoreTopic.error
    || mergeTopic.error || addKeyword.error || removeKeyword.error || createTopic.error || feedback.error;

  const topicRow = (topic: ManagedTopic, child = false) => (
    <button
      type="button" key={topic.id} onClick={() => { setSelectedId(topic.id); setTab('details'); }}
      className={`w-full rounded-lg border p-3 text-start transition ${selectedId === topic.id ? 'border-brand-500 bg-brand-500/10' : 'border-transparent hover:bg-[var(--surface-2)]'} ${child ? 'ms-5 !w-[calc(100%-1.25rem)]' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${topic.is_active ? 'bg-emerald-500' : 'bg-slate-500'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{topic.name_ar}</span>
            {child && <span className="text-[10px] muted">فرعي</span>}
            {!topic.is_active && <span className="badge bg-slate-500/15 text-[10px]">مؤرشف</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] muted">
            <span><span className="num">{fmtNum(topic.post_count)}</span> تفاعل</span>
            <span><span className="num">{fmtNum(topic.human_reviewed_count)}</span> مراجع</span>
            {topic.last_activity_at && <span>{fmtRelative(topic.last_activity_at)}</span>}
          </div>
        </div>
      </div>
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold"><BookOpenText size={22} className="text-brand-500" /> إدارة المواضيع</h1>
          <p className="mt-1 text-sm muted">إدارة شجرة المواضيع والكلمات والدمج والمراجعة مع سجل كامل لكل قرار.</p>
        </div>
        {canManage && <button className="btn-primary" onClick={() => setShowCreate(true)} disabled={!programId}><Plus size={16} /> موضوع جديد</button>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-3"><div className="text-xs muted">المواضيع النشطة</div><div className="num text-xl font-bold">{activeTopics.length}</div></div>
        <div className="card p-3"><div className="text-xs muted">تحتاج مراجعة</div><div className="num text-xl font-bold text-amber-600">{activeTopics.filter((topic) => topic.post_count < 3).length}</div></div>
        <div className="card p-3"><div className="text-xs muted">المؤرشفة</div><div className="num text-xl font-bold">{topics.filter((topic) => !topic.is_active).length}</div></div>
        <div className="card p-3"><div className="text-xs muted">بلا بصمة دلالية</div><div className="num text-xl font-bold text-red-600">{activeTopics.filter((topic) => !topic.has_centroid).length}</div></div>
      </div>

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select className="input max-w-52" value={programId} onChange={(event) => { setProgramId(event.target.value); setSelectedId(null); }}>
          <option value="">كل البرامج</option>
          {(programs?.items ?? []).map((program) => <option key={program.id} value={program.id}>{program.name_ar}</option>)}
        </select>
        <input className="input min-w-52 flex-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الوصف أو الكلمات…" />
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} /> تحتاج مراجعة</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> عرض المؤرشفة</label>
      </div>

      {isLoading ? <div className="card p-10 text-center muted">جارٍ تحميل المواضيع…</div> : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,.8fr)_minmax(0,1.5fr)]">
          <aside className="card max-h-[72vh] overflow-y-auto p-2">
            {!filtered.length && <div className="p-8 text-center text-sm muted">لا توجد مواضيع مطابقة.</div>}
            {roots.map((root) => (
              <div key={root.id} className="mb-1">
                {topicRow(root)}
                {filtered.filter((topic) => topic.parent_id === root.id).map((child) => topicRow(child, true))}
              </div>
            ))}
            {orphanChildren.map((topic) => topicRow(topic, true))}
          </aside>

          {!selected ? <div className="card p-12 text-center muted">اختر موضوعًا لعرض تفاصيله.</div> : (
            <section className="card overflow-hidden">
              <div className="border-b border-[var(--border)] p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold">{selected.name_ar}</h2>
                      <span className={`badge ${selected.is_active ? 'bg-emerald-500/15 text-emerald-600' : 'bg-slate-500/15'}`}>{selected.is_active ? 'نشط' : 'مؤرشف'}</span>
                      {selected.level === 2 && <span className="badge bg-brand-500/15 text-brand-600">فرعي تحت {selected.parent_name}</span>}
                    </div>
                    <div className="mt-1 text-xs muted">{selected.program_name}{selected.service_name ? ` · ${selected.service_name}` : ''}</div>
                    {selected.merged_into_name && <div className="mt-2 text-xs text-amber-600">تم دمجه سابقًا في: {selected.merged_into_name}</div>}
                  </div>
                  {canManage && <div className="flex flex-wrap gap-2">
                    {selected.is_active ? (
                      <>
                        <button className="btn-ghost !text-xs" onClick={() => setShowMerge(true)}>دمج</button>
                        <button className="btn-ghost !text-xs !text-red-600" onClick={() => {
                          if (window.confirm(`أرشفة «${selected.name_ar}»${selected.children_count ? ' وجميع فروعه' : ''}؟`)) archiveTopic.mutate(selected.id);
                        }}>أرشفة</button>
                      </>
                    ) : selected.merged_into_id ? (
                      <span className="text-xs muted">موضوع مدمج — محفوظ للتدقيق</span>
                    ) : <button className="btn-primary !text-xs" onClick={() => restoreTopic.mutate(selected.id)}>استعادة</button>}
                  </div>}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className="rounded-lg bg-[var(--surface-2)] p-2.5"><div className="text-[11px] muted">التفاعلات</div><div className="num font-bold">{fmtNum(selected.post_count)}</div></div>
                  <div className="rounded-lg bg-[var(--surface-2)] p-2.5"><div className="text-[11px] muted">مراجعة بشرية</div><div className="num font-bold">{fmtNum(selected.human_reviewed_count)}</div></div>
                  <div className="rounded-lg bg-[var(--surface-2)] p-2.5"><div className="text-[11px] muted">متوسط التشابه</div><div className="num font-bold">{selected.avg_similarity === null ? '—' : fmtPct(selected.avg_similarity)}</div></div>
                  <div className="rounded-lg bg-[var(--surface-2)] p-2.5"><div className="text-[11px] muted">آخر نشاط</div><div className="text-xs font-bold">{selected.last_activity_at ? fmtRelative(selected.last_activity_at) : 'لا يوجد'}</div></div>
                </div>
              </div>

              <div className="classification-tabs !rounded-none !border-0 !border-b" role="tablist">
                <button className={tab === 'details' ? 'is-active' : ''} onClick={() => setTab('details')}>التفاصيل والكلمات</button>
                <button className={tab === 'interactions' ? 'is-active' : ''} onClick={() => setTab('interactions')}>التفاعلات <span className="num">{selected.post_count}</span></button>
                <button className={tab === 'audit' ? 'is-active' : ''} onClick={() => setTab('audit')}>سجل التغييرات</button>
              </div>

              {mutationError && <div className="m-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-600">{(mutationError as ApiError).message}</div>}

              {tab === 'details' && <div className="space-y-5 p-5">
                <div>
                  <h3 className="mb-3 text-sm font-bold">بيانات الموضوع</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="text-xs">الاسم<input className="input mt-1.5" value={editName} onChange={(event) => setEditName(event.target.value)} disabled={!canManage || !selected.is_active} /></label>
                    <label className="text-xs">الموضوع الرئيسي<select className="input mt-1.5" value={editParentId} onChange={(event) => setEditParentId(event.target.value)} disabled={!canManage || !selected.is_active}>
                      <option value="">موضوع رئيسي</option>
                      {activeTopics.filter((topic) => topic.id !== selected.id && !topic.parent_id && topic.program_id === selected.program_id).map((topic) => <option key={topic.id} value={topic.id}>{topic.name_ar}</option>)}
                    </select></label>
                    <label className="text-xs md:col-span-2">الوصف<textarea className="input mt-1.5" rows={3} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={!canManage || !selected.is_active} /></label>
                  </div>
                  {canManage && selected.is_active && <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {!selected.has_centroid && <button className="btn-ghost" disabled={computeCentroid.isPending} onClick={() => computeCentroid.mutate()}>{computeCentroid.isPending ? 'جارٍ الحساب…' : 'حساب البصمة الدلالية'}</button>}
                    <button className="btn-primary" disabled={!editName.trim() || saveTopic.isPending} onClick={() => saveTopic.mutate()}>{saveTopic.isPending ? 'جارٍ الحفظ…' : 'حفظ التعديلات'}</button>
                  </div>}
                  {!selected.has_centroid && <div className="mt-2 text-xs text-amber-600">لن يُستخدم الموضوع في المطابقة الآلية حتى تُحسب بصمته الدلالية.</div>}
                </div>

                <div className="border-t border-[var(--border)] pt-5">
                  <h3 className="mb-3 text-sm font-bold">كلمات الموضوع</h3>
                  <div className="flex flex-wrap gap-2">
                    {selected.keywords.map((keyword) => <span key={keyword.id} className={`badge ${keyword.kind === 'exclude' ? 'bg-red-500/15 text-red-600' : keyword.kind === 'include' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-brand-500/15 text-brand-600'}`}>
                      <span className="text-[10px] opacity-70">{keywordLabels[keyword.kind]}</span> {keyword.term}
                      {canManage && selected.is_active && <button className="ms-1 opacity-60 hover:opacity-100" onClick={() => removeKeyword.mutate(keyword.id)}><X size={11} /></button>}
                    </span>)}
                    {!selected.keywords.length && <span className="text-xs muted">لا توجد كلمات مرتبطة.</span>}
                  </div>
                  {canManage && selected.is_active && <div className="mt-3 flex flex-wrap gap-2">
                    <input className="input min-w-48 flex-1" value={keywordTerm} onChange={(event) => setKeywordTerm(event.target.value)} placeholder="كلمة أو عبارة…" />
                    <select className="input !w-28" value={keywordKind} onChange={(event) => setKeywordKind(event.target.value as TopicKeyword['kind'])}>
                      <option value="alias">مرادف</option><option value="include">تضمين</option><option value="exclude">استبعاد</option>
                    </select>
                    <button className="btn-ghost" disabled={keywordTerm.trim().length < 2 || addKeyword.isPending} onClick={() => addKeyword.mutate()}>إضافة</button>
                  </div>}
                </div>

                <div className="border-t border-[var(--border)] pt-5">
                  <h3 className="mb-3 text-sm font-bold">المواضيع الأقرب دلاليًا</h3>
                  <div className="space-y-2">
                    {(similar?.items ?? []).map((topic) => <button key={topic.id} className="flex w-full items-center justify-between rounded-lg bg-[var(--surface-2)] p-2.5 text-start text-xs" onClick={() => setSelectedId(topic.id)}>
                      <span>{topic.name_ar}{!topic.is_active && <span className="ms-2 muted">مؤرشف</span>}</span>
                      <span className={`num ${topic.similarity >= .82 ? 'text-amber-600' : 'muted'}`}>{fmtPct(topic.similarity)}</span>
                    </button>)}
                    {selected.has_centroid && !similar?.items.length && <div className="text-xs muted">لا توجد مواضيع قابلة للمقارنة.</div>}
                  </div>
                </div>
              </div>}

              {tab === 'interactions' && <div className="max-h-[60vh] space-y-2 overflow-y-auto p-4">
                {interactionsLoading && <div className="p-8 text-center muted">جارٍ التحميل…</div>}
                {!interactionsLoading && !interactions?.items.length && <div className="p-8 text-center muted">لا توجد تفاعلات مرتبطة.</div>}
                {(interactions?.items ?? []).map((interaction) => <article key={interaction.id} className="rounded-xl border border-[var(--border)] p-3">
                  <div className="flex gap-3">
                    <Avatar src={interaction.profile_image_url} name={interaction.display_name} username={interaction.username} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs muted"><strong className="text-[var(--text)]">{interaction.display_name ?? interaction.username ?? 'حساب'}</strong><span>{fmtRelative(interaction.posted_at)}</span>{interaction.similarity !== null && <span className="num">تشابه {fmtPct(interaction.similarity)}</span>}</div>
                      <a href={interaction.url} target="_blank" rel="noreferrer" className="mt-2 block text-sm leading-6 hover:text-brand-600">{interaction.text}</a>
                      {canManage && <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-2">
                        <select className="input !w-48 !py-1 !text-xs" value={moveTargets[interaction.id] ?? ''} onChange={(event) => setMoveTargets((current) => ({ ...current, [interaction.id]: event.target.value }))}>
                          <option value="">نقل إلى موضوع…</option>
                          {activeTopics.filter((topic) => topic.id !== selected.id && topic.program_id === selected.program_id).map((topic) => <option key={topic.id} value={topic.id}>{topic.name_ar}</option>)}
                        </select>
                        <button className="btn-ghost !py-1 !text-xs" disabled={!moveTargets[interaction.id] || feedback.isPending} onClick={() => feedback.mutate({ postId: interaction.id, targetId: moveTargets[interaction.id] })}>نقل</button>
                        <button className="btn-ghost !py-1 !text-xs !text-red-600" disabled={feedback.isPending} onClick={() => {
                          if (window.confirm('فصل هذا التفاعل وتركه غير مصنف؟')) feedback.mutate({ postId: interaction.id });
                        }}>فصل</button>
                      </div>}
                    </div>
                  </div>
                </article>)}
              </div>}

              {tab === 'audit' && <div className="max-h-[60vh] space-y-2 overflow-y-auto p-4">
                {auditLoading && <div className="p-8 text-center muted">جارٍ تحميل السجل…</div>}
                {!auditLoading && !auditData?.items.length && <div className="p-8 text-center muted">لا توجد تغييرات مسجلة.</div>}
                {(auditData?.items ?? []).map((item) => <div key={item.id} className="rounded-lg border border-[var(--border)] p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><strong>{actionLabels[item.action] ?? item.action}</strong><span className="text-xs muted">{fmtRelative(item.occurred_at)}</span></div>
                  <div className="mt-1 text-xs muted">{item.user_email ?? 'النظام'}{item.reason ? ` · ${item.reason}` : ''}</div>
                </div>)}
              </div>}
            </section>
          )}
        </div>
      )}

      {showMerge && selected && <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setShowMerge(false)}>
        <div className="card w-full max-w-md p-5" onClick={(event) => event.stopPropagation()}>
          <h3 className="font-bold">دمج «{selected.name_ar}»</h3>
          <p className="mt-1 text-xs leading-5 muted">ستنقل التفاعلات والكلمات والفروع إلى الموضوع الهدف، وسيُؤرشف الموضوع الحالي. العملية محفوظة في سجل التدقيق.</p>
          <select className="input mt-4" value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)} autoFocus>
            <option value="">اختر الموضوع الهدف…</option>
            {activeTopics.filter((topic) => topic.id !== selected.id && topic.program_id === selected.program_id && (!selected.children_count || topic.level === 1)).map((topic) => <option key={topic.id} value={topic.id}>{topic.name_ar}</option>)}
          </select>
          {mergeTopic.error && <div className="mt-3 text-xs text-red-600">{(mergeTopic.error as ApiError).message}</div>}
          <div className="mt-5 flex justify-end gap-2"><button className="btn-ghost" onClick={() => setShowMerge(false)}>إلغاء</button><button className="btn-primary" disabled={!mergeTargetId || mergeTopic.isPending} onClick={() => mergeTopic.mutate()}>{mergeTopic.isPending ? 'جارٍ الدمج…' : 'تأكيد الدمج'}</button></div>
        </div>
      </div>}

      {showCreate && <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setShowCreate(false)}>
        <div className="card w-full max-w-md p-5" onClick={(event) => event.stopPropagation()}>
          <h3 className="font-bold">موضوع جديد</h3>
          <p className="mt-1 text-xs muted">البرنامج محدد من الفلتر الحالي، ويمكن إنشاء الموضوع رئيسيًا أو فرعيًا.</p>
          <input className="input mt-4" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="اسم الموضوع" autoFocus />
          <textarea className="input mt-3" rows={3} value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="وصف مختصر" />
          <select className="input mt-3" value={createParentId} onChange={(event) => setCreateParentId(event.target.value)}>
            <option value="">موضوع رئيسي</option>
            {activeTopics.filter((topic) => topic.program_id === programId && topic.level === 1).map((topic) => <option key={topic.id} value={topic.id}>فرعي تحت: {topic.name_ar}</option>)}
          </select>
          {createTopic.error && <div className="mt-3 text-xs text-red-600">{(createTopic.error as ApiError).message}</div>}
          <div className="mt-5 flex justify-end gap-2"><button className="btn-ghost" onClick={() => setShowCreate(false)}>إلغاء</button><button className="btn-primary" disabled={!createName.trim() || createTopic.isPending} onClick={() => createTopic.mutate()}>{createTopic.isPending ? 'جارٍ الإنشاء…' : 'إنشاء الموضوع'}</button></div>
        </div>
      </div>}
    </div>
  );
}
