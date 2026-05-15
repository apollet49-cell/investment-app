"""PDF report generation — branded, magazine-style layout.

Built with ReportLab Platypus + Pillow-rendered charts. Uses ReportLab's
built-in font set (no .ttf bundling) — Helvetica for body, Helvetica-Bold
for stats, Times-Italic for narrative captions. Sage-green hero band,
KPI stat cards, side-by-side allocation chart + legend, footer with page
number on every page.

This is the file that ships when the user hits /exports/pdf. The Monthly
Review view (browser-rendered then ⌘P) produces an even nicer PDF, but
this server-side path is the one external integrations / downloads use.
"""
from __future__ import annotations

import io
import logging
import math
from datetime import date

from PIL import Image as PILImage, ImageDraw, ImageFont  # noqa: E402
from reportlab.lib import colors  # noqa: E402
from reportlab.lib.colors import HexColor  # noqa: E402
from reportlab.lib.enums import TA_CENTER, TA_LEFT  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet  # noqa: E402
from reportlab.lib.units import cm, mm  # noqa: E402
from reportlab.pdfgen import canvas as _canvas  # noqa: E402
from reportlab.platypus import (  # noqa: E402
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import Flowable  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from models import Investment, User  # noqa: E402
from services.ai_service import APIKeyMissingError, one_shot  # noqa: E402

log = logging.getLogger("pdf_report")


# -- Palette ---------------------------------------------------------------
SAGE = HexColor("#6b7d5e")
SAGE_DEEP = HexColor("#5a6b50")
TAUPE = HexColor("#8a7558")
TAUPE_DEEP = HexColor("#6e5b40")
TERRA = HexColor("#a56551")
INK = HexColor("#2a241e")
INK_SOFT = HexColor("#7a6f5d")
CREAM = HexColor("#faf7f2")
BORDER = HexColor("#e8ddc8")
GRID = HexColor("#d9cfb9")

# Pillow uses RGB tuples
_SAGE_RGB = (107, 125, 94)
_TAUPE_RGB = (138, 117, 88)
_TERRA_RGB = (165, 101, 81)
_CREAM_RGB = (250, 247, 242)
_INK_RGB = (42, 36, 30)
_INK_SOFT_RGB = (122, 111, 93)
_GRID_RGB = (217, 207, 185)
# Palette for slices / bars
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


# -- Fonts (system fallbacks) ---------------------------------------------
def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = (
        # macOS
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        # Linux (Render uses Debian)
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


# -- Hero band Flowable ----------------------------------------------------
class HeroBand(Flowable):
    """A full-width sage band with brand mark + title + subtitle. Sits at
    the very top of the document, replacing the default Title style."""

    def __init__(self, title: str, subtitle: str, width: float = A4[0] - 4 * cm, height: float = 2.8 * cm):
        super().__init__()
        self.title = title
        self.subtitle = subtitle
        self.width = width
        self.height = height

    def wrap(self, *_):
        return self.width, self.height

    def draw(self):
        c = self.canv
        # Background
        c.setFillColor(SAGE)
        c.rect(0, 0, self.width, self.height, fill=1, stroke=0)
        # Brand mark — a stylised "I" with three rising bars (reuses the
        # site's logo motif). Drawn in cream on the sage band.
        c.setFillColor(CREAM)
        bx = 0.7 * cm
        by = 0.6 * cm
        # Three rising bars
        for i, h in enumerate((0.45, 0.75, 1.05)):
            c.roundRect(bx + i * 0.32 * cm, by, 0.22 * cm, h * cm, 0.05 * cm, fill=1, stroke=0)
        # Title — Times-Roman gives a more "annual report" feel than Helvetica
        c.setFillColor(CREAM)
        c.setFont("Times-Roman", 22)
        c.drawString(bx + 1.6 * cm, self.height - 1.2 * cm, self.title)
        c.setFont("Helvetica", 9.5)
        c.setFillColorRGB(1, 1, 1, alpha=0.85)
        c.drawString(bx + 1.6 * cm, self.height - 1.85 * cm, self.subtitle.upper())


# -- KPI strip -------------------------------------------------------------
def _kpi_strip(invested: float, current: float, roi_pct: float, currency: str) -> Table:
    """Three stat cards side-by-side: Net worth / Invested / ROI."""
    delta = current - invested
    delta_sign = "+" if delta >= 0 else ""
    roi_sign = "+" if roi_pct >= 0 else ""
    roi_color = SAGE if roi_pct >= 0 else TERRA

    cell_style = ParagraphStyle(
        "kpiLabel", fontName="Helvetica", fontSize=8, textColor=INK_SOFT,
        spaceAfter=4, leading=10, alignment=TA_LEFT,
    )
    value_style = ParagraphStyle(
        "kpiValue", fontName="Times-Roman", fontSize=20, textColor=INK,
        leading=22, spaceAfter=2, alignment=TA_LEFT,
    )
    sub_style = ParagraphStyle(
        "kpiSub", fontName="Helvetica", fontSize=9, textColor=INK_SOFT,
        leading=11, alignment=TA_LEFT,
    )
    roi_value_style = ParagraphStyle(
        "kpiRoi", fontName="Times-Roman", fontSize=20, textColor=roi_color,
        leading=22, spaceAfter=2, alignment=TA_LEFT,
    )

    def cell(label, value_p, sub):
        return [
            Paragraph(label.upper(), cell_style),
            value_p,
            Paragraph(sub, sub_style),
        ]

    data = [[
        cell("Current value", Paragraph(f"{current:,.0f} {currency}", value_style),
             f"{delta_sign}{delta:,.0f} since cost"),
        cell("Total invested", Paragraph(f"{invested:,.0f} {currency}", value_style),
             "Cost basis"),
        cell("Total ROI", Paragraph(f"{roi_sign}{roi_pct:.2f}%", roi_value_style),
             "Vs cost basis"),
    ]]

    page_w = A4[0] - 4 * cm
    col_w = page_w / 3
    table = Table(data, colWidths=[col_w] * 3, rowHeights=[2.4 * cm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CREAM),
        ("BOX", (0, 0), (0, 0), 0, BORDER),
        ("LINEAFTER", (0, 0), (1, 0), 0.5, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEABOVE", (0, 0), (-1, 0), 1, SAGE),
        ("LINEBELOW", (0, 0), (-1, -1), 1, BORDER),
    ]))
    return table


# -- Section header --------------------------------------------------------
def _section_header(title: str, eyebrow: str | None = None) -> KeepTogether:
    """Eyebrow (small caps, muted) + title (serif, large) + thin sage rule."""
    eyebrow_style = ParagraphStyle(
        "eyebrow", fontName="Helvetica-Bold", fontSize=8, textColor=SAGE,
        leading=10, spaceAfter=2, alignment=TA_LEFT,
    )
    title_style = ParagraphStyle(
        "sectionTitle", fontName="Times-Roman", fontSize=16, textColor=INK,
        leading=18, spaceAfter=2, alignment=TA_LEFT,
    )
    rule = Table([[""]], colWidths=[A4[0] - 4 * cm], rowHeights=[0.5])
    rule.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 0.6, BORDER),
    ]))

    parts = []
    if eyebrow:
        parts.append(Paragraph(eyebrow.upper(), eyebrow_style))
    parts.append(Paragraph(title, title_style))
    parts.append(Spacer(1, 4))
    parts.append(rule)
    parts.append(Spacer(1, 10))
    return KeepTogether(parts)


# -- Allocation chart (doughnut, no embedded title) -----------------------
def _allocation_chart(by_type: dict[str, float]) -> io.BytesIO:
    W, H = 540, 460
    img = PILImage.new("RGB", (W, H), _CREAM_RGB)
    draw = ImageDraw.Draw(img)
    if not by_type:
        f = _font(14)
        draw.text((W // 2, H // 2), "No investments", font=f, fill=_INK_SOFT_RGB, anchor="mm")
    else:
        cx, cy, R, r_inner = W // 2, H // 2 - 10, 150, 78
        total = sum(by_type.values()) or 1.0
        items = list(by_type.items())
        start_angle = -90.0
        for i, (typ, value) in enumerate(items):
            extent = (value / total) * 360.0
            color = _PALETTE[i % len(_PALETTE)]
            draw.pieslice([cx - R, cy - R, cx + R, cy + R],
                          start=start_angle, end=start_angle + extent,
                          fill=color)
            start_angle += extent
        # Doughnut hole
        draw.ellipse([cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner], fill=_CREAM_RGB)
        # Center label — total count
        center_font = _font(11)
        big_font = _font(22)
        draw.text((cx, cy - 12), f"{len(items)}", font=big_font, fill=_INK_RGB, anchor="mm")
        draw.text((cx, cy + 18), "ASSET TYPES", font=center_font, fill=_INK_SOFT_RGB, anchor="mm")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf


def _allocation_legend_table(by_type: dict[str, float]) -> Table:
    """Right-side legend with colored swatches, name, value, percent."""
    total = sum(by_type.values()) or 1.0
    items = sorted(by_type.items(), key=lambda kv: kv[1], reverse=True)
    rows = []
    swatch_style = ParagraphStyle("sw", fontName="Helvetica", fontSize=9, leading=11)
    name_style = ParagraphStyle("nm", fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=INK)
    val_style = ParagraphStyle("vl", fontName="Helvetica", fontSize=9, leading=11, textColor=INK_SOFT, alignment=2)  # right
    for i, (typ, val) in enumerate(items):
        r, g, b = _PALETTE[i % len(_PALETTE)]
        swatch = (
            f'<font color="#{r:02x}{g:02x}{b:02x}">■</font> '
            f'<font color="#2a241e">{typ.replace("_", " ").title()}</font>'
        )
        pct = (val / total) * 100
        rows.append([Paragraph(swatch, name_style),
                     Paragraph(f"{pct:.1f}%", val_style)])
    tbl = Table(rows, colWidths=[5 * cm, 1.6 * cm])
    tbl.setStyle(TableStyle([
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, GRID),
    ]))
    return tbl


# -- Top investments bar chart --------------------------------------------
def _value_chart(rows: list) -> io.BytesIO:
    W, H = 1000, 430
    img = PILImage.new("RGB", (W, H), _CREAM_RGB)
    draw = ImageDraw.Draw(img)
    rows = rows[:10]
    if not rows:
        f = _font(14)
        draw.text((W // 2, H // 2), "No investments", font=f, fill=_INK_SOFT_RGB, anchor="mm")
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        buf.seek(0)
        return buf

    label_font = _font(13)
    axis_font = _font(11)
    legend_font = _font(13)

    pl, pr, pt, pb = 70, 30, 30, 120
    plot_w = W - pl - pr
    plot_h = H - pt - pb

    max_val = max(max(r.amount_invested, r.current_value) for r in rows) or 1.0
    magnitude = 10 ** max(0, int(math.log10(max_val)) - 1)
    axis_max = math.ceil(max_val / magnitude) * magnitude

    # Y grid + labels
    for i in range(5):
        y = pt + plot_h - (plot_h * i / 4)
        draw.line([(pl, y), (pl + plot_w, y)], fill=_GRID_RGB, width=1)
        val = axis_max * i / 4
        draw.text((pl - 8, y), _fmt_short(val), font=axis_font, fill=_INK_SOFT_RGB, anchor="rm")

    n = len(rows)
    group_w = plot_w / n
    bar_w = group_w * 0.36
    invested_color = (157, 142, 121)
    current_color = (107, 125, 94)
    for i, r in enumerate(rows):
        gx = pl + group_w * i + group_w / 2
        h_inv = (r.amount_invested / axis_max) * plot_h if axis_max else 0
        h_cur = (r.current_value / axis_max) * plot_h if axis_max else 0
        # Invested
        draw.rectangle([gx - bar_w - 2, pt + plot_h - h_inv, gx - 2, pt + plot_h], fill=invested_color)
        # Current — capped on top with a tiny taupe band for delta cue
        draw.rectangle([gx + 2, pt + plot_h - h_cur, gx + bar_w + 2, pt + plot_h], fill=current_color)
        # X label — rotate visually by truncating and wrapping
        name = (r.name[:14] + "…") if len(r.name) > 15 else r.name
        draw.text((gx, pt + plot_h + 10), name, font=label_font, fill=_INK_RGB, anchor="mt")

    # Legend top-right
    lx, ly = W - 280, 8
    draw.rectangle([lx, ly, lx + 14, ly + 14], fill=invested_color)
    draw.text((lx + 22, ly), "Invested", font=legend_font, fill=_INK_RGB)
    draw.rectangle([lx + 130, ly, lx + 144, ly + 14], fill=current_color)
    draw.text((lx + 152, ly), "Current", font=legend_font, fill=_INK_RGB)

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


# -- Page footer ----------------------------------------------------------
def _on_page(canvas_obj: _canvas.Canvas, doc) -> None:
    """Called on every page — paints the footer bar with brand + page #."""
    canvas_obj.saveState()
    pw, ph = A4
    # Hairline rule above footer
    canvas_obj.setStrokeColor(BORDER)
    canvas_obj.setLineWidth(0.4)
    canvas_obj.line(2 * cm, 1.5 * cm, pw - 2 * cm, 1.5 * cm)
    canvas_obj.setFont("Helvetica", 7.5)
    canvas_obj.setFillColor(INK_SOFT)
    canvas_obj.drawString(2 * cm, 1.0 * cm, "InvestApp · investment-app-kud9.onrender.com")
    canvas_obj.drawCentredString(pw / 2, 1.0 * cm,
                                  f"Generated {date.today().strftime('%B %d, %Y')}")
    canvas_obj.drawRightString(pw - 2 * cm, 1.0 * cm, f"Page {doc.page}")
    canvas_obj.restoreState()


# -- Main entry -----------------------------------------------------------
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
    # Top position for the Risk section
    top_pos = max(rows, key=lambda r: r.current_value, default=None)
    top_pos_pct = ((top_pos.current_value / total_value) * 100) if top_pos and total_value else 0
    # Largest asset class (for concentration warning)
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

    # ---- HERO BAND ----
    subtitle = f"{user.name} · {user.currency} · {date.today().strftime('%B %Y')}"
    story.append(HeroBand("Portfolio Report", subtitle))
    story.append(Spacer(1, 14))

    # ---- KPI STRIP ----
    story.append(_kpi_strip(total_invested, total_value, roi_pct, user.currency))
    story.append(Spacer(1, 22))

    # ---- ALLOCATION ----
    story.append(_section_header(
        "Asset allocation",
        eyebrow="01 · Composition",
    ))
    # Side-by-side: chart on left, legend on right. Slightly smaller
    # height (6.0cm vs 7.7cm) frees up vertical room so the Top
    # investments bar chart also lands on page 1.
    chart_img = Image(_allocation_chart(by_type), width=7.5 * cm, height=6.0 * cm)
    legend = _allocation_legend_table(by_type) if by_type else Paragraph("No data", caption_style)
    side_by_side = Table(
        [[chart_img, legend]],
        colWidths=[8 * cm, 8.5 * cm],
    )
    side_by_side.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(side_by_side)
    # Caption
    if by_type:
        total_v = sum(by_type.values()) or 1
        dominant = max(by_type.items(), key=lambda kv: kv[1])
        pct = (dominant[1] / total_v) * 100
        cap = f"{dominant[0].replace('_', ' ').title()} is the largest sleeve at {pct:.1f}% of the portfolio."
        story.append(Spacer(1, 6))
        story.append(Paragraph(cap, caption_style))

    story.append(Spacer(1, 10))

    # ---- TOP INVESTMENTS ----
    # Compact chart (4.8cm vs 7.3cm) so it fits on page 1 below the
    # allocation section. The section is informational, not the focus —
    # the holdings table on page 2 carries the detail.
    story.append(_section_header(
        "Top investments — invested vs current value",
        eyebrow="02 · Performance",
    ))
    story.append(Image(_value_chart(rows), width=17 * cm, height=4.8 * cm))
    story.append(Spacer(1, 2))
    if best and best.amount_invested:
        bp_roi = (best.current_value - best.amount_invested) / best.amount_invested * 100
        sign = "+" if bp_roi >= 0 else ""
        story.append(Paragraph(
            f"Best performer: <b>{best.name}</b> ({sign}{bp_roi:.1f}%).",
            caption_style,
        ))

    story.append(PageBreak())

    # ---- TOP 5 HOLDINGS TABLE ----
    if top5:
        story.append(_section_header("Top 5 holdings", eyebrow="03 · Detail"))
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
            # Header
            ("BACKGROUND", (0, 0), (-1, 0), SAGE),
            ("TEXTCOLOR", (0, 0), (-1, 0), CREAM),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 9),
            ("TOPPADDING", (0, 0), (-1, 0), 9),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 9),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            # Body
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 1), (-1, -1), 9.5),
            ("TEXTCOLOR", (0, 1), (-1, -1), INK),
            ("ALIGN", (2, 1), (-1, -1), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [CREAM, HexColor("#f3ede2")]),
            ("LINEBELOW", (0, 0), (-1, -1), 0.3, BORDER),
            ("TOPPADDING", (0, 1), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 8),
            # ROI column color cue
            *[(("TEXTCOLOR", (4, i + 1), (4, i + 1),
                SAGE if not body[i][4].startswith("-") else TERRA)) for i in range(len(body))],
        ]))
        story.append(tbl)
        story.append(Spacer(1, 16))

    # ---- RISK ANALYSIS ----
    story.append(_section_header("Risk profile", eyebrow="04 · Risk"))
    story.append(_risk_table(rows, by_type, total_value, top_pos, top_pos_pct, largest_class, largest_class_pct))
    story.append(Spacer(1, 8))
    story.append(Paragraph(_risk_narrative(rows, by_type, total_value, top_pos_pct, largest_class_pct), body_style))
    story.append(Spacer(1, 14))

    # ---- ANALYSIS / OUTLOOK ----
    story.append(_section_header("Outlook & action items", eyebrow="05 · Outlook"))
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
        ai_text = _fallback_analysis(rows, by_type, total_invested, total_value, roi_pct)
    except Exception as e:  # noqa: BLE001
        log.warning("AI analysis fallback: %s", e)
        ai_text = _fallback_analysis(rows, by_type, total_invested, total_value, roi_pct)

    for paragraph in ai_text.split("\n\n"):
        clean = paragraph.replace("\n", " ").strip()
        if clean:
            story.append(Paragraph(clean, body_style))

    # Build with the footer on every page
    doc.build(story, onFirstPage=_on_page, onLaterPages=_on_page)
    return buf.getvalue()


# -- Risk section helpers --------------------------------------------------
def _risk_table(rows, by_type, total_value, top_pos, top_pos_pct, largest_class, largest_class_pct) -> Table:
    """Five rows of risk metrics, each with name / metric / signal / level.

    Signal level is bucketed visually as a sage / amber / terracotta dot,
    so a glance at the right column tells you which factors deserve
    attention. The metric formulas are intentionally simple — this is a
    snapshot view, not a Value-at-Risk simulation."""
    n_positions = len([r for r in rows if r.current_value])
    n_classes = len([k for k, v in by_type.items() if v > 0])

    # Liquidity proxy: % real estate (illiquid)
    illiquid_pct = (by_type.get("real_estate", 0) / total_value * 100) if total_value else 0

    # Currency exposure proxy: any non-USD investment by type? We don't
    # track currency per row in models, so we use a heuristic — startup
    # + real_estate + bond often have currency-local quirks.
    # For now we just call it out if real estate dominates.
    fx_exposure_pct = illiquid_pct  # crude proxy

    # Build the rows
    def level(metric_pct: float, low: float, high: float) -> tuple[str, object]:
        """Returns (label, color) for the 'signal' column."""
        if metric_pct >= high:
            return ("High", TERRA)
        if metric_pct >= low:
            return ("Moderate", HexColor("#b8945e"))  # warm amber
        return ("Low", SAGE)

    pos_level = level(top_pos_pct, 25, 40)
    class_level = level(largest_class_pct, 50, 75)
    diversity_pct = max(0, 100 - n_positions * 4)  # 25 positions → 0% risk
    div_level = level(diversity_pct, 30, 60)
    illiquid_level = level(illiquid_pct, 30, 60)

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

    # Map signal levels to their cell colors
    level_colors = {
        "Low": SAGE,
        "Moderate": HexColor("#b8945e"),
        "High": TERRA,
    }

    tbl = Table(risk_rows, colWidths=[5.5 * cm, 3.5 * cm, 4.7 * cm, 2.3 * cm])
    style = TableStyle([
        # Header
        ("BACKGROUND", (0, 0), (-1, 0), SAGE),
        ("TEXTCOLOR", (0, 0), (-1, 0), CREAM),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("TOPPADDING", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 9),
        # Body
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
        # First column slightly bolder
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("ALIGN", (3, 0), (3, -1), "CENTER"),
    ])
    # Tint the signal column by level
    for i, row in enumerate(risk_rows[1:], start=1):
        signal = row[3]
        if signal in level_colors:
            style.add("TEXTCOLOR", (3, i), (3, i), level_colors[signal])
            style.add("FONTNAME", (3, i), (3, i), "Helvetica-Bold")
    tbl.setStyle(style)
    return tbl


def _risk_narrative(rows, by_type, total_value, top_pos_pct, largest_class_pct) -> str:
    """One-paragraph synthesis of the risk picture, highlighting the
    single biggest factor to monitor. Keeps the table from feeling cold."""
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


def _fallback_analysis(rows: list, by_type: dict[str, float], invested: float, value: float, roi_pct: float) -> str:
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

    p2 = ""
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

    p3 = ""
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
