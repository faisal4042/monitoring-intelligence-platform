/**
 * Queue cards for every monitored source (migration 0051): X posts and stories keep their own rendering;
 * news articles and YouTube videos/comments are drawn from the card's stored source snapshot.
 * Every card carries the numbers of the tickets it works.
 */
import {Link} from 'react-router-dom';
import {MessageSquare, Newspaper, Sparkles, Ticket, Youtube} from 'lucide-react';
import type {QueueItem} from '../../lib/queue';

export const SOURCE_CARD_KINDS = ['news', 'youtube_video', 'youtube_comment'] as const;
export type SourceCardKind = (typeof SOURCE_CARD_KINDS)[number];
export const isSourceCard = (item: Pick<QueueItem, 'interaction_type'>): item is QueueItem & {interaction_type: SourceCardKind} =>
  (SOURCE_CARD_KINDS as readonly string[]).includes(item.interaction_type);

export const SOURCE_KIND_LABELS: Record<SourceCardKind, string> = {news: 'خبر', youtube_video: 'فيديو يوتيوب', youtube_comment: 'تعليق يوتيوب'};
export const SOURCE_OPEN_LABELS: Record<SourceCardKind, string> = {news: 'فتح الخبر', youtube_video: 'مشاهدة على يوتيوب', youtube_comment: 'فتح التعليق على يوتيوب'};

export function SourceIcon({kind, size = 18}: {kind: SourceCardKind; size?: number}) {
  const Icon = kind === 'news' ? Newspaper : kind === 'youtube_video' ? Youtube : MessageSquare;
  return <span className={`queue-source-icon queue-source-icon--${kind}`} aria-hidden="true"><Icon size={size}/></span>;
}

/** Every card's source, as the agent sees it: X post, X story, news, YouTube video, YouTube comment. */
export type SourceKey = 'x' | 'story' | 'news' | 'youtube_video' | 'youtube_comment';
export const sourceKeyOf = (item: Pick<QueueItem, 'interaction_type'>): SourceKey => (item.interaction_type === 'post' ? 'x' : item.interaction_type);
const XLogo = ({size = 12}: {size?: number}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>;
export const SOURCE_BADGE_LABELS: Record<SourceKey, string> = {x: 'منشور', story: 'قصة إكس', news: 'خبر', youtube_video: 'يوتيوب · فيديو', youtube_comment: 'يوتيوب · تعليق'};
/** The coloured source badge shown first on every card. */
export function SourceBadge({item, iconOnly = false}: {item: Pick<QueueItem, 'interaction_type'>; iconOnly?: boolean}) {
  const key = sourceKeyOf(item);
  const icon = key === 'x' ? <XLogo/> : key === 'story' ? <Sparkles size={12}/> : key === 'news' ? <Newspaper size={12}/> : key === 'youtube_video' ? <Youtube size={13}/> : <MessageSquare size={12}/>;
  return iconOnly ? icon : <span className={`queue-source-badge queue-source-badge--${key}`}>{icon}{SOURCE_BADGE_LABELS[key]}</span>;
}
/** Source filter chips: the `kind` query value of each (YouTube = videos and comments). */
export const SOURCE_FILTERS: Array<{label: string; kinds: string}> = [
  {label: 'كل المصادر', kinds: ''}, {label: 'إكس', kinds: 'post'}, {label: 'الأخبار', kinds: 'news'},
  {label: 'يوتيوب', kinds: 'youtube_video,youtube_comment'}, {label: 'القصص', kinds: 'story'},
];
export function SourceFilter({value, onChange, withStories = true}: {value: string; onChange: (kinds: string) => void; withStories?: boolean}) {
  return <div className="queue-source-filter" role="group" aria-label="مصدر التفاعل">
    {SOURCE_FILTERS.filter((f) => withStories || f.kinds !== 'story').map((f) => <button key={f.label} type="button" className="dash-chip" aria-pressed={value === f.kinds}
      onClick={() => onChange(f.kinds)}>{f.kinds && <span className={`queue-source-dot queue-source-dot--${f.kinds.split(',')[0] === 'post' ? 'x' : f.kinds.split(',')[0]}`} aria-hidden="true"/>}{f.label}</button>)}
  </div>;
}

/** Card title: the article/video title, or the commenter's name for a comment. */
export const sourceTitle = (item: QueueItem) => {
  const s = item.source_snapshot ?? {};
  return item.interaction_type === 'youtube_comment' ? (s.author ?? 'تعليق') : (plainText(s.title) || 'مصدر غير متاح');
};
const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' '};
/** Feed descriptions may carry HTML (Google News wraps the headline in a link): show plain text only, never markup. */
export const plainText = (value: unknown) => String(value ?? '')
  // whole tags, a tag cut at the start ("a href=…>") or at the end ("<a href=…"), then long link/encoded fragments
  .replace(/<[^>]*>/g, ' ').replace(/^(?:[a-z][a-z0-9]*(?:\s+[a-z-]+=[^<>]*)?)?>/i, ' ').replace(/<[^>]*$/, ' ').replace(/\S{60,}/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
/** Card text: the comment itself, else the article/video description — dropped when it only repeats the title. */
export const sourceText = (item: QueueItem) => {
  const s = item.source_snapshot ?? {};
  if (item.interaction_type === 'youtube_comment') return plainText(s.text);
  const text = plainText(s.description), title = plainText(s.title);
  return !text || (title && (text.startsWith(title) || title.includes(text))) ? '' : text;
};
/** Where the item came from: newspaper, YouTube channel, or the video a comment is on. */
export const sourceOrigin = (item: QueueItem) => {
  const s = item.source_snapshot ?? {};
  return item.interaction_type === 'news' ? s.sourceName : item.interaction_type === 'youtube_video' ? s.channelTitle : s.title ? `على: ${s.title}` : null;
};
/** Only https links to the item's own source are opened. */
export const sourceUrl = (item: QueueItem) => {
  const u = item.source_snapshot?.url;
  return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
};

/** Ticket numbers of a card. Inside a clickable card they are plain labels; elsewhere links to the ticket. */
export function TicketNumbers({tickets, linked = false}: {tickets?: QueueItem['tickets']; linked?: boolean}) {
  if (!tickets?.length) return null;
  return <span className="queue-ticket-numbers" aria-label="أرقام التذاكر">
    <Ticket size={12} aria-hidden="true"/>
    {tickets.map((t) => linked
      ? <Link key={t.id} className="queue-ticket-number" to={`/tickets?ticket=${t.id}`} title="فتح التذكرة"><bdi>#{t.number}</bdi></Link>
      : <span key={t.id} className="queue-ticket-number"><bdi>#{t.number}</bdi></span>)}
  </span>;
}
