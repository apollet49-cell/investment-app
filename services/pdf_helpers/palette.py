"""Brand palette in two forms: ReportLab HexColor (for Platypus flowables
and TableStyle) and raw RGB tuples (for Pillow's ImageDraw, which doesn't
understand HexColor objects)."""
from reportlab.lib.colors import HexColor

# -- ReportLab HexColor (Platypus / TableStyle) -----------------------------
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

# -- Raw RGB (Pillow) -------------------------------------------------------
SAGE_RGB = (107, 125, 94)
TAUPE_RGB = (138, 117, 88)
TERRA_RGB = (165, 101, 81)
CREAM_RGB = (250, 247, 242)
INK_RGB = (42, 36, 30)
INK_SOFT_RGB = (122, 111, 93)
GRID_RGB = (217, 207, 185)

# Palette for slices / bars — used round-robin in allocation and bar charts.
PALETTE = [
    (138, 117, 88),    # taupe
    (107, 125, 94),    # sage
    (184, 148, 94),    # warm amber
    (122, 139, 154),   # muted slate
    (157, 127, 143),   # dusty mauve
    (165, 101, 81),    # terracotta
    (180, 165, 145),   # light taupe
    (140, 155, 130),   # light sage
]
