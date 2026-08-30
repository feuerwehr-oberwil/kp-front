"""The shipped Dienstgrade — the rank list every station starts on.

Two readers, and they are not the same thing:

* ``admin_config.EXAMPLE_CONFIG["roster"]["ranks"]`` — the template a station edits, so the
  list is visible and overridable rather than hidden in code;
* ``personnel.load_roster_ranks_info`` — the RUNTIME fallback for a station whose stored
  ``roster.ranks`` is empty. That is the majority of deployments, so this is live data and not
  documentation.

⚠️ TWIN: ``src/lib/rank.ts · SWISS_DEFAULT_RANKS`` is the same list on the frontend and falls
back independently. The two must stay identical: the backend maps imported Divera
Qualifikationen onto these ``key`` values and the app renders the badge from its own copy, so a
key present on only one side is a person whose Dienstgrad silently disappears in the UI.
``tests/test_config_template.py`` pins this side; keep the other in sync by hand when editing.
"""

from typing import Any

#: Generic Swiss militia fire-service ranks, MOST SENIOR FIRST — position is seniority, and the
#: last entry is the base rank everybody has. ``tier`` drives the "nur Offiziere" picker filter
#: and the Anwesenheit grouping. Exact membership is not load-bearing; a station overrides the
#: whole list via ``roster.ranks``.
SWISS_DEFAULT_RANKS: list[dict[str, Any]] = [
    {"key": "kdt", "label": "Kommandant", "abbr": "Kdt", "tier": "officer"},
    {"key": "maj", "label": "Major", "abbr": "Maj", "tier": "officer"},
    {"key": "hptm", "label": "Hauptmann", "abbr": "Hptm", "tier": "officer"},
    {"key": "oblt", "label": "Oberleutnant", "abbr": "Oblt", "tier": "officer"},
    {"key": "lt", "label": "Leutnant", "abbr": "Lt", "tier": "officer"},
    {"key": "fw", "label": "Feldweibel", "abbr": "Fw", "tier": "nco"},
    {"key": "wm", "label": "Wachtmeister", "abbr": "Wm", "tier": "nco"},
    {"key": "kpl", "label": "Korporal", "abbr": "Kpl", "tier": "nco"},
    {"key": "gfr", "label": "Gefreiter", "abbr": "Gfr", "tier": "crew"},
    {"key": "fwm", "label": "Feuerwehrmann", "abbr": "Fwm", "tier": "crew"},
]
