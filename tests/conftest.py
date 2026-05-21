"""Shared fixtures for integration tests.

Spins up a fresh SQLite DB per test session, overrides settings to use it,
and returns an authenticated FastAPI TestClient ready to hit endpoints.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Inject env vars BEFORE importing main / settings so Pydantic's validator passes.
# Hermetic test mode: skip the scheduler + live market refresh so tests
# don't hit real yfinance / AlphaVantage / CoinGecko endpoints (flaky,
# slow, and would leak network from CI).
os.environ.setdefault("INVESTAPP_DISABLE_SCHEDULER", "1")
os.environ.setdefault("INVESTAPP_DISABLE_LIVE_REFRESH", "1")
os.environ.setdefault("INVESTAPP_DISABLE_RATE_LIMIT", "1")
# SENTRY_ENV defaults to "production" (settings.py), and auth.py refuses to
# honour INVESTAPP_DISABLE_RATE_LIMIT in production. Without this line the
# limiter stays ON during tests, and the suite only passes by luck of
# execution order (test_auth_rate_limit_fires disabling it early). Mark the
# env as test so the disable flag is honoured for the whole run regardless
# of order / pytest-randomly / -xdist.
os.environ.setdefault("SENTRY_ENV", "test")

# Valid Fernet key (32 url-safe-base64-encoded bytes). Required by crypto.py.
os.environ.setdefault("APP_ENCRYPTION_KEY", "x6bMRJR4jD9SMX7fSeomDbTkEfx-cyreg3IcDzG1rTE=")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-must-be-at-least-32-chars-long-for-validator")
os.environ.setdefault("ALPHA_VANTAGE_KEY", "dummy")
os.environ.setdefault("OPEN_EXCHANGE_RATES_KEY", "dummy")
os.environ.setdefault("FRED_KEY", "dummy")

# Per-test-session sqlite file so each pytest run is isolated.
_db_file = Path(tempfile.gettempdir()) / "investapp_test.db"
if _db_file.exists():
    _db_file.unlink()
os.environ["DATABASE_URL"] = f"sqlite:///{_db_file}"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from fastapi.testclient import TestClient

from database import init_db
from main import app


@pytest.fixture(scope="session")
def client():
    """A TestClient with the DB initialised once for the whole session."""
    init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_token(client):
    """Register a fresh test user per test and return its bearer token."""
    import uuid
    email = f"test-{uuid.uuid4().hex[:8]}@example.com"
    r = client.post("/auth/register", json={
        "email": email, "password": "test-password-123", "name": "Test User",
    })
    assert r.status_code == 201, f"register failed: {r.text}"
    return r.json()["access_token"]


@pytest.fixture
def auth_headers(auth_token):
    return {"Authorization": f"Bearer {auth_token}"}
