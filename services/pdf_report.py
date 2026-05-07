"""PDF report generation using ReportLab + matplotlib (Agg headless backend)."""
from __future__ import annotations

import io
import logging
from datetime import date

import matplotlib

matplotlib.use("Agg")  # MUST be set before pyplot import in a server process
import matplotlib.pyplot as plt  # noqa: E402
from reportlab.lib import colors  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import getSampleStyleSheet  # noqa: E402
from reportlab.lib.units import cm  # noqa: E402
from reportlab.platypus import (  # noqa: E402
    Image,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy.orm import Session  # noqa: E402

from models import Investment, User  # noqa: E402
from services.ai_service import APIKeyMissingError, one_shot  # noqa: E402

log = logging.getLogger("pdf_report")


def _allocation_chart(by_type: dict[str, float]) -> io.BytesIO:
    fig, ax = plt.subplots(figsize=(5, 4))
    if by_type:
        labels = list(by_type.keys())
        values = list(by_type.values())
        ax.pie(values, labels=labels, autopct="%1.1f%%", startangle=90)
        ax.set_title("Allocation by asset type")
    else:
        ax.text(0.5, 0.5, "No investments", ha="center", va="center")
        ax.axis("off")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=120)
    plt.close(fig)
    buf.seek(0)
    return buf


def _value_chart(rows: list[Investment]) -> io.BytesIO:
    fig, ax = plt.subplots(figsize=(6, 3.5))
    if rows:
        names = [r.name for r in rows[:10]]
        invested = [r.amount_invested for r in rows[:10]]
        current = [r.current_value for r in rows[:10]]
        x = range(len(names))
        ax.bar([i - 0.2 for i in x], invested, width=0.4, label="Invested", color="#94a3b8")
        ax.bar([i + 0.2 for i in x], current, width=0.4, label="Current", color="#0ea5e9")
        ax.set_xticks(list(x))
        ax.set_xticklabels(names, rotation=30, ha="right")
        ax.legend()
        ax.set_title("Top investments — invested vs current value")
    else:
        ax.text(0.5, 0.5, "No investments", ha="center", va="center")
        ax.axis("off")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=120)
    plt.close(fig)
    buf.seek(0)
    return buf


def generate_pdf(db: Session, user: User) -> bytes:
    rows = db.query(Investment).filter(Investment.user_id == user.id).all()
    total_invested = sum(r.amount_invested for r in rows)
    total_value = sum(r.current_value for r in rows)
    roi = ((total_value - total_invested) / total_invested * 100.0) if total_invested > 0 else 0.0

    by_type: dict[str, float] = {}
    for r in rows:
        by_type[r.type] = by_type.get(r.type, 0.0) + r.current_value
    top5 = sorted(rows, key=lambda r: r.current_value, reverse=True)[:5]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=2 * cm)
    styles = getSampleStyleSheet()
    story = [
        Paragraph(f"Investment Report — {user.name}", styles["Title"]),
        Paragraph(f"Generated {date.today().isoformat()} | Currency: {user.currency}", styles["Normal"]),
        Spacer(1, 0.4 * cm),
        Paragraph("Portfolio summary", styles["Heading2"]),
        Table(
            [
                ["Metric", "Value"],
                ["Total invested", f"{total_invested:,.2f} {user.currency}"],
                ["Current value", f"{total_value:,.2f} {user.currency}"],
                ["Total ROI", f"{roi:+.2f}%"],
                ["Number of investments", str(len(rows))],
            ],
            hAlign="LEFT",
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ]),
        ),
        Spacer(1, 0.6 * cm),
        Paragraph("Asset allocation", styles["Heading2"]),
        Image(_allocation_chart(by_type), width=12 * cm, height=9 * cm),
        Spacer(1, 0.4 * cm),
        Paragraph("Top investments", styles["Heading2"]),
        Image(_value_chart(rows), width=15 * cm, height=8 * cm),
        Spacer(1, 0.4 * cm),
    ]

    if top5:
        story.append(Paragraph("Top 5 holdings", styles["Heading2"]))
        data = [["Name", "Type", "Invested", "Current", "ROI %"]]
        for r in top5:
            r_roi = ((r.current_value - r.amount_invested) / r.amount_invested * 100.0) if r.amount_invested > 0 else 0.0
            data.append([r.name, r.type, f"{r.amount_invested:,.2f}", f"{r.current_value:,.2f}", f"{r_roi:+.2f}%"])
        story.append(Table(data, hAlign="LEFT", style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ])))
        story.append(Spacer(1, 0.4 * cm))

    story.append(Paragraph("AI recommendations", styles["Heading2"]))
    try:
        ai_text = one_shot(
            db,
            user,
            "Give a 2-paragraph summary of this portfolio's strengths, weaknesses, and one concrete recommendation.",
            max_tokens=600,
        )
    except APIKeyMissingError:
        ai_text = "AI recommendations unavailable: set an Anthropic API key in Settings."
    except Exception as e:  # noqa: BLE001
        log.exception("AI recommendation failed: %s", e)
        ai_text = "AI recommendations unavailable: the model service did not respond."
    for paragraph in ai_text.split("\n\n"):
        story.append(Paragraph(paragraph.replace("\n", "<br/>"), styles["BodyText"]))
        story.append(Spacer(1, 0.2 * cm))

    doc.build(story)
    return buf.getvalue()
