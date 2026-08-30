"""What the shipped config TEMPLATE may and may not contain.

`admin_config example` is the file docs/SETUP.md §3 tells a new station to redirect into
`config.json` and edit. Everything in it therefore becomes a real deployment's stored config,
which makes two classes of content dangerous: a section that is written at RUNTIME (the file
then overwrites live data), and a value that has drifted from its frontend twin.
"""

import re

from app.admin_config import EXAMPLE_CONFIG
from app.ranks import SWISS_DEFAULT_RANKS


def test_the_template_ships_no_reference_layers():
    """`referenceLayers` is the one section a config FILE must never carry.

    It is written by `admin_geodata`, and `_carry_runtime_sections` only carries it over when the
    incoming file is SILENT about it. A template that ships two example layers therefore REPLACES
    a station's real hydrants on every `load`/`push` — and because the section then has content,
    neither `emptied_sections` nor the carry-over says a word. Reference layers belong in a
    geodata manifest (examples/demo-data/geodata.manifest.json).
    """
    assert "referenceLayers" not in EXAMPLE_CONFIG


def test_a_modul5_sub_slot_keeps_its_trailing_number():
    """«Wasser 1» and «Wasser 2» are two Spezialpläne, not one overwriting the other.

    TWIN: src/lib/deploymentConfig.ts · DEFAULT_MODULES · modul5. The capture drifted here first —
    without `(?:\\s+\\d+)?` both sheets resolve to the single `modul5-wasser` slot and the second
    import silently replaces the first.
    """
    modul5 = next(m for m in EXAMPLE_CONFIG["modules"] if m["id"] == "modul5")
    assert re.search(modul5["match"], "Modul 5 - Wasser 1", re.IGNORECASE).group(1) == "Wasser 1"
    assert re.search(modul5["match"], "Modul 5 - Wasser 2", re.IGNORECASE).group(1) == "Wasser 2"


def test_the_template_takes_its_ranks_from_the_runtime_default():
    """The template's rank list and the RUNTIME fallback (personnel · load_roster_ranks_info) must
    be the same list, or a station that edits the template gets a different set of Dienstgrade
    than one that never touches it."""
    assert EXAMPLE_CONFIG["roster"]["ranks"] == SWISS_DEFAULT_RANKS
    # copies, not the shared objects: the template is handed out and edited by callers
    assert EXAMPLE_CONFIG["roster"]["ranks"][0] is not SWISS_DEFAULT_RANKS[0]


def test_the_shipped_ranks_are_the_ones_the_frontend_falls_back_to():
    """TWIN: src/lib/rank.ts · SWISS_DEFAULT_RANKS — same keys, same order, both sides falling back
    independently when `roster.ranks` is empty. The backend maps imported Divera Qualifikationen
    onto these keys and the app renders the badge from its own copy, so a key on only one side is
    a Dienstgrad that vanishes in the UI. Pinned here; the TS side is kept in sync by hand."""
    assert [r["key"] for r in SWISS_DEFAULT_RANKS] == [
        "kdt",
        "maj",
        "hptm",
        "oblt",
        "lt",
        "fw",
        "wm",
        "kpl",
        "gfr",
        "fwm",
    ]
    assert [r["tier"] for r in SWISS_DEFAULT_RANKS[:5]] == ["officer"] * 5
    assert SWISS_DEFAULT_RANKS[-1]["abbr"] == "Fwm"  # the base rank everybody has
