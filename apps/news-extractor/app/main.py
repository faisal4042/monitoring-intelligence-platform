"""News extractor HTTP service.

Stateless and isolated: no database, no AI keys, no access to the API's
secrets. The API sends one article URL (plus what the feed already said
about it); this service fetches and extracts it and returns structured
fields. Persistence, dedup decisions and scheduling stay in the API.
"""
from __future__ import annotations

import hmac
import json
import logging
import sys
import threading
import time
from collections import Counter
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import settings
from .fetch import DynamicFetcher, StaticFetcher
from .limits import Limiter
from .netguard import Guard
from .robots import RobotsCache
from .strategy import VERSION, ExtractRequest, Extractor


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {"t": round(record.created, 3), "level": record.levelname.lower(), "msg": record.getMessage()}
        payload.update(getattr(record, "fields", {}))
        return json.dumps(payload, ensure_ascii=False)


_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(JsonFormatter())
log = logging.getLogger("news-extractor")
log.addHandler(_handler)
log.setLevel(logging.INFO)
log.propagate = False
# Scrapling logs every fetched URL at INFO; our own line per extraction is enough.
logging.getLogger("scrapling").setLevel(logging.WARNING)

guard = Guard()
static = StaticFetcher(settings, guard)
dynamic = DynamicFetcher(settings, guard) if settings.dynamic_enabled else None
limiter = Limiter(settings.global_concurrency, settings.per_domain_concurrency, settings.per_domain_min_interval_s)
robots = RobotsCache(static.fetch_text, settings.user_agent, settings.robots_ttl_s)
extractor = Extractor(settings, static, dynamic, limiter, robots)

_metrics_lock = threading.Lock()
_metrics: Counter = Counter()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log.info("news extractor started", extra={"fields": {"version": VERSION, "dynamic": settings.dynamic_enabled,
                                                          "concurrency": settings.global_concurrency}})
    yield
    if dynamic is not None:  # graceful shutdown: close the browser after in-flight work
        dynamic.close()
    log.info("news extractor stopped")


app = FastAPI(title="mip-news-extractor", version="1.0.0", lifespan=lifespan)


class ExtractBody(BaseModel):
    url: str = Field(max_length=2048)
    language: str | None = Field(default=None, max_length=8)
    rss_title: str | None = Field(default=None, max_length=1000)
    rss_summary: str | None = Field(default=None, max_length=20_000)
    rss_content_html: str | None = Field(default=None, max_length=500_000)
    rss_published_at: str | None = Field(default=None, max_length=64)
    allow_dynamic: bool = False
    js_required: bool = False


def _auth(token: str | None) -> None:
    if settings.token and not hmac.compare_digest(token or "", settings.token):
        raise HTTPException(401, "unauthorized")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": VERSION, "dynamic_enabled": settings.dynamic_enabled,
            "dynamic_renders": dynamic.renders if dynamic else 0}


@app.get("/metrics")
def metrics(x_extractor_token: str | None = Header(default=None)) -> dict:
    _auth(x_extractor_token)
    with _metrics_lock:
        data = dict(_metrics)
    n = max(1, data.get("requests", 0))
    return {**data, "avg_fetch_ms": round(data.get("fetch_ms_total", 0) / n),
            "avg_extract_ms": round(data.get("extract_ms_total", 0) / n), **limiter.stats()}


@app.post("/extract")
def extract(body: ExtractBody, x_extractor_token: str | None = Header(default=None),
            x_correlation_id: str | None = Header(default=None, max_length=64)) -> dict:
    _auth(x_extractor_token)
    started = time.monotonic()
    result = extractor.run(ExtractRequest(**body.model_dump(), correlation_id=x_correlation_id))
    with _metrics_lock:
        _metrics["requests"] += 1
        _metrics[f"status_{result.status}"] += 1
        _metrics[f"method_{result.method}"] += 1
        _metrics["fetch_ms_total"] += result.fetch_ms
        _metrics["extract_ms_total"] += result.extract_ms
        _metrics["retries"] += max(0, result.attempts - 1)
        if result.dynamic_used:
            _metrics["dynamic_renders"] += 1
        if result.error_kind:
            _metrics[f"error_{result.error_kind}"] += 1
    # No article text or page content in logs — only what is needed to trace the call.
    log.info("extract", extra={"fields": {
        "cid": result.correlation_id, "host": body.url.split("/")[2] if "//" in body.url else "",
        "status": result.status, "method": result.method, "error": result.error_kind, "http": result.http_status,
        "chars": result.char_count, "fetch_ms": result.fetch_ms, "extract_ms": result.extract_ms,
        "total_ms": int((time.monotonic() - started) * 1000)}})
    return result.to_dict()
