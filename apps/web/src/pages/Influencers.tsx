import { lazy, Suspense, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { canReadCardTemplates, PERMISSIONS } from '@mip/shared';
import { Plus, UsersRound } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDateRange } from '../lib/useDateRange';
import { fmtNum } from '../lib/format';
import { HUB_TABS, type HubOverview, type HubTab } from '../lib/influencers';
import DateRangeFilter from '../components/DateRangeFilter';
import PostsTab from '../components/influencers/PostsTab';
import AccountsTab, { AddAccountsDialog } from '../components/influencers/AccountsTab';
import AnalyticsTab from '../components/influencers/AnalyticsTab';
import { Delta, Kpi, StateBox } from '../components/influencers/shared';
import '../components/influencers/influencers.css';
import SearchLink from '../components/search/SearchLink';

import { Button } from '../components/ui/Button';
// The card template studio loads only when its tab is opened.
const CardStudio = lazy(() => import('../components/influencers/card-studio/CardStudio'));

/**
 * العملاء المؤثرون — monitoring hub for tracked accounts: their collected
 * posts, the managed roster, and analytics. Being on the roster only adds
 * `from:username` to collection; it never bypasses program keyword matching.
 * Everything here is read from the platform's own database — never from X.
 */
export default function Influencers() {
  const { can, user } = useAuth();
  const canWrite = can(PERMISSIONS.INFLUENCERS_WRITE);
  // Posts and analytics are interaction data: they also need posts:read, exactly like the dashboard.
  const canPosts = can(PERMISSIONS.POSTS_READ);
  const [params, setParams] = useSearchParams();
  const date = useDateRange();
  const [adding, setAdding] = useState(false);

  // The template studio needs the (proposed, not yet granted) card template permissions.
  const canCards = canReadCardTemplates(user);
  const tabs = HUB_TABS.filter((t) => (t.key === 'cards' ? canCards : canPosts || t.key === 'accounts'));
  const requested = params.get('tab') as HubTab | null;
  const tab: HubTab = tabs.some((t) => t.key === requested) ? requested! : tabs[0].key;
  const setTab = (next: HubTab, extra?: Record<string, string>) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (next === 'posts') p.delete('tab'); else p.set('tab', next);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    return p;
  });
  const showPosts = (username: string) => setTab('posts', { account: username });

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0; // RTL: left moves forward
    if (!step) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length].key;
    setTab(next); tabRefs.current[next]?.focus();
  };

  const overview = useQuery({
    queryKey: ['influencer-overview', date.apiQuery],
    enabled: canPosts && Boolean(date.apiQuery),
    queryFn: ({ signal }) => api.get<HubOverview>(`/influencers/overview?${date.apiQuery}`, signal),
  });
  const o = overview.data;

  return (
    <div className="space-y-4">
      <div className="page-heading flex-wrap">
        <div className="min-w-0">
          <span className="eyebrow">الرصد</span>
          <h1 className="flex items-center gap-2.5"><UsersRound size={22} className="text-brand-600" aria-hidden="true" /> العملاء المؤثرون</h1>
          <p>رصد منشورات الحسابات المتابَعة وتحليلها — تُجمع تغريداتها فقط إن طابقت قاموس أحد برامجنا، كأي منشور آخر.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeFilter state={date} />
          <SearchLink q="influencer:true" label="بحث في منشورات المؤثرين" />
          {canWrite && <Button variant="primary" type="submit" onClick={() => setAdding(true)}><Plus size={15} /> إضافة حسابات</Button>}
        </div>
      </div>

      {canPosts && (
        <StateBox loading={overview.isLoading || (!date.apiQuery && !date.error)} error={date.error ? new Error(date.error) : overview.error}
          onRetry={() => overview.refetch()} height={100}>
          {o && (
            <div className="inf-kpis" aria-label="مؤشرات الفترة">
              <Kpi label="الحسابات المراقبة" value={o.tracked}
                sub={o.neverSeen > 0 ? <><span className="num">{fmtNum(o.neverSeen)}</span> منها لم يُرصد لها أي منشور بعد</> : 'كل الحسابات رُصد لها نشاط سابق'} />
              <Kpi label="الحسابات النشطة خلال الفترة" value={o.now.active}
                sub={<>{o.tracked > 0 && <><span className="num">{Math.round((o.now.active / o.tracked) * 100)}%</span> من المراقبة</>}
                  {o.before && <> · <Delta now={o.now.active} before={o.before.active} /></>}</>} />
              <Kpi label="المنشورات المرصودة" value={o.now.posts}
                sub={<><span className="num">{fmtNum(o.now.relevant)}</span> مرتبطة ببرامجنا{o.before && <> · <Delta now={o.now.posts} before={o.before.posts} /></>}</>} />
              <Kpi label="البرامج المرتبطة" value={o.now.programs}
                sub={<><span className="num">{fmtNum(o.now.with_program)}</span> منشوراً مرتبطاً ببرنامج</>} />
              {o.now.with_topic > 0
                ? <Kpi label="الموضوعات" value={o.now.topics} sub={<>من <span className="num">{fmtNum(o.now.with_topic)}</span> منشوراً مصنَّفاً موضوعياً</>} />
                : <Kpi label="الموضوعات" unavailable="غير متوفرة" sub={o.now.posts ? 'لم تُصنَّف منشورات الفترة إلى موضوعات بعد' : 'لا توجد منشورات في الفترة'} />}
            </div>
          )}
        </StateBox>
      )}

      <div className="queue-tabs" role="tablist" aria-label="أقسام صفحة المؤثرين">
        {tabs.map((t, i) => (
          <button key={t.key} ref={(el) => { tabRefs.current[t.key] = el; }} id={`inf-tab-${t.key}`} role="tab" type="button"
            className="queue-tab" aria-selected={tab === t.key} aria-controls={`inf-panel-${t.key}`} tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)} onKeyDown={(e) => onTabKey(e, i)}>
            {t.label}
            {t.key === 'accounts' && o && <span className="queue-tab-count num">{fmtNum(o.tracked)}</span>}
          </button>
        ))}
      </div>

      {tab === 'posts' && <PostsTab date={date} />}
      {tab === 'accounts' && <AccountsTab date={date} canWrite={canWrite} onShowPosts={showPosts} />}
      {tab === 'analytics' && <AnalyticsTab date={date} onShowPosts={showPosts} />}
      {tab === 'cards' && <Suspense fallback={<div className="inf-skeleton" style={{ height: 320 }} />}><CardStudio /></Suspense>}

      {adding && <AddAccountsDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
