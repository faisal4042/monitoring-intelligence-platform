"""Temporary, token-protected database transfer helper.

This service is added only for a controlled migration deployment and removed
immediately afterwards. It never logs request bodies or credentials.
"""
from __future__ import annotations

import hmac
import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

MAX_DUMP_BYTES = 256 * 1024 * 1024
TOKEN = os.environ["MIGRATION_TOKEN"]
DATABASE_URL = os.environ["DATABASE_URL"]


def connection() -> tuple[str, str, str, str, str]:
    parsed = urlparse(DATABASE_URL)
    return (
        parsed.hostname or "postgres",
        str(parsed.port or 5432),
        unquote(parsed.username or "mip"),
        unquote(parsed.password or ""),
        parsed.path.lstrip("/") or "mip",
    )


def pg_env(password: str) -> dict[str, str]:
    return {**os.environ, "PGPASSWORD": password}


class Handler(BaseHTTPRequestHandler):
    server_version = "mip-db-transfer"

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep access logs useful without ever logging headers or payloads.
        print(f"{self.client_address[0]} {fmt % args}", flush=True)

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, f"Bearer {TOKEN}")

    def json_response(self, status: int, body: dict[str, object]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if not self.authorized():
            self.json_response(401, {"ok": False})
            return
        if self.path == "/health":
            self.json_response(200, {"ok": True})
            return
        if self.path != "/backup":
            self.json_response(404, {"ok": False})
            return
        host, port, user, password, database = connection()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "production-before-import.dump"
            subprocess.run(
                ["pg_dump", "-Fc", "--no-owner", "--no-privileges", "-h", host,
                 "-p", port, "-U", user, "-d", database, "-f", str(target)],
                check=True, env=pg_env(password), timeout=300,
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(target.stat().st_size))
            self.end_headers()
            with target.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    self.wfile.write(chunk)

    def do_POST(self) -> None:  # noqa: N802
        if not self.authorized():
            self.json_response(401, {"ok": False})
            return
        if self.path != "/import":
            self.json_response(404, {"ok": False})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_DUMP_BYTES:
            self.json_response(413, {"ok": False, "error": "invalid dump size"})
            return

        host, port, user, password, database = connection()
        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "incoming.dump"
            remaining = length
            with source_path.open("wb") as target:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ConnectionError("upload ended early")
                    target.write(chunk)
                    remaining -= len(chunk)

            env = pg_env(password)
            common = ["-h", host, "-p", port, "-U", user]
            subprocess.run(["dropdb", *common, "--if-exists", "--force", database], check=True, env=env, timeout=60)
            subprocess.run(["createdb", *common, database], check=True, env=env, timeout=60)
            subprocess.run(
                ["pg_restore", *common, "--no-owner", "--no-privileges", "-d", database, str(source_path)],
                check=True, env=env, timeout=900,
            )
            query = (
                "SELECT json_build_object("
                "'users',(SELECT count(*) FROM users),"
                "'posts',(SELECT count(*) FROM posts),"
                "'classifications',(SELECT count(*) FROM post_classifications),"
                "'news_articles',(SELECT count(*) FROM news_articles));"
            )
            result = subprocess.run(
                ["psql", *common, "-d", database, "-t", "-A", "-c", query],
                check=True, capture_output=True, text=True, env=env, timeout=60,
            )
            self.json_response(200, {"ok": True, "counts": json.loads(result.stdout.strip())})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
