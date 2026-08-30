/**
 * The only place a real HTTP request to X is made.
 * Reached solely through XApiGateway, which has already checked the kill
 * switch and reserved budget.
 */
import { config } from '@mip/config';
import { xApiLogger as log } from '@mip/logger';
import type { SearchRequest, XPost, XUser, XMedia, FieldSelection } from './types.js';

const BASE = 'https://api.x.com/2';

interface RawTweet {
  id: string; text: string; created_at: string; author_id: string; lang?: string;
  conversation_id?: string;
  possibly_sensitive?: boolean;
  referenced_tweets?: Array<{ type: string; id: string }>;
  entities?: { hashtags?: Array<{ tag: string }>; mentions?: Array<{ username: string }>; urls?: Array<{ expanded_url: string }> };
  public_metrics?: { like_count: number; retweet_count: number; reply_count: number; quote_count: number; impression_count?: number };
  attachments?: { media_keys?: string[] };
}

interface RawMedia {
  media_key: string; type: string; url?: string; preview_image_url?: string;
  width?: number; height?: number;
}

interface RawUser {
  id: string; username: string; name: string; description?: string;
  profile_image_url?: string; verified?: boolean; created_at?: string;
  public_metrics?: { followers_count: number; following_count: number; tweet_count: number };
}

export class RealXClient {
  private headers() {
    return {
      Authorization: `Bearer ${config.X_BEARER_TOKEN}`,
      'User-Agent': 'MonitoringIntelligencePlatform/0.1',
    };
  }

  async searchRecent(req: SearchRequest, fields: FieldSelection) {
    const params = new URLSearchParams({
      query: req.query,
      max_results: String(Math.min(Math.max(req.maxResults, 10), 100)),
      'tweet.fields': fields.tweetFields.join(','),
      'user.fields': fields.userFields.join(','),
      expansions: fields.expansions.join(','),
    });
    // Only sent when configured — an empty media.fields param would ask X to
    // resolve attachments.media_keys with no fields, which is wasted payload.
    if (fields.mediaFields.length > 0) params.set('media.fields', fields.mediaFields.join(','));
    // since_id is the single largest cost saver: never re-fetch what we have.
    if (req.sinceId) params.set('since_id', req.sinceId);

    const url = `${BASE}/tweets/search/recent?${params}`;
    const res = await fetch(url, { headers: this.headers() });

    const rateLimitRemaining = Number(res.headers.get('x-rate-limit-remaining') ?? NaN);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error({ status: res.status, body: body.slice(0, 500) }, 'X API error');
      throw Object.assign(new Error(`X API ${res.status}`), {
        status: res.status,
        code: res.status === 429 ? 'RATE_LIMITED' : res.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR',
      });
    }

    const json = (await res.json()) as {
      data?: RawTweet[];
      includes?: { users?: RawUser[]; media?: RawMedia[] };
      meta?: { newest_id?: string; result_count?: number };
    };

    const usersById = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
    const mediaByKey = new Map((json.includes?.media ?? []).map((m) => [m.media_key, m]));

    const posts: XPost[] = (json.data ?? []).map((t) => {
      const ref = t.referenced_tweets?.[0];
      const u = usersById.get(t.author_id);
      const media: XMedia[] = (t.attachments?.media_keys ?? [])
        .map((key) => mediaByKey.get(key))
        .filter((m): m is RawMedia => m !== undefined)
        .map((m) => ({
          mediaKey: m.media_key, type: m.type, url: m.url,
          previewImageUrl: m.preview_image_url, width: m.width, height: m.height,
        }));
      return {
        id: t.id,
        text: t.text,
        createdAt: t.created_at,
        authorId: t.author_id,
        lang: t.lang,
        conversationId: t.conversation_id,
        referencedType: ref?.type as XPost['referencedType'],
        referencedId: ref?.id,
        possiblySensitive: t.possibly_sensitive ?? false,
        hashtags: t.entities?.hashtags?.map((h) => h.tag) ?? [],
        mentions: t.entities?.mentions?.map((m) => m.username) ?? [],
        urls: t.entities?.urls?.map((x) => x.expanded_url) ?? [],
        metrics: {
          like: t.public_metrics?.like_count ?? 0,
          repost: t.public_metrics?.retweet_count ?? 0,
          reply: t.public_metrics?.reply_count ?? 0,
          quote: t.public_metrics?.quote_count ?? 0,
          impression: t.public_metrics?.impression_count,
        },
        author: u ? this.mapUser(u) : undefined,
        media,
      };
    });

    return {
      posts,
      status: res.status,
      newestId: json.meta?.newest_id,
      rateLimitRemaining: Number.isNaN(rateLimitRemaining) ? undefined : rateLimitRemaining,
    };
  }

  async getUsers(ids: string[], fields: FieldSelection): Promise<XUser[]> {
    const out: XUser[] = [];
    // X accepts up to 100 ids per call — batch rather than one call per user.
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const params = new URLSearchParams({ ids: batch.join(','), 'user.fields': fields.userFields.join(',') });
      const res = await fetch(`${BASE}/users?${params}`, { headers: this.headers() });
      if (!res.ok) throw Object.assign(new Error(`X API ${res.status}`), { status: res.status });
      const json = (await res.json()) as { data?: RawUser[] };
      out.push(...(json.data ?? []).map((u) => this.mapUser(u)));
    }
    return out;
  }

  private mapUser(u: RawUser): XUser {
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      description: u.description,
      profileImageUrl: u.profile_image_url,
      followersCount: u.public_metrics?.followers_count ?? 0,
      followingCount: u.public_metrics?.following_count ?? 0,
      tweetCount: u.public_metrics?.tweet_count ?? 0,
      verified: u.verified,
      createdAt: u.created_at,
    };
  }
}
