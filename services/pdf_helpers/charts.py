"""Pillow-rendered charts. Pillow replaced matplotlib here to save ~50MB
of disk and ~3s of cold-start import time on Render — these visuals are
simple enough that ImageDraw.pieslice / rectangle does the job."""
import io
import math

from PIL import Image as PILImage, ImageDraw
from reportlab.lib.units import cm
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle

from .fonts import load_font
from .palette import (
    BORDER,
    CREAM_RGB,
    GRID,
    GRID_RGB,
    INK,
    INK_RGB,
    INK_SOFT,
    INK_SOFT_RGB,
    PALETTE,
)


def fmt_short(v: float) -> str:
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f}M"
    if v >= 1_000:
        return f"{v / 1_000:.0f}k"
    return f"{v:.0f}"


def allocation_chart(by_type: dict[str, float]) -> io.BytesIO:
    """Doughnut showing portfolio composition. Centre label is the count
    of asset types — the legend table next to it carries the numbers."""
    W, H = 540, 460
    img = PILImage.new("RGB", (W, H), CREAM_RGB)
    draw = ImageDraw.Draw(img)
    if not by_type:
        f = load_font(14)
        draw.text((W // 2, H // 2), "No investments", font=f, fill=INK_SOFT_RGB, anchor="mm")
    else:
        cx, cy, R, r_inner = W // 2, H // 2 - 10, 150, 78
        total = sum(by_type.values()) or 1.0
        items = list(by_type.items())
        start_angle = -90.0
        for i, (_typ, value) in enumerate(items):
            extent = (value / total) * 360.0
            color = PALETTE[i % len(PALETTE)]
            draw.pieslice([cx - R, cy - R, cx + R, cy + R],
                          start=start_angle, end=start_angle + extent,
                          fill=color)
            start_angle += extent
        # Doughnut hole
        draw.ellipse([cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner], fill=CREAM_RGB)
        # Centre label — total count
        center_font = load_font(11)
        big_font = load_font(22)
        draw.text((cx, cy - 12), f"{len(items)}", font=big_font, fill=INK_RGB, anchor="mm")
        draw.text((cx, cy + 18), "ASSET TYPES", font=center_font, fill=INK_SOFT_RGB, anchor="mm")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf


def allocation_legend_table(by_type: dict[str, float]) -> Table:
    """Right-side legend: coloured swatch + type name + percent. Sorted
    descending so the eye lands on the dominant sleeve first."""
    total = sum(by_type.values()) or 1.0
    items = sorted(by_type.items(), key=lambda kv: kv[1], reverse=True)
    name_style = ParagraphStyle("nm", fontName="Helvetica-Bold", fontSize=9, leading=11, textColor=INK)
    val_style = ParagraphStyle("vl", fontName="Helvetica", fontSize=9, leading=11, textColor=INK_SOFT, alignment=2)
    rows = []
    for i, (typ, val) in enumerate(items):
        r, g, b = PALETTE[i % len(PALETTE)]
        swatch = (
            f'<font color="#{r:02x}{g:02x}{b:02x}">■</font> '
            f'<font color="#2a241e">{typ.replace("_", " ").title()}</font>'
        )
        pct = (val / total) * 100
        rows.append([Paragraph(swatch, name_style), Paragraph(f"{pct:.1f}%", val_style)])
    tbl = Table(rows, colWidths=[5 * cm, 1.6 * cm])
    tbl.setStyle(TableStyle([
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, GRID),
    ]))
    return tbl


def value_chart(rows: list) -> io.BytesIO:
    """Grouped bars (invested vs current value) for the top 10 holdings.
    Y-axis is auto-rounded to the next 'magnitude' bucket so the gridlines
    land on clean numbers (10k / 50k / 100k) regardless of portfolio size."""
    W, H = 1000, 430
    img = PILImage.new("RGB", (W, H), CREAM_RGB)
    draw = ImageDraw.Draw(img)
    rows = rows[:10]
    if not rows:
        f = load_font(14)
        draw.text((W // 2, H // 2), "No investments", font=f, fill=INK_SOFT_RGB, anchor="mm")
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        buf.seek(0)
        return buf

    label_font = load_font(13)
    axis_font = load_font(11)
    legend_font = load_font(13)

    pl, pr, pt, pb = 70, 30, 30, 120
    plot_w = W - pl - pr
    plot_h = H - pt - pb

    max_val = max(max(r.amount_invested, r.current_value) for r in rows) or 1.0
    magnitude = 10 ** max(0, int(math.log10(max_val)) - 1)
    axis_max = math.ceil(max_val / magnitude) * magnitude

    # Y grid + labels
    for i in range(5):
        y = pt + plot_h - (plot_h * i / 4)
        draw.line([(pl, y), (pl + plot_w, y)], fill=GRID_RGB, width=1)
        val = axis_max * i / 4
        draw.text((pl - 8, y), fmt_short(val), font=axis_font, fill=INK_SOFT_RGB, anchor="rm")

    n = len(rows)
    group_w = plot_w / n
    bar_w = group_w * 0.36
    invested_color = (157, 142, 121)
    current_color = (107, 125, 94)
    for i, r in enumerate(rows):
        gx = pl + group_w * i + group_w / 2
        h_inv = (r.amount_invested / axis_max) * plot_h if axis_max else 0
        h_cur = (r.current_value / axis_max) * plot_h if axis_max else 0
        draw.rectangle([gx - bar_w - 2, pt + plot_h - h_inv, gx - 2, pt + plot_h], fill=invested_color)
        draw.rectangle([gx + 2, pt + plot_h - h_cur, gx + bar_w + 2, pt + plot_h], fill=current_color)
        name = (r.name[:14] + "…") if len(r.name) > 15 else r.name
        draw.text((gx, pt + plot_h + 10), name, font=label_font, fill=INK_RGB, anchor="mt")

    # Legend top-right
    lx, ly = W - 280, 8
    draw.rectangle([lx, ly, lx + 14, ly + 14], fill=invested_color)
    draw.text((lx + 22, ly), "Invested", font=legend_font, fill=INK_RGB)
    draw.rectangle([lx + 130, ly, lx + 144, ly + 14], fill=current_color)
    draw.text((lx + 152, ly), "Current", font=legend_font, fill=INK_RGB)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf
