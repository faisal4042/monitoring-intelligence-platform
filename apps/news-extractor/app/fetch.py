"""Page fetching with Scrapling.

Static (default): Scrapling ``FetcherSession`` over curl_cffi, one session per
worker thread for connection reuse. Browser impersonation and generated
"stealth" headers are switched off: we send our own User-Agent and no
referer. Redirects are followed manually, one hop at a time, so every hop is
re-checked by the SSRF guard and the connection is pinned to the vetted
address (curl RESOLVE). Body size is capped by curl (MAXFILESIZE) and again
after the transfer.

Dynamic (opt-in): Scrapling ``DynamicSession`` (Playwright Chromium), reused
across requests, one page at a time, resources blocked, every request the
page makes routed through the same SSRF guard. Never the stealth browser.
"""
from __future__ import annotations

import queue
import random
import re
import threading
import time
from concurrent.futures import Future, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlsplit

from curl_cffi.const import CurlOpt
from curl_cffi.curl import CurlError
from scrapling.fetchers import FetcherSession

from .config import Settings
from .netguard import BlockedURL, Guard

HTML_TYPES = ("text/html", "application/xhtml+xml")
_CHARSET_HEADER = re.compile(r"charset=\s*[\"']?([\w-]+)", re.I)
_CHARSET_META = re.compile(rb"<meta[^>]+charset=[\"']?\s*([\w-]+)", re.I)


class FetchError(Exception):
    """A fetch that ended without usable HTML. ``kind`` is stable for metrics;
    ``retryable`` tells the caller whether a later attempt could succeed."""

    def __init__(self, kind: str, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.retryable = retryable


@dataclass
class Page:
    url: str               # final URL after redirects
    status: int
    body: bytes
    encoding: str
    headers: dict[str, str]
    method: str            # "static" | "dynamic"
    fetch_ms: int
    attempts: int
    redirects: list[str] = field(default_factory=list)


def detect_encoding(headers: dict[str, str], body: bytes) -> str:
    m = _CHARSET_HEADER.search(headers.get("content-type", ""))
    if m:
        return m.group(1).lower()
    m = _CHARSET_META.search(body[:4096])
    if m:
        return m.group(1).decode("ascii", "ignore").lower() or "utf-8"
    return "utf-8"


def _retry_after(headers: dict[str, str], cap: int) -> float | None:
    raw = headers.get("retry-after", "").strip()
    return float(min(int(raw), cap)) if raw.isdigit() else None


class StaticFetcher:
    def __init__(self, settings: Settings, guard: Guard, sleep=time.sleep):
        self.s = settings
        self.guard = guard
        self._sleep = sleep
        self._local = threading.local()

    def _session(self):
        """This thread's Scrapling session client (kept open for connection reuse)."""
        client = getattr(self._local, "client", None)
        if client is None:
            sess = FetcherSession(
                impersonate=None, stealthy_headers=False, follow_redirects=False,
                retries=1, timeout=self.s.timeout_s, verify=True,
                headers={"User-Agent": self.s.user_agent, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
                         "Accept-Language": "ar,en;q=0.8"},
            )
            client = sess.__enter__()
            self._local.session, self._local.client = sess, client
        return client

    def _once(self, url: str) -> tuple[int, dict[str, str], bytes, str]:
        target = self.guard.check_url(url)
        sess = self._session()
        # Pinned to the vetted addresses for this request only; http(s) only; size-capped.
        sess._curl_session.curl_options = {  # noqa: SLF001 — Scrapling 0.4.15 exposes no per-request curl options
            CurlOpt.RESOLVE: target.curl_resolve(),
            CurlOpt.PROTOCOLS_STR: "http,https",
            CurlOpt.REDIR_PROTOCOLS_STR: "http,https",
            CurlOpt.MAXFILESIZE_LARGE: self.s.max_bytes,
        }
        try:
            resp = sess.get(url)
        except CurlError as e:
            text = str(e)
            if "63" in text.split(":")[0] or "Maximum file size exceeded" in text:
                raise FetchError("too_large", "response exceeds size limit") from e
            if "(60)" in text or "(35)" in text or "SSL" in text or "certificate" in text.lower():
                # Certificate or TLS failure: reported as such; verification is never disabled.
                raise FetchError("tls", f"TLS/certificate error: {text[:160]}") from e
            if "timed out" in text.lower() or "(28)" in text:
                raise FetchError("timeout", "request timed out", retryable=True) from e
            raise FetchError("network", f"network error: {text[:200]}", retryable=True) from e
        headers = {str(k).lower(): str(v) for k, v in (resp.headers or {}).items()}
        body = resp.body if isinstance(resp.body, bytes) else str(resp.body).encode("utf-8")
        if len(body) > self.s.max_bytes:
            raise FetchError("too_large", "response exceeds size limit")
        return resp.status, headers, body, str(resp.url or url)

    def fetch(self, url: str) -> Page:
        start = time.monotonic()
        attempts = 0
        last: FetchError | None = None
        for attempt in range(self.s.retries + 1):
            attempts += 1
            try:
                return self._follow(url, start, attempts)
            except FetchError as e:
                last = e
                if not e.retryable or attempt == self.s.retries:
                    break
                # Exponential backoff with full jitter; honour Retry-After within a cap.
                delay = getattr(e, "retry_after", None) or random.uniform(0, self.s.backoff_base_s * (2 ** attempt))
                self._sleep(delay)
        assert last is not None
        raise last

    def _follow(self, url: str, start: float, attempts: int, any_text: bool = False) -> Page:
        current, chain = url, []
        for _ in range(self.s.max_redirects + 1):
            try:
                status, headers, body, final = self._once(current)
            except BlockedURL as e:
                raise FetchError("blocked_url", f"{e.code}: {e}") from e
            if status in (301, 302, 303, 307, 308):
                loc = headers.get("location")
                if not loc:
                    raise FetchError("bad_redirect", "redirect without location", status)
                nxt = urljoin(current, loc)
                if nxt in chain or nxt == current:
                    raise FetchError("redirect_loop", "redirect loop", status)
                chain.append(current)
                current = nxt
                continue
            if status == 429:
                err = FetchError("rate_limited", "HTTP 429", status, retryable=True)
                err.retry_after = _retry_after(headers, self.s.max_retry_after_s)  # type: ignore[attr-defined]
                raise err
            if status >= 500:
                raise FetchError("server_error", f"HTTP {status}", status, retryable=True)
            if status in (401, 403, 451):
                # Access refused by the site: respected, never worked around.
                raise FetchError("forbidden", f"HTTP {status}", status)
            if status in (404, 410):
                raise FetchError("not_found", f"HTTP {status}", status)
            if status >= 400:
                raise FetchError("http_error", f"HTTP {status}", status)
            ctype = headers.get("content-type", "").lower()
            allowed = HTML_TYPES + (("text/",) if any_text else ())
            if ctype and not any(t in ctype for t in allowed):
                raise FetchError("unsupported_content", f"content-type {ctype.split(';')[0]}", status)
            return Page(final, status, body, detect_encoding(headers, body), headers, "static",
                        int((time.monotonic() - start) * 1000), attempts, chain)
        raise FetchError("too_many_redirects", "too many redirects")

    def fetch_text(self, url: str) -> tuple[int, str]:
        """Small helper for robots.txt: status and decoded body, no retries beyond one hop chain."""
        try:
            page = self._follow(url, time.monotonic(), 1, any_text=True)  # robots.txt is text/plain
            return page.status, page.body.decode(page.encoding, "replace")
        except FetchError as e:
            if e.status is None:
                raise
            return e.status, ""


class DynamicFetcher:
    """Browser rendering for sources that genuinely need JavaScript.

    Playwright's sync API is bound to the thread that started it, so one
    dedicated thread owns the browser session; requests are queued to it and
    rendered one page at a time. The session is created on first use and
    reused, so we never launch a browser per article."""

    def __init__(self, settings: Settings, guard: Guard, extra_flags: tuple[str, ...] = ()):
        self.s = settings
        self.guard = guard
        self._extra_flags = list(extra_flags)  # tests only (host mapping for the fixture server)
        self._jobs: "queue.Queue[tuple[str, Future] | None]" = queue.Queue(maxsize=8)
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self.renders = 0

    def _ensure_thread(self) -> None:
        with self._start_lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="browser", daemon=True)
                self._thread.start()

    def _run(self) -> None:
        from scrapling.fetchers import DynamicSession  # heavy import, only when used
        session = None
        try:
            while True:
                job = self._jobs.get()
                if job is None:
                    return
                url, fut = job
                if fut.cancelled():
                    continue
                try:
                    if session is None:
                        session = DynamicSession(
                            headless=True, disable_resources=True, block_ads=True, google_search=False,
                            useragent=self.s.user_agent, timeout=self.s.dynamic_timeout_ms, network_idle=False,
                            retries=1, locale="ar-SA", real_chrome=False,
                            extra_flags=["--disable-dev-shm-usage", "--no-first-run", "--disable-extensions",
                                         "--disable-background-networking", "--disable-sync", "--deny-permission-prompts", *self._extra_flags],
                        )
                        session.__enter__()
                    fut.set_result(session.fetch(url, page_setup=self._guard_route, timeout=self.s.dynamic_timeout_ms))
                except BaseException as e:  # Playwright raises its own error types
                    if not fut.done():
                        fut.set_exception(e)
        finally:
            if session is not None:
                try:
                    session.__exit__(None, None, None)
                except Exception:
                    pass

    def _guard_route(self, page) -> None:
        cache: dict[str, bool] = {}

        def handler(route):
            url = route.request.url
            host = urlsplit(url).hostname or ""
            ok = cache.get(host)
            if ok is None:
                try:
                    self.guard.check_url(url)
                    ok = True
                except BlockedURL:
                    ok = False
                cache[host] = ok
            if ok:
                route.fallback()
            else:
                route.abort("blockedbyclient")

        page.route("**/*", handler)

    def fetch(self, url: str) -> Page:
        try:
            self.guard.check_url(url)
        except BlockedURL as e:
            raise FetchError("blocked_url", f"{e.code}: {e}") from e
        self._ensure_thread()
        start = time.monotonic()
        fut: Future = Future()
        try:
            self._jobs.put((url, fut), timeout=5)
        except queue.Full as e:
            raise FetchError("browser_busy", "browser queue full", retryable=True) from e
        try:
            resp = fut.result(timeout=self.s.dynamic_timeout_ms / 1000 + 15)
            self.renders += 1
        except FutureTimeout as e:
            fut.cancel()
            raise FetchError("timeout", "render timed out", retryable=True) from e
        except Exception as e:
            raise FetchError("browser_error", f"render failed: {str(e)[:200]}", retryable=True) from e
        status = int(getattr(resp, "status", 0) or 0)
        if status in (401, 403, 451):
            raise FetchError("forbidden", f"HTTP {status}", status)
        if status >= 400:
            raise FetchError("http_error", f"HTTP {status}", status, retryable=status >= 500)
        body = resp.body if isinstance(resp.body, bytes) else str(resp.body).encode("utf-8")
        if len(body) > self.s.max_bytes:
            raise FetchError("too_large", "rendered page exceeds size limit")
        try:
            self.guard.check_url(str(resp.url))  # final URL after any client-side navigation
        except BlockedURL as e:
            raise FetchError("blocked_url", f"{e.code}: {e}") from e
        return Page(str(resp.url), status, body, "utf-8", {}, "dynamic", int((time.monotonic() - start) * 1000), 1)

    def close(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            self._jobs.put(None)
            self._thread.join(timeout=15)
