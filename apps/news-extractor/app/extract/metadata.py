"""Structured metadata: JSON-LD (schema.org), Open Graph / article:* meta,
canonical link, language. Values are taken only when present and parseable;
nothing here falls back to the fetch time or invents an author."""
from __future__ import annotations

import html
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin

from scrapling.parser import Selector

ARTICLE_TYPES = {"newsarticle", "article", "reportagenewsarticle", "analysisnewsarticle", "blogposting",
                 "opinionnewsarticle", "backgroundnewsarticle", "webpage"}


def _first(*values: Any) -> Any:
    for v in values:
        if v not in (None, "", [], {}):
            return v
    return None


def _text(value: Any) -> Any:
    """Publishers often HTML-escape JSON-LD and meta values (&#039;, &amp;quot;)."""
    if isinstance(value, str):
        return html.unescape(html.unescape(value)).strip()
    return value


def parse_date(raw: Any, now: datetime | None = None) -> str | None:
    """ISO-8601 (with zone) from common publisher formats; None if absent,
    unparseable, or more than a day in the future (a wrong clock, not news)."""
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip().replace("Z", "+00:00")
    dt = None
    for candidate in (text, text.replace(" ", "T", 1)):
        try:
            dt = datetime.fromisoformat(candidate)
            break
        except ValueError:
            continue
    if dt is None:
        from email.utils import parsedate_to_datetime  # RFC 822 dates from some CMSs
        try:
            dt = parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None
    if dt.tzinfo is None:
        # A zone-less timestamp from a Saudi publisher is local time (UTC+3).
        dt = dt.replace(tzinfo=timezone(timedelta(hours=3)))
    now = now or datetime.now(timezone.utc)
    if dt > now + timedelta(days=1) or dt.year < 1995:
        return None
    return dt.isoformat()


def _jsonld_nodes(page: Selector) -> list[dict]:
    nodes: list[dict] = []
    for raw in page.css('script[type="application/ld+json"]::text').getall():
        try:
            data = json.loads(str(raw).strip())
        except (ValueError, TypeError):
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            item = stack.pop(0)
            if isinstance(item, list):
                stack.extend(item)
            elif isinstance(item, dict):
                if "@graph" in item:
                    stack.extend(item["@graph"] if isinstance(item["@graph"], list) else [item["@graph"]])
                nodes.append(item)
    return nodes


def _types(node: dict) -> set[str]:
    t = node.get("@type")
    return {str(x).lower() for x in (t if isinstance(t, list) else [t]) if x}


def _names(value: Any) -> list[str]:
    out: list[str] = []
    for v in value if isinstance(value, list) else [value]:
        if isinstance(v, dict):
            v = v.get("name")
        if isinstance(v, str) and v.strip() and len(v.strip()) < 120:
            out.append(v.strip())
    return out


def _image(value: Any) -> str | None:
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("url") or value.get("contentUrl")
    return value if isinstance(value, str) and value.startswith(("http://", "https://", "/")) else None


def _meta(page: Selector, *keys: str) -> str | None:
    for key in keys:
        for attr in ("property", "name", "itemprop"):
            val = page.css(f'meta[{attr}="{key}"]::attr(content)').get()
            if val and str(val).strip():
                return str(val).strip()
    return None


def extract_metadata(page: Selector, url: str) -> dict[str, Any]:
    nodes = _jsonld_nodes(page)
    article = next((n for n in nodes if _types(n) & (ARTICLE_TYPES - {"webpage"})), None)
    article = article or next((n for n in nodes if "webpage" in _types(n)), None) or {}
    canonical = page.css('link[rel="canonical"]::attr(href)').get()
    og_url = _meta(page, "og:url")
    lang = page.css("html::attr(lang)").get() or _meta(page, "og:locale", "language")

    keywords = article.get("keywords")
    tags = [t.strip() for t in (keywords if isinstance(keywords, list) else str(keywords or "").split(",")) if t and str(t).strip()]
    tags += [str(t) for t in page.css('meta[property="article:tag"]::attr(content)').getall()]
    section = _first(article.get("articleSection"), _meta(page, "article:section"))
    sections = section if isinstance(section, list) else [section] if section else []

    published_raw = _first(article.get("datePublished"), _meta(page, "article:published_time", "datePublished",
                           "pubdate", "publishdate", "date", "DC.date.issued"),
                           page.css("article time[datetime]::attr(datetime)").get(),
                           page.css("time[itemprop=datePublished]::attr(datetime)").get())
    modified_raw = _first(article.get("dateModified"), _meta(page, "article:modified_time", "og:updated_time", "dateModified"))
    authors = _names(article.get("author")) or ([a] if (a := _meta(page, "author", "article:author")) and not a.startswith("http") else [])
    publisher = _names(article.get("publisher"))

    return {
        "canonical_url": urljoin(url, str(canonical)) if canonical else (urljoin(url, og_url) if og_url else None),
        "title": _text(_first(article.get("headline"), _meta(page, "og:title", "twitter:title"), page.css("title::text").get())),
        "summary": _text(_first(article.get("description"), _meta(page, "og:description", "description", "twitter:description"))),
        "published_at": parse_date(published_raw),
        "published_raw": published_raw if isinstance(published_raw, str) else None,
        "modified_at": parse_date(modified_raw),
        "authors": [_text(a) for a in authors[:5]],
        "publisher": publisher[0] if publisher else _meta(page, "og:site_name"),
        "image_url": (urljoin(url, img) if (img := _first(_image(article.get("image")), _meta(page, "og:image", "twitter:image"))) else None),
        "language": (str(lang).split("-")[0].split("_")[0].lower() if lang else None),
        "categories": [str(s) for s in sections if s][:10],
        "tags": list(dict.fromkeys(t for t in tags if len(t) < 80))[:20],
        "jsonld_body": article.get("articleBody") if isinstance(article.get("articleBody"), str) else None,
        "jsonld_types": sorted({t for n in nodes for t in _types(n)})[:10],
        "og": {k: v for k in ("og:type", "og:site_name", "og:title") if (v := _meta(page, k))},
    }
