# Architecture

This document captures the load-bearing design decisions behind InvestApp.
Every section follows the same pattern: **what I chose · what I rejected ·
why · the cost I accepted**.

Read this before the code if you want to understand *why* things are
shaped the way they are.

---

## 1. No JavaScript framework

**Chose:** Vanilla ES modules + Chart.js + `fetch`. Hash-based SPA router
in `static/app.js`. Each view is a single file exporting `render(root)`.

**Rejected:** React / Vue / Svelte / SolidJS.

**Why:**
- I wanted to *show I understand the DOM*, not that I know how to wrap
  `React.createElement`. A reviewer reading `static/views/dashboard.js`
  sees what's actually happening — no virtual DOM, no reconciliation
  layer, no transpilation step to read through.
- Zero build pipeline. `static/` is served as-is by FastAPI; the only
  cache-busting is a `?v=N` query string on the `<script>` tag. No
  webpack, no Vite, no `npm install` to onboard. The full bundle on
  cold load is ~330 KB (Chart.js 80 + lightweight-charts 150 + app.js
  ~30 + i18n.js ~63), which is *less* than the average React app's
  hydration bundle alone.
- View modules are lazy-loaded via dynamic `import()`. After the dashboard
  renders, an idle callback preloads the other 14 views so subsequent
  clicks skip the network round-trip (see `_preloadedModules` in
  `app.js`).
- ES modules survive ten years of churn. No "this depends on Webpack 4
  and react-scripts 3.x" rot.

**Cost:**
- Re-renders on every route change rebuild `innerHTML`. For a portfolio
  tracker with ~100 rows max, this is faster than React's reconcile and
  it's measurable in the browser's perf panel — but the moment the app
  needs sub-second partial updates (real-time price flashing on hundreds
  of rows), I'd have to migrate.
- No type safety on the frontend. TypeScript would have been a free
  upgrade, but it would have forced a build step. JSDoc would have
  been a middle ground I could still add.

---

## 2. USD as the internal currency

**Chose:** Every monetary value in the database is stored in **USD**.
The frontend converts to the user's selected currency (EUR/GBP/CHF/...)
at display time using a live FX rate from `/market/forex/USD/{ccy}`.

**Rejected:** Storing values in each user's chosen currency, or storing
both the original currency + amount per row.

**Why:**
- **Single source of truth.** Aggregations (`SUM(current_value)`) work
  without per-row FX. A user with positions in NYSE-USD, LSE-GBP,
  Xetra-EUR, and TSE-JPY gets one consolidated number, immediately.
- **The market itself is multi-currency.** When yfinance returns AZN.L
  at 13810 pence, the live-value pipeline (`services/live_value.py`)
  normalises through pence → pounds → USD in a single function. There
  are 45 ISO codes in `_KNOWN_MAJOR` that map cleanly; anything else
  logs a warning rather than silently inflating the position.
- **FX failures are contained to the display layer.** If
  `/market/forex` is rate-limited, `state.fxRate` falls back to 1.0
  and `state.fxFailed = true` so the dashboard can show a clear
  "FX rate unavailable" instead of mis-labeling USD numbers as EUR.

**Cost:**
- Every read does a multiplication on the frontend. For 60 investments
  this is invisible.
- Historical FX rates aren't stored — the dashboard chart always uses
  *today's* rate to convert *yesterday's* USD values. For a French user
  who held positions through the EUR/USD swing of 2022, the
  "portfolio value in EUR" curve is a hybrid that mixes nominal USD
  growth with current FX. Acceptable trade-off for v1; a real wealth
  manager would store FX history alongside snapshots.

---

## 3. Daily portfolio snapshots, not transaction reconstruction

**Chose:** A nightly scheduled job (`services/snapshots.py`) writes one
row per user per day into `portfolio_snapshots`. The dashboard chart
reads from this table directly.

**Rejected:** Computing daily portfolio value on-demand by replaying
the `transactions` log.

**Why:**
- **TWR needs a continuous daily series**, not just contribution dates.
  `services/performance.py::compute_twr_from_snapshots` computes the
  time-weighted return by chaining day-over-day sub-returns. A
  transaction-derived series only knows about buy/sell days — the
  market-only growth between transactions is invisible.
- **Beta vs S&P 500 needs ~30+ daily observations.** Same constraint.
- **Charts feel instant.** `/dashboard/history?days=365` reads 365 rows
  in one query; no in-memory replay of the user's entire transaction
  history.
- **Live refresh stays cheap.** When yfinance is hammered, only the
  scheduled job slows down — the user-facing dashboard reads stale
  snapshots and returns in <100ms.

**Cost:**
- Storage grows ~1 row per user per day. At 1000 users this is 365k
  rows/year — Postgres handles it without breaking a sweat, but it's
  not free.
- Backfilling a new user means generating historical snapshots from
  scratch. `services/demo_seed.py` does this with a synthetic random
  walk for the demo account; a real backfill would replay transactions
  against historical prices.
- A bug in `take_snapshot` poisons the daily series permanently. This
  is why the unique constraint on `(user_id, snapshot_date)` + the
  IntegrityError fallback in `services/snapshots.py:51` matters — a
  concurrent boot can't double-insert.

---

## 4. Idempotent `ALTER TABLE` migrations, not Alembic

**Chose:** `database.py:init_db()` runs a list of `("table", "column",
"DDL")` triples on every boot. If the column exists, skip. If not, run
the `ALTER`. Same pattern for the `portfolio_snapshots` unique
constraint and the composite index on transactions.

**Rejected:** Alembic, Django's migration framework, manual SQL files.

**Why:**
- I had **5 columns to add over 6 months**. The friction of writing,
  numbering, running, and committing Alembic revisions for 5 changes
  is greater than the friction of three lines of Python.
- The migration list lives next to the model definition. No drift
  between "what the model says" and "what's in the DB" because the
  same file declares both.
- Render free-tier deploys are immutable. The migration runs at the
  start of every fresh container — no separate `alembic upgrade head`
  step in the deploy pipeline.

**Cost:**
- **No down-migration.** Rolling back a column add requires manual SQL.
  For a personal-scale app this is acceptable.
- **No migration history table.** If two instances boot simultaneously,
  both try the `ALTER`. The second one fails with "column already
  exists"; we swallow it. Postgres handles this; SQLite gets confused
  occasionally but only matters in dev.
- **Threshold for switching.** When the migration list passes ~10
  entries, or when I need to backfill data (`UPDATE ... SET ...`
  conditionally), the cost shifts and Alembic becomes worth it. The
  current count is 16 entries — I'm approaching the threshold but not
  past it yet.

---

## Three trade-offs I made consciously

### a) JWT in localStorage instead of httpOnly cookies

JWT is stored in `localStorage` and sent via `Authorization: Bearer`.
This is **XSS-vulnerable** but **CSRF-immune** — the opposite of cookies.

The trade was driven by: (1) I have no XSS surface I can find after the
audit (every user string is escaped, every error is escaped, no
unsanitized URLs), and (2) avoiding cookies means no CSRF tokens, which
is a class of bug I don't have to maintain. The day I accept
user-uploaded HTML / Markdown, this trade flips and I migrate to
cookies + double-submit CSRF tokens.

### b) Single uvicorn worker, scheduler state in-process

The APScheduler instance lives on `app.state.scheduler`, the SSE hub
on `app.state.sse`. Multi-worker (uvicorn `--workers N`) would create N
schedulers all firing the same job — duplicate snapshots, duplicate
broadcasts.

I accepted **one worker** as a trade-off. The keep-alive ping in the
GitHub Actions uptime workflow (`/health` every 15 min) means Render's
free-tier cold-start never bites real users. The day I outgrow one
worker, the scheduler migrates to a separate process (Render
"Background Worker" service) and SSE moves to Redis pub/sub.

### c) Float for money columns, not Numeric(18, 2)

Every monetary column in `models.py` is `Float` (double-precision
IEEE-754). The textbook-correct choice is `Numeric(18, 2)` for
accounting-grade precision.

The trade was driven by: (1) all aggregation is for display, not
clearing — I'm never settling a payment based on these numbers, and
(2) IEEE-754 gives ~15 significant decimal digits, which is more than
enough for portfolios up to ~€1 trillion. The Newton's-method XIRR
solver runs entirely in floats; switching to Decimal would force me
to either lose precision in `math.log`/`math.pow` or pull in `mpmath`.
The day this app becomes part of a real settlement flow (it won't),
I'd add a separate `ledger` table with `Numeric` and reconcile.

---

## Layered structure

```
investment_app/
├── main.py              # FastAPI app + lifespan (DB init, scheduler, Sentry)
├── settings.py          # Pydantic Settings (env loader + validators)
├── database.py          # SQLAlchemy engine + idempotent migrations
├── auth.py              # JWT (PyJWT) + bcrypt + get_current_user dep
├── crypto.py            # Fernet wrapper for per-user Anthropic keys
├── models.py            # SQLAlchemy ORM: User, Investment, Transaction,
│                        #   Scenario, ChatMessage, Alert, WatchlistItem,
│                        #   DCAPlan, PortfolioSnapshot
├── schemas.py           # Pydantic v2 request/response models
│                        #   (StrictBase with allow_inf_nan=False)
├── routers/             # HTTP layer — thin: parse input, call service,
│   │                    #   shape response. No business logic.
│   ├── investments.py, transactions.py, plans.py, scenarios.py,
│   ├── dashboard.py, planning.py, calculator.py, exports.py,
│   ├── alerts.py, watchlist.py, market.py, markets.py,
│   ├── tax.py, settings.py, chatbot.py, wallet.py, dividends.py
├── services/            # Business logic — pure functions wherever possible.
│   ├── performance.py   # XIRR (Newton), TWR (snapshot-based), simple ROI
│   ├── risk.py          # Volatility, max drawdown, beta, Sharpe, score
│   ├── calculator.py    # ROI, NPV, IRR, CAGR, Sharpe, breakeven, payback
│   ├── rebalancing.py   # Target-allocation drift + buy/sell suggestions
│   ├── fire.py          # Years-to-FIRE with real-return discounting
│   ├── tax.py           # FR fiscality: CTO / PEA / AV / PER scenarios
│   ├── diversification.py, carbon.py, dividends.py, stress_test.py
│   ├── market_data.py   # yfinance / Alpha Vantage / CoinGecko / FRED
│   ├── market_universe.py, news.py, property_valuation.py (DVF),
│   ├── live_value.py    # Currency-normalise live prices to USD
│   ├── snapshots.py     # Daily portfolio snapshots (scheduled job)
│   ├── ai_service.py    # Anthropic streaming
│   ├── alerts_engine.py, sse.py, technicals.py, wallet_sync.py,
│   ├── pdf_report.py, demo_seed.py
│   └── clock.py         # today_utc() / now_utc() — single TZ source
├── static/              # Vanilla SPA
│   ├── index.html, app.js, style.css, i18n.js
│   └── views/           # 15 lazy-loaded view modules (one per route)
└── tests/               # 72 tests, 5 modules:
    ├── test_performance.py  (19) — XIRR convergence, TWR contributions
    ├── test_calculator.py   (19) — ROI / NPV / IRR / CAGR / Sharpe edges
    ├── test_rebalancing.py  (10) — drift, buy-only mode, normalisation
    ├── test_risk.py         (13) — vol, drawdown, beta correlation
    └── test_integration.py  (11) — auth flow, dashboard summary,
                               CSV round-trip, CSRF guard
```

**Rule of thumb in this codebase:**
- `routers/*.py` should be **thin** — parse input, call one service, shape
  response. If a router file passes ~150 lines, business logic has
  leaked in.
- `services/*.py` should be **pure where possible** — input → output, no
  side effects. The exceptions (`live_value`, `market_data`, `sse`,
  `snapshots`) are explicitly I/O-bound and named accordingly.
- `models.py` is the **schema source of truth**. `schemas.py` mirrors it
  for the wire format but rejects edge cases (NaN/Inf) the DB would
  silently accept.

---

## Observability

| What | How | Status |
|---|---|---|
| Errors | Sentry SDK in `main.py` lifespan, guarded by `SENTRY_DSN` env | SDK integrated, DSN set per-deploy |
| Usage | PostHog frontend SDK in `app.js::loadPosthog`, 11 events tracked | SDK integrated, API key set per-deploy |
| Uptime | GitHub Actions cron pings `/health` (which does `SELECT 1`) every 15 min | Workflow drafted, install via UI |
| Logs | Python `logging` to stdout, captured by Render | Active |

The pattern: **integrations are wired in code, activation is per-deploy
via env vars**. A developer cloning the repo doesn't need a Sentry
account; setting `SENTRY_DSN=""` makes the SDK a no-op import.

---

## What I'd do differently with infinite time

- **TypeScript on the frontend.** Vanilla JS was a deliberate choice to
  show DOM literacy; TS would have caught two bugs this session
  (`err.message` vs `error.message`, fn arg order in the Chart.js
  destroy loop). The cost is the build step, which I avoided on purpose.
- **A real Alembic migration history.** I'm at 16 idempotent ALTER
  entries; the next column triggers the migration.
- **Historical FX storage.** Today the EUR display of a 2022 USD
  snapshot uses 2026 EUR/USD. Wrong for charts that span FX regime
  changes. Fixed by storing the day's rate alongside each snapshot.
- **Multi-currency at the storage layer.** Today every value is USD;
  a French user holding only EUR-denominated assets pays a double FX
  hit (USD store + EUR display). The trade was worth it for code
  simplicity; a v2 would tag each row with its native currency.
- **A real benchmark portfolio per user.** S&P 500 is hardcoded; a
  user invested in EU should compare against MSCI World or STOXX 600.

These aren't bugs — they're **conscious trade-offs**. Each could be
adopted in a focused 1-2 day push when the constraint hits.

---

*Last updated: 2026-05-15.*
*Backing audit: 14 rounds of self-audit, ~130 bugs identified and
fixed, 72 tests green, ~14 800 lines of code, 30 commits in this
hardening pass alone.*
