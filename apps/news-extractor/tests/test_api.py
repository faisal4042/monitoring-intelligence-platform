"""HTTP surface: health, token check, request validation, and that a blocked
URL comes back as a structured result instead of being fetched."""
from fastapi.testclient import TestClient

import app.main as main


def client():
    return TestClient(main.app)


def test_health():
    r = client().get("/health")
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["dynamic_enabled"] is False


def test_token_required_when_configured(monkeypatch):
    monkeypatch.setattr(main, "settings", main.settings.__class__(token="s3cret"))
    c = client()
    assert c.post("/extract", json={"url": "https://example.com"}).status_code == 401
    assert c.post("/extract", json={"url": "http://127.0.0.1/"}, headers={"X-Extractor-Token": "s3cret"}).status_code == 200


def test_blocked_url_is_a_result_not_a_fetch():
    r = client().post("/extract", json={"url": "http://169.254.169.254/latest/meta-data/"}, headers={"X-Correlation-Id": "abc123"})
    body = r.json()
    assert r.status_code == 200 and body["status"] in ("failed", "skipped") and body["content"] is None
    assert body["correlation_id"] == "abc123"


def test_request_limits():
    assert client().post("/extract", json={"url": "x" * 3000}).status_code == 422
