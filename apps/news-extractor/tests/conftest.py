"""Shared fixtures: a local HTTP server with scripted responses, and a guard
that lets only the fixture hostname through (pinned to 127.0.0.1)."""
from __future__ import annotations

import sys
import threading
import time
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.netguard import Guard  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
HOST = "fixture.test"


def fixture_html(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class Routes:
    def __init__(self):
        self.table: dict[str, list] = {}
        self.hits: dict[str, int] = {}
        self.headers_seen: list[dict] = []

    def add(self, path: str, *responses):
        """Each response: (status, headers dict, body bytes, delay seconds). Last one repeats."""
        self.table[path] = list(responses)


@pytest.fixture
def server():
    routes = Routes()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            routes.headers_seen.append({k.lower(): v for k, v in self.headers.items()})
            path = self.path
            n = routes.hits.get(path, 0)
            routes.hits[path] = n + 1
            seq = routes.table.get(path)
            if not seq:
                self.send_response(404); self.end_headers(); return
            status, headers, body, delay = seq[min(n, len(seq) - 1)]
            if delay:
                time.sleep(delay)
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            if "Content-Length" not in headers:
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    routes.port = port  # type: ignore[attr-defined]
    routes.base = f"http://{HOST}:{port}"  # type: ignore[attr-defined]
    yield routes
    httpd.shutdown()


@pytest.fixture
def guard(server):
    # The fixture hostname is not in DNS at all: a fetch can only reach it if
    # the fetcher pins the connection to the address the guard vetted.
    return Guard(resolver=lambda h, p: ["127.0.0.1"] if h == HOST else [],
                 allow_hosts=frozenset({HOST}), ports=frozenset({80, 443, server.port}))


@pytest.fixture
def settings():
    return replace(Settings(), timeout_s=3, retries=2, backoff_base_s=0.01, max_retry_after_s=1,
                   per_domain_min_interval_s=0.0, max_bytes=200_000, respect_robots=True, dynamic_enabled=False)


HTML = {"Content-Type": "text/html; charset=utf-8"}
