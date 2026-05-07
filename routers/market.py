from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
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


@router.get("/historical/{symbol}")
async def historical(symbol: str, period: str = Query("1y")) -> dict:
    data = await market_service.get_historical(symbol, period)
    if not data:
        raise HTTPException(status_code=404, detail=f"no historical data for {symbol}")
    return {"symbol": symbol.upper(), "period": period, "candles": data}


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
            yield "retry: 5000\n\n"  # tell EventSource to reconnect after 5s
            yield ": connected\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # heartbeat
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
