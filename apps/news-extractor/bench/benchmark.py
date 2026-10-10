"""Benchmark: the current engine (what news_articles holds today, plus its
HTTP layer on the article page) against the Scrapling extractor, on the same
real article URLs. Run from apps/news-extractor:

    .venv/Scripts/python bench/benchmark.py bench/sample.json bench/legacy.json bench/results.json

Sequential, robots.txt respected, 1.5 s between requests to one domain, no
browser (dynamic is reported as "would need a browser", not used).
"""
from __future__ import annotations

import json
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.extract.cleaning import arabic_ratio, normalize_for_hash  # noqa: E402
from app.main import extractor  # noqa: E402
from app.strategy import ExtractRequest  # noqa: E402

FURNITURE = re.compile(r"(اقرأ أيضا|اقرأ أيضًا|اقرأ أيضاً|شارك (الخبر|المقال)|تابعونا|جميع الحقوق محفوظة|الأكثر قراءة|Read more|All rights reserved)")


def same_title(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    x, y = normalize_for_hash(a), normalize_for_hash(b)
    return x == y or (len(x) > 15 and (x in y or y in x))


def hours_apart(a: str | None, b: str | None) -> float | None:
    if not a or not b:
        return None
    try:
        return abs((datetime.fromisoformat(a.replace("Z", "+00:00")) - datetime.fromisoformat(b.replace("Z", "+00:00"))).total_seconds()) / 3600
    except ValueError:
        return None


def main(sample_path: str, legacy_path: str, out_path: str) -> None:
    sample = json.loads(Path(sample_path).read_text(encoding="utf-8"))
    legacy = {x["url"]: x for x in json.loads(Path(legacy_path).read_text(encoding="utf-8"))["items"]}
    legacy_meta = json.loads(Path(legacy_path).read_text(encoding="utf-8"))
    proc = psutil.Process()
    rss0 = proc.memory_info().rss
    peak = rss0
    rows = []
    for item in sample:
        t0 = time.monotonic()
        r = extractor.run(ExtractRequest(url=item["url"], language=item.get("language") or "ar",
                                         rss_title=item["legacy"]["title"], rss_summary=item["legacy"]["description"]))
        wall = int((time.monotonic() - t0) * 1000)
        peak = max(peak, proc.memory_info().rss)
        lg = item["legacy"]
        rows.append({
            "source": item["source"], "connector": item["connector"], "url": item["url"],
            "legacy_fetch": legacy.get(item["url"], {}),
            "legacy": {"title": lg["title"], "has_date": bool(lg["published_at"]), "summary_chars": len(lg["description"] or ""),
                       "has_author": bool(lg["author"])},
            "scrapling": {"status": r.status, "method": r.method, "reason": r.reason, "error_kind": r.error_kind,
                          "http_status": r.http_status, "title": r.title, "chars": r.char_count, "has_date": bool(r.published_at),
                          "has_author": bool(r.authors), "canonical_differs": bool(r.canonical_url and r.canonical_url.rstrip("/") != item["url"].rstrip("/")),
                          "arabic_ratio": round(arabic_ratio(r.content or ""), 2) if r.content else None,
                          "furniture_hits": len(FURNITURE.findall(r.content or "")), "fetch_ms": r.fetch_ms, "extract_ms": r.extract_ms,
                          "wall_ms": wall, "body_strategy": r.metadata.get("body_strategy"), "js_hint": bool(r.metadata.get("js_hint")),
                          "content_hash": r.content_hash},
            "date_gap_hours": hours_apart(lg["published_at"], r.published_at),
            "title_agrees": same_title(lg["title"], r.title),
            "excerpt": (r.content or "")[:220],
        })
        print(f'{r.status:9} {r.method:7} {r.char_count:6} {item["source"]}', flush=True)

    n = len(rows)
    sc = [x["scrapling"] for x in rows]
    lf = [x["legacy_fetch"] for x in rows]
    fetched = [s for s in sc if s["http_status"] == 200]
    by_source = defaultdict(lambda: Counter())
    for x in rows:
        by_source[x["source"]][x["scrapling"]["status"]] += 1
    hashes = Counter(s["content_hash"] for s in sc if s["content_hash"])
    gaps = [x["date_gap_hours"] for x in rows if x["date_gap_hours"] is not None]
    summary = {
        "sample": {"articles": n, "sources": len(by_source), "connectors": Counter(x["connector"] for x in rows)},
        "fetch": {
            "legacy_ok": sum(1 for f in lf if f.get("ok")), "scrapling_ok": len(fetched),
            "legacy_avg_ms": round(statistics.mean([f["ms"] for f in lf if f.get("ok")])) if any(f.get("ok") for f in lf) else None,
            "scrapling_avg_fetch_ms": round(statistics.mean([s["fetch_ms"] for s in fetched])) if fetched else None,
            "scrapling_errors": Counter(s["error_kind"] for s in sc if s["error_kind"]),
            "legacy_errors": Counter((f.get("error") or f"HTTP {f.get('status')}")[:60] for f in lf if not f.get("ok")),
        },
        "extraction": {
            "legacy_full_text": 0,
            "scrapling": Counter(s["status"] for s in sc),
            "scrapling_avg_chars_complete": round(statistics.mean([s["chars"] for s in sc if s["status"] == "complete"])) if any(s["status"] == "complete" for s in sc) else None,
            "scrapling_avg_extract_ms": round(statistics.mean([s["extract_ms"] for s in fetched])) if fetched else None,
            "body_strategy": Counter(s["body_strategy"] for s in sc if s["body_strategy"]),
            "furniture_residue_articles": sum(1 for s in sc if s["furniture_hits"]),
            "arabic_ratio_median": statistics.median([s["arabic_ratio"] for s in sc if s["arabic_ratio"] is not None]) if any(s["arabic_ratio"] is not None for s in sc) else None,
        },
        "title": {"agree": sum(1 for x in rows if x["title_agrees"]), "comparable": sum(1 for x in rows if x["scrapling"]["title"])},
        "date": {
            "legacy_has_date": sum(1 for x in rows if x["legacy"]["has_date"]),
            "scrapling_has_date": sum(1 for s in sc if s["has_date"]),
            "page_fills_missing": sum(1 for x in rows if not x["legacy"]["has_date"] and x["scrapling"]["has_date"]),
            "both": len(gaps), "agree_within_1h": sum(1 for g in gaps if g <= 1), "agree_within_24h": sum(1 for g in gaps if g <= 24),
        },
        "author": {"legacy": sum(1 for x in rows if x["legacy"]["has_author"]), "scrapling": sum(1 for s in sc if s["has_author"])},
        "duplicates": {"canonical_differs_from_feed_url": sum(1 for s in sc if s["canonical_differs"]),
                       "same_body_in_sample": sum(c - 1 for c in hashes.values() if c > 1)},
        "browser": {"would_need_browser": sum(1 for s in sc if s["js_hint"] and s["status"] == "empty"), "used": 0},
        "memory_mb": {"scrapling_rss_start": round(rss0 / 1e6), "scrapling_rss_peak": round(peak / 1e6),
                      "legacy_rss_start": legacy_meta.get("rssBeforeMb"), "legacy_rss_peak": legacy_meta.get("rssPeakMb")},
        "per_source": {k: dict(v) for k, v in sorted(by_source.items())},
    }
    Path(out_path).write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main(*sys.argv[1:4])
