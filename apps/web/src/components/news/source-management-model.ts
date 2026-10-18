import { classifySource, type SourceState } from '@mip/shared';
export interface ManagedSource {
  id: string; name_ar: string; name_en: string | null; program_id: string | null; program_name: string | null;
  base_url: string; rss_url: string | null; sitemap_url: string | null; api_url: string | null;
  country: string | null; language: string; source_type: string; connector_type: string;
  source_weight: number; check_interval_minutes: number; is_active: boolean; crawl_allowed: boolean;
  extraction_mode: 'off' | 'shadow' | 'static' | 'dynamic'; last_checked_at: string | null;
  collection_attempt_at: string | null; collection_success_at: string | null; collection_status: string | null;
  collection_error: string | null; articles_total: number; articles_24h: number; discovered_total: number; discovered_24h: number;
  last_collection_error?: string | null; last_collection_error_at?: string | null;
  attempts: Array<{ status: string; connector_used: string | null; started_at: string; finished_at: string | null; items_discovered: number; items_new: number; error: string | null }>;
}
export interface SourceFilters { search: string; program: string; state: string; connector: string; extraction: string; sort: string; page: number; pageSize: number }
export function extractionReviewIds(sources: ManagedSource[], rows: Array<{
  id: string; mode: string; engine: string; breakerOpen: boolean; empty: number; failed: number; errorRecovered: boolean;
}>) {
  const active = new Set(sources.filter(s => s.is_active).map(s => s.id));
  return new Set(rows.filter(e => active.has(e.id) && e.engine === e.mode
    && (e.breakerOpen || (e.empty + e.failed > 0 && !e.errorRecovered))).map(e => e.id));
}
export function selectSources(sources: ManagedSource[], filters: SourceFilters, extractionReview: ReadonlySet<string> = new Set(), now = Date.now()) {
  const diagnoses = new Map(sources.map(s => [s.id, classifySource(s, now)]));
  const normalized = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim();
  const rows = sources.filter(s => (!filters.search || normalized(`${s.name_ar} ${s.name_en ?? ''}`).includes(normalized(filters.search)))
    && (!filters.program || (s.program_id ?? '__none') === filters.program)
    && (!filters.state || (filters.state === 'attention' ? ['troubled','review','unknown'].includes(diagnoses.get(s.id)!.state) || (s.is_active && extractionReview.has(s.id)) : diagnoses.get(s.id)!.state === filters.state))
    && (!filters.connector || s.connector_type === filters.connector) && (!filters.extraction || s.extraction_mode === filters.extraction));
  rows.sort((a,b) => {
    if (filters.sort === 'priority') return (a.is_active && extractionReview.has(a.id) ? Math.min(1, diagnoses.get(a.id)!.priority) : diagnoses.get(a.id)!.priority)
      - (b.is_active && extractionReview.has(b.id) ? Math.min(1, diagnoses.get(b.id)!.priority) : diagnoses.get(b.id)!.priority) || a.name_ar.localeCompare(b.name_ar,'ar');
    if (filters.sort === 'success') return (Date.parse(b.collection_success_at ?? '') || 0) - (Date.parse(a.collection_success_at ?? '') || 0) || a.id.localeCompare(b.id);
    if (filters.sort === 'articles') return b.articles_total - a.articles_total || a.id.localeCompare(b.id);
    if (filters.sort === 'state') return diagnoses.get(a.id)!.priority - diagnoses.get(b.id)!.priority || a.id.localeCompare(b.id);
    return a.name_ar.localeCompare(b.name_ar,'ar') || a.id.localeCompare(b.id);
  });
  const pageSize = [25,50,100].includes(filters.pageSize) ? filters.pageSize : 25;
  const pages = Math.max(1,Math.ceil(rows.length/pageSize)); const page = Math.min(pages,Math.max(1,filters.page));
  return { rows: rows.slice((page-1)*pageSize,page*pageSize), total: rows.length, pages, page, diagnoses };
}
export function sourceCounts(sources: ManagedSource[], extractionReview: ReadonlySet<string>, now = Date.now()) {
  const counts: Record<SourceState,number> = { healthy:0,troubled:0,paused:0,review:0,unknown:0 };
  for (const s of sources) counts[classifySource(s,now).state]++;
  return { ...counts, attention: sources.filter(s => ['review','unknown'].includes(classifySource(s,now).state) || (s.is_active && extractionReview.has(s.id))).length,
    articles24h: sources.reduce((n,s) => n+s.articles_24h,0) };
}
