from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from data.asset_universe import TOP_CRYPTOS, TOP_ETFS, TOP_STOCKS
from services.market_universe import market_universe
from services.news import get_news

router = APIRouter(prefix="/markets", tags=["markets"])


@router.get("/stocks")
async def stocks() -> dict:
    data = await market_universe.get_stocks()
    return {"count": len(data), "items": data}


@router.get("/etfs")
async def etfs() -> dict:
    data = await market_universe.get_etfs()
    return {"count": len(data), "items": data}


@router.get("/crypto")
async def crypto() -> dict:
    data = await market_universe.get_crypto()
    return {"count": len(data), "items": data}


@router.get("/movers/{asset_type}")
async def movers(asset_type: str, n: int = Query(10, ge=1, le=50)) -> dict:
    if asset_type not in {"stock", "etf", "crypto"}:
        raise HTTPException(status_code=400, detail="asset_type must be stock, etf, or crypto")
    return await market_universe.get_top_movers(asset_type, n)


@router.get("/search")
async def search(q: str = Query(..., min_length=1), limit: int = Query(10, ge=1, le=25)) -> dict:
    return {"results": await market_universe.search(q, limit)}


@router.get("/asset/{symbol}")
async def asset_detail(
    symbol: str,
    asset_type: str = Query("stock"),
    period: str = Query("1y"),
) -> dict:
    if asset_type not in {"stock", "etf", "crypto"}:
        raise HTTPException(status_code=400, detail="asset_type must be stock, etf, or crypto")
    detail = await market_universe.get_asset_detail(symbol, asset_type, period)
    if not detail:
        raise HTTPException(status_code=404, detail=f"no data for {symbol}")
    return detail


@router.get("/asset/{symbol}/news")
async def asset_news(symbol: str, limit: int = Query(8, ge=1, le=25)) -> dict:
    return {"items": await get_news(symbol, limit)}


@router.get("/price-on/{symbol}")
async def price_on(
    symbol: str,
    date: str = Query(..., description="YYYY-MM-DD"),
    asset_type: str = Query("stock"),
) -> dict:
    """Close price of the asset on (or just before) the given date.
    Falls back to the nearest prior trading day for weekends / holidays."""
    try:
        target = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    if target > datetime.now().date():
        raise HTTPException(status_code=400, detail="date is in the future")
    if asset_type not in {"stock", "etf", "crypto"}:
        raise HTTPException(status_code=400, detail="asset_type must be stock, etf, or crypto")
    result = await market_universe.get_price_on_date(symbol, target, asset_type)
    if not result:
        raise HTTPException(status_code=404, detail=f"no price data for {symbol} on {date}")
    return result


@router.get("/universe")
async def universe() -> dict:
    return {
        "stocks": len(TOP_STOCKS),
        "etfs": len(TOP_ETFS),
        "cryptos": len(TOP_CRYPTOS),
        "total": len(TOP_STOCKS) + len(TOP_ETFS) + len(TOP_CRYPTOS),
    }


class CompareItem(BaseModel):
    symbol: str
    asset_type: str = "stock"
    name: Optional[str] = None


class CompareRequest(BaseModel):
    items: list[CompareItem]
    period: str = "1y"


@router.post("/compare")
async def compare(body: CompareRequest) -> dict:
    """Return base-100 normalised historical price series for 1-5 assets.
    Useful for comparing performance across stocks/ETFs/crypto over a period."""
    items = body.items[:5]
    if not items:
        raise HTTPException(status_code=400, detail="at least one symbol required")

    async def _fetch(item: CompareItem):
        try:
            return await market_universe.get_historical(item.symbol, body.period)
        except Exception:
            return None

    raw = await asyncio.gather(*(_fetch(i) for i in items))

    series = []
    for item, hist in zip(items, raw):
        if not hist or len(hist) < 2:
            series.append({"symbol": item.symbol, "name": item.name or item.symbol, "error": "no data"})
            continue
        base = hist[0]["close"]
        if not base or base <= 0:
            series.append({"symbol": item.symbol, "name": item.name or item.symbol, "error": "invalid base price"})
            continue
        # Sub-sample if too many points to keep the payload reasonable
        step = max(1, len(hist) // 250)
        sampled = hist[::step]
        if sampled[-1] != hist[-1]:
            sampled.append(hist[-1])
        points = [{"date": h["date"], "value": round((h["close"] / base) * 100, 2)} for h in sampled]
        series.append({
            "symbol": item.symbol,
            "name": item.name or item.symbol,
            "start_price": round(base, 4),
            "end_price": round(hist[-1]["close"], 4),
            "change_pct": round((hist[-1]["close"] / base - 1) * 100, 2),
            "points": points,
        })

    return {"period": body.period, "series": series}
