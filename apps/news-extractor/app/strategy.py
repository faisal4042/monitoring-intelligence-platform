"""Fetch strategy: RSS full text → static fetch → browser (only when needed
and allowed) → controlled fallback. One attempt chain per call; retries of a
failed article are scheduled by the API with backoff, never looped here."""
from __future__ import annotations

import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any
from urllib.parse import urlsplit

from lxml import html as lxml_html
from scrapling.parser import Selector

from .config import Settings
from .extract import sites
from .extract.cleaning import clean_paragraphs, content_hash, simhash64
from .extract.content import extract_body, parse_tree
from .extract.metadata import extract_metadata, parse_date
from .extract.sites.nextjs import flight_largest_row
from .extract.validate import validate
from .fetch import DynamicFetcher, FetchError, Page, StaticFetcher
from .limits import Limiter
from .netguard import BlockedURL
from .robots import RobotsCache

VERSION = "news-extractor/1.0 scrapling/0.4.15"
_TRUNCATED = re.compile(r"(\.\.\.|…|\[…\]|\[\.\.\.\]|اقرأ المزيد|Read more)\s*$")


@dataclass
class ExtractRequest:
    url: str
    language: str | None = None
    rss_title: str | None = None
    rss_summary: str | None = None
    rss_content_html: str | None = None
    rss_published_at: str | None = None
    allow_dynamic: bool = False
    js_required: bool = False
    correlation_id: str | None = None


@dataclass
class ExtractResult:
    url: str
    status: str                       # complete | partial | empty | failed | skipped
    method: str                       # rss | static | dynamic | none
    reason: str | None = None
    error_kind: str | None = None
    retryable: bool = False
    http_status: int | None = None
    final_url: str | None = None
    canonical_url: str | None = None
    title: str | None = None
    summary: str | None = None
    content: str | None = None
    content_hash: str | None = None
    simhash: int | None = None
    char_count: int = 0
    word_count: int = 0
    language: str | None = None
    published_at: str | None = None
    modified_at: str | None = None
    authors: list[str] = field(default_factory=list)
    publisher: str | None = None
    image_url: str | None = None
    categories: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    fetch_ms: int = 0
    extract_ms: int = 0
    attempts: int = 0
    dynamic_used: bool = False
    correlation_id: str = ""
    extractor_version: str = VERSION

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _html_to_paragraphs(fragment: str) -> list[str]:
    try:
        root = lxml_html.fragment_fromstring(fragment, create_parent="div")
    except Exception:
        return []
    blocks = [el.text_content() for el in root.iter("p", "li", "h2", "h3", "blockquote")]
    return blocks or [root.text_content()]


def _looks_js_rendered(body: bytes) -> bool:
    head = body[:200_000].lower()
    scripts = head.count(b"<script")
    markers = (b'id="__next"', b'id="root"', b'id="app"', b"ng-version", b"data-reactroot", b"__nuxt")
    return scripts > 15 or any(m in head for m in markers)


class Extractor:
    def __init__(self, settings: Settings, static: StaticFetcher, dynamic: DynamicFetcher | None,
                 limiter: Limiter, robots: RobotsCache | None):
        self.s = settings
        self.static = static
        self.dynamic = dynamic
        self.limiter = limiter
        self.robots = robots

    def run(self, req: ExtractRequest) -> ExtractResult:
        cid = req.correlation_id or uuid.uuid4().hex[:16]
        host = (urlsplit(req.url).hostname or "").lower()
        rule = sites.rule_for(host)
        min_chars = rule.min_chars if rule else None

        # Level 1 — the feed already carries the full article.
        if req.rss_content_html and not req.js_required:
            paras = clean_paragraphs(_html_to_paragraphs(req.rss_content_html))
            text = "\n\n".join(paras)
            verdict = validate(text, req.rss_title, req.language, min_chars)
            if verdict.status == "complete" and not _TRUNCATED.search(text) and len(text) >= 600:
                return self._finish(ExtractResult(req.url, "complete", "rss", correlation_id=cid), text, req,
                                    {"title": req.rss_title, "summary": req.rss_summary,
                                     "published_at": parse_date(req.rss_published_at)}, 0)

        # The SSRF guard comes before anything touches the network, robots.txt included,
        # so a blocked URL is reported as blocked rather than as a robots failure.
        try:
            self.static.guard.check_url(req.url)
        except BlockedURL as e:
            return ExtractResult(req.url, "failed", "none", reason=f"{e.code}: {e}", error_kind="blocked_url", correlation_id=cid)

        if self.robots is not None and self.s.respect_robots:
            try:
                with self.limiter.slot(host):
                    allowed, why = self.robots.check(req.url)
            except TimeoutError:
                return ExtractResult(req.url, "failed", "none", reason="busy", error_kind="busy", retryable=True, correlation_id=cid)
            if not allowed and why:
                # robots.txt could not be read (network, TLS, 5xx): not fetched, retried later.
                kind = why.split(":", 1)[1]
                return ExtractResult(req.url, "failed", "none", reason=why, error_kind=kind if kind == "tls" else "robots_unreachable",
                                     retryable=kind != "tls", correlation_id=cid)
            if not allowed:
                return ExtractResult(req.url, "skipped", "none", reason="robots_disallowed", error_kind="robots", correlation_id=cid)

        # Level 2 — static fetch (default path).
        result = self._attempt(req, "static", rule, min_chars, cid)
        js_hint = bool(rule and rule.js_required) or req.js_required or bool(result.metadata.get("js_hint"))

        # Level 3 — browser, only when static HTML had no article and rendering is allowed.
        if (result.status in ("empty",) or (result.status == "partial" and js_hint)) and js_hint \
                and req.allow_dynamic and self.s.dynamic_enabled and self.dynamic is not None:
            rendered = self._attempt(req, "dynamic", rule, min_chars, cid)
            rendered.attempts += result.attempts
            if rendered.status in ("complete", "partial") and rendered.char_count > result.char_count:
                return rendered
            result.metadata["dynamic_attempt"] = {"status": rendered.status, "reason": rendered.reason}
            result.dynamic_used = True

        # Level 4 — controlled fallback: keep what the feed gave us, report why.
        if result.status in ("empty", "failed") and req.rss_summary and len(req.rss_summary.strip()) >= 40:
            result.metadata["fallback"] = "rss_summary_kept"
        return result

    def _attempt(self, req: ExtractRequest, mode: str, rule, min_chars, cid: str) -> ExtractResult:
        host = (urlsplit(req.url).hostname or "").lower()
        fetcher = self.static if mode == "static" else self.dynamic
        try:
            with self.limiter.slot(host):
                page: Page = fetcher.fetch(req.url)  # type: ignore[union-attr]
        except TimeoutError:
            return ExtractResult(req.url, "failed", mode, reason="busy", error_kind="busy", retryable=True, correlation_id=cid)
        except FetchError as e:
            return ExtractResult(req.url, "failed", mode, reason=str(e), error_kind=e.kind, retryable=e.retryable,
                                 http_status=e.status, correlation_id=cid, dynamic_used=mode == "dynamic")
        t0 = time.monotonic()
        selector = Selector(content=page.body, url=page.url, encoding=page.encoding,
                            adaptive=bool(self.s.adaptive_storage),
                            **({"storage_args": {"storage_file": self.s.adaptive_storage, "url": host}} if self.s.adaptive_storage else {}))
        meta = extract_metadata(selector, page.url)
        site_paras = sites.apply(rule, selector, bool(self.s.adaptive_storage)) if rule else None
        body = extract_body(parse_tree(page.body, page.encoding), site_paras, meta.get("title") or req.rss_title)
        text = "\n\n".join(body.paragraphs)
        if not text and meta.get("jsonld_body"):
            text = "\n\n".join(clean_paragraphs(str(meta["jsonld_body"]).split("\n")))
            body.strategy = "jsonld"
        if len(text) < 150 and b"self.__next_f" in page.body:
            # Next.js page whose body ships in the RSC payload (no browser needed).
            flight = clean_paragraphs(flight_largest_row(page.body.decode(page.encoding, "replace")))
            if sum(map(len, flight)) > max(150, len(text)):
                text, body.strategy = "\n\n".join(flight), "nextjs"
        res = ExtractResult(req.url, "complete", mode, final_url=page.url, http_status=page.status,
                            fetch_ms=page.fetch_ms, attempts=page.attempts, correlation_id=cid, dynamic_used=mode == "dynamic")
        res.metadata = {"body_strategy": body.strategy, "container": body.container, "redirects": page.redirects,
                        "og": meta.get("og"), "jsonld_types": meta.get("jsonld_types"), "published_raw": meta.get("published_raw"),
                        "site_rule": rule.domains[0] if rule else None}
        if mode == "static" and len(text) < 200 and _looks_js_rendered(page.body):
            res.metadata["js_hint"] = True
        return self._finish(res, text, req, meta, int((time.monotonic() - t0) * 1000), min_chars)

    def _finish(self, res: ExtractResult, text: str, req: ExtractRequest, meta: dict, extract_ms: int,
                min_chars: int | None = None) -> ExtractResult:
        title = meta.get("title") or req.rss_title
        verdict = validate(text, title, req.language, min_chars)
        res.status, res.reason = verdict.status, verdict.reason
        res.extract_ms = extract_ms
        res.title = str(title).strip() if title else None
        res.summary = meta.get("summary") or req.rss_summary
        res.content = text if verdict.status != "empty" else None
        if res.content:
            res.content_hash = content_hash(res.content)
            res.simhash = simhash64(res.content)
            res.char_count = len(res.content)
            res.word_count = len(res.content.split())
        res.canonical_url = meta.get("canonical_url")
        res.published_at = meta.get("published_at")  # never the fetch time
        res.modified_at = meta.get("modified_at")
        res.authors = meta.get("authors") or []
        res.publisher = meta.get("publisher")
        res.image_url = meta.get("image_url")
        res.language = meta.get("language") or req.language
        res.categories = meta.get("categories") or []
        res.tags = meta.get("tags") or []
        return res
