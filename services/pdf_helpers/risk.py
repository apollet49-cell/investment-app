"""Risk section: a five-row factor table with a sage/amber/terracotta
signal column, a one-paragraph narrative synthesis underneath, plus the
fallback Outlook prose used when the Anthropic key isn't set."""
from reportlab.lib.colors import HexColor
from reportlab.lib.units import cm
from reportlab.platypus import Table, TableStyle

from .palette import BORDER, CREAM, INK, SAGE, TERRA


def _level(metric_pct: float, low: float, high: float) -> tuple[str, object]:
    """Bucket a percentage into Low / Moderate / High with a colour."""
    if metric_pct >= high:
        return ("High", TERRA)
    if metric_pct >= low:
        return ("Moderate", HexColor("#b8945e"))
    return ("Low", SAGE)


def risk_table(rows, by_type, total_value, top_pos, top_pos_pct, largest_class, largest_class_pct) -> Table:
    """Five rows of risk metrics, each with name / metric / signal / level.

    Signal level is bucketed visually as a sage / amber / terracotta dot,
    so a glance at the right column tells you which factors deserve
    attention. The metric formulas are intentionally simple — this is a
    snapshot view, not a Value-at-Risk simulation."""
    n_positions = len([r for r in rows if r.current_value])
    n_classes = len([k for k, v in by_type.items() if v > 0])

    # Liquidity proxy: % real estate (illiquid)
    illiquid_pct = (by_type.get("real_estate", 0) / total_value * 100) if total_value else 0

    pos_level = _level(top_pos_pct, 25, 40)
    class_level = _level(largest_class_pct, 50, 75)
    diversity_pct = max(0, 100 - n_positions * 4)  # 25 positions → 0% risk
    div_level = _level(diversity_pct, 30, 60)
    illiquid_level = _level(illiquid_pct, 30, 60)

    risk_rows = [
        ["Factor", "Metric", "Reading", "Signal"],
        [
            "Single-position concentration",
            f"{top_pos.name if top_pos else '—'}",
            f"{top_pos_pct:.1f}% of net worth",
            pos_level[0],
        ],
        [
            "Asset-class concentration",
            (largest_class or '—').replace('_', ' ').title(),
            f"{largest_class_pct:.1f}% of net worth",
            class_level[0],
        ],
        [
            "Position diversity",
            f"{n_positions} positions / {n_classes} classes",
            "8-12 positions across 3+ classes is the baseline",
            div_level[0],
        ],
        [
            "Illiquidity exposure",
            "Real estate share",
            f"{illiquid_pct:.1f}% of net worth",
            illiquid_level[0],
        ],
        [
            "Bond cushion",
            "Defensive allocation",
            "Present" if by_type.get("bond", 0) > 0 else "Absent",
            "Low" if by_type.get("bond", 0) > 0 else "Moderate",
        ],
    ]

    level_colors = {
        "Low": SAGE,
        "Moderate": HexColor("#b8945e"),
        "High": TERRA,
    }

    tbl = Table(risk_rows, colWidths=[5.5 * cm, 3.5 * cm, 4.7 * cm, 2.3 * cm])
    style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SAGE),
        ("TEXTCOLOR", (0, 0), (-1, 0), CREAM),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("TOPPADDING", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 9),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 1), (-1, -1), 9),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [CREAM, HexColor("#f3ede2")]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 1), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 7),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("ALIGN", (3, 0), (3, -1), "CENTER"),
    ])
    for i, row in enumerate(risk_rows[1:], start=1):
        signal = row[3]
        if signal in level_colors:
            style.add("TEXTCOLOR", (3, i), (3, i), level_colors[signal])
            style.add("FONTNAME", (3, i), (3, i), "Helvetica-Bold")
    tbl.setStyle(style)
    return tbl


def risk_narrative(rows, by_type, total_value, top_pos_pct, largest_class_pct) -> str:
    """One-paragraph synthesis of the risk picture, highlighting the
    single biggest factor to monitor."""
    bits = []
    if top_pos_pct >= 40:
        bits.append(
            f"The portfolio's single largest position alone represents "
            f"{top_pos_pct:.0f}% of net worth — a position-specific shock "
            f"(earnings miss, regulatory event) would materially move the entire portfolio."
        )
    elif top_pos_pct >= 25:
        bits.append(
            f"Single-position concentration is moderate at {top_pos_pct:.0f}% — "
            "high enough to warrant a regular trim discipline if it keeps growing."
        )
    if largest_class_pct >= 75:
        bits.append(
            f"Asset-class concentration is the dominant factor: {largest_class_pct:.0f}% "
            "of net worth sits in one bucket. Correlation within that sleeve dictates the overall ride."
        )
    if not by_type.get("bond"):
        bits.append(
            "No defensive sleeve. Even 10% in short-duration bonds historically "
            "reduces portfolio volatility ~25% — that's a cheap drawdown cushion."
        )
    if not bits:
        bits.append(
            "Risk picture is broadly balanced. Position-level and asset-class "
            "concentrations are within typical ranges; no single factor dominates the profile."
        )
    return " ".join(bits)


def fallback_analysis(rows: list, by_type: dict[str, float], invested: float, value: float, roi_pct: float) -> str:
    """Deterministic narrative when no Anthropic key is set. Doesn't say
    "AI unavailable" — gives a real (rule-based) analysis the user can
    act on."""
    total = sum(by_type.values()) or 1.0
    dominant_type, dominant_val = max(by_type.items(), key=lambda kv: kv[1]) if by_type else ("none", 0)
    dom_pct = (dominant_val / total) * 100
    best = max(rows, key=lambda r: ((r.current_value - r.amount_invested) / r.amount_invested) if r.amount_invested else -1, default=None)
    has_bonds = any(r.type == "bond" for r in rows)
    n_positions = len(rows)

    p1 = (
        f"The portfolio shows a total return of {roi_pct:+.2f}% on "
        f"{invested:,.0f} invested, with a current value of {value:,.0f}. "
    )
    if best and best.amount_invested:
        bp_roi = (best.current_value - best.amount_invested) / best.amount_invested * 100
        p1 += f"The top driver is {best.name} ({bp_roi:+.1f}%), which has done the heavy lifting on the overall return."

    if dom_pct > 70:
        p2 = (
            f"The largest concentration risk is in {dominant_type.replace('_', ' ')} "
            f"at {dom_pct:.0f}% of net worth. A single asset class doing all the work "
            "means the portfolio's fortunes are tied to one cycle — consider 1-2 "
            "uncorrelated sleeves before adding more to the same theme."
        )
    elif n_positions < 5:
        p2 = (
            f"With only {n_positions} positions held, position-level risk is "
            "elevated: a single earnings miss could materially move net worth. "
            "Widening to 8-12 names across at least 3 asset classes is the "
            "comfortable baseline."
        )
    else:
        p2 = (
            f"Allocation looks broadly diversified across {len(by_type)} asset classes. "
            "The main thing to monitor now is correlation creep — re-check at least "
            "annually that the names you hold aren't unknowingly moving together."
        )

    if not has_bonds and value > 50000:
        p3 = (
            "Action item: add a bond sleeve. Even a 10% allocation to short-duration "
            "Treasuries historically cuts portfolio volatility by ~25%. The "
            "opportunity cost is small; the drawdown protection is real."
        )
    elif dom_pct > 50:
        p3 = (
            "Action item: trim the dominant sleeve to ~30-35% of the portfolio over "
            "the next two quarters, and redeploy the freed capital into 2-3 "
            "uncorrelated positions. Discipline beats conviction on rebalancing."
        )
    elif roi_pct > 30:
        p3 = (
            "Action item: lock in some gains. With overall returns north of 30%, "
            "selling winners back to target weights — even partially — captures "
            "the compounding into cash you can redeploy on the next dip."
        )
    else:
        p3 = (
            "Action item: schedule a quarterly review on the calendar. The single "
            "biggest predictor of long-term portfolio performance is reviewing it "
            "without emotion every 90 days, not chasing daily moves."
        )

    return f"{p1}\n\n{p2}\n\n{p3}"
