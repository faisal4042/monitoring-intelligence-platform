"""Source-specific extraction rules.

A rule exists only for a publisher whose pages the generic extractor gets
wrong (measured, see docs/news-scrapling.md). Rules live in one small module
per publisher group and register themselves by domain here. They use
Scrapling selectors; with adaptive storage configured, a selector that stops
matching after a site redesign is relocated by element similarity instead of
silently returning nothing.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable
from importlib import import_module
from pkgutil import iter_modules

from scrapling.parser import Selector


@dataclass(frozen=True)
class SiteRule:
    domains: tuple[str, ...]
    body: tuple[str, ...]                    # CSS selectors tried in order for the article body container
    remove: tuple[str, ...] = ()             # CSS selectors removed from inside the body (inline furniture)
    paragraphs: str = "p, h2, h3, li, blockquote"
    date_xpath: str | None = None            # a visible date when the page has no machine-readable one
    notes: str = ""
    min_chars: int | None = None             # e.g. short official announcements
    js_required: bool = False                # body is rendered client-side; static HTML has no text
    tags: tuple[str, ...] = field(default=())
    # For pages whose article text ships inside an embedded data payload rather than markup.
    custom: Callable[[str], list[str]] | None = None


_REGISTRY: dict[str, SiteRule] = {}


def register(rule: SiteRule) -> SiteRule:
    for d in rule.domains:
        _REGISTRY[d.lower().removeprefix("www.")] = rule
    return rule


def rule_for(host: str) -> SiteRule | None:
    labels = host.lower().removeprefix("www.").split(".")
    for i in range(len(labels) - 1):  # news.example.com.sa → example.com.sa → com.sa
        rule = _REGISTRY.get(".".join(labels[i:]))
        if rule:
            return rule
    return None


def apply(rule: SiteRule, page: Selector, adaptive: bool) -> list[str] | None:
    if rule.custom is not None:
        paras = rule.custom(str(page.html_content))
        if sum(len(p) for p in paras) >= 80:
            return paras
    for i, css in enumerate(rule.body):
        ident = f"{rule.domains[0]}:body:{i}"
        found = page.css(css, identifier=ident, adaptive=adaptive, auto_save=adaptive)
        if not found:
            continue
        container = found[0]
        # Selector wrappers are rebuilt on every query, so removed elements are matched by their text.
        drop = {str(el.get_all_text(separator=" ", strip=True)) for sel in rule.remove for el in container.css(sel)}
        paras = []
        for el in container.css(rule.paragraphs):
            text = str(el.get_all_text(separator=" ", strip=True))
            if text and text not in drop:
                paras.append(text)
        if not paras:
            text = str(container.get_all_text(separator="\n", strip=True))
            paras = [t for t in text.split("\n") if t.strip()]
        if sum(len(p) for p in paras) >= 80:
            return paras
    return None


def _load() -> None:
    for mod in iter_modules(__path__):
        import_module(f"{__name__}.{mod.name}")


_load()
