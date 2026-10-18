import {pageBounds,uniqueRows,navigateTabs} from '../lib/data-browsing';
import {useAuth} from '../lib/auth';
import {PERMISSIONS as P} from '@mip/shared';
import QueueDraftNotice from '../components/QueueDraftNotice';
import AsyncState from '../components/AsyncState';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, BarChart3, Bookmark, CalendarRange, ChevronLeft, ChevronRight, CircleHelp, FilterX, LayoutGrid, Link2, List,
  Lock, RotateCcw, SearchCode, SearchX, SlidersHorizontal, Sparkles, X,
} from 'lucide-react';
import { parseSearch, removeSpan, topLevelConditions, type SearchEntity, type SearchNode } from '@mip/shared';
import { api, ApiError } from '../lib/api';
import { DEFAULT_DATE_RANGE, useDateRange } from '../lib/useDateRange';
import { fmtNum } from '../lib/format';
import {
  SORT_LABELS, VALUE_LABELS, fieldConditionCount, setFieldCondition, useSearchState,
  type FieldsResponse, type QueryResponse, type SavedSearch,
} from '../lib/search';
import DateRangeFilter from '../components/DateRangeFilter';
import SearchBar, { SyntaxHelp } from '../components/search/SearchBar';
import FiltersPanel, { INITIAL_FILTERS_DRAFT, type FiltersDraft } from '../components/search/FiltersPanel';
import QuickFilters from '../components/search/QuickFilters';
import SearchDrawer from '../components/search/SearchDrawer';
import ModalSurface, { ModalCloseButton } from '../components/ModalSurface';
import Results from '../components/search/Results';
import AnalyticsPanel from '../components/search/AnalyticsPanel';
import SavedSearches from '../components/search/SavedSearches';
import '../components/influencers/influencers.css';
import '../components/search/search.css';

/** Human label for a top-level condition chip. */
function chipLabel(n: SearchNode): string {
  switch (n.type) {
    case 'term': return n.value;
    case 'phrase': return `"${n.value}"`;
    case 'not': return `استبعاد: ${chipLabel(n.child)}`;
    case 'field': return `${n.field}${n.op === ':' ? ':' : `:${n.op}`}${VALUE_LABELS[n.value] ?? n.value}`;
    default: return n.type === 'or' ? n.children.map(chipLabel).join(' أو ') : n.children.map(chipLabel).join(' و ');
  }
}

/**
 * البحث المتقدم — one search language over posts, news, accounts and queue
 * tickets. Everything (query, tab, period, sort, page, view) lives in the URL,
 * so a search is a link. Only platform data is searched; nothing goes to X.
 */
export default function AdvancedSearch() {
  const {can}=useAuth();
  const { state, update } = useSearchState();
  const date = useDateRange(undefined,{resetKeys:['page','item','detail','detailSection']});
  const [panel, setPanel] = useState<'filters' | 'saved' | 'help' | null>(null);
  const [filtersDraft, setFiltersDraft] = useState<FiltersDraft>(INITIAL_FILTERS_DRAFT);
  const [savedRun, setSavedRun] = useState<{ name: string; q: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const fields = useQuery({ queryKey: ['search-fields'], queryFn: () => api.get<FieldsResponse>('/search/fields'), staleTime: 5 * 60_000 });
  const tabs = fields.data?.tabs ?? [];
  const tabInfo = tabs.find((t) => t.key === state.tab);
  const allowed=!!tabInfo?.allowed&&can(...(state.tab==='tickets'?[P.QUEUE_WORK,P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL]:[state.tab==='posts'?P.POSTS_READ:state.tab==='news'?P.NEWS_READ:P.CUSTOMERS_READ]));
  const period = useMemo(() => Object.fromEntries(new URLSearchParams(date.apiQuery)) as Record<string, string>, [date.apiQuery]);

  const result = useQuery({
    queryKey: ['search', state.q, state.tab, period, state.sort, state.page, state.size],
    enabled: allowed && Boolean(date.apiQuery),
    queryFn: () => api.post<QueryResponse>('/search/query', { q: state.q, tab: state.tab, ...period, sort: state.sort || undefined, page: state.page, pageSize: state.size }),
  });
  const r = allowed&&!date.error?result.data:undefined;
  const conds = useMemo(() => { try { return topLevelConditions(parseSearch(state.q).ast); } catch { return []; } }, [state.q]);
  const bounds=pageBounds(r?.total,state.size,10000,1000);const pages=bounds.accessible;
  useEffect(()=>{if(result.isSuccess&&r&&!r.unsupported&&state.page>pages)update({page:pages},{replace:true});},[result.isSuccess,r?.total,state.page,pages,update]);
  useEffect(() => { if (savedRun && savedRun.q !== state.q) setSavedRun(null); }, [state.q, savedRun]);

  const runSearch = (q: string, tab?: SearchEntity) => update({ q, ...(tab ? { tab } : {}) });
  const onSaved = (s: SavedSearch) => {
    update({ q: s.query, tab: s.tab, sort: s.sort ?? '' },{period:s.period.from||s.period.to?{from:s.period.from,to:s.period.to}:{range:s.period.range??DEFAULT_DATE_RANGE}});
    setSavedRun({ name: s.name, q: s.query.trim() });
    setPanel(null);
  };
  const resetAll = () => { update({q:''},{period:{range:DEFAULT_DATE_RANGE}}); };
  const copyLink = async () => { await navigator.clipboard?.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const filterCount = fieldConditionCount(state.q);
  const items = r ? uniqueRows(r.items) : [];
  const first = r && items.length ? (state.page - 1) * state.size + 1 : 0;

  if (fields.error) return <AsyncState error={fields.error}
    errorMessage="تعذر تحميل تعريف حقول البحث. حاول مرة أخرى."
    onRetry={() => fields.refetch()} />;

  return (
    <div className="as-page" dir="rtl"><QueueDraftNotice/>
      <header className="as-header">
        <div className="min-w-0">
          <span className="eyebrow">الرصد</span>
          <h1 className="as-h1"><SearchCode size={24} className="as-h1-icon" aria-hidden="true" /> البحث المتقدم</h1>
          <p className="as-lead">بحث موحد في المنشورات والأخبار والحسابات وتذاكر الطابور — داخل بيانات المنصة فقط.</p>
        </div>
        <div className="as-header-actions">
          <button type="button" className="as-hbtn" onClick={() => setPanel('saved')} aria-haspopup="dialog">
            <Bookmark size={16} aria-hidden="true" /> البحوث المحفوظة
          </button>
          <button type="button" className="as-hbtn" onClick={() => setPanel('filters')} aria-haspopup="dialog">
            <SlidersHorizontal size={16} aria-hidden="true" /> الفلاتر المتقدمة
            {filterCount > 0 && <span className="as-count-badge num" aria-label={`${filterCount} شرط حقلي نشط`}>{filterCount}</span>}
          </button>
          <button type="button" className="as-hbtn as-hbtn--icon" onClick={() => setPanel('help')} aria-haspopup="dialog" aria-label="دليل صيغ البحث" title="دليل صيغ البحث">
            <CircleHelp size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="as-search-card" aria-label="البحث والفلاتر">
        <SearchBar value={state.q} onSubmit={(q) => runSearch(q)} fields={fields.data?.fields ?? []} tab={state.tab} />
        <div className="as-filterbar" role="group" aria-label="فلاتر سريعة">
          <div className="as-date"><DateRangeFilter state={date} /></div>
          {fields.data && <QuickFilters fields={fields.data.fields} tab={state.tab} q={state.q} onChange={runSearch} />}
          <button type="button" className="as-more" onClick={() => setPanel('filters')}>
            <SlidersHorizontal size={14} aria-hidden="true" /> فلاتر أخرى
          </button>
        </div>
        {conds.length > 0 && (
          <div className="as-active" aria-label="الشروط النشطة">
            <span className="as-active-label">الشروط النشطة</span>
            {conds.map((c) => (
              <span key={`${c.span.start}-${c.span.end}`} className="as-active-chip">
                <span dir="auto">{chipLabel(c.node)}</span>
                <button type="button" aria-label={`إزالة الشرط ${chipLabel(c.node)}`} onClick={() => runSearch(removeSpan(state.q, c.span))}><X size={13} /></button>
              </span>
            ))}
            <button type="button" className="as-reset" onClick={resetAll}><RotateCcw size={14} aria-hidden="true" /> إعادة ضبط الكل</button>
          </div>
        )}
      </section>

      {savedRun && (
        <p className="as-saved-banner" role="status"><Bookmark size={14} aria-hidden="true" /> تعرض الآن نتائج البحث المحفوظ «<b>{savedRun.name}</b>»
          <button type="button" className="as-link-btn" onClick={() => setPanel('saved')}>عمليات البحث المحفوظة</button></p>
      )}

      <section className="as-results" aria-label="النتائج">
        <div onKeyDown={navigateTabs} className="as-tabs" role="tablist" aria-label="نوع البيانات">
          {tabs.map((t) => {
            const count = t.key === state.tab ? r?.total : r?.counts?.[t.key]?.total;
            return (
              <button key={t.key} role="tab" type="button" className="as-tab" aria-selected={state.tab === t.key} disabled={!t.allowed}
                tabIndex={state.tab === t.key ? 0 : -1}
                title={!t.allowed ? t.reason : r?.counts?.[t.key]?.reason} onClick={() => update({ tab: t.key, sort: '' })}>
                <span>{t.label}</span>
                {t.allowed && count !== undefined && count !== null && <span className="as-tab-count num">{fmtNum(count)}</span>}
                {!t.allowed && <Lock size={12} aria-label="غير مصرح" />}
              </button>
            );
          })}
        </div>

        <div className="as-toolbar">
          <p className="as-summary" aria-live="polite">
            {r && r.total !== null && !r.unsupported
              ? <><bdi><b className="num">{fmtNum(r.total)}</b> نتيجة</bdi>{items.length > 0 && <> · <bdi>عرض <span className="num">{fmtNum(first)}</span> إلى <span className="num">{fmtNum(first + items.length - 1)}</span></bdi></>} · <bdi><span className="num">{r.tookMs}</span> م.ث</bdi></>
              : result.isFetching ? 'جارٍ البحث…' : null}
          </p>
          <div className="as-controls">
            <div className="as-ctl-group" role="group" aria-label="خيارات العرض">
              <label className="as-select"><span>الترتيب</span>
                <select value={state.sort || r?.sort || tabInfo?.sorts[0] || ''} onChange={(e) => update({ sort: e.target.value })}>
                  {(tabInfo?.sorts ?? []).map((s) => <option key={s} value={s}>{SORT_LABELS[s] ?? s}</option>)}
                </select>
              </label>
              <label className="as-select"><span>لكل صفحة</span>
                <select value={state.size} onChange={(e) => update({ size: Number(e.target.value) })}>
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              {state.tab !== 'posts' && (
                <div className="as-seg" role="group" aria-label="طريقة العرض">
                  <button type="button" aria-pressed={state.view === 'list'} aria-label="عرض قائمة" title="قائمة" onClick={() => update({ view: 'list' }, { resetPage: false })}><List size={16} /></button>
                  <button type="button" aria-pressed={state.view === 'cards'} aria-label="عرض شبكة" title="شبكة" onClick={() => update({ view: 'cards' }, { resetPage: false })}><LayoutGrid size={16} /></button>
                </div>
              )}
            </div>
            <div className="as-ctl-group" role="group" aria-label="إجراءات النتائج">
              {(state.tab === 'posts' || state.tab === 'news') && (
                <button type="button" className={`as-ctl ${state.analytics ? 'is-on' : ''}`} aria-pressed={state.analytics} onClick={() => update({ analytics: !state.analytics }, { resetPage: false })}>
                  <BarChart3 size={15} aria-hidden="true" /> تحليل النتائج</button>
              )}
              <button type="button" className="as-ctl" onClick={copyLink} aria-live="polite"><Link2 size={15} aria-hidden="true" /> {copied ? 'تم نسخ الرابط' : 'مشاركة الرابط'}</button>
            </div>
          </div>
        </div>

        {bounds.restricted&&<p role="status" className="as-banner">الإجمالي {fmtNum(r!.total)}؛ يتيح التصفح الحالي {pages} صفحة بهذا الحجم. ضيّق الفترة أو الفلاتر للوصول إلى بقية النتائج.</p>}
        {r?.warnings?.map((w) => <p key={w} className="as-banner" role="status">{w}</p>)}
        {!state.q && r && items.length > 0 && <p className="as-hint"><Sparkles size={14} aria-hidden="true" /> تعرض النتائج كل بيانات الفترة المحددة. اكتب كلمات أو اختر فلترًا لتضييقها.</p>}

        {state.analytics && (state.tab === 'posts' || state.tab === 'news') && allowed && !r?.unsupported &&
          <AnalyticsPanel q={state.q} tab={state.tab} period={period} />}

        {tabInfo && !allowed
          ? <ResultState icon={<Lock size={22} />} title="لا تملك صلاحية هذا النوع من البيانات" text={tabInfo.reason ?? 'لا تملك صلاحية قراءة هذا النوع من البيانات.'} />
          : date.error ? <ResultState tone="error" icon={<CalendarRange size={22} />} title="الفترة الزمنية غير صالحة" text={date.error} />
          : result.error ? <ResultState tone="error" icon={<AlertTriangle size={22} />} title="تعذر تنفيذ البحث" text={(result.error as ApiError).message || 'حدث خطأ أثناء البحث.'}
              actions={<button type="button" className="as-ctl" onClick={() => result.refetch()}><RotateCcw size={15} aria-hidden="true" /> إعادة المحاولة</button>} />
          : fields.isLoading || (result.isLoading && !r) ? <ResultsSkeleton />
          : r?.unsupported ? <ResultState icon={<FilterX size={22} />} title="شرط غير متاح في هذا التبويب" text={r.unsupported.reason}
              actions={<button type="button" className="as-ctl" onClick={() => runSearch(setFieldCondition(state.q, r.unsupported!.field, null))}>إزالة شرط {r.unsupported.field}</button>} />
          : r && items.length === 0 ? (state.q
              ? <ResultState icon={<SearchX size={22} />} title="لا توجد نتائج مطابقة" text="لم نجد ما يطابق هذه الشروط في الفترة المحددة. جرّب فترة أطول أو شروطًا أقل."
                  actions={<>{date.preset !== 'all' && <button type="button" className="as-ctl" onClick={() => date.set('all')}><CalendarRange size={15} aria-hidden="true" /> البحث في كل الفترات</button>}
                    <button type="button" className="as-ctl" onClick={() => runSearch('')}><FilterX size={15} aria-hidden="true" /> مسح الشروط</button></>} />
              : <ResultState icon={<CalendarRange size={22} />} title="لا توجد بيانات في هذه الفترة" text="لم تُجمع بيانات من هذا النوع خلال الفترة المحددة."
                  actions={date.preset !== 'all' ? <button type="button" className="as-ctl" onClick={() => date.set('all')}>عرض كل الفترات</button> : undefined} />)
          : r && <div aria-busy={result.isFetching} className={result.isFetching ? 'as-refreshing' : undefined}>
              <Results tab={state.tab} items={items} view={state.view} needles={r.highlight ?? []} onSearch={runSearch} />
              {r.total!==null&&pages > 1 && (
                <nav className="as-pager" aria-label="ترقيم الصفحات">
                  <span className="as-pager-info">صفحة <span className="num">{fmtNum(state.page)}</span> من <span className="num">{fmtNum(pages)}</span></span>
                  <div className="as-pager-buttons">
                    <button type="button" className="as-page-btn" aria-label="الصفحة السابقة" disabled={result.isFetching||state.page <= 1} onClick={() => update({ page: state.page - 1 })}><ChevronRight size={16} /></button>
                    {pageWindow(state.page, pages).map((p, i) => p === 0 ? <span key={`gap${i}`} className="as-page-gap" aria-hidden="true">…</span>
                      : <button type="button" key={p} className="as-page-btn num" aria-current={p === state.page ? 'page' : undefined} disabled={result.isFetching} onClick={() => update({ page: p })}>{p}</button>)}
                    <button type="button" className="as-page-btn" aria-label="الصفحة التالية" disabled={result.isFetching||state.page >= pages} onClick={() => update({ page: state.page + 1 })}><ChevronLeft size={16} /></button>
                  </div>
                </nav>
              )}
            </div>}
      </section>

      {panel === 'filters' && fields.data && (
        <SearchDrawer id="as-filters-drawer" title="الفلاتر المتقدمة" icon={<SlidersHorizontal size={18} aria-hidden="true" />}
          badge={filterCount > 0 ? <span className="as-count-badge num">{filterCount}</span> : undefined} onClose={() => setPanel(null)}
          footer={<>
            <button type="button" className="as-ctl" disabled={!filterCount} onClick={() => {
              let q = state.q; for (const c of [...conds].reverse()) if (c.node.type === 'field' || (c.node.type === 'not' && c.node.child.type === 'field')) q = removeSpan(q, c.span);
              runSearch(q);
            }}><FilterX size={15} aria-hidden="true" /> مسح شروط الحقول</button>
            <button type="button" className="btn-primary" onClick={() => setPanel(null)}>عرض النتائج{r?.total != null && <> (<span className="num">{fmtNum(r.total)}</span>)</>}</button>
          </>}>
          <p className="as-note">يُضاف كل فلتر إلى الاستعلام فورًا ويظهر ضمن الشروط النشطة. تبقى القيم التي بدأت كتابتها محفوظة عند إغلاق اللوحة.</p>
          <FiltersPanel fields={fields.data.fields} tab={state.tab} q={state.q} onChange={runSearch} draft={filtersDraft} setDraft={setFiltersDraft} />
        </SearchDrawer>
      )}
      {panel === 'saved' && fields.data && (
        <SearchDrawer id="as-saved-drawer" title="عمليات البحث المحفوظة" icon={<Bookmark size={18} aria-hidden="true" />} onClose={() => setPanel(null)}>
          <SavedSearches available={fields.data.saved.available} reason={fields.data.saved.reason}
            current={{ q: state.q, tab: state.tab, period, sort: state.sort }} onRun={onSaved} />
        </SearchDrawer>
      )}
      {panel === 'help' && (
        <ModalSurface labelledBy="as-help-title" onClose={() => setPanel(null)} panelClassName="card modal-card as-help-dialog">
          <header className="as-drawer-head">
            <h2 id="as-help-title" className="as-drawer-title"><CircleHelp size={18} aria-hidden="true" /> دليل صيغ البحث</h2>
            <ModalCloseButton type="button" className="icon-button" aria-label="إغلاق" onClick={() => setPanel(null)}><X size={17} /></ModalCloseButton>
          </header>
          <SyntaxHelp />
        </ModalSurface>
      )}
    </div>
  );
}

function ResultState({ icon, title, text, actions, tone }: { icon: ReactNode; title: string; text: ReactNode; actions?: ReactNode; tone?: 'error' }) {
  return (
    <div className={`as-state ${tone === 'error' ? 'as-state--error' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="as-state-icon" aria-hidden="true">{icon}</span>
      <h2 className="as-state-title">{title}</h2>
      <p className="as-state-text">{text}</p>
      {actions && <div className="as-state-actions">{actions}</div>}
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="as-skeletons" aria-busy="true" aria-label="جارٍ تحميل النتائج">
      {[0, 1, 2].map((i) => <div key={i} className="as-skeleton"><span /><span /><span /></div>)}
    </div>
  );
}

/** 1 … 4 5 [6] 7 8 … 20 */
function pageWindow(page: number, pages: number): number[] {
  const set = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= pages));
  const sorted = [...set].sort((a, b) => a - b);
  const out: number[] = [];
  sorted.forEach((p, i) => { if (i && p - sorted[i - 1] > 1) out.push(0); out.push(p); });
  return out;
}
