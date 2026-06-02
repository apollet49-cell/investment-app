from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, User
from services.data_verifier import verify_price
from services.market_data import _INDEX_MAP, market_service

log = logging.getLogger("market")
router = APIRouter(prefix="/market", tags=["market"])


@router.get("/price/{symbol}")
async def price(symbol: str) -> dict:
    data = await market_service.get_stock_price(symbol)
    if not data:
        raise HTTPException(status_code=404, detail=f"no price data found for {symbol}")
    return data


@router.get("/crypto/{coin_id}")
async def crypto(coin_id: str) -> dict:
    data = await market_service.get_crypto_price(coin_id)
    if not data:
        raise HTTPException(status_code=404, detail=f"no crypto data found for {coin_id}")
    return data


@router.get("/forex/{from_currency}/{to_currency}")
async def forex(from_currency: str, to_currency: str) -> dict:
    data = await market_service.get_forex_rate(from_currency, to_currency)
    if not data:
        raise HTTPException(status_code=404, detail="no forex data found")
    return data


@router.get("/indices")
async def indices() -> dict:
    data = await market_service.get_all_indices()
    return {"indices": data, "supported": list(_INDEX_MAP.keys())}


@router.get("/verify/{symbol}")
async def verify(symbol: str, asset_class: str = Query("stock")) -> dict:
    return await verify_price(symbol, asset_class)


@router.get("/macro/{indicator}")
async def macro(indicator: str, country: str = Query("US")) -> dict:
    data = await market_service.get_macro_indicator(indicator, country)
    if not data:
        raise HTTPException(status_code=404, detail="no macro data found")
    return data


# Demo seeds (and any user copying crypto from CoinGecko URLs) store
# crypto symbols as their CoinGecko ids: "bitcoin", "ethereum",
# "solana"… yfinance only speaks tickers like "BTC-USD", so the chart
# 404s on every crypto position until we translate. Curated map for the
# common ones; everything else falls back to UPPER + "-USD" which is
# what yfinance uses for the long tail.
_COINGECKO_TO_YF = {
    "bitcoin": "BTC-USD",  "ethereum": "ETH-USD", "solana": "SOL-USD",
    "cardano": "ADA-USD",  "dogecoin": "DOGE-USD", "ripple": "XRP-USD",
    "polkadot": "DOT-USD", "tron": "TRX-USD",     "litecoin": "LTC-USD",
    "stellar": "XLM-USD",  "chainlink": "LINK-USD", "avalanche-2": "AVAX-USD",
    "monero": "XMR-USD",   "tezos": "XTZ-USD",    "cosmos": "ATOM-USD",
    "uniswap": "UNI-USD",  "filecoin": "FIL-USD", "internet-computer": "ICP-USD",
    "near": "NEAR-USD",    "polygon": "MATIC-USD","aptos": "APT-USD",
}


def _yf_ticker(symbol: str) -> str:
    """Translate frontend-supplied symbols to yfinance tickers when needed.
    Stocks/ETFs (AAPL, ASML.AS) and already-formatted crypto (BTC-USD)
    pass through unchanged. Lowercase-only-letters strings without a dot
    or dash are treated as CoinGecko ids."""
    if "-" in symbol or "." in symbol or not symbol.isalpha():
        return symbol
    if symbol != symbol.lower():
        return symbol
    return _COINGECKO_TO_YF.get(symbol, f"{symbol.upper()}-USD")


@router.get("/historical/{symbol}")
async def historical(symbol: str, period: str = Query("1y")) -> dict:
    ticker = _yf_ticker(symbol)
    data = await market_service.get_historical(ticker, period)
    if not data:
        raise HTTPException(status_code=404, detail=f"no historical data for {symbol}")
    return {"symbol": symbol.upper(), "period": period, "candles": data}


@router.get("/price-on/{symbol}")
async def price_on(
    symbol: str,
    date: str = Query(..., description="ISO date YYYY-MM-DD"),
    asset_type: str = Query("stock", description="stock | etf | crypto"),
) -> dict:
    """Historical price for a single symbol at a given date. Used by the
    investments form: when the user picks an asset and a purchase date,
    the back-end returns the actual price on (or the nearest trading day
    to) that date, which becomes the basis for the implied quantity.
    Re-added after the markets-browser router was retired."""
    from datetime import date as date_cls
    try:
        target = date_cls.fromisoformat(date)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid date — expected YYYY-MM-DD")
    from services.market_universe import market_universe
    result = await market_universe.get_price_on_date(symbol, target, asset_type)
    if not result:
        raise HTTPException(status_code=404, detail=f"no price found for {symbol} on {date}")
    return result


@router.get("/search")
async def search(q: str = Query(..., min_length=1)) -> dict:
    return {"results": await market_service.search_symbols(q)}


@router.get("/portfolio-live")
async def portfolio_live(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Live verified prices for every symbol in the user's portfolio."""
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    symbols = sorted({r.symbol.upper() for r in rows if r.symbol})
    if not symbols:
        return {"symbols": [], "prices": []}
    market_service.watch(symbols)
    results = await asyncio.gather(*(market_service.get_stock_price(s) for s in symbols), return_exceptions=True)
    return {
        "symbols": symbols,
        "prices": [r for r in results if isinstance(r, dict)],
    }


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    """SSE feed: clients receive 'prices', 'forex', 'indices', 'macro' events."""
    sse = request.app.state.sse
    queue = await sse.connect()

    async def gen():
        try:
            # retry=30s avoids a tight reconnect loop if proxies kill the
            # connection (5s was the previous value — caused the "page
            # reloads every 5 seconds" feel for end-users).
            yield "retry: 30000\n\n"
            yield ": connected\n\n"
            while True:
                try:
                    # 5s heartbeat keeps the connection above most proxy
                    # idle timeouts (Cloudflare / Render → 30s+); the
                    # previous 15s was sometimes too slow.
                    payload = await asyncio.wait_for(queue.get(), timeout=5)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # heartbeat keeps proxy alive
        except asyncio.CancelledError:
            pass
        finally:
            await sse.disconnect(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/stats")
async def stats() -> dict:
    return market_service.cache_stats()


@router.websocket("/ws")
async def market_ws(websocket: WebSocket) -> None:
    """Bi-directional WebSocket feed for the same broadcasts that the SSE
    endpoint serves. Lower per-message overhead than SSE (no `data: ` /
    `\\n\\n` framing, no `retry:` directive), and the connection stays
    open through proxies that otherwise idle-kill long HTTP streams.

    The frontend prefers this when available and falls back to /stream
    (SSE) if the upgrade is blocked (older proxies, restrictive CORS).

    The SSE endpoint is kept for compatibility — sw.js fallback, curl,
    bots, and any client that doesn't speak WebSocket."""
    await websocket.accept()
    sse = websocket.app.state.sse
    queue = await sse.connect()
    # Ping every 25s — keeps the connection warm through cloud proxies
    # (Cloudflare idle is 100s, Render is ~110s).
    PING_EVERY = 25.0
    try:
        while True:
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=PING_EVERY)
                await websocket.send_text(payload)
            except asyncio.TimeoutError:
                # Send a JSON ping the client can recognise (vs an SSE comment).
                await websocket.send_text('{"type":"ping"}')
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("WS error: %s", e)
    finally:
        await sse.disconnect(queue)
