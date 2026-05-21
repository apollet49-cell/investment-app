"""Building blocks for the magazine-style PDF report.

Split from services/pdf_report.py to keep that file focused on the
orchestration (which sections appear in which order). Each submodule
groups one concern:

- palette: colors as ReportLab HexColor + PIL RGB tuples
- fonts: portable TTF lookup with macOS / Linux fallbacks
- charts: Pillow-rendered allocation doughnut + top-investments bars
- components: Platypus Flowables (hero band, KPI strip, section header,
  page footer)
- risk: signal table + narrative paragraph + AI-less fallback prose
"""
from .palette import (  # noqa: F401
    BORDER,
    CREAM,
    GRID,
    INK,
    INK_SOFT,
    PALETTE,
    SAGE,
    SAGE_DEEP,
    TAUPE,
    TAUPE_DEEP,
    TERRA,
    CREAM_RGB,
    GRID_RGB,
    INK_RGB,
    INK_SOFT_RGB,
    SAGE_RGB,
    TAUPE_RGB,
    TERRA_RGB,
)
from .fonts import load_font  # noqa: F401
from .charts import (  # noqa: F401
    allocation_chart,
    allocation_legend_table,
    fmt_short,
    value_chart,
)
from .components import (  # noqa: F401
    HeroBand,
    kpi_strip,
    on_page,
    section_header,
)
from .risk import (  # noqa: F401
    fallback_analysis,
    risk_narrative,
    risk_table,
)
