"""PDF report generation using ReportLab + Pillow.

Pillow replaces matplotlib for the charts — matplotlib was ~50MB on disk
(+ pulled scipy / fontconfig / freetype bloat in a hot path that only
renders 2 simple charts). Pillow is already a transitive dep of ReportLab
so we add zero new dependencies.
"""
from __future__ import annotations

import io
import logging
import math
from datetime import date

from PIL import Image as PILImage, ImageDraw, ImageFont  # noqa: E402
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


# Earth-tone palette matching the rest of the app. Each chart picks
# from this list in order, so a fresh portfolio gets consistent colours.
_PALETTE = [
    (138, 117, 88),    # taupe
    (107, 125, 94),    # sage
    (184, 148, 94),    # warm amber
    (122, 139, 154),   # muted slate
    (157, 127, 143),   # dusty mauve
    (165, 101, 81),    # terracotta
    (180, 165, 145),   # light taupe
    (140, 155, 130),   # light sage
]
_BG = (250, 247, 242)
_INK = (42, 36, 30)
_INK_SOFT = (122, 111, 93)
_GRID = (217, 207, 185)


def _font(size: int) -> ImageFont.FreeTypeFont:
    """Try a few common system fonts, fall back to PIL's bitmap."""
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",        # macOS
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",     # Linux
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def _allocation_chart(by_type: dict[str, float]) -> io.BytesIO:
    """Doughnut-style allocation chart."""
    W, H = 720, 540
    img = PILImage.new("RGB", (W, H), _BG)
    draw = ImageDraw.Draw(img)
    title_font = _font(22)
    label_font = _font(15)
    pct_font = _font(14)

    draw.text((W // 2, 24), "Allocation by asset type", font=title_font, fill=_INK, anchor="mt")

    if not by_type:
        draw.text((W // 2, H // 2), "No investments", font=label_font, fill=_INK_SOFT, anchor="mm")
    else:
        cx, cy, R, r_inner = W // 2 - 100, H // 2 + 20, 170, 90
        total = sum(by_type.values()) or 1.0
        # Slices
        start_angle = -90.0
        items = list(by_type.items())
        for i, (typ, value) in enumerate(items):
            slice_pct = value / total
            extent = slice_pct * 360.0
            color = _PALETTE[i % len(_PALETTE)]
            draw.pieslice([cx - R, cy - R, cx + R, cy + R], start=start_angle,
                          end=start_angle + extent, fill=color)
            start_angle += extent
        # Doughnut hole
        draw.ellipse([cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner], fill=_BG)
        # Legend on the right
        legend_x, legend_y = W - 240, 90
        for i, (typ, value) in enumerate(items):
            color = _PALETTE[i % len(_PALETTE)]
            draw.rectangle([legend_x, legend_y, legend_x + 14, legend_y + 14], fill=color)
            pct = value / total * 100
            draw.text((legend_x + 22, legend_y - 1), typ, font=label_font, fill=_INK)
            draw.text((legend_x + 22, legend_y + 16), f"{pct:.1f}%", font=pct_font, fill=_INK_SOFT)
            legend_y += 44

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf


def _value_chart(rows: list) -> io.BytesIO:
    """Grouped bar chart: invested vs current value for the top 10 holdings."""
    W, H = 900, 480
    img = PILImage.new("RGB", (W, H), _BG)
    draw = ImageDraw.Draw(img)
    title_font = _font(22)
    label_font = _font(12)
    legend_font = _font(13)

    draw.text((W // 2, 24), "Top investments — invested vs current value",
              font=title_font, fill=_INK, anchor="mt")

    rows = rows[:10]
    if not rows:
        draw.text((W // 2, H // 2), "No investments", font=label_font, fill=_INK_SOFT, anchor="mm")
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        buf.seek(0)
        return buf

    # Plot area
    pl, pr, pt, pb = 70, 40, 80, 100
    plot_w = W - pl - pr
    plot_h = H - pt - pb
    max_val = max(max(r.amount_invested, r.current_value) for r in rows) or 1.0
    # Round up to a nice number for axis
    magnitude = 10 ** max(0, int(math.log10(max_val)) - 1)
    axis_max = math.ceil(max_val / magnitude) * magnitude

    # Y-axis grid
    for i in range(5):
        y = pt + plot_h - (plot_h * i / 4)
        draw.line([(pl, y), (pl + plot_w, y)], fill=_GRID, width=1)
        val = axis_max * i / 4
        draw.text((pl - 6, y), _fmt_short(val), font=label_font, fill=_INK_SOFT, anchor="rm")

    # Bars
    n = len(rows)
    group_w = plot_w / n
    bar_w = group_w * 0.34
    invested_color = (157, 142, 121)
    current_color = (107, 125, 94)
    for i, r in enumerate(rows):
        gx = pl + group_w * i + group_w / 2
        h_inv = (r.amount_invested / axis_max) * plot_h if axis_max else 0
        h_cur = (r.current_value / axis_max) * plot_h if axis_max else 0
        draw.rectangle([gx - bar_w - 2, pt + plot_h - h_inv, gx - 2, pt + plot_h], fill=invested_color)
        draw.rectangle([gx + 2, pt + plot_h - h_cur, gx + bar_w + 2, pt + plot_h], fill=current_color)
        # X label (truncated)
        name = (r.name[:11] + "…") if len(r.name) > 12 else r.name
        # Rotate-style: just place above the bar; saves implementing text rotation.
        draw.text((gx, pt + plot_h + 10), name, font=label_font, fill=_INK, anchor="mt")

    # Legend
    lx, ly = W - 280, H - 30
    draw.rectangle([lx, ly, lx + 14, ly + 14], fill=invested_color)
    draw.text((lx + 22, ly), "Invested", font=legend_font, fill=_INK)
    draw.rectangle([lx + 130, ly, lx + 144, ly + 14], fill=current_color)
    draw.text((lx + 152, ly), "Current", font=legend_font, fill=_INK)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf


def _fmt_short(v: float) -> str:
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f}M"
    if v >= 1_000:
        return f"{v / 1_000:.0f}k"
    return f"{v:.0f}"


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
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2a241e")),
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
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2a241e")),
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
