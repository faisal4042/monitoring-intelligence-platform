"""robots.txt, fetched through the same guarded static fetcher and cached per
origin. A missing robots.txt (404) allows; an unreachable one (5xx, network
error) disallows for this cycle rather than guessing."""
from __future__ import annotations

import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from protego import Protego

FetchText = Callable[[str], tuple[int, str]]


class RobotsCache:
    def __init__(self, fetch_text: FetchText, user_agent: str, ttl_s: int):
        self._fetch = fetch_text
        self._ua = user_agent
        self._ttl = ttl_s
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, Protego | None, bool, str | None]] = {}

    def allowed(self, url: str) -> bool:
        return self.check(url)[0]

    def check(self, url: str) -> tuple[bool, str | None]:
        """(allowed, reason). reason is None when the site's own rules decided;
        otherwise why robots.txt could not be read (then we do not fetch)."""
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        with self._lock:
            hit = self._cache.get(origin)
        if hit is None or hit[0] < time.monotonic():
            hit = self._load(origin)
            with self._lock:
                self._cache[origin] = hit
        _, parser, default, reason = hit
        if parser is None:
            return default, reason
        return parser.can_fetch(url, self._ua), None

    def _load(self, origin: str) -> tuple[float, Protego | None, bool, str | None]:
        expires = time.monotonic() + self._ttl
        try:
            status, body = self._fetch(f"{origin}/robots.txt")
        except Exception as e:
            kind = getattr(e, "kind", "network")
            return (time.monotonic() + 300, None, False, f"robots_unreachable:{kind}")
        if status in (401, 403):
            return (expires, None, False, None)
        if status >= 500:  # temporarily unknown: disallow, look again soon
            return (time.monotonic() + 300, None, False, f"robots_unreachable:http_{status}")
        if status >= 400:  # 404/410: the site publishes no rules
            return (expires, None, True, None)
        return (expires, Protego.parse(body), True, None)
