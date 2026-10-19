import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, History, Sparkles, Ticket, UserRound, ListChecks, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@mip/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { TICKET_STATUS_LABELS, type TicketStatus } from '../../lib/tickets';
import { fmtDateTime, fmtNum } from '../../lib/format';
import DialogSurface from '../queue-board/DialogSurface';
import Avatar from '../Avatar';
import { AnalysisDetails, EngagementMetrics, InteractionActionBar, InteractionMedia, InteractionText } from './InteractionCard';
import { queueLabel, type DetailSection, type Interaction, type InteractionActions, type InteractionDetail } from './interaction';
import { ProcessingHistory } from './ProcessingHistory';
import { Button } from '../ui/Button';
import '../queue-board/queue-board.css';


function AccountInfo({ post }: { post: Interaction }) {
  return <><div className="ic-account-profile"><Avatar src={post.profile_image_url} name={post.display_name} username={post.username} size={44} ring={!!post.is_verified}/><div><strong>{post.display_name ?? post.username ?? 'حساب غير معروف'}</strong><bdi>@{post.username ?? '—'}</bdi></div></div>
    {post.author_bio && <p className="ic-account-bio" dir="auto">{post.author_bio}</p>}
    <dl className="ic-facts"><div><dt>المتابعون</dt><dd>{fmtNum(post.followers_count)}</dd></div><div><dt>يتابع</dt><dd>{fmtNum(post.following_count)}</dd></div><div><dt>حساب موثق</dt><dd>{post.is_verified == null ? 'غير متوفر' : post.is_verified ? 'نعم' : 'لا'}</dd></div><div><dt>حساب مؤثر متابَع</dt><dd>{post.is_influencer ? 'نعم' : 'لا'}</dd></div><div><dt>معرف الحساب في إكس</dt><dd><bdi>{post.x_author_id}</bdi></dd></div></dl>
  </>;
}

const sections = [
  { id: 'interaction', title: 'التفاعل', icon: FileText },
  { id: 'analysis', title: 'تحليل AI', icon: Sparkles },
  { id: 'account', title: 'الحساب', icon: UserRound },
  { id: 'history', title: 'التفاعلات السابقة', icon: History },
  { id: 'ticket', title: 'التذكرة والإسناد', icon: Ticket },
  { id: 'events', title: 'سجل الإجراءات', icon: ListChecks },
] as const;

/** Conversation ticket (engine 0047) linked to this post; silent when the user lacks ticket access or the server predates it. */
function ConversationTicket({ postId }: { postId: string }) {
  const { can } = useAuth();
  const allowed = can(PERMISSIONS.TICKETS_READ) || can(PERMISSIONS.TICKETS_READ_ALL);
  const q = useQuery({ queryKey: ['ticket-by-post', postId], enabled: allowed, retry: false, staleTime: 30000,
    queryFn: ({ signal }) => api.get<{ activated: boolean; ticket: { id: string; ticket_number: string; status: TicketStatus; assignee_name: string | null } | null }>(`/tickets/by-post/${postId}`, signal) });
  if (!allowed || !q.data?.activated) return null;
  const t = q.data.ticket;
  return t
    ? <p>تذكرة المحادثة: <Link className="ic-link" to={`/tickets?ticket=${t.id}`}><bdi className="num">{t.ticket_number}</bdi></Link> · {TICKET_STATUS_LABELS[t.status]}{t.assignee_name && ` · ${t.assignee_name}`}</p>
    : <p className="ic-scope-note">لا توجد تذكرة محادثة مرتبطة بهذا التفاعل.</p>;
}

export default function InteractionDetails({ id, initialSection, actions, onClose, onLightbox }: {
  id: string; initialSection: DetailSection; actions: InteractionActions; onClose: () => void; onLightbox: (url: string) => void;
}) {
  const detail = useQuery({ queryKey: ['live-detail', id], queryFn: ({ signal }) => api.get<InteractionDetail>(`/posts/${id}/detail`, signal), staleTime: 30000 });
  const ref = useRef<HTMLDivElement>(null);
  const jump = (section: string) => {
    const heading = ref.current?.querySelector<HTMLElement>(`[data-section="${section}"] h3`);
    heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
  };
  useEffect(() => { if (detail.data && initialSection !== 'interaction') jump(initialSection); }, [detail.data?.post.id, initialSection]);
  const post = detail.data?.post;
  return <div className="ic-drawer-host"><DialogSurface className="ic-drawer-host" title="تفاصيل التفاعل" drawer onClose={onClose}>
    {detail.isPending && <div className="ic-loading" role="status"><RefreshCw size={20} className="ic-spin"/>جارٍ تحميل تفاصيل التفاعل…</div>}
    {detail.error && <div role="alert" className="ic-error"><strong>تعذر تحميل التفاصيل</strong><p>{detail.error.message}</p><Button variant="ghost" type="submit" onClick={() => detail.refetch()}>إعادة المحاولة</Button></div>}
    {detail.data && post && <div className="ic-detail" ref={ref}>
      <nav className="ic-detail-nav" aria-label="أقسام تفاصيل التفاعل">{sections.map(section => <button key={section.id} onClick={() => jump(section.id)}><section.icon size={14} aria-hidden="true"/>{section.title}</button>)}</nav>
      <section data-section="interaction"><h3 tabIndex={-1}><FileText size={17}/>التفاعل كاملًا</h3><InteractionText text={post.text} full/><InteractionMedia post={post} onLightbox={onLightbox} full/><EngagementMetrics post={post}/><dl className="ic-facts"><div><dt>نُشر</dt><dd>{fmtDateTime(post.posted_at)}</dd></div><div><dt>جُمع</dt><dd>{fmtDateTime(post.collected_at)}</dd></div><div><dt>حالة المحتوى</dt><dd>{post.status === 'duplicate' ? `مكرر${post.duplicate_type ? ` · ${post.duplicate_type}` : ''}` : post.status === 'filtered_out' ? 'مستبعد' : post.status}</dd></div><div><dt>معرف المنشور</dt><dd><bdi>{post.x_post_id}</bdi></dd></div></dl></section>
      <section data-section="analysis"><h3 tabIndex={-1}><Sparkles size={17}/>تحليل وتصنيف الذكاء الاصطناعي</h3><AnalysisDetails post={post} onClassify={post.relevance && actions.onClassify ? () => actions.onClassify!(post) : undefined}/></section>
      <section data-section="account"><h3 tabIndex={-1}><UserRound size={17}/>معلومات الحساب</h3><AccountInfo post={post}/></section>
      <section data-section="history"><h3 tabIndex={-1}><History size={17}/>سجل التفاعلات السابقة</h3>{actions.onHistory ? <><p className="muted">استعرض تفاعلات هذا الحساب والإحصاءات بالفترة التي تختارها.</p><button className="ic-action" onClick={() => actions.onHistory!(post)}><History size={15}/>عرض سجل الحساب</button></> : <p className="muted">يتطلب صلاحية قراءة سجل الحساب.</p>}</section>
      <section data-section="ticket"><h3 tabIndex={-1}><Ticket size={17}/>التذكرة والإسناد</h3><p>{queueLabel(post)}{post.assignee_name && ` · ${post.assignee_name}`}</p>{post.queue_id && actions.onTicket ? <button className="ic-action" onClick={() => actions.onTicket!(post)}><Ticket size={15}/>فتح التذكرة والإسناد</button> : !post.queue_id && !['duplicate', 'filtered_out'].includes(post.status) && actions.onAddToQueue ? <button className="ic-action" onClick={() => actions.onAddToQueue!(post)}>إضافة للطابور</button> : <p className="ic-scope-note">لا إجراء إسناد متاح لهذا التفاعل ضمن صلاحياتك.</p>}<ConversationTicket postId={post.id}/></section>
      <section data-section="events"><h3 tabIndex={-1}><ListChecks size={17}/>سجل الإجراءات والتعديلات</h3><ProcessingHistory detail={detail.data}/></section>
      <section><h3>سبب الجمع وقاعدة المطابقة</h3><p>{detail.data.why.query_name ?? 'لم يسجل اسم استعلام'}{detail.data.why.version != null && ` · الإصدار ${detail.data.why.version}`}</p><div className="ic-keywords">{(detail.data.why.matched_keywords ?? post.matched_keywords ?? []).map((keyword, i) => <span className="ic-chip" key={i}>{keyword}</span>)}</div>{detail.data.why.compiled && <code dir="ltr">{detail.data.why.compiled}</code>}{(detail.data.why.filter_reason ?? post.filter_reason) && <p>سبب الاستبعاد: {detail.data.why.filter_reason ?? post.filter_reason}</p>}</section>
      <div className="ic-detail-actions"><InteractionActionBar post={post} actions={actions}/></div>
    </div>}
  </DialogSurface></div>;
}
