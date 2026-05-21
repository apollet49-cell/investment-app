from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Brotli compression is ~20% smaller than gzip for text. brotli-asgi
# transparently falls back to gzip if the client's Accept-Encoding doesn't
# include "br" (older curl, some bots).
try:
    from brotli_asgi import BrotliMiddleware  # type: ignore
    _HAS_BROTLI = True
except ImportError:
    from fastapi.middleware.gzip import GZipMiddleware
    _HAS_BROTLI = False

from database import init_db
from settings import settings as app_settings

# Sentry: initialise BEFORE the FastAPI app so its middleware catches every
# unhandled exception. If SENTRY_DSN is empty or the SDK isn't installed
# (minimal lockfile / dev env without monitoring), we no-op rather than
# refusing to boot.
if app_settings.SENTRY_DSN:
    try:
        import sentry_sdk
        sentry_sdk.init(
            dsn=app_settings.SENTRY_DSN,
            environment=app_settings.SENTRY_ENV,
            traces_sample_rate=app_settings.SENTRY_TRACES_SAMPLE_RATE,
            send_default_pii=False,
        )
    except ImportError:
        logging.getLogger("investment_app").warning(
            "SENTRY_DSN is set but sentry-sdk is not installed — "
            "error reporting disabled. Run `pip install sentry-sdk[fastapi]`."
        )
from routers import (
    alerts as alerts_router,
    dashboard as dashboard_router,
    dividends as dividends_router,
    exports as exports_router,
    investments as investments_router,
    market as market_router,
    planning as planning_router,
    scenarios as scenarios_router,
    settings as settings_router,
    tax as tax_router,
    transactions as transactions_router,
)
from routers import calculator as calculator_router
from auth import limiter as auth_limiter, router as auth_router
from slowapi.errors import RateLimitExceeded
from slowapi import _rate_limit_exceeded_handler
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

    # Always provide an SSEHub on app.state so endpoints that touch it
    # don't AttributeError when the scheduler is disabled (tests, hermetic
    # runs). The hub just won't receive any broadcasts.
    from services.sse import SSEHub
    app.state.sse = SSEHub()

    # Tests (and other hermetic environments) opt out of the scheduler so
    # they don't hit real yfinance / AlphaVantage endpoints. We log loudly
    # if this is set in prod — usually a typo or misconfig.
    if os.getenv("INVESTAPP_DISABLE_SCHEDULER") == "1":
        if app_settings.SENTRY_ENV == "production":
            log.warning(
                "⚠️ INVESTAPP_DISABLE_SCHEDULER=1 in production — "
                "snapshots, SSE broadcasts, and price refresh are disabled."
            )
        else:
            log.info("Scheduler disabled via INVESTAPP_DISABLE_SCHEDULER=1")
        yield
        return

    # Phase B: scheduler state
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from services.market_data import market_service
    from services.alerts_engine import refresh_all_alerts
    from services.snapshots import take_all_snapshots
    from database import SessionLocal

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

    def _cleanup_demo_users():
        """Drop demo+*@local.invest accounts older than 24h. Demo users
        are created on every /auth/demo call; without this job the DB
        would balloon over time. FK cascades take their investments,
        transactions, snapshots, etc. with them."""
        from datetime import datetime, timedelta, timezone
        from models import User as _U
        bg_db = SessionLocal()
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            stale = bg_db.query(_U).filter(
                _U.email.like("demo+%@local.invest"),
                _U.created_at < cutoff,
            ).all()
            for u in stale:
                bg_db.delete(u)
            if stale:
                bg_db.commit()
                log.info("demo cleanup: removed %d users older than 24h", len(stale))
        finally:
            bg_db.close()

    async def cleanup_demo_users_job():
        try:
            await asyncio.to_thread(_cleanup_demo_users)
        except Exception as e:
            log.exception("demo cleanup failed: %s", e)

    async def purge_market_cache():
        try:
            from services import market_cache_db
            n = await asyncio.to_thread(market_cache_db.purge_expired)
            if n:
                log.info("market_data_cache: purged %d expired rows", n)
        except Exception as e:
            log.exception("market cache purge failed: %s", e)

    app.state.scheduler.add_job(refresh_portfolios, "interval", seconds=60, id="portfolios", max_instances=1)
    app.state.scheduler.add_job(refresh_forex, "interval", seconds=300, id="forex", max_instances=1)
    app.state.scheduler.add_job(refresh_indices, "interval", seconds=900, id="indices", max_instances=1)
    app.state.scheduler.add_job(refresh_macro, "interval", seconds=3600, id="macro", max_instances=1)
    app.state.scheduler.add_job(purge_market_cache, "interval", hours=1, id="market_cache_purge", max_instances=1)
    # Snapshot every 6h so we get coverage even if the process restarts daily
    # (Render free tier sleeps idle services). The take_snapshot helper is
    # idempotent — running it 4× a day still produces one row per user per date.
    app.state.scheduler.add_job(daily_snapshots, "interval", hours=6, id="snapshots", max_instances=1, next_run_time=None)
    # Demo user cleanup runs hourly so accounts > 24h vanish soon after.
    app.state.scheduler.add_job(cleanup_demo_users_job, "interval", hours=1, id="demo_cleanup", max_instances=1)
    app.state.scheduler.start()
    log.info("Scheduler started (portfolio 60s, forex 300s, indices 900s, macro 3600s, snapshots 6h, demo cleanup 1h)")

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

# slowapi: hook the limiter from auth.py into the app so the @limiter.limit
# decorators on /auth/{register,login,demo} actually fire, and 429 responses
# are emitted instead of a bare 500.
app.state.limiter = auth_limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS — explicit allowlist (wildcard with credentials is invalid per spec).
# Configure via the CORS_ALLOWED_ORIGINS env var on Render. An empty env value
# falls back to localhost so a misconfigured dev machine still works; prod
# origins MUST be supplied via env.
_allowed_origins = [o.strip() for o in app_settings.CORS_ALLOWED_ORIGINS.split(",") if o.strip()]
if not _allowed_origins:
    _allowed_origins = ["http://localhost:8000", "http://127.0.0.1:8000"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Compress JSON & text responses ≥500B. Brotli when the lib is available
# (most clients support it now); falls back to gzip. Cuts a 40KB dashboard
# summary to ~4KB Brotli / ~5KB gzip on the wire.
if _HAS_BROTLI:
    app.add_middleware(BrotliMiddleware, minimum_size=500)
else:
    app.add_middleware(GZipMiddleware, minimum_size=500)


# Security headers — set on every response. CSP is the headline: it stops
# a stored XSS from exfiltrating localStorage (where the JWT lives) by
# pinning script-src to self + the two CDN origins we actually use, and
# pinning connect-src to self + analytics/error endpoints. 'unsafe-inline'
# stays for script and style because the app inlines PostHog's init
# snippet and uses style="..." attributes across views — tightening this
# further would require a build step or per-render nonce.
_IS_PROD = app_settings.SENTRY_ENV == "production"
_CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://eu.i.posthog.com https://us.i.posthog.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    # connect-src: API + WebSocket + analytics/error/exchange-rate endpoints
    "connect-src 'self' ws: wss: https://eu.i.posthog.com https://us.i.posthog.com https://*.sentry.io https://*.ingest.sentry.io",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    # Clickjacking + content-sniffing + referrer leakage
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    response.headers.setdefault("Content-Security-Policy", _CSP)
    # HSTS only in production (over HTTPS) — sending it on a dev http://
    # localhost would lock the browser into requiring HTTPS for localhost,
    # breaking the dev workflow.
    if _IS_PROD:
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains",
        )
    return response

app.include_router(auth_router)
app.include_router(investments_router.router)
app.include_router(calculator_router.router)
app.include_router(scenarios_router.router)
app.include_router(exports_router.router)
app.include_router(dashboard_router.router)
app.include_router(settings_router.router)
app.include_router(alerts_router.router)
app.include_router(market_router.router)
app.include_router(tax_router.router)
app.include_router(planning_router.router)
app.include_router(transactions_router.router)
app.include_router(dividends_router.router)


@app.get("/health")
async def health() -> dict[str, bool]:
    # Includes a tiny DB roundtrip so an uptime monitor catches DB outages
    # (Render Postgres free tier sleeps), not just "server is up".
    try:
        from database import engine
        from sqlalchemy import text
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"ok": True, "db": True}
    except Exception:
        return {"ok": False, "db": False}


@app.get("/config/public")
async def public_config() -> dict:
    """Front-end-safe config (no secrets). Used by app.js to wire up
    optional integrations like PostHog analytics."""
    return {
        "posthog": {
            "api_key": app_settings.POSTHOG_API_KEY,
            "host": app_settings.POSTHOG_HOST if app_settings.POSTHOG_API_KEY else "",
        },
    }


@app.get("/")
async def root_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/sw.js")
async def service_worker() -> FileResponse:
    """Serve the Service Worker from the root so its default scope is the
    whole app (a SW loaded from /static/sw.js only controls /static/*).
    Sets a no-cache header so SW updates propagate on the next page load."""
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


@app.get("/manifest.json")
async def manifest() -> FileResponse:
    """Mirror the manifest at root for consistency with /sw.js."""
    return FileResponse(STATIC_DIR / "manifest.json", media_type="application/manifest+json")


# Mount static files (CSS/JS/SVG). index.html is served by `/` above.
#
# Cache strategy:
# - URLs with a ?v=N query string (versioned by VIEW_VERSION in app.js) are
#   treated as immutable — the browser caches them for a year. Any update
#   to those files comes with a bumped ?v=N+1, which is a brand-new URL.
# - URLs without ?v= (e.g. /static/i18n.js loaded via static `import`) get
#   a short 60s cache. This is short enough that a deploy propagates in a
#   minute but long enough to make in-session navigation instant.
# This replaces the previous no-cache-everything behaviour that forced the
# browser to re-download app.js / style.css on every page navigation.
class VersionedStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if not path.endswith((".css", ".js", ".html", ".svg")):
            return response
        # ?v= present → immutable; treat each versioned URL as a unique
        # resource and let the browser cache it indefinitely.
        query = scope.get("query_string", b"")
        if b"v=" in query:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "public, max-age=60"
        return response


app.mount("/static", VersionedStaticFiles(directory=str(STATIC_DIR)), name="static")
