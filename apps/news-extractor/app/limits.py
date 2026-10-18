"""Concurrency and pacing: one global cap, and per publisher domain a
concurrency cap plus a minimum interval between requests. In-process only;
the API side additionally serialises sources per domain."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from typing import Iterator


class Limiter:
    def __init__(self, global_concurrency: int, per_domain: int, min_interval_s: float):
        self._global = threading.BoundedSemaphore(global_concurrency)
        self._per_domain = per_domain
        self._interval = min_interval_s
        self._lock = threading.Lock()
        self._domain_sems: dict[str, threading.BoundedSemaphore] = {}
        self._next_slot: dict[str, float] = {}

    def _sem(self, domain: str) -> threading.BoundedSemaphore:
        with self._lock:
            sem = self._domain_sems.get(domain)
            if sem is None:
                sem = self._domain_sems[domain] = threading.BoundedSemaphore(self._per_domain)
            return sem

    @contextmanager
    def slot(self, domain: str, timeout_s: float = 60.0) -> Iterator[None]:
        """Hold a global and a domain slot, waiting out the domain's pacing interval."""
        if not self._global.acquire(timeout=timeout_s):
            raise TimeoutError("global concurrency limit: no slot available")
        sem = self._sem(domain)
        try:
            if not sem.acquire(timeout=timeout_s):
                raise TimeoutError(f"domain concurrency limit: {domain}")
            try:
                with self._lock:
                    now = time.monotonic()
                    start = max(now, self._next_slot.get(domain, 0.0))
                    self._next_slot[domain] = start + self._interval
                if start > now:
                    time.sleep(start - now)
                yield
            finally:
                sem.release()
        finally:
            self._global.release()

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"domains_seen": len(self._domain_sems)}
