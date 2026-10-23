"""Server-side Einsatzrapport PDF composition (ReportLab) — the package that was ``report_pdf.py``.

The rapport is a FORM, not a data export:
stable automatic facts print as values, missing human fields print as labeled write-in lines,
and printing never blocks on completeness. The signed part flows continuously to minimise
paper: Details box → Kurzbericht → Zeiten-Stubs → Partner → Bemerkungen → Personal (full
roster as tick-off rows with von–bis) → Material worksheet → Unterschriften; then the
Beilagen (Journal when non-empty, Kroki, Pläne, Atemschutz). Stunden are NOT printed or
computed — WinFAP derives them from von–bis.

The Kroki and the annotated Objektpläne are rendered HERE, server-side (app/kroki.py:
raster tiles + the shared symbol pack + pdfium) from pure data the client sends — no
browser capture, no headless browser. Legacy
clients may still upload captured figure PNGs for one release.

Structural labels (section headings, column headers) are German — the app's canonical domain
language and the only deployment locale today (a future enhancement could pass them in). VALUE
labels that depend on locale/state (Trupp status, journal area) are resolved on the client and
sent as strings, so the PDF matches the on-screen report exactly.

Modules (one per former banner): ``schema`` payload models · ``labels`` German labels ·
``styles`` styles, markup and flowables · ``kroki_view`` the Kroki's print framing · ``tafel`` the
Tafel's sheets · ``compose`` compose_report_pdf · ``auswertung`` the debrief sheet. This module
re-exports the public face: the payload models and the two composers.
"""

# Rules for this area that span modules: docs/rapport.md.

from reportlab import rl_config

from .compose import compose_report_pdf
from .schema import (
    IncidentFacts,
    KrokiDrawingIn,
    KrokiEntityIn,
    KrokiIn,
    MittelFormRowIn,
    PersonalRowIn,
    PlanAnnoIn,
    PlanPageIn,
    ReportMetaIn,
    ReportPayload,
)
from .tafel import TafelPrintPayload, compose_tafel_pdf

__all__ = [
    "IncidentFacts",
    "KrokiDrawingIn",
    "KrokiEntityIn",
    "KrokiIn",
    "MittelFormRowIn",
    "PersonalRowIn",
    "PlanAnnoIn",
    "PlanPageIn",
    "ReportMetaIn",
    "ReportPayload",
    "TafelPrintPayload",
    "compose_report_pdf",
    "compose_tafel_pdf",
]

# ReportLab defaults to ASCII85-encoding every compressed stream (`useA85`) so old PDF tools that
# can only read ASCII can still consume the file — a concern from an era before every viewer spoke
# binary PDF, and moot for a Rapport that never leaves the app/download pipeline. On this deployment
# (reportlab 5.0.0, Python 3.13) there is no prebuilt `_rl_accel` C wheel, so the A85 encode falls
# back to pure-Python `_py_asciiBase85Encode` — profiling a full Rapport compose showed it burning
# ~70% of render time (8.9s of 12.8s over 3 composes). `pdfdoc` reads `rl_config.useA85` at
# document-save time, not at import time, so flipping it here — once, for every compose path
# (the editor and the capture download both call `compose_report_pdf`) — is enough: ~2.2s → ~1.07s per
# compose, and a third smaller output (no base85 blow-up) on top.
rl_config.useA85 = 0
