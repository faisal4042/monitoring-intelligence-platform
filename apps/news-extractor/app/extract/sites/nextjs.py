"""Next.js App Router pages stream their React tree as ``self.__next_f.push``
payloads. Some publishers render the article body only there (as
``dangerouslySetInnerHTML``), so the text is present in the static HTML but
not as markup. Reading it is a parse of data the page already sent — no
JavaScript is executed and no browser is needed."""
from __future__ import annotations

import json
import re

from lxml import html as lxml_html

from . import SiteRule, register

_PUSH = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')
_HTML = re.compile(r'"__html":("(?:[^"\\]|\\.)*")')


def flight_payload(page_html: str) -> str:
    parts = []
    for m in _PUSH.finditer(page_html):
        try:
            parts.append(json.loads(m.group(1)))
        except ValueError:
            continue
    return "".join(parts)


def flight_body(page_html: str, body_class: str) -> list[str]:
    data = flight_payload(page_html)
    start = data.find(f'"className":"{body_class}"')
    if start < 0:
        return []
    end = data.find("\n", start)  # one RSC row holds the body element and its children
    segment = data[start:end if end > 0 else len(data)]
    paras: list[str] = []
    for m in _HTML.finditer(segment):
        try:
            fragment = json.loads(m.group(1))
            root = lxml_html.fragment_fromstring(fragment, create_parent="div")
        except Exception:
            continue
        blocks = [el.text_content() for el in root.iter("p", "h2", "h3", "li", "blockquote")] or [root.text_content()]
        paras.extend(b for b in blocks if b and b.strip())
    return paras


def flight_largest_row(page_html: str) -> list[str]:
    """Generic fallback for any Next.js page: the RSC row whose embedded HTML
    carries the most text. One row is one rendered element subtree, so this
    takes the article body without pulling in sibling widgets."""
    data = flight_payload(page_html)
    best: list[str] = []
    for row in data.split(chr(10)):  # RSC rows are newline-separated
        if '"__html"' not in row:
            continue
        paras: list[str] = []
        for m in _HTML.finditer(row):
            try:
                fragment = json.loads(m.group(1))
            except ValueError:
                continue
            # Inline scripts/config injected the same way are not article text.
            if fragment.lstrip()[:1] in ("{", "[") or "function(" in fragment or "window." in fragment:
                continue
            try:
                root = lxml_html.fragment_fromstring(fragment, create_parent="div")
            except Exception:
                continue
            blocks = [el.text_content() for el in root.iter("p", "h2", "h3", "li", "blockquote")] or [root.text_content()]
            paras.extend(b for b in blocks if b and b.strip())
        if sum(map(len, paras)) > sum(map(len, best)):
            best = paras
    return best


register(SiteRule(
    domains=("ajel.sa",),
    body=(".aj-article-body",),
    custom=lambda page: flight_body(page, "aj-article-body"),
    notes="Next.js: body is in the RSC payload, not in server-rendered markup (measured 2026-10-10).",
))
