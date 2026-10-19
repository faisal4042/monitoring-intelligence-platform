import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { PERMISSIONS } from '@mip/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Interaction } from '../live/interaction';
import InteractionList from '../live/InteractionList';
import type { DateRangeState } from '../../lib/useDateRange';
import { fmtNum } from '../../lib/format';
import { RELEVANCE, SENTIMENT, useDebounced, type AccountPage } from '../../lib/influencers';
import Avatar from '../Avatar';
import { StateBox } from './shared';

import { Button } from '../ui/Button';
const PAGE_SIZE = 20;

/** The influencer feed: server-side filters and cursor pages from GET /posts — never the whole table. */
export default function PostsTab({ date }: { date: DateRangeState }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const account = params.get('account') ?? '';
  const program = params.get('program') ?? '';
  const sentiment = params.get('sentiment') ?? '';
  const relevance = params.get('relevance') ?? '';
  const includeFiltered = params.get('filtered') === '1';
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim(), 350);

  const set = (key: string, value: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });
  useEffect(() => { if ((params.get('q') ?? '') !== q) set('q', q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: programs } = useQuery({
    queryKey: ['programs'],
    queryFn: () => api.get<{ items: Array<{ id: string; name_ar: string; is_active: boolean }> }>('/programs'),
    enabled: can(PERMISSIONS.PROGRAMS_READ),
    staleTime: 5 * 60_000,
  });

  const filters = { account, program, sentiment, relevance, q, includeFiltered, range: date.apiQuery };
  const feed = useInfiniteQuery({
    queryKey: ['influencer-feed', filters],
    enabled: Boolean(date.apiQuery),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams(date.apiQuery);
      p.set('influencersOnly', 'true'); p.set('limit', String(PAGE_SIZE));
      if (account) p.set('username', account);
      if (program) p.set('programId', program);
      if (sentiment) p.set('sentiment', sentiment);
      if (relevance) p.set('relevance', relevance);
      if (q) p.set('q', q);
      if (includeFiltered) p.set('includeFiltered', 'true');
      if (pageParam) p.set('cursor', pageParam);
      return api.get<{ items: Interaction[]; nextCursor: string | null }>(`/posts?${p}`, signal);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const posts = feed.data?.pages.flatMap((pg) => pg.items) ?? [];

  // Load the next page when the end of the list scrolls into view; the button stays as a fallback.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !feed.hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !feed.isFetchingNextPage) feed.fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el); return () => io.disconnect();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage]);

  const active = [account, program, sentiment, relevance, q].filter(Boolean).length + (includeFiltered ? 1 : 0);
  const clearAll = () => {
    setText('');
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of ['account', 'program', 'sentiment', 'relevance', 'q', 'filtered']) next.delete(k);
      return next;
    }, { replace: true });
  };

  return (
    <div className="space-y-3" role="tabpanel" id="inf-panel-posts" aria-labelledby="inf-tab-posts">
      <div className="card p-3 inf-toolbar">
        <label className="inf-search">
          <Search size={15} aria-hidden="true" />
          <input className="input" type="search" placeholder="ابحث في نص المنشورات…" aria-label="البحث في نص المنشورات"
            value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <AccountPicker value={account} onChange={(v) => set('account', v)} />
        {can(PERMISSIONS.PROGRAMS_READ) && (
          <select className="input" aria-label="البرنامج" value={program} onChange={(e) => set('program', e.target.value)}>
            <option value="">كل البرامج</option>
            {(programs?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select>
        )}
        <select className="input" aria-label="المشاعر" value={sentiment} onChange={(e) => set('sentiment', e.target.value)}>
          <option value="">كل المشاعر</option>
          {Object.entries(SENTIMENT).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}
        </select>
        <select className="input" aria-label="حالة الارتباط" value={relevance} onChange={(e) => set('relevance', e.target.value)}>
          <option value="">كل حالات الارتباط</option>
          {Object.entries(RELEVANCE).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}
        </select>
        <label className="inf-check" title="المنشورات التي استبعدها الفلتر الأولي قبل التصنيف">
          <input type="checkbox" checked={includeFiltered} onChange={(e) => set('filtered', e.target.checked ? '1' : '')} />
          إظهار المستبعدة
        </label>
        {active > 0 && <Button variant="ghost" type="submit" onClick={clearAll}><X size={14} /> مسح الفلاتر ({active})</Button>}
      </div>

      <div className="inf-result-line">
        <span>
          {feed.isSuccess && (posts.length
            ? <>يُعرض <span className="num">{fmtNum(posts.length)}</span> منشوراً{feed.hasNextPage ? ' — المزيد يُحمَّل عند التمرير' : ' — نهاية النتائج'}</>
            : null)}
        </span>
        <span>الأحدث أولاً حسب وقت النشر على إكس</span>
      </div>

      <StateBox
        loading={feed.isLoading || (!date.apiQuery && !date.error)} error={date.error ? new Error(date.error) : feed.error}
        onRetry={() => feed.refetch()} height={320}
        empty={!posts.length}
        emptyText={active > 0
          ? <>لا توجد منشورات تطابق هذه الفلاتر في الفترة المحددة.<Button variant="ghost" type="submit" onClick={clearAll}>مسح الفلاتر</Button></>
          : 'لا توجد منشورات مرصودة من الحسابات المتابَعة في هذه الفترة. جرّب فترة أطول من منتقي الفترة.'}
      >
        <InteractionList posts={posts} onAccount={username => set('account', username)}/>
        <div ref={sentinel} />
        {feed.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button variant="ghost" type="submit" onClick={() => feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
              {feed.isFetchingNextPage ? 'جارٍ تحميل المزيد…' : 'تحميل المزيد'}
            </Button>
          </div>
        )}
        {feed.isFetchNextPageError && <div className="inf-state inf-state--error" role="alert">تعذّر تحميل الصفحة التالية.</div>}
      </StateBox>

    </div>
  );
}

/** Picks one tracked account by searching the roster on the server (8 at a time). */
function AccountPicker({ value, onChange }: { value: string; onChange: (username: string) => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const q = useDebounced(text.trim(), 250);
  const { data, isFetching } = useQuery({
    queryKey: ['influencer-accounts-pick', q],
    queryFn: () => api.get<AccountPage>(`/influencers/accounts?${new URLSearchParams({ q, pageSize: '8', sort: 'total_posts', range: 'all' })}`),
    enabled: open,
    staleTime: 30_000,
  });
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (value) return (
    <span className="inf-chip">
      <span className="num truncate">@{value}</span>
      <button type="button" onClick={() => onChange('')} aria-label="إلغاء تصفية الحساب"><X size={13} /></button>
    </span>
  );
  return (
    <div className="inf-combo" ref={wrap}>
      <input
        className="input" placeholder="كل الحسابات — ابحث بالاسم أو المعرف" aria-label="تصفية حسب الحساب"
        role="combobox" aria-expanded={open} aria-controls="inf-account-options" aria-autocomplete="list"
        value={text} onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
      />
      {open && (
        <div className="inf-combo-list" id="inf-account-options" role="listbox">
          {isFetching && !data && <div className="p-2 text-xs muted">جارٍ البحث…</div>}
          {data && !data.items.length && <div className="p-2 text-xs muted">لا يوجد حساب متابَع بهذا الاسم.</div>}
          {data?.items.map((a) => (
            <button key={a.id} type="button" role="option" aria-selected={false} className="inf-combo-option"
              onClick={() => { onChange(a.username); setText(''); setOpen(false); }}>
              <Avatar src={a.profile_image_url} name={a.display_name} username={a.username} size={22} />
              <span className="min-w-0 flex-1 truncate">{a.display_name ?? a.username} <span className="muted num">@{a.username}</span></span>
              <span className="muted num text-xs">{fmtNum(a.total_posts)}</span>
            </button>
          ))}
          {data && data.total > data.items.length && <div className="p-2 text-xs muted">اكتب لتضييق النتائج — {fmtNum(data.total)} حساباً مطابقاً.</div>}
        </div>
      )}
    </div>
  );
}
