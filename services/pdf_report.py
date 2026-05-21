"""PDF report orchestration.

This file decides which sections appear in which order and ties them
together with ReportLab's Platypus build pipeline. The visual building
blocks (hero band, KPI strip, charts, risk table, prose fallback) live
in `services.pdf_helpers` so this file can stay focused on the story.
"""
from __future__ import annotations

import io
import logging
from datetime import date

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import (
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy.orm import Session

from models import Investment, User
from services.ai_service import APIKeyMissingError, one_shot
from services.pdf_helpers import (
    BORDER,
    CREAM,
    HeroBand,
    INK,
    INK_SOFT,
    SAGE,
    TERRA,
    allocation_chart,
    allocation_legend_table,
    fallback_analysis,
    kpi_strip,
    on_page,
    risk_narrative,
    risk_table,
    section_header,
    value_chart,
)

log = logging.getLogger("pdf_report")


def generate_pdf(db: Session, user: User) -> bytes:
    rows = db.query(Investment).filter(Investment.user_id == user.id).all()
    total_invested = sum(r.amount_invested for r in rows)
    total_value = sum(r.current_value for r in rows)
    roi_pct = ((total_value - total_invested) / total_invested * 100.0) if total_invested > 0 else 0.0

    by_type: dict[str, float] = {}
    for r in rows:
        by_type[r.type] = by_type.get(r.type, 0.0) + r.current_value
    top5 = sorted(rows, key=lambda r: r.current_value, reverse=True)[:5]
    best = max(rows, key=lambda r: ((r.current_value - r.amount_invested) / r.amount_invested) if r.amount_invested else -1, default=None)
    top_pos = max(rows, key=lambda r: r.current_value, default=None)
    top_pos_pct = ((top_pos.current_value / total_value) * 100) if top_pos and total_value else 0
    largest_class, largest_class_val = max(by_type.items(), key=lambda kv: kv[1]) if by_type else (None, 0)
    largest_class_pct = (largest_class_val / total_value * 100) if total_value else 0

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.6 * cm, bottomMargin=2 * cm,
        title=f"InvestApp Report — {user.name}",
        author="InvestApp",
    )

    styles = getSampleStyleSheet()
    body_style = ParagraphStyle(
        "body", parent=styles["BodyText"],
        fontName="Helvetica", fontSize=10, leading=14, textColor=INK,
        spaceAfter=8,
    )
    caption_style = ParagraphStyle(
        "caption", fontName="Times-Italic", fontSize=10, leading=13,
        textColor=INK_SOFT, spaceAfter=6,
    )

    story: list = []

    subtitle = f"{user.name} · {user.currency} · {date.today().strftime('%B %Y')}"
    story.append(HeroBand("Portfolio Report", subtitle))
    story.append(Spacer(1, 14))

    story.append(kpi_strip(total_invested, total_value, roi_pct, user.currency))
    story.append(Spacer(1, 22))

    # Asset allocation: chart on the left, legend table on the right.
    story.append(section_header("Asset allocation", eyebrow="01 · Composition"))
    chart_img = Image(allocation_chart(by_type), width=7.5 * cm, height=6.0 * cm)
    legend = allocation_legend_table(by_type) if by_type else Paragraph("No data", caption_style)
    side_by_side = Table([[chart_img, legend]], colWidths=[8 * cm, 8.5 * cm])
    side_by_side.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(side_by_side)
    if by_type:
        total_v = sum(by_type.values()) or 1
        dominant = max(by_type.items(), key=lambda kv: kv[1])
        pct = (dominant[1] / total_v) * 100
        cap = f"{dominant[0].replace('_', ' ').title()} is the largest sleeve at {pct:.1f}% of the portfolio."
        story.append(Spacer(1, 6))
        story.append(Paragraph(cap, caption_style))

    story.append(Spacer(1, 10))

    # Compact top-investments chart so it fits on page 1 below the
    # allocation section. The full holdings table on page 2 carries detail.
    story.append(section_header("Top investments — invested vs current value", eyebrow="02 · Performance"))
    story.append(Image(value_chart(rows), width=17 * cm, height=4.8 * cm))
    story.append(Spacer(1, 2))
    if best and best.amount_invested:
        bp_roi = (best.current_value - best.amount_invested) / best.amount_invested * 100
        sign = "+" if bp_roi >= 0 else ""
        story.append(Paragraph(f"Best performer: <b>{best.name}</b> ({sign}{bp_roi:.1f}%).", caption_style))

    story.append(PageBreak())

    # Top 5 holdings table.
    if top5:
        story.append(section_header("Top 5 holdings", eyebrow="03 · Detail"))
        header = ["Name", "Type", "Invested", "Current", "ROI"]
        body = []
        for r in top5:
            r_roi = ((r.current_value - r.amount_invested) / r.amount_invested * 100.0) if r.amount_invested > 0 else 0.0
            roi_str = f"+{r_roi:.1f}%" if r_roi >= 0 else f"{r_roi:.1f}%"
            body.append([
                r.name,
                r.type.replace("_", " ").title(),
                f"{r.amount_invested:,.0f}",
                f"{r.current_value:,.0f}",
                roi_str,
            ])
        tbl = Table([header] + body, colWidths=[5.5 * cm, 2.5 * cm, 2.7 * cm, 2.7 * cm, 2.6 * cm])
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), SAGE),
            ("TEXTCOLOR", (0, 0), (-1, 0), CREAM),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 9),
            ("TOPPADDING", (0, 0), (-1, 0), 9),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 9),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 1), (-1, -1), 9.5),
            ("TEXTCOLOR", (0, 1), (-1, -1), INK),
            ("ALIGN", (2, 1), (-1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [CREAM, HexColor("#f3ede2")]),
            ("LINEBELOW", (0, 0), (-1, -1), 0.3, BORDER),
            ("TOPPADDING", (0, 1), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 8),
            *[(("TEXTCOLOR", (4, i + 1), (4, i + 1),
                SAGE if not body[i][4].startswith("-") else TERRA)) for i in range(len(body))],
        ]))
        story.append(tbl)
        story.append(Spacer(1, 16))

    # Risk profile.
    story.append(section_header("Risk profile", eyebrow="04 · Risk"))
    story.append(risk_table(rows, by_type, total_value, top_pos, top_pos_pct, largest_class, largest_class_pct))
    story.append(Spacer(1, 8))
    story.append(Paragraph(risk_narrative(rows, by_type, total_value, top_pos_pct, largest_class_pct), body_style))
    story.append(Spacer(1, 14))

    # Outlook — AI-augmented when a key is available, deterministic
    # fallback when not. The user shouldn't see "AI unavailable"; the
    # fallback gives a real rule-based analysis.
    story.append(section_header("Outlook & action items", eyebrow="05 · Outlook"))
    try:
        ai_text = one_shot(
            db, user,
            "Write a 3-paragraph analytical commentary on this portfolio: "
            "(1) what's working and the key drivers of return, "
            "(2) the single biggest concentration or correlation risk you see, "
            "(3) one specific, numbered action item the user should consider this quarter. "
            "Be direct and specific with numbers. No generic financial-advisor disclaimers. "
            "Max 220 words total. No bullet lists, no headers — flowing prose.",
            max_tokens=700,
        )
    except APIKeyMissingError:
        ai_text = fallback_analysis(rows, by_type, total_invested, total_value, roi_pct)
    except Exception as e:  # noqa: BLE001
        log.warning("AI analysis fallback: %s", e)
        ai_text = fallback_analysis(rows, by_type, total_invested, total_value, roi_pct)

    for paragraph in ai_text.split("\n\n"):
        clean = paragraph.replace("\n", " ").strip()
        if clean:
            story.append(Paragraph(clean, body_style))

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()
