import type { RawArticle } from './types.js';
import { canonicalizeUrl } from '../lib/url-canonicalize.js';

type Channel = 'rss' | 'atom' | 'sitemap' | 'crawler';
const rank: Record<Channel, number> = { rss: 3, atom: 3, sitemap: 2, crawler: 1 };
const fields = ['title', 'description', 'author', 'publishedAt', 'imageUrl', 'language', 'publisherName', 'publisherUrl', 'contentHtml'] as const;
const present = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/** Field-level channel priority; lower-quality discoveries only fill gaps. */
export function mergeDiscovered(map: Map<string, RawArticle>, incoming: RawArticle, channel: Channel): void {
  let key: string;
  try { key = canonicalizeUrl(incoming.url); } catch { return; }
  const previous = map.get(key);
  const provenance = { ...(previous?.raw.discoveryFields as Record<string, Channel> | undefined) };
  const merged: RawArticle = previous ? { ...previous, raw: { ...incoming.raw, ...previous.raw } } : { ...incoming, publishedAt: null, raw: { ...incoming.raw } };
  for (const field of fields) {
    let value = incoming[field];
    if (field === 'publishedAt' && value && Number.isNaN(Date.parse(value))) value = null;
    if (present(value) && (!present(previous?.[field]) || rank[channel] > rank[provenance[field] ?? 'crawler'])) {
      Object.assign(merged, { [field]: value }); provenance[field] = channel;
    }
  }
  merged.raw.discoveryFields = provenance;
  merged.raw.discoveryChannels = [...new Set([...(previous?.raw.discoveryChannels as string[] ?? []), channel])];
  map.set(key, merged);
}
