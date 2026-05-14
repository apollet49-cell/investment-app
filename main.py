from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from database import init_db
from settings import settings as app_settings

# Sentry: initialise BEFORE the FastAPI app so its middleware catches every
# unhandled exception. If SENTRY_DSN is empty, the SDK is a no-op.
if app_settings.SENTRY_DSN:
    import sentry_sdk
    sentry_sdk.init(
        dsn=app_settings.SENTRY_DSN,
        environment=app_settings.SENTRY_ENV,
        traces_sample_rate=app_settings.SENTRY_TRACES_SAMPLE_RATE,
        # Don't send PII (user emails) by default; flip on once you have
        # a data-retention policy reviewed.
        send_default_pii=False,
    )
from routers import (
    alerts as alerts_router,
    chatbot as chatbot_router,
    dashboard as dashboard_router,
    dividends as dividends_router,
    exports as exports_router,
    investments as investments_router,
    market as market_router,
    markets as markets_router,
    planning as planning_router,
    plans as plans_router,
    scenarios as scenarios_router,
    settings as settings_router,
    tax as tax_router,
    transactions as transactions_router,
    wallet as wallet_router,
    watchlist as watchlist_router,
)
from routers import calculator as calculator_router
from auth import router as auth_router
# app_settings imported above for Sentry; kept here as documentation.

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("investment_app")

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Validate config (raises if any required key missing — see settings.py)
    log.info("Starting investment app — config validated")
    init_db()
    log.info("Database initialised")

    # Phase B: scheduler + SSE state
    from services.sse import SSEHub
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from services.market_data import market_service
    from services.alerts_engine import refresh_all_alerts
    from services.snapshots import take_all_snapshots
    from database import SessionLocal

    app.state.sse = SSEHub()
    app.state.scheduler = AsyncIOScheduler()

    async def refresh_portfolios():
        try:
            await market_service.refresh_watched_symbols(app.state.sse)
        except Exception as e:
            log.exception("portfolio refresh failed: %s", e)

    async def refresh_forex():
        try:
            await market_service.refresh_forex(app.state.sse)
        except Exception as e:
            log.exception("forex refresh failed: %s", e)

    async def refresh_indices():
        try:
            await market_service.refresh_indices(app.state.sse)
        except Exception as e:
            log.exception("indices refresh failed: %s", e)

    async def refresh_macro():
        try:
            await market_service.refresh_macro(app.state.sse)
        except Exception as e:
            log.exception("macro refresh failed: %s", e)

    async def daily_snapshots():
        try:
            n = await asyncio.to_thread(take_all_snapshots, SessionLocal)
            log.info("daily snapshots written: %d", n)
        except Exception as e:
            log.exception("daily snapshots failed: %s", e)

    app.state.scheduler.add_job(refresh_portfolios, "interval", seconds=60, id="portfolios", max_instances=1)
    app.state.scheduler.add_job(refresh_forex, "interval", seconds=300, id="forex", max_instances=1)
    app.state.scheduler.add_job(refresh_indices, "interval", seconds=900, id="indices", max_instances=1)
    app.state.scheduler.add_job(refresh_macro, "interval", seconds=3600, id="macro", max_instances=1)
    # Snapshot every 6h so we get coverage even if the process restarts daily
    # (Render free tier sleeps idle services). The take_snapshot helper is
    # idempotent — running it 4× a day still produces one row per user per date.
    app.state.scheduler.add_job(daily_snapshots, "interval", hours=6, id="snapshots", max_instances=1, next_run_time=None)
    app.state.scheduler.start()
    log.info("Scheduler started (portfolio 60s, forex 300s, indices 900s, macro 3600s, snapshots 6h)")

    # Take an initial snapshot for everyone on boot so the chart isn't empty.
    try:
        n = await asyncio.to_thread(take_all_snapshots, SessionLocal)
        log.info("startup snapshots written: %d", n)
    except Exception as e:
        log.exception("startup snapshots failed: %s", e)

    try:
        yield
    finally:
        log.info("Shutting down scheduler")
        app.state.scheduler.shutdown(wait=False)


app = FastAPI(
    title="Investment Analysis App",
    version="1.0.0",
    description="Production-shaped investment analysis with AI advisor and live market data.",
    lifespan=lifespan,
)

# CORS — explicit allowlist (wildcard with credentials is invalid per spec).
# Configure via the CORS_ALLOWED_ORIGINS env var on Render. An empty env value
# falls back to localhost + the deployed origin so misconfig doesn't block
# every cross-origin request.
_DEFAULT_ORIGINS = [
    "http://localhost:8000", "http://127.0.0.1:8000",
    "https://investment-app-kud9.onrender.com",
]
_allowed_origins = [o.strip() for o in app_settings.CORS_ALLOWED_ORIGINS.split(",") if o.strip()]
if not _allowed_origins:
    _allowed_origins = _DEFAULT_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(investments_router.router)
app.include_router(calculator_router.router)
app.include_router(scenarios_router.router)
app.include_router(chatbot_router.router)
app.include_router(exports_router.router)
app.include_router(dashboard_router.router)
app.include_router(settings_router.router)
app.include_router(alerts_router.router)
app.include_router(market_router.router)
app.include_router(markets_router.router)
app.include_router(watchlist_router.router)
app.include_router(wallet_router.router)
app.include_router(tax_router.router)
app.include_router(planning_router.router)
app.include_router(transactions_router.router)
app.include_router(dividends_router.router)
app.include_router(plans_router.router)


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/")
async def root_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# Mount static files (CSS/JS/SVG). index.html is served by `/` above.
# A small wrapper ensures dev browsers don't aggressively cache CSS/JS so style
# changes show up on a normal reload.
class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if path.endswith((".css", ".js", ".html")):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


app.mount("/static", NoCacheStaticFiles(directory=str(STATIC_DIR)), name="static")
