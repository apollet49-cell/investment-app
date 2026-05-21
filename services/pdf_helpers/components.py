"""Platypus flowables that compose the report's chrome — the hero band
at the top of page 1, the KPI strip directly under it, section headers
between blocks, and the per-page footer."""
from datetime import date

from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas as _canvas
from reportlab.platypus import KeepTogether, Paragraph, Spacer, Table, TableStyle
from reportlab.platypus.flowables import Flowable

from .palette import BORDER, CREAM, INK, INK_SOFT, SAGE, TERRA


class HeroBand(Flowable):
    """Full-width sage band with brand mark + title + subtitle. Sits at
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
        c.setFillColor(SAGE)
        c.rect(0, 0, self.width, self.height, fill=1, stroke=0)
        # Brand mark — three rising bars echoing the site's logo motif.
        c.setFillColor(CREAM)
        bx = 0.7 * cm
        by = 0.6 * cm
        for i, h in enumerate((0.45, 0.75, 1.05)):
            c.roundRect(bx + i * 0.32 * cm, by, 0.22 * cm, h * cm, 0.05 * cm, fill=1, stroke=0)
        c.setFillColor(CREAM)
        c.setFont("Times-Roman", 22)
        c.drawString(bx + 1.6 * cm, self.height - 1.2 * cm, self.title)
        c.setFont("Helvetica", 9.5)
        c.setFillColorRGB(1, 1, 1, alpha=0.85)
        c.drawString(bx + 1.6 * cm, self.height - 1.85 * cm, self.subtitle.upper())


def kpi_strip(invested: float, current: float, roi_pct: float, currency: str) -> Table:
    """Three stat cards side-by-side: current value / invested / ROI."""
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
        return [Paragraph(label.upper(), cell_style), value_p, Paragraph(sub, sub_style)]

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


def section_header(title: str, eyebrow: str | None = None) -> KeepTogether:
    """Small-caps eyebrow + serif title + thin sage rule. Wrapped in
    KeepTogether so the title isn't orphaned at a page break from its
    content."""
    eyebrow_style = ParagraphStyle(
        "eyebrow", fontName="Helvetica-Bold", fontSize=8, textColor=SAGE,
        leading=10, spaceAfter=2, alignment=TA_LEFT,
    )
    title_style = ParagraphStyle(
        "sectionTitle", fontName="Times-Roman", fontSize=16, textColor=INK,
        leading=18, spaceAfter=2, alignment=TA_LEFT,
    )
    rule = Table([[""]], colWidths=[A4[0] - 4 * cm], rowHeights=[0.5])
    rule.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 0.6, BORDER)]))

    parts = []
    if eyebrow:
        parts.append(Paragraph(eyebrow.upper(), eyebrow_style))
    parts.append(Paragraph(title, title_style))
    parts.append(Spacer(1, 4))
    parts.append(rule)
    parts.append(Spacer(1, 10))
    return KeepTogether(parts)


def on_page(canvas_obj: _canvas.Canvas, doc) -> None:
    """Footer painted on every page: brand on the left, generation date
    centered, page number on the right. Wired in via doc.build()'s
    onFirstPage / onLaterPages hooks."""
    canvas_obj.saveState()
    pw, _ph = A4
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
