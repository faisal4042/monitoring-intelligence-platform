/**
 * Validates and safely fetches an admin-supplied URL before News Monitoring
 * ever touches it — starting with Test Connection (Phase 1), which fetches
 * whatever URL an admin types in. That is a real SSRF surface from day one,
 * not something to harden "later": a literal-string host check alone is not
 * enough (DNS rebinding swaps the answer between the check and the request),
 * so every candidate IP a hostname resolves to is checked, and the same
 * check runs again on every redirect hop before it is followed.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { config } from '@mip/config';
import { badRequest } from '../../../lib/errors.js';

const MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPES = ['text/', 'application/xml', 'application/rss+xml', 'application/atom+xml', 'application/json'];

// On Windows, Node's bundled CA set can reject otherwise valid publisher
// certificate chains that Windows itself trusts. Merge (never replace) the
// OS trust store before any news fetch. This keeps TLS verification enabled
// and avoids the unsafe NODE_TLS_REJECT_UNAUTHORIZED workaround.
if (process.platform === 'win32') {
  const certificates = [...new Set([...getCACertificates('default'), ...getCACertificates('system')])];
  setDefaultCACertificates(certificates);
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) || // link-local, includes 169.254.169.254 cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === '::1') return true;
  if (norm.startsWith('fe80:') || norm.startsWith('fc') || norm.startsWith('fd')) return true; // link-local + unique-local
  const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const literal = isIP(hostname);
  if (literal === 4) {
    if (isPrivateIPv4(hostname)) throw badRequest('لا يمكن الوصول إلى عناوين شبكة داخلية أو خاصة', 'SSRF_BLOCKED');
    return;
  }
  if (literal === 6) {
    if (isPrivateIPv6(hostname)) throw badRequest('لا يمكن الوصول إلى عناوين شبكة داخلية أو خاصة', 'SSRF_BLOCKED');
    return;
  }
  if (hostname === 'localhost') throw badRequest('لا يمكن الوصول إلى localhost', 'SSRF_BLOCKED');

  // dns.lookup() goes through the OS resolver (getaddrinfo) — the same path
  // fetch() itself uses to actually connect. dns.resolve4/6 (c-ares) query
  // nameservers directly over raw UDP instead, which is unreliable on
  // Windows and in plenty of real networks (VPNs, DNS-over-HTTPS, corporate
  // resolvers) even when normal resolution works fine — confirmed on this
  // exact machine: resolve4() returned ECONNREFUSED for a domain dns.lookup()
  // resolved correctly. Any private-IP result here is still what fetch()
  // will actually connect to, so the SSRF check stays meaningful.
  const addresses = await lookup(hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) throw badRequest('تعذّر تحليل اسم النطاق (DNS)', 'DNS_RESOLUTION_FAILED');
  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) throw badRequest('الرابط يشير إلى شبكة داخلية أو خاصة', 'SSRF_BLOCKED');
    if (family === 6 && isPrivateIPv6(address)) throw badRequest('الرابط يشير إلى شبكة داخلية أو خاصة', 'SSRF_BLOCKED');
  }
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  headers: Headers;
  body: string;
  responseMs: number;
  finalUrl: string;
  contentTypeAllowed: boolean;
}

/**
 * Fetches a URL only after confirming it (and every redirect hop) resolves
 * to a public address, and enforces a byte cap while streaming so a source
 * cannot exhaust memory with an oversized or endless response.
 */
export async function safeFetch(inputUrl: string, extraHeaders?: Record<string, string>): Promise<SafeFetchResult> {
  // AbortSignal.timeout() on the fetch call is not enough by itself: a
  // connection attempt a firewall silently drops (rather than actively
  // refuses) can sit in a TCP SYN-retry loop that some undici versions don't
  // reliably unwind from on abort. This hard wall-clock race guarantees
  // Test Connection always returns within budget regardless of what the
  // network layer does underneath it — one bad/unreachable source must never
  // hold a request open indefinitely.
  return Promise.race([
    safeFetchInner(inputUrl, extraHeaders),
    new Promise<SafeFetchResult>((_, reject) =>
      setTimeout(() => reject(badRequest('انتهت مهلة الاتصال بالمصدر', 'FETCH_TIMEOUT')), config.NEWS_FETCH_TIMEOUT_MS + 2000)),
  ]);
}

async function safeFetchInner(inputUrl: string, extraHeaders?: Record<string, string>): Promise<SafeFetchResult> {
  let current = inputUrl;
  const start = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw badRequest('يُسمح فقط بروابط http/https', 'INVALID_PROTOCOL');
    }
    await assertPublicHost(parsed.hostname);

    const res = await fetch(parsed, {
      redirect: 'manual',
      signal: AbortSignal.timeout(config.NEWS_FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'MIP-NewsMonitor/1.0 (+internal source discovery)', ...extraHeaders },
    });

    // 304 Not Modified carries no body and isn't a redirect — the caller
    // (an incremental RSS fetch that sent If-None-Match/If-Modified-Since)
    // decides what "unchanged" means, this layer just hands it back as-is.
    if (res.status === 304) {
      return { ok: true, status: 304, headers: res.headers, body: '', responseMs: Date.now() - start, finalUrl: parsed.toString(), contentTypeAllowed: true };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw badRequest('استجابة إعادة توجيه بلا رابط', 'BAD_REDIRECT');
      current = new URL(location, parsed).toString();
      continue;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > config.NEWS_MAX_RESPONSE_BYTES) {
      throw badRequest('حجم الاستجابة يتجاوز الحد المسموح', 'RESPONSE_TOO_LARGE');
    }

    // Body still needs a hard cap even without a trustworthy Content-Length.
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > config.NEWS_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw badRequest('حجم الاستجابة يتجاوز الحد المسموح', 'RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString('utf8');

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      body,
      responseMs: Date.now() - start,
      finalUrl: parsed.toString(),
      contentTypeAllowed: ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t)),
    };
  }

  throw badRequest('عدد كبير جداً من عمليات إعادة التوجيه', 'TOO_MANY_REDIRECTS');
}
