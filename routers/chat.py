"""Agentic chat — Claude with tool access to the user's portfolio.

Conceptually the inverse of the old streaming chatbot: instead of just
prosing about the portfolio summary baked into the system prompt, Claude
here is given a toolbox of read-only API calls and decides which ones to
fire to answer the user's question. The user can ask things like
"what's my biggest risk?", "would my XIRR survive a 30% BTC drop?",
"what would I owe if I sold today?" — Claude consults the relevant
endpoint(s) and stitches the answer.

Read-only by design: tools query the user's own data, never mutate.
Per-user Anthropic key honoured (encrypted via crypto.py); falls back to
the global env key if the user hasn't provided one.

Loop bounded at 6 tool-use rounds to defend against runaway chains.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from anthropic import Anthropic, APIError, AuthenticationError, RateLimitError
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import User
from services.ai_service import APIKeyMissingError, _resolve_key, build_system_prompt
from settings import settings

log = logging.getLogger("chat")

router = APIRouter(prefix="/chat", tags=["chat"])

MAX_TOOL_ROUNDS = 6
MAX_TOKENS_PER_TURN = 1500


# ─────────────────────────── REQUEST / RESPONSE ───────────────────────────

class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class AskRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)


class ToolCallRecord(BaseModel):
    name: str
    input: dict[str, Any]


class AskResponse(BaseModel):
    reply: str
    tools_used: list[ToolCallRecord] = Field(default_factory=list)
    stop_reason: Optional[str] = None


# ─────────────────────────── TOOL SCHEMAS ───────────────────────────
# Anthropic tool-use shape: each entry has name, description, input_schema.
# Input schemas are minimal JSON Schema — we keep them tight so Claude
# doesn't hallucinate fancy params we don't honour.

TOOLS = [
    {
        "name": "get_portfolio_summary",
        "description": "Total portfolio value, total invested, overall ROI, "
                       "best performer, allocation by asset type, monthly returns "
                       "and recent portfolio-over-time series. The first stop for "
                       "almost any portfolio question.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "list_investments",
        "description": "List every position with name, symbol, type, account_type "
                       "(PEA/CTO/AV/PER), invested amount, current value and ROI %.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_performance_metrics",
        "description": "Honest performance: XIRR (cashflow-weighted return), "
                       "TWR (time-weighted), CAGR. Use this when asked about "
                       "real returns, beating the market, or annualised performance.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_risk_metrics",
        "description": "Risk profile from real daily snapshots: annualised "
                       "volatility, max drawdown, beta vs S&P 500, Sharpe ratio, "
                       "and a composite risk score 0-100.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Lookback window in days (default 180).", "minimum": 30, "maximum": 3650},
            },
            "required": [],
        },
    },
    {
        "name": "get_history_vs_benchmark",
        "description": "Daily portfolio value series + the S&P 500 benchmark "
                       "rebased to 100, over the requested window. Use for "
                       "'am I beating the market' questions.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Window in days (default 365).", "minimum": 30, "maximum": 3650},
            },
            "required": [],
        },
    },
    {
        "name": "get_tax_simulation",
        "description": "What the user would owe if they sold today, side-by-side "
                       "across CTO / PEA / AV / PER tax wrappers (France). "
                       "Includes the PEA contribution cap tracker.",
        "input_schema": {
            "type": "object",
            "properties": {
                "tmi": {"type": "integer", "description": "Tranche Marginale d'Imposition in % (0, 11, 30, 41, 45). Default 30."},
                "pea_years": {"type": "integer", "description": "PEA holding years. Default 5."},
                "av_years": {"type": "integer", "description": "AV (assurance-vie) holding years. Default 8."},
            },
            "required": [],
        },
    },
    {
        "name": "get_fire_projection",
        "description": "Years until financial independence using the 25× rule. "
                       "Inputs in USD/month. Outputs years_to_fire, progress_pct, "
                       "target_portfolio, and a year-by-year trajectory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "monthly_expenses": {"type": "number", "description": "Target monthly expenses in USD."},
                "monthly_savings": {"type": "number", "description": "Monthly savings in USD."},
                "expected_return_pct": {"type": "number", "description": "Expected real annual return %. Default 7."},
                "target_multiplier": {"type": "number", "description": "FIRE multiplier. 25 = 4% rule. Default 25."},
            },
            "required": ["monthly_expenses", "monthly_savings"],
        },
    },
    {
        "name": "run_stress_test",
        "description": "Run pre-defined macro stress scenarios (2008 crisis, "
                       "COVID, tech crash, etc.) against the current portfolio. "
                       "Returns per-scenario expected loss in USD and %.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_dividends_estimate",
        "description": "Annual dividend income estimate + upcoming ex-dividend "
                       "dates per position. Use when asked about income or cashflow.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "list_alerts",
        "description": "User's active price/drawdown alerts and whether any are "
                       "currently triggered.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
]

TOOL_NAMES = {t["name"] for t in TOOLS}


# ─────────────────────────── TOOL EXECUTION ───────────────────────────
# Each tool calls the same underlying handler that the matching HTTP route
# uses, so the data Claude sees IS the data the dashboard sees. We import
# the handlers lazily to avoid circular dependencies at module load time.

async def _run_tool(name: str, args: dict[str, Any], user: User, db: Session) -> Any:
    """Dispatch one Claude tool-call. Always returns a serialisable dict —
    on error we return {"error": "..."} so Claude can recover gracefully
    instead of the whole turn 500ing."""
    try:
        if name == "get_portfolio_summary":
            from routers.dashboard import summary as _summary
            res = await _summary(current=user, db=db)
            # Pydantic model -> dict for JSON serialisation
            return res.model_dump() if hasattr(res, "model_dump") else res

        if name == "list_investments":
            from models import Investment
            rows = db.query(Investment).filter(Investment.user_id == user.id).all()
            return {
                "count": len(rows),
                "positions": [
                    {
                        "id": r.id, "name": r.name, "symbol": r.symbol, "type": r.type,
                        "account_type": r.account_type, "amount_invested": r.amount_invested,
                        "current_value": r.current_value, "quantity": r.quantity,
                        "purchase_date": str(r.purchase_date),
                        "roi_pct": round(((r.current_value - r.amount_invested) / r.amount_invested * 100) if r.amount_invested else 0, 2),
                    }
                    for r in rows
                ],
            }

        if name == "get_performance_metrics":
            from routers.dashboard import performance as _perf
            return await _perf(current=user, db=db)

        if name == "get_risk_metrics":
            from routers.dashboard import risk as _risk
            days = int(args.get("days", 180))
            return await _risk(days=days, benchmark="^GSPC", current=user, db=db)

        if name == "get_history_vs_benchmark":
            from routers.dashboard import history as _hist
            days = int(args.get("days", 365))
            return await _hist(days=days, benchmark="^GSPC", current=user, db=db)

        if name == "get_tax_simulation":
            from routers.tax import summary as _tax
            tmi = int(args.get("tmi", 30))
            pea_years = int(args.get("pea_years", 5))
            av_years = int(args.get("av_years", 8))
            return await _tax(tmi=tmi, pea_years=pea_years, av_years=av_years, current=user, db=db)

        if name == "get_fire_projection":
            from routers.planning import fire as _fire
            return await _fire(
                monthly_expenses=float(args["monthly_expenses"]),
                monthly_savings=float(args["monthly_savings"]),
                expected_return_pct=float(args.get("expected_return_pct", 7.0)),
                target_multiplier=float(args.get("target_multiplier", 25.0)),
                inflation_pct=2.0,
                current=user, db=db,
            )

        if name == "run_stress_test":
            from routers.planning import stress_test as _stress
            return await _stress(current=user, db=db)

        if name == "get_dividends_estimate":
            from routers.dividends import calendar as _div
            return await _div(current=user, db=db)

        if name == "list_alerts":
            from models import Alert
            rows = db.query(Alert).filter(Alert.user_id == user.id, Alert.is_active == True).all()
            return {
                "count": len(rows),
                "alerts": [
                    {"id": a.id, "type": a.type, "threshold": a.threshold,
                     "scope": a.scope, "is_triggered": a.is_triggered}
                    for a in rows
                ],
            }

        return {"error": f"unknown tool: {name}"}
    except Exception as e:
        log.warning("tool %s failed: %s", name, e)
        return {"error": str(e)}


# ─────────────────────────── ENDPOINT ───────────────────────────

def _system_prompt() -> str:
    return (
        "You are InvestAI, a portfolio analyst embedded inside the InvestApp web "
        "app. The current user is logged in; you have read-only tool access to "
        "their actual investment data. Always call tools to get real numbers "
        "before answering — never fabricate values. Cite specific figures the "
        "tools return. Be concise: 2-4 short paragraphs, with concrete numbers "
        "and one clear takeaway at the end. French-friendly: if the user writes "
        "in French, answer in French; otherwise English. Never give generic "
        "financial-advisor disclaimers; the app's /disclaimer page covers that. "
        "If a tool fails or returns no data, say so honestly instead of guessing."
    )


@router.post("/ask", response_model=AskResponse)
async def ask(
    payload: AskRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AskResponse:
    """One round of agentic chat. Claude may call tools up to MAX_TOOL_ROUNDS
    times before returning a final text response. History is supplied by the
    client per request (no server-side persistence — keeps the surface small)."""
    try:
        api_key = _resolve_key(current)
    except APIKeyMissingError:
        raise HTTPException(
            status_code=400,
            detail="No Anthropic API key configured. Add one in Settings.",
        )

    client = Anthropic(api_key=api_key)

    # Build the message stream: prior history + new user message.
    messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content}
        for m in payload.history
        if m.role in ("user", "assistant")
    ]
    messages.append({"role": "user", "content": payload.message})

    tools_used: list[ToolCallRecord] = []
    stop_reason: Optional[str] = None

    try:
        for _round in range(MAX_TOOL_ROUNDS):
            resp = client.messages.create(
                model=settings.ANTHROPIC_MODEL,
                max_tokens=MAX_TOKENS_PER_TURN,
                system=_system_prompt(),
                tools=TOOLS,
                messages=messages,
            )
            stop_reason = resp.stop_reason

            # Append Claude's full response (text + tool_use blocks) to history,
            # then execute any tool calls and feed back their results.
            messages.append({"role": "assistant", "content": resp.content})

            tool_uses = [b for b in resp.content if getattr(b, "type", "") == "tool_use"]
            if not tool_uses:
                # Pure text reply — we're done.
                text_parts = [b.text for b in resp.content if getattr(b, "type", "") == "text"]
                return AskResponse(
                    reply="".join(text_parts).strip() or "(no response)",
                    tools_used=tools_used,
                    stop_reason=stop_reason,
                )

            tool_results = []
            for tu in tool_uses:
                if tu.name not in TOOL_NAMES:
                    result = {"error": f"unknown tool: {tu.name}"}
                else:
                    tools_used.append(ToolCallRecord(name=tu.name, input=dict(tu.input)))
                    result = await _run_tool(tu.name, dict(tu.input), current, db)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": _stringify(result),
                })
            messages.append({"role": "user", "content": tool_results})

        # Hit the round cap — return whatever last text we had.
        text_parts = [
            b.text for m in messages if isinstance(m.get("content"), list)
            for b in m["content"] if getattr(b, "type", "") == "text"
        ]
        return AskResponse(
            reply=(text_parts[-1] if text_parts else "I needed more tool calls than I'm allowed. Please rephrase or split your question."),
            tools_used=tools_used,
            stop_reason="max_rounds",
        )
    except AuthenticationError:
        raise HTTPException(status_code=400, detail="Anthropic API key was rejected. Update it in Settings.")
    except RateLimitError:
        raise HTTPException(status_code=429, detail="Anthropic rate limit hit. Try again in a moment.")
    except APIError as e:
        log.exception("Anthropic API error: %s", e)
        raise HTTPException(status_code=502, detail="AI service is temporarily unavailable.")
    except HTTPException:
        # Already-shaped HTTP errors (from _resolve_key etc.) pass through.
        raise
    except Exception as e:
        # Catch-all so an unexpected exception in a tool handler (e.g. a
        # KeyError on a freshly-seeded demo account, a SQLAlchemy edge case)
        # surfaces as a clean 500 with an actionable detail instead of a
        # generic Internal Server Error with empty body that the frontend
        # then renders as "Network error". Full traceback in the server log.
        log.exception("Unexpected error in /chat/ask: %s", e)
        raise HTTPException(
            status_code=500,
            detail=f"Chat failed: {type(e).__name__}: {str(e)[:200] or 'unknown error'}",
        )


def _stringify(value: Any) -> str:
    """Anthropic's tool_result content must be string-or-list-of-blocks. We
    JSON-serialise dicts/lists so Claude reads structured data; primitives
    pass through as str()."""
    import json
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=str, ensure_ascii=False)
    except Exception:
        return str(value)
