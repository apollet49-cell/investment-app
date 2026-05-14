from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# Base model for all write-side schemas: reject NaN/Inf floats (would
# corrupt arithmetic downstream) and forbid extra fields (mass-assignment
# defense — extra keys in a POST body now 422 instead of being silently
# dropped, surfacing client/server contract drift).
class StrictBase(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


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
    # NaN/Inf in floats would silently corrupt arithmetic (XIRR Newton's,
    # ROI division). Reject at the schema level.
    model_config = ConfigDict(allow_inf_nan=False)
    name: str = Field(min_length=1, max_length=255)
    type: str
    symbol: Optional[str] = Field(default=None, max_length=64)
    amount_invested: float = Field(gt=0)
    current_value: float = Field(ge=0)
    quantity: Optional[float] = Field(default=None, ge=0)
    monthly_rental_income: Optional[float] = Field(default=None, ge=0)
    monthly_rental_charges: Optional[float] = Field(default=None, ge=0)
    loan_amount: Optional[float] = Field(default=None, ge=0)
    loan_interest_rate_pct: Optional[float] = Field(default=None, ge=0)
    monthly_mortgage_payment: Optional[float] = Field(default=None, ge=0)
    annual_yield_pct: Optional[float] = None
    address: Optional[str] = None
    postal_code: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    surface_sqm: Optional[float] = Field(default=None, ge=0)
    property_subtype: Optional[str] = None
    garden_sqm: Optional[float] = Field(default=None, ge=0)
    account_type: Optional[str] = None
    purchase_date: date
    notes: Optional[str] = None


class InvestmentCreate(InvestmentBase):
    pass


class InvestmentUpdate(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    name: Optional[str] = Field(default=None, max_length=255)
    type: Optional[str] = None
    symbol: Optional[str] = None
    amount_invested: Optional[float] = Field(default=None, gt=0)
    current_value: Optional[float] = Field(default=None, ge=0)
    quantity: Optional[float] = Field(default=None, ge=0)
    monthly_rental_income: Optional[float] = Field(default=None, ge=0)
    monthly_rental_charges: Optional[float] = Field(default=None, ge=0)
    loan_amount: Optional[float] = Field(default=None, ge=0)
    loan_interest_rate_pct: Optional[float] = Field(default=None, ge=0)
    monthly_mortgage_payment: Optional[float] = Field(default=None, ge=0)
    annual_yield_pct: Optional[float] = None
    address: Optional[str] = None
    postal_code: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    surface_sqm: Optional[float] = Field(default=None, ge=0)
    property_subtype: Optional[str] = None
    garden_sqm: Optional[float] = Field(default=None, ge=0)
    account_type: Optional[str] = None
    purchase_date: Optional[date] = None
    notes: Optional[str] = None


class PropertyValuationRequest(BaseModel):
    postal_code: str = Field(min_length=2, max_length=16)
    country: str = "FR"
    surface_sqm: float = Field(gt=0)
    property_subtype: str = "apartment"  # apartment | house | office


class PropertyValuationResponse(BaseModel):
    status: str  # ok | no_data | no_match | unsupported_country | error
    estimated_value_local: Optional[float] = None
    local_currency: Optional[str] = None
    estimated_value_usd: Optional[float] = None
    median_price_per_sqm_local: Optional[float] = None
    comparable_count: int = 0
    source: Optional[str] = None
    samples: list[dict] = []
    message: Optional[str] = None


class InvestmentOut(InvestmentBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    created_at: datetime
    roi_pct: float = 0.0
    # Override the gt=0 constraint from InvestmentBase: when SERIALISING
    # existing rows we tolerate edge data (e.g. inherited real-estate with
    # amount_invested=0, or legacy rows from older schemas). Validation on
    # NEW investments still runs through InvestmentCreate which keeps gt=0.
    amount_invested: float
    current_value: float


class CSVImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[str] = []


# ---------- Scenarios ----------
class ScenarioBase(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
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


class TransactionCreate(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    type: str  # buy | sell | dividend | fee | split
    transaction_date: date
    quantity: Optional[float] = Field(default=None, ge=0)
    price_per_unit: Optional[float] = Field(default=None, ge=0)
    amount: float = Field(gt=0)
    fees: Optional[float] = Field(default=None, ge=0)
    notes: Optional[str] = Field(default=None, max_length=2000)


class TransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    investment_id: int
    type: str
    transaction_date: date
    quantity: Optional[float]
    price_per_unit: Optional[float]
    amount: float
    fees: Optional[float]
    notes: Optional[str]
    created_at: datetime


class DCAPlanCreate(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    name: str = Field(min_length=1, max_length=255)
    symbol: Optional[str] = Field(default=None, max_length=64)
    asset_type: str = "etf"
    amount: float = Field(gt=0)
    frequency: str = "monthly"
    day_of_month: Optional[int] = Field(default=None, ge=1, le=31)
    start_date: date
    is_active: bool = True


class DCAPlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    symbol: Optional[str]
    asset_type: str
    amount: float
    frequency: str
    day_of_month: Optional[int]
    start_date: date
    is_active: bool
    created_at: datetime


class TargetAllocationUpdate(BaseModel):
    target_by_type: dict[str, float]


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
class DiversificationScore(BaseModel):
    score: Optional[float] = None
    risk_score: Optional[float] = None
    position_score: Optional[float] = None
    type_score: Optional[float] = None
    sector_score: Optional[float] = None
    country_score: Optional[float] = None
    positions: int = 0
    top_positions: list[dict[str, Any]] = []
    type_distribution: dict[str, float] = {}
    sector_distribution: dict[str, float] = {}
    country_distribution: dict[str, float] = {}
    risk_factors: list[str] = []
    message: Optional[str] = None


class CarbonFootprint(BaseModel):
    total_tco2e_year: float = 0.0
    tracked_positions: int = 0
    skipped_positions: int = 0
    breakdown: list[dict[str, Any]] = []
    equivalents: dict[str, Any] = {}
    message: Optional[str] = None


class DashboardSummary(BaseModel):
    total_invested: float
    current_value: float
    total_roi_pct: float
    best_performer: Optional[InvestmentOut]
    by_type: dict[str, float]  # asset allocation by type (current_value)
    portfolio_over_time: list[dict[str, Any]]  # [{date, value}]
    monthly_returns: list[dict[str, Any]]  # [{month, return_pct}]
    triggered_alerts: list[AlertOut] = []
    diversification: Optional[DiversificationScore] = None
    carbon: Optional[CarbonFootprint] = None


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
