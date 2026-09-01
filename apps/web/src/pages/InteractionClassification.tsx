import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtPct, fmtRelative, fmtNum } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';
import { ChartNoAxesCombined, Check, Plus, X, Zap } from 'lucide-react';
import Avatar from '../components/Avatar';
import AuthorHistoryModal from '../components/AuthorHistoryModal';

interface Program { id: string; name_ar: string; color: string }
interface Topic {
  id: string; program_id: string; name_ar: string; description: string | null;
  parent_id: string | null; level: number; post_count: number; has_centroid: boolean;
  program_name: string; source: string; human_reviewed_count: number;
  last_activity_at: string | null; avg_similarity: number | null;
}
interface ClassificationStats {
  totalRelevant: number; linkedStage2: number; linkedStage3: number;
  pending: number; excluded: number;
  topics: { total: number; manual: number; llmAuto: number };
  suggestions: { pending: number; eligible: number };
}
interface Interaction {
  id: string; text: string; posted_at: string; url: string; x_author_id: string;
  program_id: string | null;
  username: string | null; display_name: string | null;
  profile_image_url: string | null; followers_count: number | null; is_verified: boolean | null;
  topic_id: string; topic_name: string;
  program_name: string | null; program_color: string | null;
  confidence: number; stage: number;
}
interface SuggestionMember {
  id: string; text: string; posted_at: string; url: string | null;
  similarity: number | null; username: string | null; display_name: string | null;
}
interface TopicSuggestion {
  id: string; program_id: string; name_ar: string; description: string | null;
  support_count: number; program_name: string; program_color: string | null;
  service_name: string | null; eligible: boolean; members: SuggestionMember[];
  similar_topics: { id: string; name_ar: string; similarity: number }[];
}
interface UnclassifiedInteraction {
  id: string; text: string; posted_at: string; url: string; x_author_id: string;
  program_id: string | null;
  username: string | null; display_name: string | null; profile_image_url: string | null;
  program_name: string | null; program_color: string | null; has_embedding: boolean;
  suggestion_id: string | null; suggestion_name: string | null; suggestion_support: number | null;
}

type ReviewAction = {
  suggestion: TopicSuggestion;
  action: 'approve' | 'merge' | 'reject';
  topicId?: string;
};

const supportTier = (count: number) => {
  if (count >= 3) return { label: 'جاهز للاعتماد', className: 'bg-emerald-500/15 text-emerald-600' };
  if (count === 2) return { label: 'مراجعة سريعة', className: 'bg-amber-500/15 text-amber-600' };
  return { label: 'اعتماد استثنائي', className: 'bg-red-500/15 text-red-600' };
};

const evidenceTerms = (suggestion: TopicSuggestion) => {
  const ignored = new Set(['هذا', 'هذه', 'التي', 'الذي', 'على', 'الى', 'إلى', 'من', 'في', 'عن', 'مع', 'هل', 'ما', 'هو', 'هي', 'تم', 'كان', 'عند']);
  const counts = new Map<string, number>();
  const texts = [suggestion.name_ar, ...suggestion.members.map((member) => member.text)];
  for (const text of texts) {
    const unique = new Set((text.match(/[\p{L}\p{N}_]{3,}/gu) ?? []).map((word) => word.toLowerCase()));
    unique.forEach((word) => { if (!ignored.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1); });
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word);
};

export default function InteractionClassification() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canManage = can(PERMISSIONS.TOPICS_MANAGE);

  const [programId, setProgramId] = useState('');
  const [topicId, setTopicId] = useState('');
  const [minConfidence, setMinConfidence] = useState(0.84);
  const [view, setView] = useState<'approved' | 'suggestions' | 'unclassified'>('approved');
  const [creating, setCreating] = useState(false);
  const [createProgramId, setCreateProgramId] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const [historyAuthorId, setHistoryAuthorId] = useState<string | null>(null);
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [assignmentTargets, setAssignmentTargets] = useState<Record<string, string>>({});
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [reviewName, setReviewName] = useState('');
  const [reviewDescription, setReviewDescription] = useState('');

  const { data: programs } = useQuery({
    queryKey: ['programs'],
    queryFn: () => api.get<{ items: Program[] }>('/programs'),
  });

  const { data: topics } = useQuery({
    queryKey: ['topics', programId],
    queryFn: () => api.get<{ items: Topic[] }>(`/topics${programId ? `?programId=${programId}` : ''}`),
  });

  const { data: createParentTopics } = useQuery({
    queryKey: ['create-topic-parents', createProgramId],
    queryFn: () => api.get<{ items: Topic[] }>(`/topics?programId=${createProgramId}`),
    enabled: creating && !!createProgramId,
  });

  const { data: stats } = useQuery({
    queryKey: ['classification-stats', programId],
    queryFn: () => api.get<ClassificationStats>(`/classification/stats${programId ? `?programId=${programId}` : ''}`),
    refetchInterval: 30_000,
  });

  const { data: interactions, isLoading } = useQuery({
    queryKey: ['classification-interactions', programId, topicId, minConfidence],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '50', minConfidence: String(minConfidence) });
      if (programId) p.set('programId', programId);
      if (topicId) p.set('topicId', topicId);
      return api.get<{ items: Interaction[]; nextCursor: string | null }>(`/classification/interactions?${p}`);
    },
    refetchInterval: 30_000,
  });

  const { data: suggestions, isLoading: suggestionsLoading } = useQuery({
    queryKey: ['topic-suggestions', programId],
    queryFn: () => api.get<{ items: TopicSuggestion[]; minSupport: number }>(
      `/topic-suggestions?status=pending${programId ? `&programId=${programId}` : ''}`,
    ),
    enabled: view === 'suggestions',
  });

  const { data: unclassified, isLoading: unclassifiedLoading } = useQuery({
    queryKey: ['classification-unclassified', programId],
    queryFn: () => api.get<{ items: UnclassifiedInteraction[] }>(
      `/classification/unclassified${programId ? `?programId=${programId}` : ''}`,
    ),
    enabled: view === 'unclassified',
  });

  const createTopic = useMutation({
    mutationFn: () => api.post('/topics', {
      programId: createProgramId,
      parentId: parentId || undefined,
      nameAr: nameAr.trim(),
      description: description.trim() || undefined,
    }),
    onSuccess: () => {
      setProgramId(createProgramId);
      setTopicId('');
      setNameAr('');
      setDescription('');
      setParentId('');
      setCreating(false);
      qc.invalidateQueries({ queryKey: ['topics'] });
      qc.invalidateQueries({ queryKey: ['create-topic-parents'] });
      qc.invalidateQueries({ queryKey: ['classification-stats'] });
    },
  });

  const openCreateTopic = () => {
    createTopic.reset();
    setCreateProgramId(programId);
    setNameAr('');
    setDescription('');
    setParentId('');
    setCreating(true);
  };

  const computeCentroid = useMutation({
    mutationFn: (id: string) => api.post(`/topics/${id}/centroid`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['topics'] }),
  });

  const runClassification = useMutation({
    mutationFn: () => api.post<{ considered: number; embedded: number; linked: number; skipped: number }>('/classification/run', {
      programId: programId || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topics'] });
      qc.invalidateQueries({ queryKey: ['classification-interactions'] });
      qc.invalidateQueries({ queryKey: ['classification-stats'] });
    },
  });

  const reviewSuggestion = useMutation({
    mutationFn: ({ id, action, topicId: mergeTopicId, force, nameAr: approvedName, approvedDescription }: {
      id: string; action: 'approve' | 'merge' | 'reject'; topicId?: string; force?: boolean;
      nameAr?: string; approvedDescription?: string;
    }) => api.post(`/topic-suggestions/${id}/${action}`,
      mergeTopicId ? { topicId: mergeTopicId } : { force, nameAr: approvedName, description: approvedDescription }),
    onSuccess: () => {
      setReviewAction(null);
      qc.invalidateQueries({ queryKey: ['topic-suggestions'] });
      qc.invalidateQueries({ queryKey: ['topics'] });
      qc.invalidateQueries({ queryKey: ['classification-interactions'] });
      qc.invalidateQueries({ queryKey: ['classification-unclassified'] });
      qc.invalidateQueries({ queryKey: ['classification-stats'] });
    },
  });

  const openReview = (suggestion: TopicSuggestion, action: ReviewAction['action'], targetTopicId?: string) => {
    reviewSuggestion.reset();
    setReviewName(suggestion.name_ar);
    setReviewDescription(suggestion.description ?? '');
    setReviewAction({ suggestion, action, topicId: targetTopicId });
  };

  const topicFeedback = useMutation({
    mutationFn: ({ id, correct, correctTopicId }: { id: string; correct: boolean; correctTopicId?: string }) =>
      api.post(`/classification/interactions/${id}/topic-feedback`, { correct, correctTopicId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['classification-interactions'] });
      qc.invalidateQueries({ queryKey: ['classification-unclassified'] });
      qc.invalidateQueries({ queryKey: ['classification-stats'] });
    },
  });

  const topicsWithoutCentroid = (topics?.items ?? []).filter((t) => !t.has_centroid);
  const topTopics = (topics?.items ?? []).filter((t) => t.post_count > 0).slice(0, 8);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2.5 text-xl font-bold"><ChartNoAxesCombined size={22} className="text-brand-500" /> تصنيف التفاعلات</h1>
        <p className="text-sm muted">
          يربط كل منشور بموضوع عبر تشابه المتجهات (Qwen3-Embedding-8B) — مهما ارتفعت النسبة فهي درجة تشابه وليست يقيناً
          مطلقاً؛ لهذا لا يُربط أي منشور تحت الحد الأدنى المختار بدلاً من التخمين.
        </p>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-3">
            <div className="text-xs muted">مؤهّلة للتصنيف</div>
            <div className="text-xl font-bold num">{fmtNum(stats.totalRelevant)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs muted">مرتبطة (تشابه)</div>
            <div className="text-xl font-bold num text-emerald-600">{fmtNum(stats.linkedStage2)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs muted">مرتبطة (LLM)</div>
            <div className="text-xl font-bold num text-emerald-600">{fmtNum(stats.linkedStage3)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs muted" title="لم تُفحص بعد">قيد الانتظار</div>
            <div className="text-xl font-bold num text-amber-600">{fmtNum(stats.pending)}</div>
          </div>
          <div className="card p-3">
            <div className="text-xs muted" title="فُحصت ولم تطابق أي موضوع بثقة كافية">مستبعدة</div>
            <div className="text-xl font-bold num muted">{fmtNum(stats.excluded)}</div>
          </div>
        </div>
      )}

      <div className="classification-tabs" role="tablist" aria-label="أقسام تصنيف التفاعلات">
        <button className={view === 'approved' ? 'is-active' : ''} onClick={() => setView('approved')}>
          المواضيع المعتمدة <span className="num">{stats?.topics.total ?? 0}</span>
        </button>
        <button className={view === 'suggestions' ? 'is-active' : ''} onClick={() => setView('suggestions')}>
          مقترحات للمراجعة <span className="num">{stats?.suggestions.pending ?? 0}</span>
          {!!stats?.suggestions.eligible && <span className="classification-tab-alert num">{stats.suggestions.eligible}</span>}
        </button>
        <button className={view === 'unclassified' ? 'is-active' : ''} onClick={() => setView('unclassified')}>
          غير مصنف <span className="num">{(stats?.pending ?? 0) + (stats?.excluded ?? 0)}</span>
        </button>
      </div>

      {view === 'approved' && topTopics.length > 0 && (
        <div className="card p-4">
          <div className="text-sm font-medium mb-3">
            المواضيع الأكثر تكراراً
            {stats && (
              <span className="text-xs muted font-normal"> — {stats.topics.total} موضوع ({stats.topics.manual} يدوي · {stats.topics.llmAuto} مُكتشَف تلقائياً)</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {topTopics.map((t) => (
              <button
                key={t.id}
                className="badge bg-[var(--surface-3)] hover:bg-brand-500/15 hover:text-brand-600"
                onClick={() => { setTopicId(t.id); setProgramId(t.program_id); }}
                title={t.description ?? undefined}
              >
                {t.name_ar}
                <span className="num text-[10px] opacity-70">{t.post_count}</span>
                <span className="text-[10px] opacity-70">✓ {t.human_reviewed_count}</span>
                {t.avg_similarity !== null && <span className="num text-[10px] opacity-70">{fmtPct(t.avg_similarity)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select className="input max-w-48" value={programId} onChange={(e) => { setProgramId(e.target.value); setTopicId(''); }}>
          <option value="">كل البرامج</option>
          {(programs?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
        </select>
        {view === 'approved' && <select className="input max-w-56" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
          <option value="">كل المواضيع</option>
          {(topics?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name_ar}</option>)}
        </select>}
        {view === 'approved' && <label className="flex items-center gap-2 text-xs muted">
          حد الثقة الأدنى
          <input
            type="number" min={0.5} max={0.99} step={0.01}
            className="input !w-20"
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          />
        </label>}

        <div className="flex-1" />

        {canManage && (
          <>
            {view === 'approved' && <button className="btn-ghost" onClick={openCreateTopic} disabled={!programs?.items.length}>
              <Plus size={15} /> موضوع جديد
            </button>}
            <button
              className="btn-primary"
              disabled={runClassification.isPending}
              onClick={() => runClassification.mutate()}
            >
              <Zap size={15} /> {runClassification.isPending ? 'جارٍ التصنيف…' : 'تشغيل التصنيف'}
            </button>
          </>
        )}
      </div>

      {runClassification.data && (
        <div className="card p-3 text-sm">
          فُحص <span className="num font-medium">{runClassification.data.considered}</span> منشوراً
          ({runClassification.data.embedded} منها تم تضمينه حديثاً)،
          {' '}ورُبط <span className="num font-medium text-emerald-600">{runClassification.data.linked}</span> منها بموضوع بثقة عالية،
          {' '}وتُرك <span className="num font-medium">{runClassification.data.skipped}</span> بلا ربط لعدم بلوغ الحد الأدنى.
        </div>
      )}
      {runClassification.error && (
        <div className="card p-3 text-sm text-red-600">
          {(runClassification.error as ApiError).message}
        </div>
      )}

      {view === 'approved' && canManage && topicsWithoutCentroid.length > 0 && (
        <div className="card p-3">
          <div className="text-sm font-medium mb-2">مواضيع بلا centroid — لن تُستخدم في المطابقة حتى تُحسب:</div>
          <div className="flex flex-wrap gap-2">
            {topicsWithoutCentroid.map((t) => (
              <button
                key={t.id}
                className="badge bg-amber-500/15 text-amber-700 dark:text-amber-400"
                onClick={() => computeCentroid.mutate(t.id)}
                disabled={computeCentroid.isPending}
              >
                احسب centroid: {t.name_ar}
              </button>
            ))}
          </div>
          {computeCentroid.error && (
            <div className="text-xs text-red-600 mt-2">{(computeCentroid.error as ApiError).message}</div>
          )}
        </div>
      )}

      {view === 'approved' && isLoading && <div className="card p-8 text-center muted text-sm">جارٍ التحميل…</div>}

      {view === 'approved' && !isLoading && !interactions?.items?.length && (
        <div className="card p-10 text-center">
          <p className="muted">
            لا توجد تفاعلات مصنّفة بعد. أنشئ موضوعاً، احسب centroid له، ثم شغّل التصنيف.
          </p>
        </div>
      )}

      {view === 'suggestions' && suggestionsLoading && (
        <div className="card p-8 text-center muted text-sm">جارٍ تحميل المقترحات…</div>
      )}
      {view === 'suggestions' && !suggestionsLoading && !suggestions?.items.length && (
        <div className="card p-10 text-center muted">لا توجد مقترحات تنتظر المراجعة.</div>
      )}
      {view === 'suggestions' && (
        <div className="grid gap-3 lg:grid-cols-2">
          {(suggestions?.items ?? []).map((suggestion) => (
            <article className="card overflow-hidden" key={suggestion.id}>
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold">{suggestion.name_ar}</h3>
                      <span className={`badge ${supportTier(suggestion.support_count).className}`}>
                        <span className="num">{suggestion.support_count}</span> تفاعلات داعمة
                      </span>
                      <span className={`badge ${supportTier(suggestion.support_count).className}`}>
                        {supportTier(suggestion.support_count).label}
                      </span>
                    </div>
                    <div className="mt-1 text-xs muted">
                      {suggestion.program_name}{suggestion.service_name ? ` · ${suggestion.service_name}` : ''}
                    </div>
                  </div>
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: suggestion.program_color ?? '#888' }} />
                </div>
                {suggestion.description && <p className="mt-3 text-sm leading-6 muted">{suggestion.description}</p>}
                {evidenceTerms(suggestion).length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="muted">أدلة نصية مشتركة:</span>
                    {evidenceTerms(suggestion).map((term) => (
                      <span key={term} className="badge bg-brand-500/10 text-brand-600">{term}</span>
                    ))}
                  </div>
                )}
                {(suggestion.similar_topics ?? []).length > 0 && (
                  <div className="mt-3 rounded-lg border border-[var(--border)] p-2.5 text-xs">
                    <div className="mb-1.5 font-medium">مواضيع معتمدة قريبة — تحقق قبل إنشاء موضوع مكرر:</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(suggestion.similar_topics ?? []).map((topic) => (
                        <button
                          type="button"
                          key={topic.id}
                          className={`badge ${topic.similarity >= 0.82 ? 'bg-amber-500/15 text-amber-600' : 'bg-[var(--surface-2)]'}`}
                          onClick={() => setMergeTargets((current) => ({ ...current, [suggestion.id]: topic.id }))}
                        >
                          {topic.name_ar} · <span className="num">{fmtPct(topic.similarity)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-3 space-y-2">
                  {suggestion.members.slice(0, 3).map((member) => (
                    <a key={member.id} href={member.url ?? '#'} target="_blank" rel="noreferrer" className="block rounded-lg bg-[var(--surface-2)] p-2.5 text-xs leading-5 hover:text-brand-600">
                      <span className="font-medium">{member.display_name ?? member.username ?? 'حساب'}</span>
                      <span className="muted"> — {member.text.length > 150 ? `${member.text.slice(0, 150)}…` : member.text}</span>
                      {member.similarity !== null && <span className="num ms-2 text-brand-600" title="تشابه التفاعل مع مركز المقترح">{fmtPct(member.similarity)}</span>}
                    </a>
                  ))}
                </div>
              </div>
              {canManage && (
                <div className="border-t border-[var(--border)] bg-[var(--surface-2)] p-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-primary !py-1.5 !text-xs"
                      disabled={reviewSuggestion.isPending}
                      title={!suggestion.eligible ? 'سيُسجل كاعتماد يدوي استثنائي لعدم اكتمال عدد التفاعلات الداعمة' : ''}
                      onClick={() => openReview(suggestion, 'approve')}
                    >
                      {suggestion.eligible ? 'اعتماد الموضوع' : 'اعتماد يدوي'}
                    </button>
                    <select
                      className="input !w-48 !py-1.5 !text-xs"
                      value={mergeTargets[suggestion.id] ?? ''}
                      onChange={(e) => setMergeTargets((current) => ({ ...current, [suggestion.id]: e.target.value }))}
                    >
                      <option value="">دمج مع موضوع…</option>
                      {(topics?.items ?? []).filter((t) => t.program_id === suggestion.program_id).map((t) => (
                        <option key={t.id} value={t.id}>{t.name_ar}</option>
                      ))}
                    </select>
                    <button
                      className="btn-ghost !py-1.5 !text-xs"
                      disabled={!mergeTargets[suggestion.id] || reviewSuggestion.isPending}
                      onClick={() => openReview(suggestion, 'merge', mergeTargets[suggestion.id])}
                    >دمج</button>
                    <button
                      className="btn-ghost !py-1.5 !text-xs !text-red-600"
                      disabled={reviewSuggestion.isPending}
                      onClick={() => openReview(suggestion, 'reject')}
                    >رفض</button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {view === 'unclassified' && unclassifiedLoading && (
        <div className="card p-8 text-center muted text-sm">جارٍ تحميل التفاعلات…</div>
      )}
      {view === 'unclassified' && !unclassifiedLoading && !unclassified?.items.length && (
        <div className="card p-10 text-center muted">لا توجد تفاعلات غير مصنفة.</div>
      )}
      {view === 'unclassified' && (
        <div className="space-y-2">
          {(unclassified?.items ?? []).map((it) => (
            <article className="card p-4" key={it.id}>
              <div className="flex items-start gap-3">
                <Avatar src={it.profile_image_url} name={it.display_name} username={it.username} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs muted">
                    <span className="font-medium text-[var(--text)]">{it.display_name ?? it.username ?? 'حساب غير معروف'}</span>
                    {it.program_name && <span>{it.program_name}</span>}
                    <span className={`badge ${it.has_embedding ? 'bg-amber-500/15 text-amber-600' : 'bg-slate-500/15'}`}>
                      {it.suggestion_name ? `ضمن مقترح: ${it.suggestion_name}` : it.has_embedding ? 'لم يبلغ حد الثقة' : 'بانتظار الفحص'}
                    </span>
                  </div>
                  <a href={it.url} target="_blank" rel="noreferrer" className="mt-2 block text-sm leading-7 hover:text-brand-600">{it.text}</a>
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2 text-xs muted">
                    <span>{fmtRelative(it.posted_at)}</span>
                    {canManage && (
                      <div className="ms-auto flex gap-2">
                        <select
                          className="input !w-52 !py-1 !text-xs"
                          value={assignmentTargets[it.id] ?? ''}
                          onChange={(e) => setAssignmentTargets((current) => ({ ...current, [it.id]: e.target.value }))}
                        >
                          <option value="">اختر موضوعًا معتمدًا…</option>
                          {(topics?.items ?? []).filter((t) => !it.program_id || t.program_id === it.program_id).map((t) => (
                            <option key={t.id} value={t.id}>{t.name_ar}</option>
                          ))}
                        </select>
                        <button
                          className="btn-primary !px-3 !py-1 !text-xs"
                          disabled={!assignmentTargets[it.id] || topicFeedback.isPending}
                          onClick={() => topicFeedback.mutate({ id: it.id, correct: false, correctTopicId: assignmentTargets[it.id] })}
                        >ربط</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {view === 'approved' && <div className="space-y-2">
        {(interactions?.items ?? []).map((it) => (
          <article key={it.id} className="card p-4">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => setHistoryAuthorId(it.x_author_id)}
                className="rounded-full focus-visible:outline-2 focus-visible:outline-brand-500"
                aria-label={it.username ? `فتح سجل تفاعلات ${it.username}` : 'فتح سجل تفاعلات الحساب'}
              >
                <Avatar
                  src={it.profile_image_url}
                  name={it.display_name}
                  username={it.username}
                  size={40}
                  ring={it.is_verified ?? false}
                />
              </button>

              <div className="min-w-0 flex-1 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs muted mb-1 flex flex-wrap items-center gap-x-1.5">
                    <button type="button" onClick={() => setHistoryAuthorId(it.x_author_id)} className="hover:text-brand-600 hover:underline font-medium">
                      {it.display_name ?? it.username ?? 'حساب غير معروف'}
                    </button>
                    {it.followers_count !== null && (
                      <span><span className="num">{fmtNum(it.followers_count)}</span> متابع</span>
                    )}
                    {it.program_name && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full inline-block" style={{ background: it.program_color ?? '#888' }} />
                          {it.program_name}
                        </span>
                      </>
                    )}
                  </div>
                  <a href={it.url} target="_blank" rel="noreferrer" className="text-[15px] leading-7 hover:text-brand-600">
                    {it.text}
                  </a>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className="badge bg-brand-500/15 text-brand-600 dark:text-brand-400">{it.topic_name}</span>
                  {it.stage === 2 ? (
                    <span className="num text-xs muted" title="درجة التشابه مع مركز الموضوع">{fmtPct(it.confidence)}</span>
                  ) : (
                    <span className="text-xs text-emerald-600">مراجع بشريًا</span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-3 border-t pt-2 text-xs muted" style={{ borderColor: 'var(--border)' }}>
              <div className="flex flex-wrap items-center gap-2">
                <span>{fmtRelative(it.posted_at)}</span>
                {canManage && (
                  <div className="ms-auto flex flex-wrap justify-end gap-1.5">
                    <button className="btn-ghost !px-2 !py-1 !text-xs !text-emerald-600" disabled={topicFeedback.isPending} onClick={() => topicFeedback.mutate({ id: it.id, correct: true })}><Check size={13} /> التصنيف صحيح</button>
                    <button className="btn-ghost !px-2 !py-1 !text-xs !text-red-600" disabled={topicFeedback.isPending} onClick={() => topicFeedback.mutate({ id: it.id, correct: false })}><X size={13} /> التصنيف خاطئ</button>
                    <select
                      className="input !w-44 !py-1 !text-xs"
                      value={moveTargets[it.id] ?? ''}
                      onChange={(e) => setMoveTargets((current) => ({ ...current, [it.id]: e.target.value }))}
                      aria-label="نقل التفاعل إلى موضوع آخر"
                    >
                      <option value="">نقل إلى موضوع…</option>
                      {(topics?.items ?? []).filter((topic) => topic.id !== it.topic_id && (!it.program_id || topic.program_id === it.program_id)).map((topic) => (
                        <option key={topic.id} value={topic.id}>{topic.name_ar}</option>
                      ))}
                    </select>
                    <button
                      className="btn-ghost !px-2 !py-1 !text-xs"
                      disabled={!moveTargets[it.id] || topicFeedback.isPending}
                      onClick={() => topicFeedback.mutate({ id: it.id, correct: false, correctTopicId: moveTargets[it.id] })}
                    >نقل</button>
                  </div>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>}

      {creating && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setCreating(false)}>
          <form
            className="card p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); if (createProgramId && nameAr.trim()) createTopic.mutate(); }}
          >
            <h3 className="font-bold mb-1">موضوع جديد</h3>
            <p className="text-xs muted mb-4">
              اختر البرنامج ثم أضف اسمًا واضحًا ووصفًا يساعد على تصنيف التفاعلات بدقة.
            </p>
            <label className="mb-3 block text-xs font-medium">
              البرنامج <span className="text-red-500">*</span>
              <select
                className="input mt-1.5"
                value={createProgramId}
                onChange={(e) => { setCreateProgramId(e.target.value); setParentId(''); }}
                autoFocus
              >
                <option value="">اختر البرنامج…</option>
                {(programs?.items ?? []).map((program) => (
                  <option key={program.id} value={program.id}>{program.name_ar}</option>
                ))}
              </select>
            </label>
            <input className="input mb-3" value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="اسم الموضوع" />
            <textarea className="input mb-4" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="وصف مختصر (اختياري لكن يُحسّن الدقة)" />
            <select className="input mb-4" value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={!createProgramId}>
              <option value="">موضوع رئيسي</option>
              {(createParentTopics?.items ?? []).filter((topic) => topic.level === 1).map((topic) => (
                <option key={topic.id} value={topic.id}>فرعي تحت: {topic.name_ar}</option>
              ))}
            </select>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>إلغاء</button>
              <button className="btn-primary" disabled={!createProgramId || !nameAr.trim() || createTopic.isPending}>
                {createTopic.isPending ? 'جارٍ الإنشاء…' : 'إنشاء الموضوع'}
              </button>
            </div>
            {createTopic.error && <div className="text-xs text-red-600 mt-3">{(createTopic.error as ApiError).message}</div>}
          </form>
        </div>
      )}

      {reviewAction && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setReviewAction(null)}>
          <div className="card w-full max-w-lg overflow-hidden" onClick={(event) => event.stopPropagation()}>
            <div className="border-b border-[var(--border)] p-5">
              <h3 className="font-bold">
                {reviewAction.action === 'approve' && 'مراجعة واعتماد الموضوع'}
                {reviewAction.action === 'merge' && 'تأكيد دمج الموضوع'}
                {reviewAction.action === 'reject' && 'تأكيد رفض المقترح'}
              </h3>
              <p className="mt-1 text-xs muted">
                القرار سيُسجّل باسم المستخدم مع عدد التفاعلات الداعمة ووقت المراجعة.
              </p>
            </div>
            <div className="space-y-4 p-5">
              <div className={`rounded-lg p-3 text-sm ${supportTier(reviewAction.suggestion.support_count).className}`}>
                <span className="font-bold">{supportTier(reviewAction.suggestion.support_count).label}</span>
                {' · '}<span className="num">{reviewAction.suggestion.support_count}</span> تفاعلات داعمة
                {reviewAction.suggestion.support_count < 3 && (
                  <div className="mt-1 text-xs">هذا القرار يدوي استثنائي؛ لن يعتمد النظام موضوعًا بهذه القوة تلقائيًا.</div>
                )}
              </div>

              {reviewAction.action === 'approve' ? (
                <>
                  <label className="block text-xs font-medium">
                    اسم الموضوع بعد المراجعة
                    <input className="input mt-1.5" value={reviewName} onChange={(event) => setReviewName(event.target.value)} autoFocus />
                  </label>
                  <label className="block text-xs font-medium">
                    الوصف
                    <textarea className="input mt-1.5" rows={3} value={reviewDescription} onChange={(event) => setReviewDescription(event.target.value)} />
                  </label>
                  {(reviewAction.suggestion.similar_topics ?? []).some((topic) => topic.similarity >= 0.82) && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                      يوجد موضوع معتمد قريب بنسبة مرتفعة. راجع خيار الدمج قبل إنشاء موضوع جديد لتجنب التكرار.
                    </div>
                  )}
                </>
              ) : reviewAction.action === 'merge' ? (
                <div className="rounded-lg bg-[var(--surface-2)] p-3 text-sm">
                  سيتم نقل جميع التفاعلات إلى: <strong>{(topics?.items ?? []).find((topic) => topic.id === reviewAction.topicId)?.name_ar}</strong>
                </div>
              ) : (
                <p className="text-sm leading-6">سيُرفض المقترح ولن يظهر ضمن المواضيع المعتمدة، مع بقاء سجله محفوظًا للتدقيق.</p>
              )}

              {reviewSuggestion.error && <div className="text-sm text-red-600">{(reviewSuggestion.error as ApiError).message}</div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] p-4">
              <button className="btn-ghost" onClick={() => setReviewAction(null)} disabled={reviewSuggestion.isPending}>إلغاء</button>
              <button
                className={reviewAction.action === 'reject' ? 'btn-ghost !text-red-600' : 'btn-primary'}
                disabled={reviewSuggestion.isPending || (reviewAction.action === 'approve' && !reviewName.trim())}
                onClick={() => reviewSuggestion.mutate({
                  id: reviewAction.suggestion.id,
                  action: reviewAction.action,
                  topicId: reviewAction.topicId,
                  force: reviewAction.action === 'approve' && reviewAction.suggestion.support_count < 3,
                  nameAr: reviewAction.action === 'approve' ? reviewName.trim() : undefined,
                  approvedDescription: reviewAction.action === 'approve' ? reviewDescription.trim() : undefined,
                })}
              >
                {reviewSuggestion.isPending ? 'جارٍ الحفظ…' : reviewAction.action === 'approve' ? 'تأكيد الاعتماد' : reviewAction.action === 'merge' ? 'تأكيد الدمج' : 'تأكيد الرفض'}
              </button>
            </div>
          </div>
        </div>
      )}

      {historyAuthorId && (
        <AuthorHistoryModal xAuthorId={historyAuthorId} onClose={() => setHistoryAuthorId(null)} />
      )}
    </div>
  );
}
