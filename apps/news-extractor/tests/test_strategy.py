"""Fetch strategy end to end against the local server: RSS full text without a
fetch, static path, robots.txt, controlled fallback, and browser use only
when it is needed and allowed."""
from dataclasses import replace

from app.fetch import FetchError, Page, StaticFetcher
from app.limits import Limiter
from app.robots import RobotsCache
from app.strategy import ExtractRequest, Extractor

from conftest import HTML, fixture_html

FULL_RSS = "".join(f"<p>الفقرة رقم {i} من نص الخبر الكامل كما ورد في الخلاصة مع تفاصيل كافية عن الموضوع.</p>" for i in range(12))


def make(settings, guard, dynamic=None):
    static = StaticFetcher(settings, guard, sleep=lambda s: None)
    return Extractor(settings, static, dynamic, Limiter(4, 1, 0), RobotsCache(static.fetch_text, settings.user_agent, 60)), static


class FakeDynamic:
    def __init__(self, body: bytes):
        self.body, self.calls = body, 0

    def fetch(self, url):
        self.calls += 1
        return Page(url, 200, self.body, "utf-8", {}, "dynamic", 5, 1)


def test_rss_full_text_is_used_without_fetching(server, guard, settings):
    ex, _ = make(settings, guard)
    r = ex.run(ExtractRequest(url=f"{server.base}/never", language="ar", rss_title="عنوان", rss_content_html=FULL_RSS,
                              rss_published_at="Sun, 05 Oct 2026 09:30:00 +0300"))
    assert (r.status, r.method) == ("complete", "rss")
    assert r.published_at == "2026-10-05T09:30:00+03:00"
    assert "/never" not in server.hits and "/robots.txt" not in server.hits


def test_truncated_rss_falls_through_to_static(server, guard, settings):
    server.add("/robots.txt", (404, {}, b"", 0))
    server.add("/a", (200, HTML, fixture_html("arabic_article.html"), 0))
    ex, _ = make(settings, guard)
    r = ex.run(ExtractRequest(url=f"{server.base}/a", language="ar", rss_content_html=FULL_RSS + "<p>…</p>"))
    assert r.method == "static" and r.status in ("complete", "partial")
    assert r.title == "الهيئة العامة للعقار تطلق خدمة جديدة لتوثيق العقود"
    assert r.published_at == "2026-10-05T09:30:00+03:00" and r.authors == ["سارة العتيبي"]
    assert r.content_hash and r.simhash is not None and r.char_count > 200


def test_robots_disallow_is_respected(server, guard, settings):
    server.add("/robots.txt", (200, {"Content-Type": "text/plain"}, b"User-agent: *\nDisallow: /private/\n", 0))
    server.add("/private/a", (200, HTML, b"<p>secret</p>", 0))
    ex, _ = make(settings, guard)
    r = ex.run(ExtractRequest(url=f"{server.base}/private/a"))
    assert (r.status, r.reason) == ("skipped", "robots_disallowed") and "/private/a" not in server.hits


def test_failure_is_reported_not_saved_as_article(server, guard, settings):
    server.add("/robots.txt", (404, {}, b"", 0))
    server.add("/gone", (404, HTML, b"", 0))
    server.add("/blank", (200, HTML, b"<html><body><div id='root'></div></body></html>", 0))
    ex, _ = make(settings, guard)
    gone = ex.run(ExtractRequest(url=f"{server.base}/gone", rss_summary="ملخص الخبر من الخلاصة يكفي لعرضه في القائمة"))
    assert (gone.status, gone.error_kind, gone.retryable) == ("failed", "not_found", False)
    assert gone.content is None and gone.metadata.get("fallback") == "rss_summary_kept"
    blank = ex.run(ExtractRequest(url=f"{server.base}/blank"))
    assert blank.status == "empty" and blank.content is None


def test_browser_only_when_needed_and_allowed(server, guard, settings):
    server.add("/robots.txt", (404, {}, b"", 0))
    app_shell = b"<html><body><div id='__next'></div>" + b"<script></script>" * 20 + b"</body></html>"
    server.add("/spa", (200, HTML, app_shell, 0))
    server.add("/a", (200, HTML, fixture_html("arabic_article.html"), 0))
    dyn = FakeDynamic(fixture_html("arabic_article.html"))
    on = replace(settings, dynamic_enabled=True)

    ex, _ = make(on, guard, dyn)
    assert ex.run(ExtractRequest(url=f"{server.base}/a", allow_dynamic=True)).method == "static"
    assert dyn.calls == 0                                     # static was enough

    r = ex.run(ExtractRequest(url=f"{server.base}/spa", allow_dynamic=True))
    assert (r.method, dyn.calls) == ("dynamic", 1) and r.status in ("complete", "partial")

    ex_off, _ = make(settings, guard, dyn)                    # global flag off
    assert ex_off.run(ExtractRequest(url=f"{server.base}/spa", allow_dynamic=True)).method == "static"
    ex_src, _ = make(on, guard, dyn)                          # source not allowed
    assert ex_src.run(ExtractRequest(url=f"{server.base}/spa", allow_dynamic=False)).method == "static"
    assert dyn.calls == 1


def test_static_network_failure_is_retryable_result(server, guard, settings):
    server.add("/robots.txt", (404, {}, b"", 0))
    server.add("/down", (503, HTML, b"", 0))
    ex, _ = make(settings, guard)
    r = ex.run(ExtractRequest(url=f"{server.base}/down"))
    assert (r.status, r.error_kind, r.retryable, r.http_status) == ("failed", "server_error", True, 503)


def test_fetch_error_kinds_are_stable():
    assert FetchError("timeout", "x", retryable=True).retryable


def test_unreachable_robots_is_not_reported_as_disallowed(server, guard, settings):
    server.add("/robots.txt", (503, {}, b"", 0))
    server.add("/a", (200, HTML, fixture_html("arabic_article.html"), 0))
    ex, _ = make(settings, guard)
    r = ex.run(ExtractRequest(url=f"{server.base}/a"))
    assert (r.status, r.error_kind, r.retryable) == ("failed", "robots_unreachable", True)
    assert r.reason == "robots_unreachable:http_503" and "/a" not in server.hits
