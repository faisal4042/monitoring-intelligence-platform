import { STATUS_ORDER, type BoardAgent } from './workforce';
export type AgentSort = 'status' | 'load' | 'tickets' | 'closed' | 'name';
export function loadRatio(a: Pick<BoardAgent, 'open' | 'maxOpen'>) {
  return a.maxOpen > 0 ? a.open / a.maxOpen : a.open > 0 ? 1 : 0;
}
export function workloadLabel(a: Pick<BoardAgent, 'open' | 'maxOpen' | 'status'>) {
  if (a.status === 'offline') return 'غير متصل';
  if (a.status !== 'available') return 'غير متاح للإسناد';
  if (a.maxOpen === 0) return 'الطاقة معطلة';
  return a.open >= a.maxOpen ? 'مشغول' : 'متاح';
}
export function selectBoardAgents(agents: BoardAgent[], search: string, sort: AgentSort, page: number, size = 10) {
  const needle = search.trim().toLocaleLowerCase('ar');
  const filtered = agents.filter(a => (a.full_name + ' ' + a.team_name).toLocaleLowerCase('ar').includes(needle));
  const compare = (a: BoardAgent, b: BoardAgent) => {
    if (sort === 'status') return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (sort === 'load') return loadRatio(b) - loadRatio(a);
    if (sort === 'tickets') return b.open - a.open;
    if (sort === 'closed') return b.closedToday - a.closedToday;
    return 0;
  };
  filtered.sort((a, b) => compare(a, b) || a.full_name.localeCompare(b.full_name, 'ar') || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.max(1, Math.min(page, pages));
  return { rows: filtered.slice((current - 1) * size, current * size), total: filtered.length, pages, current };
}
