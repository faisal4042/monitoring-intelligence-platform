import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, Eye, ExternalLink, FileText, Heart, History, Info, ListPlus, MessageCircle, MoreHorizontal, Pencil, Play, Repeat2, Sparkles, Ticket, Download, BadgeCheck } from 'lucide-react';
import Avatar from '../Avatar';
import { api } from '../../lib/api';
import { fmtCompact, fmtDateTime, fmtNum } from '../../lib/format';
import { availableMetrics, classificationSource, interactionLabel, operationalState, relevanceConfidence, safeExternalUrl, tokenizeInteraction, type CardDensity, type Interaction, type InteractionActions, type InteractionDetail } from './interaction';
import { ProcessingHistory } from './ProcessingHistory';
import './interaction-card.css';
import VideoEmbedModal, {xPostIdOf} from './VideoEmbed';
import {InteractionMedia} from '../media/InteractionMedia';

export function InteractionText({ text, full = false, onMore, bio = false, children }: { text: string; full?: boolean; onMore?: () => void; bio?: boolean; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (full || expanded || !ref.current) return;
    const element = ref.current;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [text, full, expanded]);
  return <div className={`ic-text-wrap ${bio ? 'ic-bio' : ''}`}>
    <p id={id} ref={ref} dir="auto" className={`ic-text ${full || expanded ? 'ic-text-full' : 'ic-text-clamped'}`}>
      {children ?? tokenizeInteraction(text).map((token, i) => token.kind === 'link'
        ? <a key={i} href={token.href} target="_blank" rel="noreferrer"><bdi>{token.text}</bdi></a>
        : token.kind === 'text' ? token.text : <bdi key={i} className="ic-text-token">{token.text}</bdi>)}
    </p>
    {!full && (overflow || expanded) && <button className="ic-text-expand" aria-controls={onMore ? undefined : id} aria-expanded={onMore ? undefined : expanded} onClick={() => onMore ? onMore() : setExpanded(!expanded)}>{expanded ? 'عرض أقل' : 'عرض المزيد'}<ChevronDown size={14} aria-hidden="true"/></button>}
  </div>;
}

export {InteractionMedia, type MediaSource} from '../media/InteractionMedia';

const metricIcons = { likes: Heart, reposts: Repeat2, replies: MessageCircle, views: Eye };
export function EngagementMetrics({ post }: { post: Interaction }) {
  const metrics = availableMetrics(post);
  if (!metrics.length) return null;
  return <div className="ic-metrics" aria-label="مؤشرات التفاعل">{metrics.map(metric => {
    const Icon = metricIcons[metric.key];
    return <span key={metric.key} title={`${metric.label}: ${fmtNum(metric.value)}`} aria-label={`${metric.label}: ${fmtNum(metric.value)}`}><Icon size={15} strokeWidth={1.8} aria-hidden="true"/><bdi>{fmtCompact(metric.value)}</bdi><span className="ic-metric-label">{metric.label}</span></span>;
  })}</div>;
}

function tone(value: string | null) {
  return ['positive', 'very_positive', 'relevant'].includes(value ?? '') ? 'success' : ['negative', 'very_negative', 'spam'].includes(value ?? '') ? 'danger' : 'neutral';
}
/** One analysis fact: a short visible key keeps chips unambiguous (sentiment vs. intent) without extra rows. */
function Fact({ k, title, className = '', children }: { k: string; title: string; className?: string; children: ReactNode }) {
  return <span className={`ic-chip ${className}`} title={title}><span className="ic-chip-k">{k}</span><span className="ic-chip-v">{children}</span></span>;
}
export function ClassificationSummary({ post, onDetails }: { post: Interaction; onDetails: () => void }) {
  const confidence = relevanceConfidence(post);
  return <div className="ic-classification" aria-label="ملخص التصنيف">
    <Sparkles size={14} className="ic-analysis-icon" aria-hidden="true"/>
    {post.program_name && <Fact k="البرنامج" title="البرنامج" className="ic-program">{post.program_name}</Fact>}
    {post.topic_name && <Fact k="الموضوع" title="الموضوع" className="ic-topic">{post.topic_name}</Fact>}
    {post.intent && <Fact k="النوع" title="نوع التفاعل">{interactionLabel(post.intent)}</Fact>}
    {post.sentiment && <Fact k="المشاعر" title="المشاعر" className={`ic-tone-${tone(post.sentiment)}`}>{interactionLabel(post.sentiment)}</Fact>}
    {post.relevance && <Fact k="الصلة" title="الصلة" className={`ic-tone-${tone(post.relevance)}`}><CheckCircle2 size={12} aria-hidden="true"/>{interactionLabel(post.relevance)}{confidence != null && <bdi className="ic-confidence" title="ثقة تصنيف الصلة">{confidence}%</bdi>}</Fact>}
    {post.stage == null && <span className="ic-chip">{post.status === 'duplicate' ? 'لا تصنيف للمكرر' : 'بانتظار التصنيف'}</span>}
    {post.human_corrected && <span className="ic-chip ic-human" title="تمت مراجعة التصنيف بشريًا">مراجعة بشرية</span>}
    <button type="button" className="ic-analysis-link" onClick={onDetails}><Info size={14} aria-hidden="true"/>تفاصيل التحليل</button>
  </div>;
}

export function AnalysisDetails({ post, onClassify }: { post: Interaction; onClassify?: () => void }) {
  const confidence = relevanceConfidence(post);
  return <div className="ic-analysis-details">
    <dl className="ic-facts">
      <div><dt>البرنامج</dt><dd>{post.program_name ?? 'غير محدد'}</dd></div>
      <div><dt>الموضوع المرتبط</dt><dd>{post.topic_name ?? 'لم يُحسم الموضوع بعد'}</dd></div>
      <div><dt>الصلة</dt><dd>{interactionLabel(post.relevance)}</dd></div>
      <div><dt>نوع التفاعل</dt><dd>{interactionLabel(post.intent)}</dd></div>
      <div><dt>المشاعر</dt><dd>{interactionLabel(post.sentiment)}</dd></div>
      <div><dt>ثقة الصلة</dt><dd>{confidence == null ? post.human_corrected ? 'لا توجد ثقة جديدة للمراجعة البشرية' : 'غير متوفرة' : `${confidence}%`}</dd></div>
      <div><dt>مصدر التصنيف</dt><dd>{classificationSource(post)}</dd></div>
      {post.model && <div><dt>نموذج التصنيف</dt><dd><bdi>{post.model}</bdi></dd></div>}
      {post.sentiment_stage != null && <div><dt>مصدر المشاعر</dt><dd>{post.sentiment_stage === 3 ? 'نموذج لغوي' : post.sentiment_stage === 2 ? 'تصنيف آلي' : 'قواعد أولية'} · المرحلة {post.sentiment_stage}</dd></div>}
      {post.sentiment_model && <div><dt>نموذج المشاعر</dt><dd><bdi>{post.sentiment_model}</bdi></dd></div>}
    </dl>
    <div className="ic-reason"><strong>سبب التصنيف</strong><p>{post.reason_ar ?? 'لم يسجل سبب للتصنيف'}</p></div>
    {onClassify && <button className="ic-action" onClick={onClassify}><Pencil size={15} aria-hidden="true"/>تعديل التصنيف</button>}
  </div>;
}

type MenuAction = { label: string; icon: ReactNode; onClick: () => void };
function MoreMenu({ actions }: { actions: MenuAction[] }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = false) => { setPosition(null); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    const triggerRect = trigger.current!.getBoundingClientRect();
    const top = rect.bottom > window.innerHeight - 8 ? Math.max(8, triggerRect.top - rect.height - 6) : position.top;
    const left = Math.max(8, Math.min(position.left, window.innerWidth - rect.width - 8));
    if (top !== position.top || left !== position.left) setPosition({ top, left });
    menu.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const pointer = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const dismiss = () => close(true);
    document.addEventListener('pointerdown', pointer);
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', pointer); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [position]);
  if (!actions.length) return null;
  return <>
    <button ref={trigger} type="button" className="ic-action ic-action-more" aria-haspopup="menu" aria-expanded={!!position} aria-controls={position ? id : undefined} onClick={() => {
      if (position) { close(true); return; }
      const rect = trigger.current!.getBoundingClientRect(); setPosition({ top: rect.bottom + 6, left: rect.right - 210 });
    }} aria-label={`المزيد من الإجراءات (${actions.length})`} title="المزيد من الإجراءات"><MoreHorizontal size={16} aria-hidden="true"/><span className="ic-action-label">المزيد</span><span className="ic-more-count" aria-hidden="true">{actions.length}</span></button>
    {position && createPortal(<div ref={menu} id={id} role="menu" aria-label="إجراءات إضافية" dir="rtl" className="ic-more-menu" style={position} onKeyDown={event => {
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') { event.preventDefault(); close(true); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>{actions.map(action => <button key={action.label} type="button" role="menuitem" onClick={() => { close(true); action.onClick(); }}>{action.icon}{action.label}</button>)}</div>, document.body)}
  </>;
}

/**
 * Primary: the actions used on almost every card (details, the ticket when one exists, the original post).
 * Everything else lives in «المزيد», with the same permission gates (an action absent from `actions` is never offered).
 */
export function InteractionActionBar({ post, actions }: { post: Interaction; actions: InteractionActions }) {
  const url = safeExternalUrl(post.url);
  const secondary: MenuAction[] = [];
  if (actions.onHistory) secondary.push({ label: 'سجل الحساب', icon: <History size={16} aria-hidden="true"/>, onClick: () => actions.onHistory!(post) });
  if (post.relevance && actions.onClassify) secondary.push({ label: 'تعديل التصنيف', icon: <Pencil size={16} aria-hidden="true"/>, onClick: () => actions.onClassify!(post) });
  if (!post.queue_id && !['duplicate', 'filtered_out'].includes(post.status) && actions.onAddToQueue) secondary.push({ label: 'إضافة للطابور', icon: <ListPlus size={16} aria-hidden="true"/>, onClick: () => actions.onAddToQueue!(post) });
  if (actions.onExport) secondary.push({ label: 'تصدير التفاعل', icon: <Download size={16} aria-hidden="true"/>, onClick: () => actions.onExport!(post) });
  return <div className="ic-actions" aria-label="إجراءات التفاعل">
    <button type="button" className="ic-action ic-action-primary" onClick={() => actions.onDetails(post)}><FileText size={15} aria-hidden="true"/>التفاصيل</button>
    {post.queue_id && actions.onTicket && <button type="button" className="ic-action" aria-label="التذكرة والإسناد" title="التذكرة والإسناد" onClick={() => actions.onTicket!(post)}><Ticket size={15} aria-hidden="true"/><span className="ic-action-label">التذكرة والإسناد</span></button>}
    {url && <a className="ic-action" href={url} target="_blank" rel="noreferrer" aria-label="الأصل (يفتح في نافذة جديدة)" title="فتح المنشور الأصلي على X"><ExternalLink size={15} aria-hidden="true"/><span className="ic-action-label">الأصل</span></a>}
    <MoreMenu actions={secondary}/>
  </div>;
}

function ExpandedInteraction({ post }: { post: Interaction }) {
  const detail = useQuery({ queryKey: ['live-detail', post.id], queryFn: ({ signal }) => api.get<InteractionDetail>(`/posts/${post.id}/detail`, signal), staleTime: 30000 });
  return <div className="ic-expanded">
    <section aria-label="بيانات الحساب"><h3>بيانات الحساب</h3><p>{post.author_bio ?? 'لا توجد نبذة متاحة'}</p><span className="muted">{post.followers_count != null && <>{fmtNum(post.followers_count)} متابع · </>}نُشر {fmtDateTime(post.posted_at)}{post.collected_at && <> · جُمع {fmtDateTime(post.collected_at)}</>}</span></section>
    <section aria-label="التحليل الكامل"><h3><Sparkles size={15}/>التحليل الكامل</h3><AnalysisDetails post={post}/></section>
    <section aria-label="سجل المعالجة"><h3>سجل المعالجة</h3>{detail.isPending ? <p role="status">جارٍ تحميل سجل المعالجة…</p> : detail.error ? <p role="alert">تعذر تحميل السجل <button className="ic-analysis-link" onClick={() => detail.refetch()}>إعادة المحاولة</button></p> : detail.data && <ProcessingHistory detail={detail.data} compact/>}</section>
    {post.filter_reason && <p className="ic-reason">سبب الاستبعاد: {post.filter_reason}</p>}
  </div>;
}

export default function InteractionCard({ post, density, selected = false, onSelect, actions, onLightbox, textContent, onAccount }: {
  post: Interaction; density: CardDensity; selected?: boolean; onSelect?: () => void; actions: InteractionActions; onLightbox: (url: string) => void; textContent?: ReactNode; onAccount?: (username: string) => void;
}) {
  const state = operationalState(post);
  return <article className={`ic-card ${selected ? 'ic-selected' : ''} ic-${density}`} aria-label={`تفاعل ${post.display_name ?? post.username ?? 'حساب غير معروف'}`}>
    <header className="ic-header">
      {onSelect && <input type="checkbox" aria-label={`تحديد ${post.username ?? post.id}`} checked={selected} onChange={onSelect}/>}
      <Avatar src={post.profile_image_url} name={post.display_name} username={post.username} size={36} ring={!!post.is_verified}/>
      <div className="ic-identity">
        <div className="ic-name-row"><button type="button" className="ic-author" onClick={() => actions.onDetails(post, 'account')}>{post.display_name ?? post.username ?? 'حساب غير معروف'}</button>{post.is_verified && <BadgeCheck size={15} className="ic-verified" aria-label="حساب موثق"/>}{post.is_influencer && <span className="ic-influencer">★ مؤثر</span>}</div>
        <div className="ic-account-stats">{onAccount && post.username ? <button className="ic-username" title="كل منشورات الحساب" onClick={() => onAccount(post.username!)}><bdi>@{post.username}</bdi></button> : <bdi className="ic-username">@{post.username ?? '—'}</bdi>}<span>المتابعون <bdi>{fmtNum(post.followers_count)}</bdi></span><span>يتابع <bdi>{fmtNum(post.following_count)}</bdi></span></div>
        {post.author_bio?.trim() && <InteractionText text={post.author_bio} full={density === 'expanded'} bio/>}
      </div>
      <div className="ic-header-meta"><span className="ic-when"><span className="ic-platform" role="img" aria-label="منصة X">𝕏</span><time dateTime={post.posted_at}><bdi>{fmtDateTime(post.posted_at)}</bdi></time></span><span className={`ic-state ic-tone-${state.tone}`}>{state.label}</span></div>
    </header>
    <div className="ic-content"><InteractionText text={post.text} full={density === 'expanded'}>{textContent}</InteractionText><InteractionMedia post={post} onLightbox={onLightbox} full={density === 'expanded'}/></div>
    <ClassificationSummary post={post} onDetails={() => actions.onDetails(post, 'analysis')}/>
    {density === 'expanded' && <ExpandedInteraction post={post}/>}
    <footer className="ic-footer"><InteractionActionBar post={post} actions={actions}/><EngagementMetrics post={post}/></footer>
  </article>;
}
