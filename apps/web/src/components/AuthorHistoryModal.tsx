import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime, fmtNum, fmtRelative } from '../lib/format';
import Avatar from './Avatar';
import { ExternalLink, Heart, MessageCircle, Repeat2 } from 'lucide-react';

interface HistoryItem {
  id: string;
  x_post_id: string;
  text: string;
  posted_at: string;
  url: string | null;
  is_reply: boolean;
  is_quote: boolean;
  is_repost: boolean;
  relevance: string | null;
  intent: string | null;
  sentiment: string | null;
  program_name: string | null;
  program_color: string | null;
  matched_keywords: string[] | null;
  like_count: number | null;
  repost_count: number | null;
  reply_count: number | null;
}

interface AuthorHistory {
  author: {
    x_author_id: string;
    username: string | null;
    display_name: string | null;
    description: string | null;
    profile_image_url: string | null;
    location: string | null;
    followers_count: number | null;
    following_count: number | null;
    tweet_count: number | null;
    is_verified: boolean | null;
    first_seen_at: string | null;
    last_seen_at: string | null;
  };
  stats: {
    interaction_count: number;
    complaint_count: number;
    inquiry_count: number;
    negative_count: number;
    engagement_total: number;
    first_interaction_at: string | null;
    last_interaction_at: string | null;
  };
  items: HistoryItem[];
}

const INTENT: Record<string, string> = {
  complaint: 'شكوى', inquiry: 'استفسار', suggestion: 'اقتراح', praise: 'إشادة',
  news: 'خبر', experience: 'تجربة', warning: 'تحذير', issue: 'مشكلة', request: 'طلب', other: 'أخرى',
};

const SENTIMENT: Record<string, string> = {
  very_positive: 'إيجابي جداً', positive: 'إيجابي', neutral: 'محايد',
  negative: 'سلبي', very_negative: 'سلبي جداً',
};

export default function AuthorHistoryModal({
  xAuthorId,
  onClose,
}: {
  xAuthorId: string;
  onClose: () => void;
}) {
  const [days, setDays] = useState('30');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());
  const { data, isLoading, isError } = useQuery({
    queryKey: ['author-history', xAuthorId, days],
    queryFn: () => api.get<AuthorHistory>(`/posts/authors/${encodeURIComponent(xAuthorId)}/history?days=${days}`),
  });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const author = data?.author;
  const stats = data?.stats;
  const toggleExpanded = (id: string) => {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="history-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="سجل تفاعلات العميل"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="history-header">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar
              src={author?.profile_image_url}
              name={author?.display_name}
              username={author?.username}
              size={44}
              ring={author?.is_verified ?? false}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-bold">{author?.display_name ?? 'ملف العميل'}</h2>
                {author?.is_verified && <span className="verified-mark" aria-label="حساب موثّق">✓</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs muted">
                {author?.username && <span className="num">@{author.username}</span>}
                <span><span className="num">{fmtNum(author?.followers_count)}</span> متابع</span>
                <span><span className="num">{fmtNum(author?.following_count)}</span> يتابع</span>
              </div>
            </div>
          </div>
          <div className="history-header-actions">
            {author?.username && (
              <a
                className="history-x-button"
                href={`https://x.com/${author.username}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`فتح حساب @${author.username} في X في نافذة جديدة`}
                title={`فتح @${author.username} في X`}
              >
                <span className="history-x-mark" aria-hidden="true">X</span>
                <span className="history-x-label">فتح في X</span>
                <ExternalLink className="history-x-external" size={15} strokeWidth={2} aria-hidden="true" />
              </a>
            )}
            <button className="history-close" onClick={onClose} aria-label="إغلاق">×</button>
          </div>
        </header>

        {author?.description && <p className="history-profile-bio muted">{author.description}</p>}

        <div className="history-toolbar">
          <div>
            <h3 className="font-bold">سجل التفاعلات</h3>
            <p className="text-xs muted">كل ما جمعته المنصة لهذا العميل</p>
          </div>
          <select className="input w-auto" value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="30">آخر 30 يوماً</option>
            <option value="90">آخر 90 يوماً</option>
            <option value="365">آخر سنة</option>
            <option value="all">كل المدة</option>
          </select>
        </div>

        {stats && (
          <div className="history-stats">
            <div><strong className="num">{fmtNum(stats.interaction_count)}</strong><span>تفاعل</span></div>
            <div><strong className="num">{fmtNum(stats.complaint_count)}</strong><span>شكوى</span></div>
            <div><strong className="num">{fmtNum(stats.inquiry_count)}</strong><span>استفسار</span></div>
            <div><strong className="num">{fmtNum(stats.negative_count)}</strong><span>سلبي</span></div>
          </div>
        )}

        <div className="history-list">
          {isLoading && <div className="history-empty">جارٍ تحميل سجل العميل…</div>}
          {isError && <div className="history-empty text-red-500">تعذر تحميل سجل العميل.</div>}
          {!isLoading && !isError && !data?.items.length && (
            <div className="history-empty">لا توجد تفاعلات في هذه المدة.</div>
          )}
          {data?.items.map((item) => {
            const expanded = expandedItems.has(item.id);
            const canExpand = item.text.length > 140 || item.text.split('\n').length > 2;
            const engagement = (item.like_count ?? 0) + (item.repost_count ?? 0) + (item.reply_count ?? 0);
            return (
            <article className="history-item" key={item.id}>
              <div className="history-item-head">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar
                    src={author?.profile_image_url}
                    name={author?.display_name}
                    username={author?.username}
                    size={40}
                    ring={author?.is_verified ?? false}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold">{author?.display_name ?? 'حساب غير معروف'}</div>
                    {author?.username && <div className="num truncate text-xs muted">@{author.username}</div>}
                  </div>
                </div>
                <time className="shrink-0 text-xs muted" title={fmtDateTime(item.posted_at)}>{fmtRelative(item.posted_at)}</time>
              </div>
              <div className="history-item-meta">
                  {item.program_name && (
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <span className="h-2 w-2 rounded-full" style={{ background: item.program_color ?? '#888' }} />
                      {item.program_name}
                    </span>
                  )}
                  {item.intent && <span className="badge bg-[var(--surface-3)]">{INTENT[item.intent] ?? item.intent}</span>}
                  {item.sentiment && <span className={`badge ${item.sentiment.includes('negative') ? 'text-red-500 bg-red-500/10' : 'bg-[var(--surface-3)]'}`}>{SENTIMENT[item.sentiment] ?? item.sentiment}</span>}
              </div>
              <div className={`history-item-text ${expanded || !canExpand ? 'is-expanded' : ''}`}>
                {item.text}
              </div>
              {canExpand && (
                <button
                  type="button"
                  className="history-read-more"
                  onClick={() => toggleExpanded(item.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? 'SHOW LESS' : 'READ MORE'}
                </button>
              )}
              <div className="history-item-footer">
                {engagement > 0 && (
                  <div className="interaction-metrics">
                    <span className="post-metric" title="الردود"><MessageCircle className="post-metric-icon" size={17} strokeWidth={1.8} aria-hidden="true" /><span className="num">{fmtNum(item.reply_count)}</span></span>
                    <span className="post-metric" title="إعادات النشر"><Repeat2 className="post-metric-icon" size={18} strokeWidth={1.8} aria-hidden="true" /><span className="num">{fmtNum(item.repost_count)}</span></span>
                    <span className="post-metric" title="الإعجابات"><Heart className="post-metric-icon" size={17} strokeWidth={1.8} aria-hidden="true" /><span className="num">{fmtNum(item.like_count)}</span></span>
                  </div>
                )}
                {item.matched_keywords?.length ? (
                  <span className="truncate">طابق: {item.matched_keywords.join('، ')}</span>
                ) : null}
                {item.url && (
                  <a className="history-x-link" href={item.url} target="_blank" rel="noreferrer" aria-label="فتح التفاعل في X في نافذة جديدة">
                    <span aria-hidden="true">X</span>
                    فتح في X
                    <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
                  </a>
                )}
              </div>
            </article>
          );})}
        </div>

        {stats?.first_interaction_at && (
          <footer className="history-footer">
            أول تفاعل محفوظ: <span className="num">{fmtDateTime(stats.first_interaction_at)}</span>
          </footer>
        )}
      </section>
    </div>
  );
}
