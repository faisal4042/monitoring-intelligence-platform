/**
 * Influencer profile pictures for the card, served from the API so the card's
 * canvas stays exportable (same origin) and no handle ever reaches a
 * third-party avatar service.
 *
 * Only the profile_image_url X already gave us (stored on the author row) is
 * fetched, and only from X's image CDN: https, host pbs.twimg.com, default
 * port, no credentials. The connection's resolved address must be public (an
 * internal answer is refused at connect time, so DNS cannot redirect it), no
 * redirect is followed, and the body must be a JPEG/PNG/WebP image within the
 * size cap. This is the image CDN, not the X API: no quota or cost is involved.
 *
 * Read-only for the database; results are cached in memory only.
 */
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

export const AVATAR_HOST = 'pbs.twimg.com';
export const AVATAR_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60 * 60_000;
const FAIL_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;

export type AvatarImage = { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; body: Buffer };

/**
 * The stored URL, upgraded to X's 400×400 rendition, if it is allowed; otherwise null.
 * Only the size suffix of the file name changes, never the host or path prefix.
 */
export function avatarSourceUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  let u: URL;
  try { u = new URL(stored); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== AVATAR_HOST || u.port !== '' || u.username || u.password) return null;
  if (!u.pathname.startsWith('/profile_images/')) return null;
  u.hash = '';
  u.pathname = u.pathname.replace(/_(normal|bigger|mini)(\.[a-z]+)$/i, '_400x400$2');
  return u.toString();
}

/** True only for globally routable unicast addresses (no loopback, private, link-local, CGNAT, multicast, reserved…). */
export function isPublicAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (kind === 6) {
    const v = address.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (v === '::' || v === '::1') return false;
    // Global unicast is 2000::/3; everything else (ULA fc00::/7, link-local fe80::/10, multicast ff00::/8…) is refused.
    return /^[23][0-9a-f]{0,3}:/.test(v) && !v.startsWith('2001:db8:') && !v.startsWith('2002:');
  }
  return false;
}

/** DNS lookup that fails unless every answer is public; used as the socket's lookup, so the checked address is the one dialled. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || !list.every((a) => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('Refused non-public address'), { code: 'EADDRNOTPUBLIC' }), '', 0);
    }
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/** The image type from its first bytes; the server's Content-Type header is never trusted. */
export function sniffImage(body: Buffer): AvatarImage['contentType'] | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.length >= 12 && body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export type Fetcher = (url: string) => Promise<Buffer | null>;

/** One GET with the public-only lookup, no redirects, a timeout and a byte cap; null on any failure. */
export const fetchImage: Fetcher = (url) => new Promise((resolve) => {
  const req = https.get(url, {
    lookup: publicOnlyLookup, timeout: TIMEOUT_MS,
    headers: { accept: 'image/jpeg,image/png,image/webp', 'user-agent': 'MIP-avatar/1' },
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return resolve(null); }
    const declared = Number(res.headers['content-length'] ?? 0);
    if (declared > AVATAR_MAX_BYTES) { res.destroy(); return resolve(null); }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > AVATAR_MAX_BYTES) { res.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve(size <= AVATAR_MAX_BYTES ? Buffer.concat(chunks) : null));
    res.on('error', () => resolve(null));
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(null));
});

const cache = new Map<string, { at: number; image: AvatarImage | null }>();
export const clearAvatarCache = () => cache.clear();

/** The validated image for a stored profile URL, or null (not allowed, unreachable, too large or not an image). */
export async function loadAvatar(stored: string | null | undefined, fetcher: Fetcher = fetchImage): Promise<AvatarImage | null> {
  const url = avatarSourceUrl(stored);
  if (!url) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < (hit.image ? CACHE_TTL_MS : FAIL_TTL_MS)) return hit.image;
  const body = await fetcher(url);
  const contentType = body && body.length <= AVATAR_MAX_BYTES ? sniffImage(body) : null;
  const image = body && contentType ? { contentType, body } : null;
  cache.set(url, { at: Date.now(), image });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return image;
}
