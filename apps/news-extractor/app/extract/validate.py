"""Is the extracted text an article? Thresholds depend on the source: a
government announcement can be two sentences and still be complete, so a
short result is "partial", not automatically a failure. An empty page is
never reported as a complete article."""
from __future__ import annotations

from dataclasses import dataclass

from .cleaning import arabic_ratio, normalize_for_hash

DEFAULT_MIN_CHARS = 250
SHORT_FORM_MIN_CHARS = 90


@dataclass
class Verdict:
    status: str     # "complete" | "partial" | "empty"
    reason: str | None


def validate(text: str, title: str | None, expected_lang: str | None, min_chars: int | None = None) -> Verdict:
    floor = min_chars or DEFAULT_MIN_CHARS
    body = text.strip()
    if not body:
        return Verdict("empty", "no_text")
    if title and normalize_for_hash(body) == normalize_for_hash(title):
        return Verdict("empty", "title_only")
    if expected_lang == "ar" and len(body) >= 80 and arabic_ratio(body) < 0.3:
        return Verdict("partial", "unexpected_language")
    if len(body) >= floor:
        return Verdict("complete", None)
    if len(body) >= min(floor, SHORT_FORM_MIN_CHARS):
        return Verdict("partial", "short_text")
    return Verdict("empty", "too_short")
