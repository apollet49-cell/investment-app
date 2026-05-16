from __future__ import annotations

from datetime import datetime, date
from typing import Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base

INVESTMENT_TYPES = ("stock", "real_estate", "crypto", "bond", "etf", "startup")
SUPPORTED_CURRENCIES = ("USD", "EUR", "GBP", "CHF")
RISK_LEVELS = ("low", "medium", "high")
ALERT_TYPES = ("roi_below", "drawdown_above")
ALERT_SCOPES = ("portfolio", "investment")
TRANSACTION_TYPES = ("buy", "sell", "dividend", "fee", "split")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    currency: Mapped[str] = mapped_column(String(8), default="USD", nullable=False)
    encrypted_anthropic_key: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    key_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    # Target allocation by asset type, stored as JSON: {"stock": 60, "crypto": 20, ...}
    target_allocation_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    investments: Mapped[list["Investment"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    scenarios: Mapped[list["Scenario"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    chat_messages: Mapped[list["ChatMessage"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    alerts: Mapped[list["Alert"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    watchlist: Mapped[list["WatchlistItem"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    dca_plans: Mapped[list["DCAPlan"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    snapshots: Mapped[list["PortfolioSnapshot"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Investment(Base):
    __tablename__ = "investments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    symbol: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    amount_invested: Mapped[float] = mapped_column(Float, nullable=False)
    current_value: Mapped[float] = mapped_column(Float, nullable=False)
    quantity: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Real-estate-only: monthly rent received and monthly expenses (taxes,
    # maintenance, etc.). Both nullable; populated only when
    # type == "real_estate". Stored in USD like the other amounts.
    monthly_rental_income: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    monthly_rental_charges: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Real-estate financing (optional). All in USD.
    loan_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    loan_interest_rate_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    monthly_mortgage_payment: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Real-estate property details (used by the DVF valuation feature for FR).
    address: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    postal_code: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    country: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    surface_sqm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    property_subtype: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    garden_sqm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Startup-only: expected annual yield as a percentage (e.g. 12.5 for 12.5%/yr).
    annual_yield_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Tax wrapper (French context): cto | pea | av | per | other
    account_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    purchase_date: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="investments")


class Scenario(Base):
    __tablename__ = "scenarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    horizon_months: Mapped[int] = mapped_column(Integer, nullable=False)
    annual_return: Mapped[float] = mapped_column(Float, nullable=False)
    inflation_rate: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    risk_level: Mapped[str] = mapped_column(String(16), default="medium", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="scenarios")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # "user" or "assistant"
    content: Mapped[str] = mapped_column(Text, nullable=False)
    truncated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="chat_messages")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    scope: Mapped[str] = mapped_column(String(16), default="portfolio", nullable=False)
    investment_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("investments.id", ondelete="CASCADE"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_triggered: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    dismissed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="alerts")


class Transaction(Base):
    """Audit log of every buy/sell/dividend/fee on an investment. Coexists
    with the manual Investment.amount_invested/quantity fields — the
    transactions table is the detailed source of truth for tax accounting
    while the Investment row stays as a fast summary."""
    __tablename__ = "transactions"
    __table_args__ = (
        # Dashboard /performance scans WHERE user_id=? ORDER BY transaction_date.
        # A composite index avoids a sort for the common XIRR / TWR queries.
        Index("ix_tx_user_date", "user_id", "transaction_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    investment_id: Mapped[int] = mapped_column(Integer, ForeignKey("investments.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)  # buy | sell | dividend | fee | split
    transaction_date: Mapped[date] = mapped_column(Date, nullable=False)
    quantity: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    price_per_unit: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    amount: Mapped[float] = mapped_column(Float, nullable=False)  # USD net amount of the transaction
    fees: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="transactions")


DCA_FREQUENCIES = ("weekly", "biweekly", "monthly", "quarterly")


class DCAPlan(Base):
    """Scheduled Dollar Cost Averaging plan — recurring contribution into a
    single asset. The app doesn't execute orders; it just tracks the plan
    and visualises the trajectory so the user can see what their DCA setup
    is doing over time."""
    __tablename__ = "dca_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    symbol: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    asset_type: Mapped[str] = mapped_column(String(16), nullable=False, default="etf")
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    frequency: Mapped[str] = mapped_column(String(16), nullable=False, default="monthly")
    day_of_month: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="dca_plans")


class WatchlistItem(Base):
    __tablename__ = "watchlist"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    symbol: Mapped[str] = mapped_column(String(64), nullable=False)
    asset_type: Mapped[str] = mapped_column(String(16), nullable=False)  # stock | etf | crypto
    name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="watchlist")


class PortfolioSnapshot(Base):
    """Daily snapshot of the user's portfolio. Captured by a scheduled job
    so the dashboard chart shows real historical value (not a linear
    interpolation between purchase date and today). One row per user per
    date — enforced by the unique constraint so concurrent take_snapshot
    calls can't race in two duplicates."""
    __tablename__ = "portfolio_snapshots"
    __table_args__ = (
        UniqueConstraint("user_id", "snapshot_date", name="uq_snapshot_user_date"),
        # Composite covers the (user_id, snapshot_date >= cutoff) queries in
        # /dashboard/history and /dashboard/risk. Postgres can satisfy both
        # the filter and the ORDER BY from this single index, avoiding a sort
        # when the time-window is small.
        Index("ix_snap_user_date", "user_id", "snapshot_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    total_value: Mapped[float] = mapped_column(Float, nullable=False)
    total_invested: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    user: Mapped["User"] = relationship(back_populates="snapshots")


class MarketDataCache(Base):
    """Postgres-backed cache for yfinance / external market data.

    The in-memory TTLCache in services/market_data.py is fast but resets
    on every Render restart (and the free tier sleeps after 15min idle —
    every wake-up is a fresh cache). This Postgres mirror survives
    restarts so the first user after a wake-up doesn't pay the cold yfinance hit.

    Keyed by (kind, key) so different data shapes coexist:
      - kind='stock'      key='AAPL'
      - kind='crypto'     key='bitcoin'
      - kind='forex'      key='USD-EUR'
      - kind='historical' key='^GSPC:1y'
      - kind='dividend'   key='AAPL'

    Hot path stays the in-memory cache; this is the slow-path safety net.
    The hourly scheduler job purges entries older than 24h to bound DB size.
    """
    __tablename__ = "market_data_cache"
    __table_args__ = (
        UniqueConstraint("kind", "key", name="uq_mdc_kind_key"),
        Index("ix_mdc_expires", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    key: Mapped[str] = mapped_column(String(128), nullable=False)
    payload: Mapped[str] = mapped_column(Text, nullable=False)  # JSON-encoded
    fetched_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

