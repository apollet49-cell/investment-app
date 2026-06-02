"""Tests for the three new features added in this batch:
- /chat/ask agentic endpoint (handler wiring, key validation)
- /dashboard/risk?include_series=true (new query param, payload shape)
- Compare view is frontend-only; sanity-check the underlying
  /market/historical endpoint still answers for a known ticker is covered
  by existing market tests, so we don't repeat that here.

We don't mock the Anthropic API — we just verify that the route exists,
authentication is required, and that a request without a configured key
fails cleanly with the expected error code instead of crashing the server.
"""
from __future__ import annotations


def test_chat_ask_requires_auth(client):
    """Without a bearer token, /chat/ask must return 401, not 500."""
    r = client.post("/chat/ask", json={"message": "hi"})
    assert r.status_code == 401, r.text


def test_chat_ask_validates_payload(client, auth_headers):
    """Empty message should fail Pydantic validation (422), not reach the model."""
    r = client.post("/chat/ask", json={"history": []}, headers=auth_headers)
    assert r.status_code == 422, r.text


def test_chat_ask_returns_400_without_anthropic_key(client, auth_headers):
    """Fresh user has no key on file. Endpoint must report it cleanly, not 500.
    We skip if the server happens to have a global key set (e.g. CI with
    ANTHROPIC_API_KEY exported)."""
    import os
    if os.environ.get("ANTHROPIC_API_KEY"):
        import pytest
        pytest.skip("global ANTHROPIC_API_KEY set; can't test missing-key branch")
    r = client.post("/chat/ask", json={"message": "Quel est mon score de risque ?"}, headers=auth_headers)
    assert r.status_code in (400, 503), r.text
    body = r.json()
    assert "anthropic" in (body.get("detail") or "").lower() or "key" in (body.get("detail") or "").lower(), body


def test_dashboard_risk_returns_insufficient_history_for_new_user(client, auth_headers):
    """A fresh user has zero snapshots → score should be null with the
    insufficient_history reason. Verifies the endpoint still works under
    the new optional `include_series` param."""
    r = client.get("/dashboard/risk?days=180", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["score"] is None
    assert body.get("reason") == "insufficient_history"


def test_dashboard_risk_include_series_param_accepted(client, auth_headers):
    """The new include_series=true param must not 422 when set, even if
    the user has no history (in which case `series` is simply absent
    because we only attach it when there ARE snapshots)."""
    r = client.get("/dashboard/risk?days=180&include_series=true", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    # Either insufficient history (no series field) or filled series.
    if body.get("series") is not None:
        assert isinstance(body["series"], list)
        for pt in body["series"][:3]:
            assert "date" in pt and "value" in pt and "drawdown_pct" in pt
            assert pt["drawdown_pct"] <= 0  # always negative or zero
