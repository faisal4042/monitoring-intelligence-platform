/**
 * Transports. The gateway decides WHETHER a call happens (kill switch, quota, mode); a transport only performs it.
 * - LiveTransport: the only code that can reach googleapis.com. Key travels in the X-Goog-Api-Key header (never the
 *   URL), is read from the environment at call time, and never appears in errors or logs.
 * - MockTransport: deterministic synthetic responses in the official response shapes; no network at all.
 */
import {API_BASE, ENDPOINTS, redactKey, type EndpointName} from './endpoints.js';

export type Params = Record<string, string | number | undefined>;
export interface TransportResponse { status: number; body: any }
export interface Transport { readonly kind: 'live' | 'mock'; request(endpoint: EndpointName, params: Params, signal?: AbortSignal): Promise<TransportResponse> }

export class LiveTransport implements Transport {
  readonly kind = 'live' as const;
  constructor(private readonly key: () => string | undefined, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) {}
  async request(endpoint: EndpointName, params: Params, signal?: AbortSignal): Promise<TransportResponse> {
    const key = this.key();
    if (!key) throw Object.assign(new Error('YOUTUBE_API_KEY is not configured'), {status: null, reason: 'keyMissing', noRetry: true});
    const url = new URL(ENDPOINTS[endpoint].path, API_BASE);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    if (url.searchParams.has('key')) throw new Error('refusing to send an API key in the URL');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {headers: {'X-Goog-Api-Key': key, Accept: 'application/json'},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
      const body = await res.json().catch(() => null);
      return {status: res.status, body};
    } catch (e) {
      // Network/timeout: no status. Message is redacted in case an implementation echoes the request.
      throw Object.assign(new Error(redactKey(String((e as Error)?.message ?? e))), {status: null, reason: 'network'});
    }
  }
}

// ── Mock ─────────────────────────────────────────────────────────────────────────────────────
// Ids are syntactically valid but obviously synthetic (prefix "mk"/"UCmock"); titles carry "[اصطناعي]".
const BASE = Date.parse('2026-10-15T08:00:00Z');
const vid = (n: number) => `mkVid${String(n).padStart(6, '0')}`;          // 11 chars
export const MOCK_CHANNELS = ['UCmockEjarOfficial000001', 'UCmockRealEstateTalk0002'];   // UC + 22 chars, like real ids
const chanTitle = (c: string) => c.endsWith('1') ? '[اصطناعي] قناة رسمية تجريبية' : '[اصطناعي] قناة عقارية تجريبية';
const videoChannel = (n: number) => MOCK_CHANNELS[n % 2];
const titles = ['تجربتي مع عقد الإيجار الإلكتروني', 'شرح منصة إيجار للمستأجر', 'تأخر استرداد مبلغ التأمين', 'نصائح للمؤجرين في الرياض',
  'ملاك: اتحاد الملاك وتنظيمه', 'البناء المستدام في المشاريع السكنية', 'الهيئة العامة للعقار وتنظيم الوساطة', 'سؤال عن توثيق العقد'];

export interface MockScenario {
  /** Endpoint → queue of forced responses (status/body or thrown network error) consumed before normal data. */
  failures?: Partial<Record<EndpointName, Array<{status: number; reason?: string} | 'network'>>>;
  videoCount?: number;           // total videos in the synthetic world
  commentsDisabled?: string[];   // video ids
  missingVideos?: string[];      // ids that videos.list omits (deleted/private)
}

export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly calls: Array<{endpoint: EndpointName; params: Params}> = [];
  constructor(public scenario: MockScenario = {}) {}
  private get total() { return this.scenario.videoCount ?? 60; }
  async request(endpoint: EndpointName, params: Params): Promise<TransportResponse> {
    this.calls.push({endpoint, params: {...params}});
    const forced = this.scenario.failures?.[endpoint]?.shift();
    if (forced === 'network') throw Object.assign(new Error('synthetic network failure'), {status: null, reason: 'network'});
    if (forced) return {status: forced.status, body: {error: {code: forced.status, message: 'synthetic', errors: [{reason: forced.reason ?? 'backendError'}]}}};
    switch (endpoint) {
      case 'search.list': return {status: 200, body: this.page(this.allVideos(), params, 50, n => ({kind: 'youtube#searchResult', id: {kind: 'youtube#video', videoId: vid(n)}, snippet: {channelId: videoChannel(n), title: titles[n % titles.length]}}))};
      case 'channels.list': {
        const ids = String(params.id ?? '').split(',').filter(c => MOCK_CHANNELS.includes(c));
        return {status: 200, body: {items: ids.map(c => ({id: c, snippet: {title: chanTitle(c)}, contentDetails: {relatedPlaylists: {uploads: 'UU' + c.slice(2)}}}))}};
      }
      case 'playlistItems.list': {
        const ch = 'UC' + String(params.playlistId).slice(2);
        const list = this.allVideos().filter(n => videoChannel(n) === ch);
        return {status: 200, body: this.page(list, params, 50, n => ({snippet: {publishedAt: this.published(n), resourceId: {videoId: vid(n)}}, contentDetails: {videoId: vid(n), videoPublishedAt: this.published(n)}}))};
      }
      case 'videos.list': {
        const ids = String(params.id ?? '').split(',').filter(Boolean).filter(i => !(this.scenario.missingVideos ?? []).includes(i));
        return {status: 200, body: {items: ids.filter(i => /^mkVid\d{6}$/.test(i)).map(i => this.video(Number(i.slice(5))))}};
      }
      case 'videos.batchGetStats': {
        const ids = String(params.id ?? '').split(',').filter(i => /^mkVid\d{6}$/.test(i));
        return {status: 200, body: {items: ids.map(i => ({id: i, statistics: this.video(Number(i.slice(5))).statistics})), summary: {requestedVideoCount: ids.length, succeededVideoCount: ids.length, failedVideoCount: 0}}};
      }
      case 'commentThreads.list': {
        const v = String(params.videoId);
        if ((this.scenario.commentsDisabled ?? []).includes(v)) return {status: 403, body: {error: {code: 403, errors: [{reason: 'commentsDisabled'}]}}};
        const n = Number(v.slice(5)) || 0, threads = Array.from({length: 120}, (_, i) => i);   // > 100 → 2 pages
        return {status: 200, body: this.page(threads, params, 100, i => this.thread(v, n, i))};
      }
      case 'comments.list': {
        if (params.parentId) {
          const parent = String(params.parentId), total = this.replyTotal(parent);
          return {status: 200, body: this.page(Array.from({length: total}, (_, i) => i), params, 100, i => this.comment(`${parent}.r${i}`, parent, i + 1))};
        }
        const ids = String(params.id ?? '').split(',').filter(Boolean);
        return {status: 200, body: {items: ids.map(id => this.comment(id, id.includes('.r') ? id.split('.r')[0] : null, 3))}};
      }
    }
  }
  private allVideos() { return Array.from({length: this.total}, (_, i) => this.total - i); }   // newest first
  private published(n: number) { return new Date(BASE + n * 3_600_000).toISOString(); }
  private page<T>(all: T[], params: Params, cap: number, map: (x: T) => unknown) {
    const size = Math.min(Number(params.maxResults ?? 5), cap), start = Number(params.pageToken ?? 0);
    const slice = all.slice(start, start + size), next = start + size < all.length ? String(start + size) : undefined;
    return {items: slice.map(map), ...(next ? {nextPageToken: next} : {}), pageInfo: {totalResults: all.length, resultsPerPage: size}};
  }
  private video(n: number) {
    const seconds = n % 3 === 0 ? 45 + n : 300 + n * 7;   // every third video is short
    return {id: vid(n), snippet: {publishedAt: this.published(n), channelId: videoChannel(n), channelTitle: chanTitle(videoChannel(n)),
        title: `[اصطناعي] ${titles[n % titles.length]} #${n}`, description: 'وصف اصطناعي لاختبار الرصد — ليس محتوى حقيقيًا', liveBroadcastContent: 'none'},
      contentDetails: {duration: `PT${Math.floor(seconds / 60)}M${seconds % 60}S`},
      statistics: {viewCount: String(1000 + n * 37), likeCount: String(10 + n), commentCount: String(120)}, status: {privacyStatus: 'public'}};
  }
  private replyTotal(threadId: string) { const i = Number(threadId.split('.c')[1] ?? 0); return i % 10 === 0 ? 7 : i % 4 === 0 ? 2 : 0; }
  private comment(id: string, parent: string | null, k: number) {
    return {id, snippet: {authorDisplayName: `[اصطناعي] مستخدم ${k}`, authorChannelId: {value: `UCmockAuthor${String(k).padStart(12, '0')}`},
      textDisplay: parent ? 'رد اصطناعي للاختبار' : 'تعليق اصطناعي: متى يتم استرداد التأمين؟', likeCount: k, ...(parent ? {parentId: parent} : {}),
      publishedAt: new Date(BASE + 86_400_000 - k * 60_000).toISOString(), updatedAt: new Date(BASE + 86_400_000 - k * 60_000).toISOString()}};
  }
  private thread(videoId: string, n: number, i: number) {
    const id = `${videoId}.c${i}`, total = this.replyTotal(id);
    const top = {...this.comment(id, null, i + 1)};
    top.snippet.publishedAt = new Date(BASE + n * 3_600_000 + (120 - i) * 60_000).toISOString();   // newest first
    return {id, snippet: {videoId, topLevelComment: top, totalReplyCount: total, isPublic: true},
      ...(total ? {replies: {comments: Array.from({length: Math.min(total, 5)}, (_, r) => this.comment(`${id}.r${r}`, id, r + 1))}} : {})};
  }
}
