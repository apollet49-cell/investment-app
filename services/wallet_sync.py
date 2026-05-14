"""Read-only wallet balance sync via free public APIs.

Supports BTC (Blockstream Esplora) and ETH (Cloudflare's public RPC).
Returns balance in native units + USD equivalent (price from CoinGecko cache).

No private keys, no signing — purely view-only based on a public address.
"""
from __future__ import annotations

import logging
from typing import Optional

import aiohttp

from services.market_data import market_service

log = logging.getLogger("wallet_sync")

BLOCKSTREAM_API = "https://blockstream.info/api"
ETH_RPC = "https://cloudflare-eth.com"

SATOSHIS_PER_BTC = 100_000_000
WEI_PER_ETH = 10 ** 18


async def _btc_price_usd() -> Optional[float]:
    data = await market_service.get_crypto_price("bitcoin")
    return data.get("price_usd") if data else None


async def _eth_price_usd() -> Optional[float]:
    data = await market_service.get_crypto_price("ethereum")
    return data.get("price_usd") if data else None


async def fetch_btc_balance(address: str) -> dict:
    """Return {address, currency: 'BTC', balance, balance_usd, source} for a BTC address.
    Raises ValueError on invalid address or fetch failure."""
    address = address.strip()
    if not address or len(address) < 26 or len(address) > 90:
        raise ValueError("invalid BTC address format")
    url = f"{BLOCKSTREAM_API}/address/{address}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as sess:
            async with sess.get(url) as resp:
                if resp.status == 400:
                    raise ValueError("Blockstream rejected this address (likely malformed)")
                if resp.status == 404:
                    raise ValueError("address not found on the BTC chain")
                if resp.status != 200:
                    raise ValueError(f"Blockstream returned HTTP {resp.status}")
                data = await resp.json()
    except aiohttp.ClientError as e:
        raise ValueError(f"network error: {e}") from e

    chain = data.get("chain_stats") or {}
    funded = int(chain.get("funded_txo_sum", 0))
    spent = int(chain.get("spent_txo_sum", 0))
    balance_sat = funded - spent
    balance_btc = balance_sat / SATOSHIS_PER_BTC
    price = await _btc_price_usd()
    return {
        "address": address,
        "currency": "BTC",
        "balance": balance_btc,
        "balance_usd": round(balance_btc * price, 2) if price else None,
        "price_usd": price,
        "source": "blockstream.info",
    }


async def fetch_eth_balance(address: str) -> dict:
    """Return {address, currency: 'ETH', balance, balance_usd, source} for an ETH address.
    Raises ValueError on invalid address or fetch failure."""
    address = address.strip().lower()
    if not address.startswith("0x") or len(address) != 42:
        raise ValueError("invalid ETH address (expected 0x… 42 chars)")
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_getBalance",
        "params": [address, "latest"],
        "id": 1,
    }
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as sess:
            async with sess.post(ETH_RPC, json=payload) as resp:
                if resp.status != 200:
                    raise ValueError(f"ETH RPC returned HTTP {resp.status}")
                data = await resp.json()
    except aiohttp.ClientError as e:
        raise ValueError(f"network error: {e}") from e

    if "error" in data:
        raise ValueError(data["error"].get("message", "ETH RPC error"))
    hex_balance = data.get("result", "0x0")
    try:
        wei = int(hex_balance, 16)
    except (TypeError, ValueError):
        raise ValueError("ETH RPC returned a malformed balance")
    balance_eth = wei / WEI_PER_ETH
    price = await _eth_price_usd()
    return {
        "address": address,
        "currency": "ETH",
        "balance": balance_eth,
        "balance_usd": round(balance_eth * price, 2) if price else None,
        "price_usd": price,
        "source": "cloudflare-eth.com",
    }
