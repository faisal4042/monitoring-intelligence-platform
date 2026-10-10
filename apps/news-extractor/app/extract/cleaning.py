"""Text clean-up for Arabic and English article bodies.

Cleaning removes page furniture only: share/subscribe/follow prompts,
"read also" teasers, copyright lines, repeated paragraphs. It never rewrites
words, digits or names. ``normalize_for_hash`` is used only to compute the
content fingerprint and is never stored as the article text.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata

# Whole-line furniture. Anchored and short: a sentence that merely contains
# one of these words inside real reporting is kept.
_FURNITURE = [
    r"^(شارك|مشاركة|انشر|نشر)(\s+(الخبر|المقال|على|عبر).{0,40})?$",
    r"^(تابع(نا|وا)?|تابعونا)\s+(على|عبر).{0,60}$",
    r"^(اشترك|اشتركوا|للاشتراك|سجل)\s.{0,60}(النشرة|القناة|البريد|واتساب|تيليجرام|تلغرام).{0,40}$",
    r"^(اقرأ|إقرأ|اقرا)\s+(أيضا|أيضاً|ايضا|المزيد)\s*[:：]?.{0,160}$",
    r"^(اقرأ\s+أيضا|اقرأ\s+أيضًا|مواضيع ذات صلة|أخبار ذات صلة|ذات صلة|الأكثر قراءة|الأكثر مشاهدة|المزيد من الأخبار)\s*[:：]?$",
    r"^(جميع الحقوق محفوظة|حقوق النشر|©).{0,120}$",
    r"^(للمزيد من الأخبار|لمزيد من المعلومات)\s+(تابع|زوروا|اضغط).{0,80}$",
    r"^(اضغط|انقر)\s+هنا.{0,60}$",
    r"^(Share|Share this|Follow us|Subscribe|Read more|Read also|Related( articles| news)?|Most read|All rights reserved)\b.{0,80}$",
    r"^(Tweet|WhatsApp|Facebook|Twitter|X|LinkedIn|Telegram|Email|Print|طباعة|واتساب|فيسبوك|تويتر|تيليجرام)$",
    r"^(Advertisement|إعلان|اعلان|محتوى إعلاني)$",
]
_FURNITURE_RE = [re.compile(p, re.I) for p in _FURNITURE]
# Lines that end the article body when they appear as their own block.
STOP_MARKERS = re.compile(r"^(اقرأ\s+أيضا|اقرأ\s+أيضًا|أخبار ذات صلة|مواضيع ذات صلة|الأكثر قراءة|التعليقات|اترك تعليقا|Related|Comments)\s*[:：]?$", re.I)

_WS = re.compile(r"[ \t ​‌‍⁠﻿]+")
_TATWEEL = "ـ"
_DIACRITICS = re.compile(r"[ً-ْٰ]")


def clean_line(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = _WS.sub(" ", text).strip()
    return text


def is_furniture(line: str) -> bool:
    return any(rx.match(line) for rx in _FURNITURE_RE)


def clean_paragraphs(paragraphs: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in paragraphs:
        line = clean_line(raw)
        if not line or is_furniture(line):
            continue
        key = normalize_for_hash(line)
        if key in seen:  # the same paragraph twice (sticky headers, duplicated teasers)
            continue
        seen.add(key)
        out.append(line)
    return out


def normalize_for_hash(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).replace(_TATWEEL, "")
    t = _DIACRITICS.sub("", t)
    t = re.sub("[إأآا]", "ا", t).replace("ى", "ي").replace("ة", "ه")
    t = re.sub(r"[^\w\s]", " ", t.lower())
    return re.sub(r"\s+", " ", t).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize_for_hash(text).encode("utf-8")).hexdigest()


def simhash64(text: str) -> int:
    """64-bit SimHash over normalised words (term-frequency weighted), for
    near-duplicate detection: a light edit moves a few bits, an unrelated text
    about half of them. Returned signed so it fits a Postgres bigint."""
    counts: dict[str, int] = {}
    for w in normalize_for_hash(text).split():
        if len(w) > 1:
            counts[w] = counts.get(w, 0) + 1
    v = [0] * 64
    for word, weight in counts.items():
        h = int.from_bytes(hashlib.blake2b(word.encode("utf-8"), digest_size=8).digest(), "big")
        for i in range(64):
            v[i] += weight if (h >> i) & 1 else -weight
    out = 0
    for i in range(64):
        if v[i] > 0:
            out |= 1 << i
    return out - (1 << 64) if out >= (1 << 63) else out


def arabic_ratio(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if "؀" <= c <= "ۿ" or "ݐ" <= c <= "ݿ") / len(letters)
