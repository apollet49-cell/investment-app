# InvestApp

> Built because I was tired of guessing my XIRR.

Live demo: [investment-app-kud9.onrender.com](https://investment-app-kud9.onrender.com)
(click "Try the demo — no signup" on the landing page; you land in a fully-seeded portfolio in two clicks)

![demo](docs/demo.gif) <!-- TODO: record a 15s clip — landing → demo button → dashboard hot-take → /review → ⌘P to PDF -->

---

## Why I built this

Every portfolio tracker I tried did one of three annoying things:

1. **Lied about returns.** They'd average the time-weighted return *after* a fresh deposit, so adding €5k mysteriously made my "performance" look better.
2. **Ignored my French tax envelopes.** PEA, CTO, AV, PER each have different fiscal treatment, and pretending they're one bucket gives the wrong FIRE date.
3. **Made me eyeball the chart vs the S&P.** "Am I beating the market?" should be a number, not a vibe.

So I built one that doesn't. Honest XIRR + TWR. Side-by-side tax envelope simulation. A composite risk score from real metrics (volatility, max drawdown, beta vs benchmark, Sharpe). A monthly review that reads my portfolio like a senior advisor — concentration warnings, asset-class imbalance, action items — not generic "diversify your portfolio" boilerplate.

The whole thing fits in one Python process (FastAPI + Postgres) and one HTML page (vanilla ES modules, no build step).

---

## The three design decisions I'm proudest of

### 1. Vanilla ES modules over a framework

No React, no Svelte, no build step. `app.js` is a hash-router + state holder, `views/*.js` each export a `render(root)`. Module loading is `import(url)` with a `?v=N` cache-bust. The cost: no JSX, no type checking, manual DOM updates. The benefit: zero build pipeline, ~50KB of JS for the whole app (Brotli), and any browser dev tools can step through the code without sourcemaps. For a single-author project where bundle size and onboarding cost actually matter, this is the right trade.

### 2. Stale-while-revalidate cache layered across mem → sessionStorage → IndexedDB

Every `/dashboard/*`, `/investments/`, and `/planning/*` read goes through `cachedGet(path)` which:
1. Returns from an in-memory `Map` if hit (zero latency).
2. Falls back to sessionStorage (synchronous, survives soft reload).
3. Falls back to IndexedDB (asynchronous, survives tab close + browser restart).
4. Falls back to network.
5. Always fires a background revalidation so the next read is fresh.

Concurrent calls for the same path share one in-flight promise — no duplicate fetches on first paint. Mutations seed the cache with the server's authoritative response so there's no flicker. The dashboard renders in ~80ms on repeat visits because the network is no longer in the critical path.

### 3. Deterministic insight → AI augmentation, not AI-first

The dashboard's "Hot Take" card and the Monthly Review are computed from **rules**, not LLM calls. If your top holding is >40% of the portfolio, it says so. If crypto is >25%, it says so. No model, no token cost, works offline, works for everyone including demo users.

The AI layer (Claude prose in `/dashboard/ai-review`) is *additive*: when a user provides their Anthropic key it generates a 2-paragraph commentary on top of the deterministic facts. Otherwise it's gracefully hidden. This means the AI feels like a power-up, not a single point of failure — and the cost stays under control (6h cache per user, keyed on portfolio bucket so $0.50 ticks don't churn).

---

## What I'd change with more time

1. **Pre-rendered server-side dashboard.** The landing is already SSR-ish (critical CSS inlined, hero content in the initial HTML), but the dashboard still hydrates from JSON. With more time I'd ship a real SSR for the first dashboard load — eliminates the 200ms gap between FCP and interactivity.
2. **Multi-worker via Redis pub/sub.** The Service Worker layer and the APScheduler that fans out SSE/WebSocket broadcasts both assume a single uvicorn process. For real traffic I'd move broadcast state into Redis so each worker can publish/subscribe. The architecture doc has a section on this.
3. **More tests on the broadcast path.** 81 tests cover math, auth, CRUD, scenarios, alerts, dashboard endpoints, and PWA — but the SSE/WebSocket fan-out and the APScheduler jobs are still observed-in-prod-only. The next 10 tests would target those paths with `httpx-ws` for the WS upgrade and a fake `SessionLocal` for the scheduler.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the four load-bearing decisions (no framework / USD internal / daily snapshots / idempotent ALTER) and three explicit trade-offs (JWT in localStorage / single uvicorn / float for money).

---

## Quick start

```bash
cd investment_app
./setup.sh                    # creates .venv, installs deps, generates secrets in .env
source .venv/bin/activate
# Edit .env: add ALPHA_VANTAGE_KEY, OPEN_EXCHANGE_RATES_KEY, FRED_KEY
uvicorn main:app --reload     # http://localhost:8000
```

Then either:
- **Click "Try the demo — no signup"** on the landing page (creates an ephemeral user with a seeded portfolio).
- Or register with email/password and use `/investments/seed-demo` to populate.

### Required API keys

| Variable | Purpose | Free signup |
|---|---|---|
| `ALPHA_VANTAGE_KEY` | Stock price fallback | https://www.alphavantage.co/support/#api-key |
| `OPEN_EXCHANGE_RATES_KEY` | Forex primary source | https://openexchangerates.org/signup/free |
| `FRED_KEY` | US macro indicators | https://fred.stlouisfed.org/docs/api/api_key.html |

`ANTHROPIC_API_KEY` is optional — the Monthly Review's AI prose section uses it; everything else works without it.

### Production deploy

Render.com works out of the box. For a public deployment, **upgrade Postgres past the free tier** — free Postgres on Render sleeps after 15 minutes and the first request pays a 10s cold-start. $7/mo of Starter eliminates that hit and is the single highest-ROI change for a public-facing portfolio piece.

---

## Stack

- **Backend.** FastAPI 0.115, SQLAlchemy 2.0, Pydantic 2.9, PyJWT 2.9 (replaced python-jose after CVE-2024-33663/33664), Fernet-encrypted per-user API keys, APScheduler, Brotli middleware, Sentry SDK.
- **Frontend.** Vanilla ES modules, Chart.js + lightweight-charts (lazy-loaded), IndexedDB for cache persistence, Service Worker + manifest for PWA install, WebSocket with SSE fallback for live prices.
- **Math.** Newton-Raphson XIRR, TWR from daily snapshots, beta-regression risk metrics, multi-source price verification with 3σ outlier rejection.
- **Tests.** 81 pytest tests covering auth, CRUD, scenarios, calculator math, performance metrics, risk metrics, rebalancing, dashboard summary + history + risk, alerts, transactions, planning/fire, PWA artefacts, live-refresh FX normalisation.

## File layout

```
investment_app/
├── main.py             # FastAPI app + lifespan (DB init, scheduler, key validation)
├── settings.py         # Pydantic Settings (env loader)
├── database.py         # SQLAlchemy engine, SessionLocal, Base, get_db
├── models.py           # User, Investment, Transaction, Scenario, Alert, PortfolioSnapshot
├── schemas.py          # Pydantic request/response models
├── auth.py             # JWT, password hashing, /auth/login + register + demo + me
├── crypto.py           # Fernet wrapper for per-user API keys
├── routers/            # dashboard, investments, scenarios, fire, tax, alerts, …
├── services/           # calculator, ai_service, market_data, risk, performance, …
├── tests/              # 81 pytest tests
├── ARCHITECTURE.md     # design decisions + trade-offs
├── setup.sh            # bootstrap script
└── static/             # SPA: index.html, style.css, app.js, i18n.js, views/*.js
```

## Known limitations

- Single uvicorn worker (scheduler + WS/SSE broadcast state are per-process). Multi-worker requires a Redis pub/sub layer between the broadcaster and the connection list.
- `APP_ENCRYPTION_KEY` rotation needs a manual re-encrypt script; the `User.key_version` column is reserved for it.
- Free-tier Postgres cold-starts hurt first impressions — see "Production deploy" above.
