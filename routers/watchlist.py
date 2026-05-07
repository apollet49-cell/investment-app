from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

import asyncio

from auth import get_current_user
from database import get_db
from models import User, WatchlistItem
from schemas import WatchlistItemCreate, WatchlistItemOut
from services.market_universe import market_universe

router = APIRouter(prefix="/watchlist", tags=["watchlist"])

VALID_TYPES = {"stock", "etf", "crypto"}


def _to_out(w: WatchlistItem) -> WatchlistItemOut:
    return WatchlistItemOut(
        id=w.id,
        symbol=w.symbol,
        asset_type=w.asset_type,
        name=w.name,
        created_at=w.created_at,
    )


@router.get("/", response_model=list[WatchlistItemOut])
async def list_watchlist(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[WatchlistItemOut]:
    rows = (
        db.query(WatchlistItem)
        .filter(WatchlistItem.user_id == current.id)
        .order_by(WatchlistItem.created_at.desc())
        .all()
    )
    return [_to_out(w) for w in rows]


@router.post("/", response_model=WatchlistItemOut, status_code=201)
async def add_to_watchlist(
    payload: WatchlistItemCreate,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WatchlistItemOut:
    if payload.asset_type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"asset_type must be one of {sorted(VALID_TYPES)}")
    sym = payload.symbol.strip()
    existing = (
        db.query(WatchlistItem)
        .filter(WatchlistItem.user_id == current.id,
                WatchlistItem.symbol == sym,
                WatchlistItem.asset_type == payload.asset_type)
        .first()
    )
    if existing:
        return _to_out(existing)
    w = WatchlistItem(user_id=current.id, symbol=sym, asset_type=payload.asset_type, name=payload.name)
    db.add(w)
    db.commit()
    db.refresh(w)
    return _to_out(w)


@router.get("/live")
async def list_with_prices(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Watchlist items joined with their current price snapshot. Slow on first
    call (per-symbol fetch), then served from MarketUniverseService caches."""
    rows = (
        db.query(WatchlistItem)
        .filter(WatchlistItem.user_id == current.id)
        .order_by(WatchlistItem.created_at.desc())
        .all()
    )
    if not rows:
        return {"items": []}

    async def _quote(item: WatchlistItem) -> dict:
        out = {
            "id": item.id,
            "symbol": item.symbol,
            "asset_type": item.asset_type,
            "name": item.name,
            "created_at": item.created_at.isoformat(),
            "price": None,
            "change_pct": None,
            "image_url": None,
        }
        try:
            if item.asset_type == "crypto":
                # Reuse the cached crypto batch when possible.
                cached = market_universe._crypto_cache.get("all", []) if hasattr(market_universe, "_crypto_cache") else []
                hit = next((c for c in cached if c.get("id") == item.symbol), None)
                if hit:
                    out["price"] = hit.get("price")
                    out["change_pct"] = hit.get("change_24h")
                    out["image_url"] = hit.get("image_url")
                else:
                    detail = await market_universe.get_asset_detail(item.symbol, "crypto", "5d")
                    if detail:
                        out["price"] = detail.get("price")
                        out["image_url"] = detail.get("image_url")
            else:
                detail = await market_universe.get_asset_detail(item.symbol, item.asset_type, "5d")
                if detail:
                    out["price"] = detail.get("price")
                    candles = detail.get("candles") or []
                    if len(candles) >= 2:
                        prev = candles[-2]["close"]
                        out["change_pct"] = ((detail["price"] - prev) / prev * 100.0) if prev else 0.0
        except Exception:
            pass
        return out

    items = await asyncio.gather(*(_quote(r) for r in rows))
    return {"items": items}


@router.delete("/{wid}")
async def remove_from_watchlist(
    wid: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    w = db.get(WatchlistItem, wid)
    if not w or w.user_id != current.id:
        raise HTTPException(status_code=404, detail="watchlist item not found")
    db.delete(w)
    db.commit()
    return Response(status_code=204)
