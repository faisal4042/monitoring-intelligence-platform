import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';
import { api } from '../../lib/api';
import { INTENT_LABELS, SENTIMENT_GROUP_LABELS } from '../../lib/dashboard';
import { fmtDateTime, fmtNum } from '../../lib/format';
import Avatar from '../Avatar';
import type { Drill } from './monitoring';

interface Item { id: string; posted_at: string; text: string | null; url: string | null; intent: string | null; relevance?: string; sentiment_group?: string | null;
  human_reviewed?: boolean; username: string | null; display_name: string | null; profile_image_url: string | null; program_name: string | null }
interface Page { total: number; items: Item[]; nextCursor: string | null; story?: { title: string; postCount: number } }

/**
 * The posts behind a clicked figure: the dashboard's own filters plus the
 * clicked dimension, from the same server definitions — so the count shown
 * here is the number that was clicked.
 */
export default function DrillDrawer({ drill, baseQuery, onClose }: { drill: Drill; baseQuery: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const qs = new URLSearchParams(baseQuery);
  for (const [k, v] of Object.entries(drill.params)) qs.set(k, v);
  const list = useInfiniteQuery({
    queryKey: ['dashboard', 'drill', qs.toString()], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => api.get<Page>(`/dashboard/interactions?${qs.toString()}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return <div className="queue-drawer" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label={drill.title} className="card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
      <header className="flex justify-between items-start gap-3">
        <div className="min-w-0"><h2 className="text-lg font-bold">{drill.title}</h2>
          {first && <p className="text-sm muted">{fmtNum(first.total)} منشور{first.story ? ` ظاهر من أصل ${fmtNum(first.story.postCount)} في القصة (المحجوب لا يُعرض)` : ' بنفس البرنامج والفترة والفلاتر'}</p>}</div>
        <button ref={closeRef} className="icon-button" aria-label="إغلاق" onClick={onClose}><X size={18} /></button>
      </header>
      {list.isLoading && <div className="dash-skeleton" style={{ height: 160 }} aria-busy="true" />}
      {list.error && <p role="alert" className="text-red-600">{(list.error as Error).message}</p>}
      {first && !items.length && <p className="dash-state">لا توجد منشورات.</p>}
      <ul className="space-y-2">{items.map((i) => <li key={i.id} className="rounded-lg border p-3 space-y-1.5" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 text-sm">
          <Avatar src={i.profile_image_url} name={i.display_name} username={i.username} size={28} />
          <span className="min-w-0 flex-1"><strong className="block truncate">{i.display_name ?? i.username ?? 'حساب غير متاح'}</strong>
            {i.username && <span className="text-xs muted" dir="ltr">@{i.username}</span>}</span>
          {i.url && <a className="icon-button" href={i.url} target="_blank" rel="noreferrer" aria-label="فتح في X"><ExternalLink size={14} /></a>}
        </div>
        <p className="text-sm leading-7 whitespace-pre-wrap" dir="auto">{i.text ?? 'النص غير متاح'}</p>
        <p className="text-xs muted flex flex-wrap gap-x-3">
          <span>{fmtDateTime(i.posted_at)}</span>{i.program_name && <span>{i.program_name}</span>}
          {i.intent && <span>{INTENT_LABELS[i.intent] ?? i.intent}</span>}
          {i.sentiment_group && <span>{SENTIMENT_GROUP_LABELS[i.sentiment_group]}</span>}
          {i.relevance && i.relevance !== 'relevant' && <span>غير ذي صلة</span>}
          {i.human_reviewed && <span>معتمد بمراجعة بشرية</span>}
        </p>
      </li>)}</ul>
      {list.hasNextPage && <button className="btn-ghost w-full" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>تحميل المزيد</button>}
    </section>
  </div>;
}
