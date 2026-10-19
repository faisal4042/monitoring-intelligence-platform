/**
 * One queue card, in the shape agents know from social inboxes: who (avatar with the source on it, name, handle,
 * account figures), when, the interaction, its conversation start, a row of one-click actions, and a footer with the
 * ticket number and the clocks. Actions go to the same queue endpoints as the drawer (the server re-checks every rule);
 * anything that needs more (assigning to someone, a corrected review, transfers) opens the details.
 */
import {lazy, Suspense, useLayoutEffect, useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  CheckCircle2, Clock, Copy, ExternalLink, Flame, Hand, History, IdCard, Maximize2, ScrollText, MessageSquareText, Sparkles,
  StickyNote, TriangleAlert, UserRound, X as Close, Zap,
} from 'lucide-react';
import {canReadInfluencerCards, PERMISSIONS as P, QUEUE_REVIEW_OUTCOME_LABELS, QUEUE_SECTION_LABELS, QUEUE_STATUS_LABELS, type QueueReviewOutcome, type QueueStatus} from '@mip/shared';
import ModalSurface, {ModalCloseButton} from '../ModalSurface';
import {Button} from '../ui/Button';
import {OverflowMenu, type OverflowItem} from '../ui/OverflowMenu';
import {api} from '../../lib/api';
import {InteractionMedia} from '../media/InteractionMedia';
import TicketHistoryDialog from './TicketHistoryDialog';
// The card renderer is heavy; load it only when an export is opened.
const CardExportDialog = lazy(() => import('../influencers/CardExportDialog'));
import {useAuth} from '../../lib/auth';
import {INTENT_LABELS, SENTIMENT_LABELS, SOURCE_LABELS, sourceOf, workTimer, type QueueItem, type ReviewCatalog} from '../../lib/queue';
import {fmtCompact, fmtDateTime, fmtNum, fmtRelative} from '../../lib/format';
import Avatar from '../Avatar';
import {contentDirection} from '../../lib/content-direction';
import {SOURCE_BADGE_LABELS, SourceBadge, SourceIcon, isSourceCard, sourceKeyOf, sourceOrigin, sourceText, sourceTitle, sourceUrl} from './SourceParts';

type Panel = null | 'escalate' | 'note' | 'priority';

export default function InteractionCard({item, now, warnMinutes, selected, onOpen, closed = false}: {
  item: QueueItem; now?: string; warnMinutes: number; selected: boolean; onOpen: () => void; closed?: boolean;
}) {
  const {user, can} = useAuth();
  const qc = useQueryClient();
  // Same cached settings the drawer uses: whether agents may take unassigned work themselves.
  const {data: catalog} = useQuery({queryKey: ['queue-review-catalog'], queryFn: () => api.get<ReviewCatalog>('/queue/review-catalog'), staleTime: 60_000});
  const selfClaim = !!catalog?.selfClaim;
  const [panel, setPanel] = useState<Panel>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const [exportingCard, setExportingCard] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const story = item.interaction_type === 'story';
  const src = isSourceCard(item);
  const key = sourceKeyOf(item);
  const supervise = can(P.QUEUE_SUPERVISE);
  const mine = item.assignee_id === user?.id;
  const live = !item.merged_into_id && item.status !== 'completed';
  const working = mine && ['assigned', 'in_progress'].includes(item.status);
  const canClose = live && (working || (supervise && item.status === 'escalated'));
  const canEscalate = live && ['assigned', 'in_progress'].includes(item.status) && (mine || supervise);
  const canNote = !item.merged_into_id && (mine || supervise);
  const canClaim = live && item.status === 'new' && can(P.QUEUE_WORK) && (selfClaim || supervise);
  const link = src ? sourceUrl(item) : story ? null : item.url;
  const timer = workTimer(item, now, warnMinutes);
  const ticket = item.tickets?.[0];
  const messages = item.tickets?.reduce((n, t) => n + (t.messages ?? 0), 0) ?? 0;

  const act = useMutation({
    mutationFn: ({path, body}: {path: string; body: Record<string, unknown>}) => api.post(`/queue/items/${item.id}/${path}`, {expectedVersion: item.version, ...body}),
    onSuccess: () => { setPanel(null); setText(''); setClosing(false); qc.invalidateQueries({queryKey: ['queue']}); qc.invalidateQueries({queryKey: ['queue-item', item.id]}); },
  });
  const run = (path: string, body: Record<string, unknown> = {}) => act.mutate({path, body});
  const toggle = (p: Panel) => { act.reset(); setText(''); setPanel(panel === p ? null : p); };
  const copy = async () => { if (!link) return; try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked: the link stays openable */ } };

  // Who: avatar (or the source/story mark) carrying the source logo, name, handle, account figures.
  const name = story ? item.story_title ?? 'قصة' : src ? sourceTitle(item) : item.display_name ?? item.username ?? 'حساب غير متاح';
  const figures = story
    ? [`${fmtNum(item.story_post_count ?? 0)} تفاعل`, item.story_influencer_count ? `${fmtNum(item.story_influencer_count)} مؤثر` : null]
    : src ? [SOURCE_BADGE_LABELS[key], sourceOrigin(item)]
    : [item.followers_count != null ? `${fmtCompact(item.followers_count)} متابع` : null, item.following_count != null ? `${fmtCompact(item.following_count)} يتابع` : null,
       item.tweet_count != null ? `${fmtCompact(item.tweet_count)} منشور` : null];
  const body = story ? item.story_summary ?? '' : src ? sourceText(item) : item.text ?? 'المصدر غير متاح — السجل التشغيلي محفوظ';
  // The clamp is CSS (width, font, wrapping), so measure real overflow rather than guess from length.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && !expanded) setCanExpand(el.scrollHeight - el.clientHeight > 1);
  }, [body, expanded]);
  const at = story ? item.story_last_seen_at : src ? item.source_snapshot?.publishedAt : item.post_posted_at;
  const channelTag = story ? 'قصة متداولة على إكس' : src ? SOURCE_BADGE_LABELS[key] : `X · ${item.root_text ? SOURCE_LABELS.reply : SOURCE_LABELS[sourceOf(item)]}`;

  return <article className={`ic-card card queue-card--src-${key} ${selected ? 'is-selected' : ''} ${item.priority === 'high' ? 'is-high' : ''}`} aria-label={`${SOURCE_BADGE_LABELS[key]}: ${name}`}>
    <button type="button" className="ic-main" onClick={onOpen} aria-label={`فتح تفاصيل ${name}`}>
      <span className="ic-head">
        <span className="ic-avatar">
          {story ? <span className="alert-kind alert-kind--story !w-11 !h-11" aria-hidden="true"><Sparkles size={19}/></span>
            : src ? <SourceIcon kind={item.interaction_type as 'news'} size={20}/>
            : <Avatar src={item.profile_image_url} name={item.display_name} username={item.username} size={44}/>}
          <span className={`ic-avatar-source ic-avatar-source--${key}`} aria-hidden="true"><SourceBadge item={item} iconOnly/></span>
        </span>
        <span className="ic-who">
          <span className="ic-name-row"><strong className="ic-name">{name}</strong>
            {!story && !src && item.username && <span className="ic-handle" dir="ltr">@{item.username}</span>}</span>
          <span className="ic-figures">{figures.filter(Boolean).join(' · ')}</span>
        </span>
        <span className="ic-when" title={at ? fmtDateTime(at) : undefined}><Zap size={15} aria-hidden="true"/>{at ? fmtRelative(at) : '—'}</span>
      </span>
      {body && <span ref={textRef} className={`ic-text ${expanded ? 'is-expanded' : ''}`} dir={contentDirection(body)}>{body}</span>}
      {!story && !src && item.root_text && <span className="ic-root">
        <span className="ic-root-head"><span className="ic-root-tag">بداية المحادثة</span>
          <span className="ic-root-who">{item.root_display_name ?? item.root_username ?? ''}{item.root_username && <span dir="ltr"> @{item.root_username}</span>}</span>
          {item.root_posted_at && <span className="ic-root-time">{fmtRelative(item.root_posted_at)}</span>}</span>
        <span className="ic-root-text" dir={contentDirection(item.root_text ?? '')}>{item.root_text}</span>
      </span>}
    </button>
    {canExpand && <button type="button" className="ic-read-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
      {expanded ? 'عرض أقل' : 'عرض المزيد'}</button>}
    {!story && !src && !!item.media?.length && <div className="ic-queue-media">
      <InteractionMedia post={item} onLightbox={(url) => window.open(url, '_blank', 'noopener,noreferrer')}/></div>}

    {/* One primary action (claim, else close), the details, and everything else under «المزيد» — only what is allowed now. */}
    <div className="ic-actions" role="toolbar" aria-label="إجراءات التفاعل">
      {canClaim ? <Button variant="primary" size="sm" icon={<Hand size={16} aria-hidden="true"/>} loading={act.isPending} onClick={() => run('claim')}>استلام</Button>
        : canClose && <Button variant="primary" size="sm" icon={<CheckCircle2 size={16} aria-hidden="true"/>} aria-pressed={closing || undefined}
            onClick={() => { act.reset(); setPanel(null); setClosing(true); }}>إغلاق التفاعل</Button>}
      <Button variant="ghost" size="sm" icon={<Maximize2 size={15} aria-hidden="true"/>} onClick={onOpen}>التفاصيل</Button>
      <OverflowMenu items={([
        canClaim && canClose ? {key: 'close', label: 'إغلاق التفاعل', icon: <CheckCircle2 size={16}/>, onSelect: () => { act.reset(); setPanel(null); setClosing(true); }} : null,
        canEscalate ? {key: 'escalate', label: 'تصعيد', icon: <TriangleAlert size={16}/>, onSelect: () => toggle('escalate')} : null,
        canNote ? {key: 'note', label: 'ملاحظة داخلية', icon: <StickyNote size={16}/>, onSelect: () => toggle('note')} : null,
        supervise && live ? {key: 'priority', label: item.priority === 'high' ? 'إلغاء الأولوية العالية' : 'أولوية عالية', icon: <Flame size={16}/>, onSelect: () => toggle('priority')} : null,
        link ? {key: 'open', label: 'فتح في المصدر', icon: <ExternalLink size={16}/>, href: link} : null,
        link ? {key: 'copy', label: copied ? 'نُسخ الرابط' : 'نسخ الرابط', icon: <Copy size={16}/>, onSelect: () => void copy()} : null,
        !story && !src ? {key: 'client', label: 'سجل العميل', icon: <History size={16}/>, onSelect: onOpen} : null,
        {key: 'history', label: 'سجل التذكرة', icon: <ScrollText size={16}/>, onSelect: () => setHistoryOpen(true)},
        item.section === 'influencer' && item.influencer_id && canReadInfluencerCards(user)
          ? {key: 'card', label: 'تصدير بطاقة المؤثر', icon: <IdCard size={16}/>, onSelect: () => setExportingCard(true)} : null,
      ] as Array<OverflowItem | null>).filter((x): x is OverflowItem => !!x)}/>
      <span className={`ic-channel ic-channel--${key}`}>{channelTag}{item.program_snapshot?.name ? ` (${item.program_snapshot.name})` : ''}</span>
      {copied && <span className="sr-only" role="status">نُسخ الرابط</span>}
    </div>

    {panel && <div className="ic-panel">
      {(panel === 'escalate' || panel === 'note' || panel === 'priority') && <form className="ic-panel-row" onSubmit={(e) => {
        e.preventDefault();
        if (panel === 'escalate') run('escalate', {reason: text.trim()});
        else if (panel === 'note') run('notes', {body: text.trim()});
        else act.mutate({path: 'priority', body: {priority: item.priority === 'high' ? 'normal' : 'high', reason: text.trim()}});
      }}>
        <input className="input ic-input" autoFocus maxLength={panel === 'note' ? 5000 : 2000} value={text} onChange={(e) => setText(e.target.value)}
          aria-label={panel === 'escalate' ? 'سبب التصعيد' : panel === 'note' ? 'نص الملاحظة' : 'سبب تغيير الأولوية'}
          placeholder={panel === 'escalate' ? 'سبب التصعيد (إلزامي)' : panel === 'note' ? 'ملاحظة داخلية للفريق' : item.priority === 'high' ? 'سبب إعادة الأولوية لعادية (إلزامي)' : 'سبب الأولوية العالية (إلزامي)'}/>
        <Button variant="primary" type="submit" disabled={act.isPending || !text.trim()}>{panel === 'escalate' ? 'تصعيد' : panel === 'note' ? 'حفظ' : item.priority === 'high' ? 'أولوية عادية' : 'أولوية عالية'}</Button>
      </form>}
      <button type="button" className="ic-panel-close" aria-label="إغلاق اللوحة" onClick={() => setPanel(null)}><Close size={15}/></button>
      {act.error && <p role="alert" className="ic-error">{(act.error as Error).message}</p>}
    </div>}
    {closing && <CloseDialog ticket={ticket?.number} busy={act.isPending} error={act.error ? (act.error as Error).message : null}
      onCancel={() => { act.reset(); setClosing(false); }} onOpenDetails={() => { setClosing(false); onOpen(); }}
      onSave={(outcome, comment) => run('complete', {review: {outcome, ...(outcome === 'irrelevant' ? {relevant: false} : {}), ...(comment ? {reason: comment} : {})}})}/>}
    {act.error && !panel && !closing && <p role="alert" className="ic-error ic-error--bar">{(act.error as Error).message}</p>}

    <footer className="ic-foot">
      <span className="ic-foot-start">
        <span className="ic-ticket">{ticket ? <>التذكرة <bdi>#{ticket.number}</bdi>{(item.tickets?.length ?? 0) > 1 && ` +${(item.tickets!.length - 1)}`}</> : 'بدون تذكرة'}</span>
        <AiStrip item={item} story={story} src={src}/>
      </span>
      <span className="ic-foot-meta">
        {messages > 1 && <span className="ic-count" title="رسائل التذكرة"><MessageSquareText size={14}/>{fmtNum(messages)}</span>}
        {item.section !== 'general' && <span className={`queue-tag queue-tag--${item.section}`}>{item.section === 'influencer' ? <UserRound size={11}/> : <Sparkles size={11}/>}{QUEUE_SECTION_LABELS[item.section].ar}</span>}
        {item.priority === 'high' && <span className="queue-tag queue-tag--hold"><Flame size={11}/>أولوية عالية</span>}
        {closed ? <span className="ic-clock"><Clock size={14}/>أُغلق {fmtRelative(item.completed_at ?? '')}</span>
          : timer && <span className={`ic-clock ${timer.warn ? 'is-late' : ''}`} title={timer.warn ? `تجاوز ${warnMinutes} دقيقة` : undefined}><Clock size={14}/>{timer.label} {timer.text}</span>}
        <span className={`queue-status-badge queue-status-badge--${item.status}`}>{QUEUE_STATUS_LABELS[item.status as QueueStatus]}</span>
        <span className="ic-assignee">{item.assignee_name ?? 'غير مسند'}</span>
      </span>
    </footer>
    {historyOpen && <TicketHistoryDialog id={item.id} ticket={ticket?.number} onClose={() => setHistoryOpen(false)}/>}
    {exportingCard && item.influencer_id && <Suspense fallback={null}>
      <CardExportDialog account={{id: item.influencer_id, username: item.username ?? ''}} onClose={() => setExportingCard(false)}/></Suspense>}
  </article>;
}

const pctOf = (v: number | null | undefined) => (v == null ? null : `${Math.round(v * 100)}%`);
/** The AI classification beside the ticket number: programme, intent, sentiment, topic and relevance, with confidence. */
function AiStrip({item, story, src}: {item: QueueItem; story: boolean; src: boolean}) {
  const sentiment = item.sentiment ? SENTIMENT_LABELS[item.sentiment] : null;
  const chips: Array<{label: string; value: string; conf?: string | null; cls?: string}> = [
    {label: 'البرنامج', value: item.program_snapshot?.name ?? '—'},
  ];
  if (!story && !src) {
    if (item.intent) chips.push({label: 'النوع', value: INTENT_LABELS[item.intent] ?? item.intent, conf: pctOf(item.intent_confidence)});
    if (sentiment) chips.push({label: 'المشاعر', value: sentiment.text, conf: pctOf(item.sentiment_confidence), cls: sentiment.cls});
    if (item.topic_name) chips.push({label: 'الموضوع', value: item.topic_name});
    if (item.relevance) chips.push({label: 'الصلة', value: item.relevance === 'relevant' ? 'مرتبط' : 'غير مرتبط', conf: pctOf(item.relevance_confidence),
      cls: item.relevance === 'relevant' ? 'is-relevant' : 'is-irrelevant'});
  } else chips.push({label: 'المصدر', value: story ? 'تجميع آلي لقصة' : 'مطابقة قاموس البرنامج'});
  return <span className="ic-ai" title={item.ai_model ? `تصنيف الذكاء الاصطناعي — ${item.ai_model}` : 'تصنيف الذكاء الاصطناعي'}>
    <Sparkles size={14} className="ic-ai-icon" aria-label="تصنيف الذكاء الاصطناعي"/>
    {chips.map((c) => <span key={c.label} className={`ic-ai-chip ${c.cls ?? ''}`}><span className="ic-ai-label">{c.label}</span>
      <b>{c.value}</b>{c.conf && <span className="ic-ai-conf">{c.conf}</span>}</span>)}
  </span>;
}

/** «إغلاق التفاعل»: review outcome from a list, an optional comment (required when not relevant), Cancel / Save. */
function CloseDialog({ticket, busy, error, onCancel, onSave, onOpenDetails}: {
  ticket?: string; busy: boolean; error: string | null; onCancel: () => void; onSave: (outcome: QueueReviewOutcome, comment: string) => void; onOpenDetails: () => void;
}) {
  const [outcome, setOutcome] = useState<QueueReviewOutcome | ''>('');
  const [comment, setComment] = useState('');
  const needsComment = outcome === 'irrelevant';
  const corrected = outcome === 'corrected';
  const ready = !!outcome && !corrected && (!needsComment || !!comment.trim());
  return <ModalSurface as="form" label="إغلاق التفاعل" onClose={onCancel} busy={busy} panelClassName="card ic-dialog"
    onSubmit={(e) => { e.preventDefault(); if (ready) onSave(outcome as QueueReviewOutcome, comment.trim()); }}>
    <header className="ic-dialog-head"><h2>إغلاق التفاعل{ticket && <span className="ic-dialog-ticket">التذكرة <bdi>#{ticket}</bdi></span>}</h2>
      <ModalCloseButton type="button" className="ic-dialog-x" aria-label="إغلاق النافذة" onClick={onCancel}><Close size={18}/></ModalCloseButton></header>
    <label className="ic-dialog-field"><span>نتيجة المراجعة</span>
      <select className="input" required autoFocus value={outcome} onChange={(e) => setOutcome(e.target.value as QueueReviewOutcome)}>
        <option value="" disabled>اختر نتيجة المراجعة</option>
        {(['confirmed', 'no_action', 'irrelevant', 'corrected'] as QueueReviewOutcome[]).map((o) => <option key={o} value={o}>{QUEUE_REVIEW_OUTCOME_LABELS[o]}</option>)}
      </select></label>
    {corrected && <p className="ic-dialog-note">تصحيح التصنيفات يحتاج اختيار القيم الصحيحة. <button type="button" className="ic-dialog-link" onClick={onOpenDetails}>افتح التفاصيل لتصحيحها</button></p>}
    <label className="ic-dialog-field"><span>تعليق {needsComment ? '(إلزامي)' : '(اختياري)'}</span>
      <textarea className="input" rows={4} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)}
        placeholder={needsComment ? 'لماذا التفاعل غير ذي صلة؟' : 'ملاحظة تُحفظ مع المراجعة'}/></label>
    {error && <p role="alert" className="ic-error">{error}</p>}
    <footer className="ic-dialog-actions">
      <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>إلغاء</Button>
      <Button variant="primary" type="submit" disabled={!ready || busy}>{busy ? 'جارٍ الحفظ…' : 'حفظ'}</Button>
    </footer>
  </ModalSurface>;
}
