"""Article body extraction.

Order: a source-specific rule (Scrapling CSS/XPath, optionally adaptive),
then well-known article-body containers, then a scoring pass that picks the
single densest text container. Picking one container — never the page — is
what keeps neighbouring stories, "read also" lists and footers out of the body.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from lxml import html as lxml_html
from lxml.etree import ParserError

from .cleaning import STOP_MARKERS, clean_line, clean_paragraphs

_DROP_TAGS = {"script", "style", "noscript", "iframe", "svg", "form", "button", "input", "select", "textarea",
              "nav", "aside", "footer", "template", "canvas", "video", "audio", "object", "embed"}
# Matched against each class/id token on its own, so "article-body" is kept
# while "share-buttons" or "related-posts" is dropped.
_BOILER_TOKEN = re.compile(
    r"^(share|sharing|social|socials|related|recommend\w*|comments?|newsletter|subscribe|subscription|advert\w*|ads?|"
    r"ad-\w+|\w+-ads?|banner|breadcrumbs?|menu|sidebar|footer|site-header|navbar|nav|popup|modal|cookie\w*|"
    r"most-read|trending|widget|author-box|print|whatsapp|telegram|tags|tag-list|keywords|read-also|readmore|"
    r"more-news|also-read|outbrain|taboola|sponsored|promo\w*)$", re.I)
_KNOWN_BODY = [
    '[itemprop="articleBody"]', '[property="articleBody"]', ".article-body", ".article__body", ".articleBody",
    ".article-content", ".article__content", ".entry-content", ".post-content", ".story-body", ".news-body",
    ".news-content", ".node-content", ".field--name-body", "#article-body", "#articleBody", ".td-post-content",
]
_BLOCKS = ("p", "h2", "h3", "h4", "li", "blockquote", "pre")


@dataclass
class Body:
    paragraphs: list[str]
    strategy: str          # "site" | "known" | "scored" | "jsonld" | "none"
    container: str | None  # a short description of where the text came from


def _tokens(el) -> list[str]:
    return (el.get("class", "") + " " + el.get("id", "")).split()


def _is_boiler(el) -> bool:
    return any(_BOILER_TOKEN.match(t) for t in _tokens(el)) or el.get("aria-hidden") == "true" or el.get("hidden") is not None


def _strip(root) -> None:
    for el in list(root.iter()):
        if not isinstance(el.tag, str):
            continue
        if el.tag in _DROP_TAGS or (el.tag not in ("html", "body", "article", "main") and _is_boiler(el)):
            parent = el.getparent()
            if parent is not None:
                el.drop_tree()


def _link_density(el) -> float:
    text = el.text_content() or ""
    if not text.strip():
        return 1.0
    linked = sum(len(a.text_content() or "") for a in el.iter("a"))
    return linked / max(1, len(text))


def _own_text(el) -> str:
    return (el.text or "") + "".join(c.tail or "" for c in el)


def _blocks(container) -> list[str]:
    out: list[str] = []
    # Paragraph-level elements with no paragraph-level children. A <div> that
    # carries text directly counts too: publishers often nest <div> inside <p>
    # (invalid HTML), which the parser resolves by moving the text out of the <p>.
    leaf = [el for el in container.iter(*_BLOCKS, "div")
            if not any(isinstance(c.tag, str) and c.tag in _BLOCKS + ("div",) for c in el.iterdescendants())
            and (el.tag != "div" or len(clean_line(_own_text(el))) >= 30)]
    if not leaf:  # text laid out with <br> inside divs
        text = "\n".join(t for t in container.itertext())
        return [ln for ln in (clean_line(x) for x in text.split("\n")) if ln]
    for el in leaf:
        text = clean_line(el.text_content() or "")
        if not text:
            continue
        if STOP_MARKERS.match(text):
            break
        if el.tag == "li" and (_link_density(el) > 0.5 or len(text) < 25):
            continue
        if _link_density(el) > 0.7 and len(text) < 160:
            continue
        out.append(text)
    return out


def _score(root) -> object | None:
    scores: dict[object, float] = {}
    for p in root.iter("p", "div", "section", "span", "td"):
        own = clean_line(" ".join(t for t in [p.text or ""] + [c.tail or "" for c in p] if t))
        text = clean_line(p.text_content() or "") if p.tag == "p" else own
        if len(text) < 40:
            continue
        weight = 1 + min(len(text) / 100, 3) + text.count("،") * 0.2 + text.count(",") * 0.1
        parent = p.getparent() if p.tag == "p" else p
        if parent is None:
            continue
        scores[parent] = scores.get(parent, 0) + weight
        grand = parent.getparent()
        if grand is not None:
            scores[grand] = scores.get(grand, 0) + weight / 2
    best, best_score = None, 0.0
    for el, s in scores.items():
        s *= 1 - min(_link_density(el), 0.9)
        if s > best_score:
            best, best_score = el, s
    return best


def parse_tree(body: bytes, encoding: str):
    try:
        return lxml_html.document_fromstring(body.decode(encoding, "replace"))
    except (ParserError, ValueError, LookupError):
        try:
            return lxml_html.document_fromstring(body.decode("utf-8", "replace"))
        except (ParserError, ValueError):
            return None


def extract_body(tree, site_paragraphs: list[str] | None, title: str | None) -> Body:
    if site_paragraphs:
        return Body(clean_paragraphs(site_paragraphs), "site", None)
    if tree is None:
        return Body([], "none", None)
    _strip(tree)
    for sel in _KNOWN_BODY:
        try:
            found = tree.cssselect(sel)
        except Exception:
            continue
        for el in found:
            paras = clean_paragraphs(_blocks(el))
            if sum(len(p) for p in paras) >= 150:
                return Body(paras, "known", sel)
    # Several <article> elements usually means a listing or "more stories":
    # take the one that carries the headline, never all of them together.
    articles = tree.findall(".//article")
    if len(articles) > 1 and title:
        head = title.strip()[:40]
        match = next((a for a in articles if head and head in (a.text_content() or "")), None)
        if match is not None:
            paras = clean_paragraphs(_blocks(match))
            if paras:
                return Body(paras, "known", "article[headline]")
    best = _score(tree)
    if best is None:
        return Body([], "none", None)
    paras = clean_paragraphs(_blocks(best))
    if title:  # the headline repeated as the first block is not body text
        paras = [p for i, p in enumerate(paras) if not (i == 0 and clean_line(p) == clean_line(title))]
    return Body(paras, "scored", best.tag)
