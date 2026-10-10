"""The real Scrapling static fetcher against a local server: statuses,
retries and backoff, Retry-After, timeouts, redirects (loops and hops to
blocked hosts), size and content-type limits, DNS pinning, headers sent."""
import time

import pytest

from app.fetch import FetchError, StaticFetcher

from conftest import HTML, fixture_html


def test_static_fetch_ok_and_honest_headers(server, guard, settings):
    server.add("/a", (200, HTML, fixture_html("arabic_article.html"), 0))
    page = StaticFetcher(settings, guard).fetch(f"{server.base}/a")
    assert page.status == 200 and page.method == "static" and page.encoding == "utf-8"
    assert "الهيئة العامة للعقار".encode() in page.body
    sent = server.headers_seen[-1]
    assert sent["user-agent"].startswith("MIP-NewsMonitor/")
    assert "referer" not in sent                      # no fake Google referer
    assert "sec-ch-ua" not in sent                     # no generated browser fingerprint headers


def test_dns_pinning_is_what_makes_the_request_reach_the_server(server, guard, settings):
    # fixture.test is not resolvable by the OS; success proves curl used the pinned address.
    server.add("/pin", (200, HTML, b"<html><body><p>ok</p></body></html>", 0))
    assert StaticFetcher(settings, guard).fetch(f"{server.base}/pin").status == 200


@pytest.mark.parametrize("status,kind,retryable", [(403, "forbidden", False), (401, "forbidden", False),
                                                   (404, "not_found", False), (410, "not_found", False)])
def test_client_errors_are_not_retried(server, guard, settings, status, kind, retryable):
    server.add("/e", (status, HTML, b"no", 0))
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard).fetch(f"{server.base}/e")
    assert (e.value.kind, e.value.status, e.value.retryable) == (kind, status, retryable)
    assert server.hits["/e"] == 1


def test_server_error_retries_with_backoff_then_succeeds(server, guard, settings):
    server.add("/flaky", (500, HTML, b"x", 0), (502, HTML, b"x", 0), (200, HTML, b"<p>ok</p>", 0))
    slept = []
    page = StaticFetcher(settings, guard, sleep=slept.append).fetch(f"{server.base}/flaky")
    assert page.status == 200 and page.attempts == 3 and server.hits["/flaky"] == 3
    assert len(slept) == 2 and all(0 <= s <= settings.backoff_base_s * 4 for s in slept)


def test_server_error_gives_up_after_retry_limit(server, guard, settings):
    server.add("/down", (500, HTML, b"x", 0))
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard, sleep=lambda s: None).fetch(f"{server.base}/down")
    assert e.value.kind == "server_error" and e.value.retryable and server.hits["/down"] == settings.retries + 1


def test_429_honours_retry_after_within_cap(server, guard, settings):
    server.add("/rl", (429, {**HTML, "Retry-After": "120"}, b"slow down", 0), (200, HTML, b"<p>ok</p>", 0))
    slept = []
    StaticFetcher(settings, guard, sleep=slept.append).fetch(f"{server.base}/rl")
    assert slept == [settings.max_retry_after_s]


def test_timeout_is_retryable(server, guard, settings):
    server.add("/slow", (200, HTML, b"<p>late</p>", settings.timeout_s + 1.5))
    t0 = time.monotonic()
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard, sleep=lambda s: None).fetch(f"{server.base}/slow")
    assert e.value.kind in ("timeout", "network") and e.value.retryable
    assert time.monotonic() - t0 < (settings.timeout_s + 2) * (settings.retries + 1)


def test_redirect_loop_and_redirect_to_blocked_host(server, guard, settings):
    server.add("/loop1", (302, {"Location": "/loop2"}, b"", 0))
    server.add("/loop2", (302, {"Location": "/loop1"}, b"", 0))
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard).fetch(f"{server.base}/loop1")
    assert e.value.kind == "redirect_loop"
    server.add("/evil", (302, {"Location": "http://169.254.169.254/latest/meta-data/"}, b"", 0))
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard).fetch(f"{server.base}/evil")
    assert e.value.kind == "blocked_url"
    server.add("/file", (302, {"Location": "file:///etc/passwd"}, b"", 0))
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard).fetch(f"{server.base}/file")
    assert e.value.kind == "blocked_url"


def test_redirect_followed_hop_by_hop(server, guard, settings):
    server.add("/old", (301, {"Location": "/new"}, b"", 0))
    server.add("/new", (200, HTML, b"<p>moved</p>", 0))
    page = StaticFetcher(settings, guard).fetch(f"{server.base}/old")
    assert page.url.endswith("/new") and page.redirects == [f"{server.base}/old"]


def test_size_and_content_type_limits(server, guard, settings):
    server.add("/big", (200, HTML, b"<p>" + b"a" * 300_000 + b"</p>", 0))
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard).fetch(f"{server.base}/big")
    assert e.value.kind == "too_large"
    server.add("/pdf", (200, {"Content-Type": "application/pdf"}, b"%PDF-1.4", 0))
    with pytest.raises(FetchError) as e:
        StaticFetcher(settings, guard).fetch(f"{server.base}/pdf")
    assert e.value.kind == "unsupported_content"


def test_charset_detection_from_meta(server, guard, settings):
    body = '<html><head><meta charset="windows-1256"></head><body><p>مرحبا</p></body></html>'.encode("windows-1256")
    server.add("/cp", (200, {"Content-Type": "text/html"}, body, 0))
    page = StaticFetcher(settings, guard).fetch(f"{server.base}/cp")
    assert page.encoding == "windows-1256" and "مرحبا" in page.body.decode(page.encoding)
