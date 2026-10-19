import { ALL_WHATSAPP_PERMISSIONS, PERMISSIONS as P } from '@mip/shared';
import { SEARCH_PERMS } from './search';

/** Any-of requirements shared by route guards and navigation; the API remains authoritative. */
export const ROUTE_ACCESS: Record<string, string[]> = {
  '/queue': [P.QUEUE_WORK, P.QUEUE_SUPERVISE, P.QUEUE_VIEW_ALL],
  '/queue/board': [P.QUEUE_SUPERVISE, P.QUEUE_VIEW_ALL],
  '/queue/settings': [P.QUEUE_SUPERVISE, P.QUEUE_VIEW_ALL],
  '/teams': [P.USERS_READ], '/programs': [P.ADMIN_SYSTEM],
  '/dashboard': [P.POSTS_READ], '/live': [P.POSTS_READ],
  '/signals': [P.TOPICS_READ], '/keywords': [P.KEYWORDS_READ],
  '/queries': [P.QUERIES_READ], '/queries/new': [P.QUERIES_WRITE],
  '/queries/:id/test': [P.QUERIES_READ], '/cost': [P.COST_READ],
  '/classification': [P.TOPICS_READ], '/topics': [P.TOPICS_READ],
  '/influencers': [P.INFLUENCERS_READ], '/advanced-search': SEARCH_PERMS,
  '/admin': [P.ADMIN_SYSTEM], '/users': [P.USERS_READ],
  '/notifications': [P.ALERTS_READ, ...ALL_WHATSAPP_PERMISSIONS],
  '/news/sources': [P.NEWS_READ], '/news/articles': [P.NEWS_READ],
  '/youtube': [P.YOUTUBE_READ,P.YOUTUBE_MANAGE],
  '/tickets': [P.TICKETS_READ, P.TICKETS_READ_ALL], '/reports': [P.REPORTS_READ],
};

export function canAccessRoute(path: string, permissions: readonly string[]) {
  return (ROUTE_ACCESS[path] ?? []).some(p => permissions.includes(p));
}

export function homeRoute(permissions: readonly string[]) {
  const order = ['/queue', '/dashboard', ...Object.keys(ROUTE_ACCESS)];
  return order.find(path => !path.includes(':') && canAccessRoute(path, permissions)) ?? '/account/password';
}
