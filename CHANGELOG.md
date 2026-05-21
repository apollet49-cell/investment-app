# Changelog

All notable changes to this project. Most recent first.

## [0.7.0] — 2026-05

### Killer feature

- **Monthly Portfolio Review**. New `/#/review` route renders a print-ready
  one-page report from the user's portfolio: hero, top positions, allocation
  bars, risk profile, three rule-based action items, optional Claude prose
  commentary. `@media print` strips the chrome so ⌘P produces a clean A4 PDF
  directly from the browser.
- **Server-side PDF** (`/exports/pdf`) fully redesigned: sage hero band,
  three KPI cards, side-by-side doughnut + legend, compact bar chart, Top 5
  holdings table with signal-tinted ROI, **Risk profile** table with five
  signal-tinted factors, Outlook section with Claude prose or deterministic
  fallback. Pillow replaces matplotlib (-50 MB on the venv, -3 s cold start).

### New for visitors

- **Demo mode** at `/auth/demo`: one-click creates an ephemeral user with a
  pre-seeded 21-position portfolio + 540 days of snapshots. Visitor lands in
  the dashboard in 2 clicks, no signup. Hourly scheduler job cleans up demo
  accounts older than 24 h.
- **Hero "Hot Take" insight card** on the dashboard: deterministic rule
  picks the single most relevant insight (concentration risk, big winner,
  asset-class imbalance, etc.) and surfaces it above the KPI cards.

### Performance

- **Stale-while-revalidate cache** layered in-memory → sessionStorage →
  IndexedDB → network. Repeat navigations render in <80 ms.
- **Request deduplication** in `cachedGet()` so concurrent SWR readers
  share a single network round-trip.
- **`/dashboard/all`** combined endpoint fans out 7 sub-endpoints
  server-side; the frontend seeds each sub-cache from the bundle.
- **Lazy-loaded** Chart.js and lightweight-charts (saves ~315 KB on
  Calculator / Settings / Reports / etc.).
- **Brotli** compression replaces gzip (~20 % smaller payloads).
- **Critical CSS inlined** in `<head>`; pre-rendered landing in the
  initial HTML so the hero is visible before `app.js` parses.
- **Bulk-insert demo snapshots**: 541 individual `add()` → one INSERT
  (10× faster on Postgres free tier).
- **Bulk-SQL `take_all_snapshots`**: one `INSERT … SELECT … GROUP BY`
  for every user, instead of N×3 per-user queries.
- **SQLAlchemy pool**: 10 + 20 with `pool_recycle=300s` for Postgres,
  sized for the dashboard fan-out concurrency.
- **Lazy backend imports** of ReportLab / Pillow / Anthropic — only
  pulled when the matching endpoint is hit.

### UX polish

- **Optimistic UI** on all investment mutations (add / edit / delete).
- **Skeleton screens** replace spinners on Dashboard and Investments.
- **Mobile bottom tabbar** (Robinhood-style, 5 routes) with iOS safe-area.
- **WebSocket** at `/market/ws` for the live price feed, with SSE fallback.
- **PWA**: manifest + Service Worker with smart cache strategy + install
  prompt 30 s after first visit (dismissible, persisted).

### Brand & content

- New brand mark: sage rounded square with three ascending bars and a
  trend line in cream. Replaces the previous taupe-circle-with-curve.
  Consistent across favicon, sidebar, auth card, and PDF hero band.
- Landing copy rewritten in first-person voice: "Built because I was
  tired of guessing my XIRR."
- README rewritten as a story (why / proudest decisions / things I'd
  change with more time) with `ARCHITECTURE.md` as the deep-dive link.

### Cleanup

- Removed chat surface (FAB + panel + helpers). The AI value lives in
  the Monthly Review.
- Removed ghost routers from disk (Watchlist, Markets browser, DCA Plans,
  Wallet, AI Chatbot). The corresponding models, schemas, JS views, CSS,
  and the unused wallet modal in investments.js are gone. Orphan DB
  tables (chat_messages, dca_plans, watchlist) are left in-place — drop
  them manually if you want to reclaim the space.
- Sidebar trimmed from 12 to 9 items.

### Tests

- 72 → 91 tests, including: scenarios CRUD + simulate, planning/fire,
  stress-test, alerts CRUD + dismiss, transactions summary, SSE hub
  back-pressure, WebSocket connect, `/dashboard/all` bundle, `/auth/demo`
  cleanup pattern, PWA artefacts (`/sw.js`, `/manifest.json`).

### Security

- PyJWT replaces python-jose (CVE-2024-33663 / 33664).
- python-multipart 0.0.18 (CVE-2024-53981).
- cryptography 44.0.1.
- `JWT_SECRET` length validator (≥ 32 chars), Fernet shape validator.
- NaN/Inf rejection on Pydantic schemas.

## [0.1.0] — 2025-Q4

Initial release. FastAPI + SQLAlchemy + vanilla-JS SPA, basic auth, CRUD,
calculator, dashboard with naive interpolated chart, multi-source market
data, AI chatbot with streaming, PDF/CSV exports, trilingual EN/FR/ZH.
