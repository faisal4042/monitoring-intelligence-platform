import {useBrowsingParams} from './useBrowsingParams';
/** Advanced search — client types, URL state and labels (pages/AdvancedSearch.tsx). */
import { useCallback, useMemo } from 'react';

import { boundedPage, pageBounds } from './data-browsing';
import { PERMISSIONS, addCondition, parseSearch, removeSpan, topLevelConditions, type SearchEntity, type SearchNode } from '@mip/shared';

/** Any one of these opens the page; each tab then checks its own permission on the server. */
export const SEARCH_PERMS = [PERMISSIONS.POSTS_READ, PERMISSIONS.NEWS_READ, PERMISSIONS.CUSTOMERS_READ,
  PERMISSIONS.QUEUE_WORK, PERMISSIONS.QUEUE_SUPERVISE, PERMISSIONS.QUEUE_VIEW_ALL];

export interface FieldInfo {
  name: string; aliases: string[]; kind: string; label: string; example: string; group: string;
  values: string[] | null; availability: Record<SearchEntity, string | null>;
}
export interface TabInfo { key: SearchEntity; label: string; allowed: boolean; reason?: string; sorts: string[] }
export interface FieldsResponse { tabs: TabInfo[]; fields: FieldInfo[]; limits: { maxLength: number }; saved: { available: boolean; reason?: string } }

export interface QueryResponse {
  tab: SearchEntity; page: number; pageSize: number; total: number | null; sort: string | null; items: Array<Record<string, any>>;
  counts: Record<string, { total: number | null; reason?: string }>; warnings: string[]; highlight?: string[];
  unsupported?: { field: string; reason: string }; tookMs: number;
}

export interface SavedSearch {
  id: string; name: string; query: string; tab: SearchEntity; period: { range?: string; from?: string; to?: string }; sort: string | null;
  visibility: 'private' | 'shared'; last_run_at: string | null; run_count: number; is_owner: boolean; owner_name: string; updated_at: string;
}

export const SORT_LABELS: Record<string, string> = {
  newest: 'الأحدث', oldest: 'الأقدم', relevance: 'الأكثر صلة', engagement: 'الأعلى تفاعلًا', followers: 'الأكثر متابعين',
  recent: 'آخر نشاط', name: 'الاسم', updated: 'آخر تحديث',
};
export const GROUP_LABELS: Record<string, string> = {
  content: 'المحتوى', account: 'الحساب', classification: 'التصنيف', engagement: 'التفاعل', dates: 'التواريخ', workflow: 'الطابور', source: 'المصدر',
};
export const VALUE_LABELS: Record<string, string> = {
  positive: 'إيجابي', negative: 'سلبي', neutral: 'محايد', very_positive: 'إيجابي جدًا', very_negative: 'سلبي جدًا', unclassified: 'غير مصنف',
  complaint: 'شكوى', inquiry: 'استفسار', suggestion: 'اقتراح', praise: 'إشادة', news: 'خبر', experience: 'تجربة', warning: 'تحذير',
  issue: 'مشكلة', request: 'طلب', other: 'أخرى', relevant: 'مرتبط', irrelevant: 'غير مرتبط', advertisement: 'إعلان', spam: 'سبام', unknown: 'غير محدد',
  image: 'صورة', video: 'فيديو', link: 'رابط', media: 'وسائط', pending: 'قيد المراجعة', done: 'مكتملة', none: 'بلا', open: 'مفتوحة',
  new: 'غير مسندة', assigned: 'مسندة', escalated: 'مصعّدة', completed: 'مغلقة', normal: 'عادية', high: 'عالية', general: 'عام', influencer: 'مؤثرين',
  story: 'قصص', keyword: 'كلمة مفتاحية', query: 'استعلام', x: 'X', true: 'نعم', false: 'لا', topic: 'موضوع', any: 'أي ارتباط', ar: 'العربية', en: 'الإنجليزية',
  SA: 'السعودية',
};

export type View = 'list' | 'cards';
export interface SearchState { q: string; tab: SearchEntity; sort: string; page: number; size: number; view: View; analytics: boolean }

/** Search state kept in the URL (the period lives in range/from/to, owned by useDateRange). */
export function useSearchState() {
  const [params, setParams] = useBrowsingParams();
  const state: SearchState = useMemo(() => ({
    q: params.get('q') ?? '',
    tab: (['posts', 'news', 'accounts', 'tickets'].includes(params.get('tab') ?? '') ? params.get('tab') : 'posts') as SearchEntity,
    sort: params.get('sort') ?? '',
    page: boundedPage(params.get('page'),pageBounds(null,[10,25,50,100].includes(Number(params.get('size')))?Number(params.get('size')):25,10000,1000).limit),
    size: [10, 25, 50, 100].includes(Number(params.get('size'))) ? Number(params.get('size')) : 25,
    view: params.get('view') === 'cards' ? 'cards' : 'list',
    analytics: params.get('analytics') === '1',
  }), [params]);
  const update = useCallback((patch: Partial<SearchState>, opts: { resetPage?: boolean; replace?: boolean; period?: Record<string,string|undefined> } = {}) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    const write = (k: string, v: string | null) => (v ? next.set(k, v) : next.delete(k));
    if (patch.q !== undefined) write('q', patch.q.trim() || null);
    if (patch.tab !== undefined) write('tab', patch.tab === 'posts' ? null : patch.tab);
    if (patch.sort !== undefined) write('sort', patch.sort || null);
    if (patch.size !== undefined) write('size', patch.size === 25 ? null : String(patch.size));
    if (patch.view !== undefined) write('view', patch.view === 'list' ? null : patch.view);
    if (patch.analytics !== undefined) write('analytics', patch.analytics ? '1' : null);
    if (patch.page !== undefined) write('page', patch.page > 1 ? String(patch.page) : null);
    else if (opts.resetPage !== false) next.delete('page');
    if(opts.period){for(const key of ['range','from','to'])next.delete(key);for(const key of ['range','from','to'])if(opts.period[key])next.set(key,opts.period[key]!);}
    if(patch.q!==undefined||patch.tab!==undefined||patch.sort!==undefined||patch.size!==undefined||opts.period){next.delete('item');next.delete('detail');next.delete('detailSection');}
    return next;
  },{replace:opts.replace}), [setParams]);
  return { state, update };
}

/** Link into the advanced search with conditions prefilled (used from other pages). */
export function searchHref(q: string, tab: SearchEntity = 'posts', extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ ...(q ? { q } : {}), ...(tab !== 'posts' ? { tab } : {}), ...extra });
  const s = p.toString();
  return `/advanced-search${s ? `?${s}` : ''}`;
}

/**
 * Quick filters edit the query text like the side filters do (the query stays the single source of truth).
 * A quick filter is single-valued: picking a value replaces the top-level `field:` condition(s) for that field.
 */
export function fieldConditions(q: string, field: string) {
  try {
    return topLevelConditions(parseSearch(q).ast)
      .filter((c): c is { node: Extract<SearchNode, { type: 'field' }>; span: { start: number; end: number } } => c.node.type === 'field' && c.node.field === field);
  } catch { return []; }
}
export function setFieldCondition(q: string, field: string, value: string | null): string {
  let next = q;
  for (const c of [...fieldConditions(q, field)].sort((a, b) => b.span.start - a.span.start)) next = removeSpan(next, c.span);
  return value ? addCondition(next, field, value) : next;
}
/** Number of top-level `field:value` conditions (what the filters drawer adds). */
export function fieldConditionCount(q: string) {
  try { return topLevelConditions(parseSearch(q).ast).filter((c) => c.node.type === 'field' || (c.node.type === 'not' && c.node.child.type === 'field')).length; }
  catch { return 0; }
}
