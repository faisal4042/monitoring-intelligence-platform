/**
 * Strips tracking noise so the same article reached via different campaign
 * links doesn't get stored twice, and hashes the result into the exact-dedup
 * key (`news_articles.url_hash`). Near-duplicate detection across different
 * URLs entirely (syndicated copies, rewritten headlines) is Phase 3 —
 * this only collapses "same URL, different tracking params".
 */
import { createHash } from 'node:crypto';

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'igshid',
];

export function canonicalizeUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  for (const param of TRACKING_PARAMS) u.searchParams.delete(param);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  // Sort remaining params so equivalent-but-reordered query strings collapse too.
  u.searchParams.sort();
  return u.toString();
}

export function hashUrl(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex');
}
