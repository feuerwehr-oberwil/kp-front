"""The one thing the three manifest-driven admin CLIs genuinely share.

``admin_geodata``, ``admin_objects`` and ``admin_checklists`` each ship a
``*.manifest.example.json`` next to themselves. Those templates are SHAPE examples: they show
the fields, and they name files the station supplies — its own GeoJSON export, its own
Modul-PDFs, its own checklist JSON. So the documented «try it with the template» step could
never pass, and all it said was ``file not found: /…/hydrant.geojson``, which reads like a
broken repo rather than an instruction. This turns that failure into one.

Deliberately NOT a passing validate: a template that validated by shipping stub files would
be telling the operator their data loaded when nothing of theirs had.
"""

from pathlib import Path

#: How the shipped templates are named. A copy that keeps the name still gets the hint, which
#: is the right call — a copy that has been pointed at real files never reaches this code.
TEMPLATE_SUFFIX = ".manifest.example.json"


def template_hint(manifest_path: Path, *, complete_example: str) -> str:
    """Extra lines to append to a «file not found» when the manifest IS a shipped template.

    Empty for any other manifest, so a station's own missing export still fails with the short
    message that is all it needs. ``complete_example`` names a manifest in this repo that does
    validate as it stands, so «does anything here work?» has an answer one command away.
    """
    if not manifest_path.name.endswith(TEMPLATE_SUFFIX):
        return ""
    return (
        f"\n       {manifest_path.name} is a TEMPLATE — it shows the shape and names files you "
        f"supply,\n       so it cannot validate as it stands. Copy it next to your own data and "
        f"point the paths\n       at your files. A manifest that does validate as it stands: "
        f"{complete_example}."
    )
