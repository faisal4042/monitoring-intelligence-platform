"""Real browser rendering (Playwright Chromium via Scrapling DynamicSession).
Skipped when Chromium is not installed. The page builds its text with
JavaScript and tries to reach a private address; the render must contain the
article and the private request must be blocked by the route guard."""
from dataclasses import replace

import pytest

from app.fetch import DynamicFetcher, FetchError
from app.extract.content import extract_body, parse_tree

from conftest import HOST, HTML

JS_PAGE = """<!DOCTYPE html><html lang="ar"><head><meta charset="utf-8"><title>خبر</title></head>
<body><div id="root"></div>
<script>
  fetch('http://127.0.0.1:9/steal').catch(function(){ window.__blocked = true; });
  var paras = ['أعلنت الهيئة العامة للعقار عن خدمة جديدة لتوثيق عقود الإيجار خلال 15 دقيقة.',
               'وأوضحت الهيئة أن الخدمة تغطي 13 منطقة وأكثر من 1,200 مكتب وساطة عقارية في المملكة.',
               'وأضافت أن المرحلة الثانية ستشمل العقود التجارية اعتباراً من الربع الأول من العام المقبل.'];
  var art = document.createElement('article');
  paras.forEach(function(t){ var p = document.createElement('p'); p.textContent = t; art.appendChild(p); });
  document.getElementById('root').appendChild(art);
</script></body></html>""".encode("utf-8")


def _chromium_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.launch(headless=True).close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _chromium_available(), reason="Playwright Chromium not installed")


def test_dynamic_render_extracts_js_article_and_blocks_private_requests(server, guard, settings):
    server.add("/spa", (200, HTML, JS_PAGE, 0))
    dyn = DynamicFetcher(replace(settings, dynamic_enabled=True, dynamic_timeout_ms=20_000), guard,
                         extra_flags=(f"--host-resolver-rules=MAP {HOST} 127.0.0.1",))
    try:
        page = dyn.fetch(f"{server.base}/spa")
        assert page.method == "dynamic" and dyn.renders == 1
        text = "\n".join(extract_body(parse_tree(page.body, "utf-8"), None, None).paragraphs)
        assert "15 دقيقة" in text and "1,200" in text
        assert "/steal" not in server.hits  # never reached anything but the fixture host
        # The same browser session is reused for the next render.
        page2 = dyn.fetch(f"{server.base}/spa")
        assert page2.status == 200 and dyn.renders == 2
    finally:
        dyn.close()


def test_dynamic_rejects_blocked_url_before_launching(guard, settings):
    dyn = DynamicFetcher(replace(settings, dynamic_enabled=True), guard)
    with pytest.raises(FetchError) as e:
        dyn.fetch("http://169.254.169.254/")
    assert e.value.kind == "blocked_url" and dyn._thread is None  # noqa: SLF001
