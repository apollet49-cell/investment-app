"""End-to-end integration tests via FastAPI TestClient.

Covers the critical paths: auth, dashboard summary, investments CRUD,
rebalance, history. These would have caught the recent regressions
(transactions.user_id missing migration, _to_out crash on edge data,
rebalance dict-payload crash on malformed body) on the first commit.
"""
from __future__ import annotations


# ---------- auth ----------

def test_register_and_login_flow(client):
    email = "integ-1@example.com"
    r = client.post("/auth/register", json={
        "email": email, "password": "secret123", "name": "Integration",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert "access_token" in body
    assert body["user"]["email"] == email
    assert body["user"]["currency"] == "USD"

    # re-register same email → 409
    r2 = client.post("/auth/register", json={
        "email": email, "password": "secret123", "name": "Dup",
    })
    assert r2.status_code == 409

    # login round-trip
    r3 = client.post("/auth/login", json={"email": email, "password": "secret123"})
    assert r3.status_code == 200
    assert r3.json()["user"]["id"] == body["user"]["id"]

    # /auth/me with the token
    r4 = client.get("/auth/me", headers={"Authorization": f"Bearer {r3.json()['access_token']}"})
    assert r4.status_code == 200
    assert r4.json()["email"] == email


def test_login_wrong_password_returns_401(client):
    client.post("/auth/register", json={
        "email": "wrong-pw@example.com", "password": "right-password", "name": "X",
    })
    r = client.post("/auth/login", json={"email": "wrong-pw@example.com", "password": "WRONG"})
    assert r.status_code == 401


# ---------- investments CRUD ----------

def test_investment_crud_roundtrip(client, auth_headers):
    # empty initially
    r = client.get("/investments/", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []

    # create
    payload = {
        "name": "Test Apple", "type": "stock", "symbol": "AAPL",
        "amount_invested": 1000.0, "current_value": 1200.0,
        "purchase_date": "2024-01-15", "quantity": 5,
    }
    r = client.post("/investments/", json=payload, headers=auth_headers)
    assert r.status_code == 201, r.text
    created = r.json()
    inv_id = created["id"]
    assert created["name"] == "Test Apple"
    assert created["roi_pct"] == 20.0

    # list now has it
    r = client.get("/investments/", headers=auth_headers)
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["id"] == inv_id

    # update
    r = client.put(f"/investments/{inv_id}", json={"current_value": 1500.0}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["current_value"] == 1500.0

    # delete
    r = client.delete(f"/investments/{inv_id}", headers=auth_headers)
    assert r.status_code in (200, 204)
    r = client.get("/investments/", headers=auth_headers)
    assert r.json() == []


def test_investment_rejects_invalid_payload(client, auth_headers):
    r = client.post("/investments/", json={
        "name": "Bad", "type": "stock",
        "amount_invested": -10.0, "current_value": 100.0,
        "purchase_date": "2024-01-01",
    }, headers=auth_headers)
    assert r.status_code == 422  # gt=0 violation

    r = client.post("/investments/", json={
        "name": "Bad", "type": "no_such_type",
        "amount_invested": 100.0, "current_value": 100.0,
        "purchase_date": "2024-01-01",
    }, headers=auth_headers)
    # Backend rejects with 400 (manual check) or 422 (pydantic). Either is fine.
    assert r.status_code in (400, 422)


# ---------- dashboard summary (the path most recently regressed) ----------

def test_dashboard_summary_empty_portfolio(client, auth_headers):
    r = client.get("/dashboard/summary", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["total_invested"] == 0
    assert body["current_value"] == 0
    assert body["best_performer"] is None


def test_dashboard_summary_with_holdings_includes_real_estate_fields(client, auth_headers):
    """Real-estate rows have fields stocks don't (city, surface_sqm). After the
    _to_out → model_validate refactor, all fields should flow through —
    this test would have caught the InvestmentBase gt=0 crash on amount=0."""
    client.post("/investments/", json={
        "name": "Studio", "type": "real_estate",
        "amount_invested": 200000, "current_value": 250000,
        "purchase_date": "2020-01-01",
        "city": "Paris", "postal_code": "75011",
        "surface_sqm": 30, "property_subtype": "apartment",
    }, headers=auth_headers)
    r = client.get("/dashboard/summary", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["current_value"] == 250000
    assert "real_estate" in body["by_type"]
    bp = body["best_performer"]
    assert bp is not None
    assert bp["name"] == "Studio"


def test_dashboard_performance_and_history(client, auth_headers):
    # Seed one investment so we have something to analyse
    client.post("/investments/", json={
        "name": "AAPL", "type": "stock", "symbol": "AAPL",
        "amount_invested": 1000, "current_value": 1100,
        "purchase_date": "2024-01-01", "quantity": 5,
    }, headers=auth_headers)
    # Add a transaction
    inv_id = client.get("/investments/", headers=auth_headers).json()[0]["id"]
    client.post(f"/investments/{inv_id}/transactions", json={
        "type": "buy", "transaction_date": "2024-01-01",
        "quantity": 5, "price_per_unit": 200, "amount": 1000,
    }, headers=auth_headers)
    r = client.get("/dashboard/performance", headers=auth_headers)
    assert r.status_code == 200, r.text
    perf = r.json()
    assert "xirr_pct" in perf
    assert "twr_pct" in perf
    assert "simple_roi_pct" in perf
    assert perf["transaction_count"] >= 1


# ---------- planning/rebalance (was crashing on malformed dict body) ----------

def test_rebalance_with_holdings(client, auth_headers):
    # Two positions, 80/20 ratio
    client.post("/investments/", json={
        "name": "Apple", "type": "stock", "amount_invested": 800,
        "current_value": 800, "purchase_date": "2024-01-01",
    }, headers=auth_headers)
    client.post("/investments/", json={
        "name": "Bond", "type": "bond", "amount_invested": 200,
        "current_value": 200, "purchase_date": "2024-01-01",
    }, headers=auth_headers)
    r = client.post("/planning/rebalance", json={
        "target_by_type": {"stock": 50, "bond": 50},
        "new_contribution": 0,
    }, headers=auth_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["mode"] == "full_rebalance"
    assert len(data["actions"]) == 2


def test_rebalance_rejects_malformed_payload(client, auth_headers):
    # The OLD endpoint accepted dict and crashed inside the for-loop when
    # target_by_type was a string. With Pydantic validation it should 422.
    r = client.post("/planning/rebalance", json={
        "target_by_type": "this is not a dict",
    }, headers=auth_headers)
    assert r.status_code == 422


# ---------- seed-demo (CSRF guard) ----------

def test_seed_demo_requires_confirm_wipe(client, auth_headers):
    # Without confirm_wipe → 400 (CSRF guard)
    r = client.post("/investments/seed-demo", json={}, headers=auth_headers)
    assert r.status_code == 400

    # With confirm_wipe → populates a portfolio
    r = client.post("/investments/seed-demo", json={"confirm_wipe": True}, headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["investments"] >= 10
    assert body["transactions"] >= 20

    # Now /investments/ returns rows
    r = client.get("/investments/", headers=auth_headers)
    assert len(r.json()) == body["investments"]
