export function boundedPage(raw: string | null, maximum: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : 1;
}

/** API limits are offsets, not invented totals. The final permitted offset is inclusive. */
export function pageBounds(total: number | null | undefined, size: number, maxOffset: number, maxPages: number) {
  const limit = Math.min(maxPages, Math.floor(maxOffset / size) + 1);
  const pages = total == null ? null : Math.max(1, Math.ceil(total / size));
  return { limit, pages, accessible: pages == null ? limit : Math.min(pages, limit), restricted: pages != null && pages > limit };
}

/** Keep server order; duplicate IDs must never create duplicate cards or selection targets. */
export function uniqueRows<T>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string') return true;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
}

export function changedFilters(params: URLSearchParams, patch: Record<string, string | null>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
  for (const key of ['page', 'cursor', 'item', 'detail', 'detailSection']) next.delete(key);
  return next;
}
import type { KeyboardEvent } from 'react';


/** Automatic tab activation follows visual RTL order; disabled tabs stay unreachable. */
export function navigateTabs(event: KeyboardEvent<HTMLElement>) {
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].filter(tab=>!tab.disabled);
  const current=tabs.indexOf(event.target as HTMLButtonElement);
  if(current<0||!tabs.length)return;
  event.preventDefault();
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowLeft'?1:-1)+tabs.length)%tabs.length;
  tabs[next].focus();tabs[next].click();
}
