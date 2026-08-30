import { useState, useLayoutEffect, useRef } from 'react';
import { fmtNum, fmtRelative } from '../lib/format';
import type { Post } from '../lib/types';
import Avatar from './Avatar';

const REL: Record<string, { text: string; cls: string }> = {
  relevant:      { text: 'مرتبط',     cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  irrelevant:    { text: 'غير مرتبط', cls: 'bg-slate-500/15 text-slate-500' },
  advertisement: { text: 'إعلان',     cls: 'bg-orange-500/15 text-orange-600' },
  spam:          { text: 'spam',      cls: 'bg-red-500/15 text-red-600' },
  unknown:       { text: 'غير محدد',  cls: 'bg-amber-500/15 text-amber-600' },
};

const SENT: Record<string, { text: string; cls: string }> = {
  very_positive: { text: 'إيجابي جداً', cls: 'text-emerald-600' },
  positive:      { text: 'إيجابي',      cls: 'text-emerald-500' },
  neutral:       { text: 'محايد',       cls: 'muted' },
  negative:      { text: 'سلبي',        cls: 'text-orange-600' },
  very_negative: { text: 'سلبي جداً',   cls: 'text-red-600' },
};

export default function PostCard({
  post: p, onWhy, onHistory, onLightbox,
}: {
  post: Post;
  onWhy: (id: string) => void;
  onHistory: (xAuthorId: string) => void;
  onLightbox: (url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const textRef = useRef<HTMLAnchorElement>(null);

  // The 2-line clamp is CSS (card width, font, wrapping all affect it), so a
  // character-count guess is wrong on wide cards — measure real overflow
  // instead of estimating it, or "READ MORE" shows up with nothing to reveal.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    setCanExpand(el.scrollHeight - el.clientHeight > 1);
  }, [p.text]);

  // A duplicate has no classification by design; showing it as "unknown"
  // would read as a classifier failure.
  const rel = p.status === 'duplicate'
    ? { text: `مكرر${p.duplicate_type === 'campaign' ? ' (حملة)' : ''}`,
        cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' }
    : REL[p.relevance ?? 'unknown'] ?? REL.unknown;
  const sent = SENT[p.sentiment ?? 'neutral'] ?? SENT.neutral;

  return (
    <article className={`card post-card ${p.status === 'filtered_out' ? 'opacity-65' : ''}`}>
      <div className="flex items-start gap-3 sm:gap-4">
        <button
          type="button"
          onClick={() => onHistory(p.x_author_id)}
          className="rounded-full focus-visible:outline-2 focus-visible:outline-brand-500"
          aria-label={p.username ? `فتح سجل تفاعلات ${p.username}` : 'فتح سجل تفاعلات الحساب'}
        >
          <Avatar src={p.profile_image_url} name={p.display_name} username={p.username} size={48} ring={p.is_verified ?? false} />
        </button>

        <div className="min-w-0 flex-1">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onHistory(p.x_author_id)}
                  className="truncate text-sm font-bold hover:text-brand-600 hover:underline"
                >
                  {p.display_name ?? 'حساب غير معروف'}
                </button>
                {p.is_verified && (
                  <span className="verified-mark" title="حساب موثّق" aria-label="حساب موثّق">✓</span>
                )}
                {p.is_influencer && (
                  <span className="badge bg-amber-500/15 text-amber-600 dark:text-amber-400 !px-1.5 !py-0 text-[10px]" title="عميل مؤثر متابَع">
                    ★ مؤثر
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs muted">
                {p.username && <span className="num">@{p.username}</span>}
                <span aria-hidden="true">·</span>
                <span><span className="num">{fmtNum(p.followers_count)}</span> متابع</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {p.topic_name && (
                <span className="badge bg-brand-500/15 text-brand-600 dark:text-brand-400" title="الموضوع المصنَّف — من تصنيف التفاعلات">
                  {p.topic_name}
                </span>
              )}
              <span className={`badge ${rel.cls}`}>{rel.text}</span>
              {p.stage && <span className="badge bg-[var(--surface-3)] num text-[10px]">S{p.stage}</span>}
            </div>
          </header>

          {p.author_bio && (
            <p className="author-bio mt-2 text-xs leading-5 muted" title={p.author_bio}>
              {p.author_bio}
            </p>
          )}

          <a
            ref={textRef}
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className={`post-text mt-3 block text-[15px] leading-7 hover:text-brand-600 ${expanded ? 'is-expanded' : ''}`}
          >
            {p.text}
          </a>

          {canExpand && (
            <button
              type="button"
              className="post-read-more"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? 'SHOW LESS' : 'READ MORE'}
            </button>
          )}

          {p.media?.[0]?.url && (
            <button
              type="button"
              onClick={() => onLightbox(p.media[0].url!)}
              className="mt-3 block w-fit max-w-full overflow-hidden rounded-xl"
              aria-label="تكبير الصورة"
            >
              <img src={p.media[0].url} alt="" loading="lazy" className="block max-h-64 max-w-full w-auto object-contain" />
            </button>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--border)] pt-3 text-xs muted">
            <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-brand-600 hover:underline">
              {fmtRelative(p.posted_at)}
            </a>
            <span className={sent.cls}>{sent.text}</span>
            {p.program_name && (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: p.program_color ?? '#888' }} />
                {p.program_name}
              </span>
            )}

            <div className="flex items-center gap-3 sm:ms-auto">
              <span className="post-metric" title="الإعجابات">
                <span aria-hidden="true">♡</span>
                <span className="num">{fmtNum(p.like_count)}</span>
              </span>
              <span className="post-metric" title="إعادات النشر">
                <span aria-hidden="true">↻</span>
                <span className="num">{fmtNum(p.repost_count)}</span>
              </span>
              <span className="post-metric" title="الردود">
                <span aria-hidden="true">◯</span>
                <span className="num">{fmtNum(p.reply_count)}</span>
              </span>
            </div>

            <button className="why-link" onClick={() => onWhy(p.id)}>لماذا جمعنا هذا؟</button>
            <button className="why-link" onClick={() => onHistory(p.x_author_id)}>سجل العميل</button>
          </div>

          {p.filter_reason && (
            <div className="mt-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs muted">
              استُبعد: <span className="num">{p.filter_reason}</span> — {p.reason_ar}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
