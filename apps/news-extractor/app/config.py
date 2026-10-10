"""Runtime limits for the extractor. Everything has a conservative default;
the service holds no secrets (no database, no API keys)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except ValueError:
        value = default
    return max(lo, min(hi, value))


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    return default if raw is None else raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    # Identify ourselves honestly; no browser impersonation, no fake referer.
    user_agent: str = field(default_factory=lambda: os.environ.get(
        "NEWS_EXTRACTOR_USER_AGENT", "MIP-NewsMonitor/2.0 (+news monitoring; respects robots.txt)"))
    timeout_s: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_TIMEOUT_S", 15, 3, 60))
    max_bytes: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_MAX_BYTES", 3_000_000, 100_000, 20_000_000))
    max_redirects: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_MAX_REDIRECTS", 5, 0, 10))
    retries: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_RETRIES", 2, 0, 5))
    backoff_base_s: float = field(default_factory=lambda: _int("NEWS_EXTRACTOR_BACKOFF_MS", 800, 100, 30_000) / 1000)
    max_retry_after_s: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_MAX_RETRY_AFTER_S", 30, 0, 300))
    # Concurrency: whole service, and per publisher domain.
    global_concurrency: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_CONCURRENCY", 4, 1, 32))
    per_domain_concurrency: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_DOMAIN_CONCURRENCY", 1, 1, 4))
    per_domain_min_interval_s: float = field(default_factory=lambda: _int("NEWS_EXTRACTOR_DOMAIN_INTERVAL_MS", 1500, 0, 60_000) / 1000)
    # Browser rendering: off unless explicitly enabled, one page at a time.
    dynamic_enabled: bool = field(default_factory=lambda: _bool("NEWS_SCRAPLING_DYNAMIC_ENABLED", False))
    dynamic_concurrency: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_DYNAMIC_CONCURRENCY", 1, 1, 4))
    dynamic_timeout_ms: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_DYNAMIC_TIMEOUT_MS", 25_000, 5_000, 90_000))
    respect_robots: bool = field(default_factory=lambda: _bool("NEWS_EXTRACTOR_RESPECT_ROBOTS", True))
    robots_ttl_s: int = field(default_factory=lambda: _int("NEWS_EXTRACTOR_ROBOTS_TTL_S", 21_600, 300, 86_400))
    # Adaptive element relocation for source-specific selectors (Scrapling storage). Empty = off.
    adaptive_storage: str = field(default_factory=lambda: os.environ.get("NEWS_EXTRACTOR_ADAPTIVE_DB", ""))
    # Shared secret the API sends; empty disables the check (local development only).
    token: str = field(default_factory=lambda: os.environ.get("NEWS_EXTRACTOR_TOKEN", ""))


settings = Settings()
