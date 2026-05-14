from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# ---------- Auth ----------
class UserRegister(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=6, max_length=128)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: EmailStr
    name: str
    currency: str
    has_anthropic_key: bool = False
    created_at: datetime


# ---------- Investments ----------
class InvestmentBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    type: str
    symbol: Optional[str] = None
    amount_invested: float = Field(gt=0)
    current_value: float = Field(ge=0)
    quantity: Optional[float] = Field(default=None, ge=0)
    purchase_date: date
    notes: Optional[str] = None


class InvestmentCreate(InvestmentBase):
    pass


class InvestmentUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    symbol: Optional[str] = None
    amount_invested: Optional[float] = Field(default=None, gt=0)
    current_value: Optional[float] = Field(default=None, ge=0)
    quantity: Optional[float] = Field(default=None, ge=0)
    purchase_date: Optional[date] = None
    notes: Optional[str] = None


class InvestmentOut(InvestmentBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    created_at: datetime
    roi_pct: float = 0.0


class CSVImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[str] = []


# ---------- Scenarios ----------
class ScenarioBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    amount: float = Field(gt=0)
    horizon_months: int = Field(gt=0, le=600)
    annual_return: float
    inflation_rate: float = 0.0
    risk_level: str = "medium"


class ScenarioCreate(ScenarioBase):
    pass


class ScenarioOut(ScenarioBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    created_at: datetime


class ScenarioSubResult(BaseModel):
    label: str
    annual_return: float
    final_value: float
    final_value_real: float  # inflation-adjusted
    points: list[dict[str, float]]  # [{month, value, value_real}, ...]


class ScenarioSimulation(BaseModel):
    scenario: ScenarioOut
    pessimistic: ScenarioSubResult
    realistic: ScenarioSubResult
    optimistic: ScenarioSubResult
    recommendation: str


# ---------- Calculator ----------
class CalcResult(BaseModel):
    mode: str
    formula: str
    inputs: dict[str, Any]
    steps: list[str]
    result: Any


# ---------- Chat ----------
class ChatMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    role: str
    content: str
    truncated: bool
    created_at: datetime


class ChatSendRequest(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


# ---------- Settings ----------
class SettingsUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    password: Optional[str] = Field(default=None, min_length=6)
    currency: Optional[str] = None
    anthropic_api_key: Optional[str] = None  # plaintext input; will be encrypted server-side


# ---------- Alerts ----------
class AlertCreate(BaseModel):
    type: str
    threshold: float
    scope: str = "portfolio"
    investment_id: Optional[int] = None


class WatchlistItemCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    asset_type: str
    name: Optional[str] = None


class WatchlistItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    symbol: str
    asset_type: str
    name: Optional[str]
    created_at: datetime


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    type: str
    threshold: float
    scope: str
    investment_id: Optional[int]
    is_active: bool
    is_triggered: bool
    dismissed_at: Optional[datetime]
    created_at: datetime


# ---------- Dashboard ----------
class DashboardSummary(BaseModel):
    total_invested: float
    current_value: float
    total_roi_pct: float
    best_performer: Optional[InvestmentOut]
    by_type: dict[str, float]  # asset allocation by type (current_value)
    portfolio_over_time: list[dict[str, Any]]  # [{date, value}]
    monthly_returns: list[dict[str, Any]]  # [{month, return_pct}]
    triggered_alerts: list[AlertOut] = []


# ---------- Market data ----------
class Quote(BaseModel):
    symbol: str
    price: float
    change: Optional[float] = None
    change_pct: Optional[float] = None
    volume: Optional[float] = None
    market_cap: Optional[float] = None
    currency: str = "USD"
    source: str
    last_updated: datetime


class CryptoQuote(BaseModel):
    name: str
    symbol: str
    price_usd: float
    price_btc: Optional[float] = None
    change_24h: Optional[float] = None
    market_cap: Optional[float] = None
    volume_24h: Optional[float] = None
    source: str
    last_updated: datetime


class ForexRate(BaseModel):
    pair: str
    rate: float
    change_24h: Optional[float] = None
    source: str
    timestamp: datetime


class IndexQuote(BaseModel):
    name: str
    symbol: str
    value: float
    change: Optional[float] = None
    change_pct: Optional[float] = None
    ytd_return: Optional[float] = None
    week52_high: Optional[float] = None
    week52_low: Optional[float] = None


class MacroIndicator(BaseModel):
    country: str
    indicator: str
    value: float
    unit: str
    period: str
    source: str


class VerificationResult(BaseModel):
    symbol: str
    verified_price: Optional[float]
    confidence_score: float
    sources_used: list[str]
    sources_failed: list[str]
    deviation_pct: float
    status: str  # VERIFIED | SUSPICIOUS | UNVERIFIED
    all_prices_by_source: dict[str, float]
    median_price: Optional[float]
    mean_price: Optional[float]
    min_price: Optional[float]
    max_price: Optional[float]
    std_deviation: Optional[float]


TokenResponse.model_rebuild()
