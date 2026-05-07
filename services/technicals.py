"""Hand-rolled technical indicators in pandas. Avoids the pandas-ta dependency
which has been flaky against pandas 2.x. Inputs are pandas Series of close prices.
Outputs are lists of `[value | None]` aligned with the input length so the
frontend can plot them as overlays on the candlestick chart.
"""
from __future__ import annotations

from typing import Optional

import pandas as pd


def _series_to_list(s: pd.Series) -> list[Optional[float]]:
    return [None if pd.isna(v) else float(v) for v in s]


def sma(close: pd.Series, period: int) -> list[Optional[float]]:
    return _series_to_list(close.rolling(window=period, min_periods=period).mean())


def rsi(close: pd.Series, period: int = 14) -> list[Optional[float]]:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(window=period, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).rolling(window=period, min_periods=period).mean()
    rs = gain / loss.replace(0, pd.NA)
    rsi_series = 100 - (100 / (1 + rs))
    return _series_to_list(rsi_series)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> dict[str, list[Optional[float]]]:
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return {
        "macd": _series_to_list(macd_line),
        "signal": _series_to_list(signal_line),
        "histogram": _series_to_list(histogram),
    }


def compute_all(close: pd.Series) -> dict:
    return {
        "ma20": sma(close, 20),
        "ma50": sma(close, 50),
        "ma200": sma(close, 200),
        "rsi14": rsi(close, 14),
        "macd": macd(close),
    }
