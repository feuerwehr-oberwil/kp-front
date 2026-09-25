"""The Lage-Grundgerüst: shipped presets and the vocabulary a slot may name.

The Grundgerüst is the handful of things every Lage needs in its first minutes — KP, Zufahrt,
Wasserbezug, Sammelplatz … — per Einsatzart (the alarm keyword CATEGORY the incident was filed
under, ``data/alarm_keywords.json``). In the Einsatz it is a small card on the Karte whose rows
place a symbol or a line and tick themselves when one exists (src/lib/lageGrundgeruest.ts).
Post-mortem 23.09.2026: after 65 minutes that Karte had no Zufahrt, Absperrung, Wasserbezug or
Bereitstellungsraum, while the hydrant layer had been opened fifteen times.

Same pattern as the alarm vocabulary: a shipped default applies until a station says otherwise.
The defaults are files, ``data/lage_grundgeruest/<name>.json``, read once at import (a missing or
malformed file is an ImportError at boot, not a silently empty card). A station's deployment
config names one of them (``lageGrundgeruest.preset``) and may replace SINGLE Einsatzarten of it
(``lageGrundgeruest.kategorien``) — per category, never per slot, so «what does our BMA list say»
has one answer in one place.

What a slot may name is checked here and nowhere else, for the schema (``schemas.LageSlot``):

* ``symbol`` — a name out of the app's own symbol pack, ``public/tactical-symbols.json`` (the
  same file the Kroki renderer reads, found the same way: ``kroki.default_pack_path``). Names are
  compatibility keys; an unknown one would be a row that places nothing.
* ``linie`` — a line preset by its LABEL (``appConfig.drawing.linePresets``). The presets live in
  the frontend, so their labels are restated in :data:`LINE_PRESETS`, and a Vitest reads this
  file to pin the two together (src/lib/lageGrundgeruest.test.ts).

Every refusal names what the writer probably meant («did you mean 'GB Schluesseldepot'?»),
because the most likely mistake in a hand-written file is the umlaut the symbol names do not use.
"""

from __future__ import annotations

import difflib
import json
import logging
import unicodedata
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

PRESET_DIR = Path(__file__).resolve().parent / "data" / "lage_grundgeruest"

#: The preset a station runs when its config names none — and the list an Einsatz without a
#: known category falls back to (see src/lib/lageGrundgeruest · grundgeruestCategory).
DEFAULT_PRESET = "fks-standard"

#: The line presets a slot may name, by label: ``appConfig.drawing.linePresets`` without the
#: neutral «Freihand» (a slot that places a plain line would tick on every scribble).
#: ⚠️ Pinned against the frontend by src/lib/lageGrundgeruest.test.ts, which reads this line.
LINE_PRESETS: tuple[str, ...] = ("Pfeil", "Rettungsachse", "Zufahrt")


def _fold(s: str) -> str:
    """Case, umlaut and spacing folded away — «GB Schlüsseldepot» and «gb schluesseldepot» meet."""
    s = s.strip().lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    s = unicodedata.normalize("NFKD", s)
    return " ".join("".join(c for c in s if not unicodedata.combining(c)).replace("_", " ").split())


def did_you_mean(name: str, candidates: Iterable[str]) -> str | None:
    """The one obviously-intended candidate, or None.

    Three tries, strictest first: the same word once case/umlauts are folded away (the likeliest
    miss in this vocabulary — the symbol names spell «ue» for «ü»), a close spelling (difflib, the
    cutoff ``config_guard`` uses), then a UNIQUE candidate containing the word («bma» →
    «bma_unechte_alarme»). A wrong suggestion is worse than none, so an ambiguous one is none.
    """
    pool = sorted(set(candidates))
    folded = {_fold(c): c for c in pool}
    key = _fold(name)
    if key in folded:
        return folded[key]
    close = difflib.get_close_matches(key, list(folded), n=1, cutoff=0.7)
    if close:
        return folded[close[0]]
    containing = [c for f, c in folded.items() if key and key in f]
    return containing[0] if len(containing) == 1 else None


def hint(name: str, candidates: Iterable[str]) -> str:
    """`` — did you mean 'x'?`` or nothing, for the end of a refusal."""
    guess = did_you_mean(name, candidates)
    return f" — did you mean {guess!r}?" if guess else ""


@lru_cache(maxsize=1)
def symbol_names() -> frozenset[str] | None:
    """Every symbol name in the deployed pack, or None when the pack cannot be found.

    None is a deployment without the SPA next to it (an exotic layout, a bare backend in a test
    container). The symbol check is then skipped with one warning rather than refusing every
    config: the frontend would still place whatever the pack it loads knows.
    """
    from .kroki import default_pack_path  # lazy: kroki pulls in PIL, only this lookup needs it

    path = default_pack_path()
    if path is None:
        logger.warning("lageGrundgeruest: no tactical-symbols.json found — symbol names are not checked")
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return frozenset(str(s["name"]) for s in data.get("symbols") or [] if isinstance(s, dict) and s.get("name"))


def check_slot_target(symbol: str | None, linie: str | None) -> None:
    """Refuse a slot that names nothing placeable — raises ValueError with a did-you-mean."""
    if bool(symbol) == bool(linie):
        raise ValueError("a slot names exactly one of «symbol» (a symbol name) or «linie» (a line preset)")
    if linie is not None and linie not in LINE_PRESETS:
        raise ValueError(
            f"linie {linie!r} is not a line preset{hint(linie, LINE_PRESETS)} (line presets: {', '.join(LINE_PRESETS)})"
        )
    if symbol is not None:
        names = symbol_names()
        if names is not None and symbol not in names:
            raise ValueError(f"symbol {symbol!r} is not in the symbol pack{hint(symbol, names)}")


def _load_presets() -> dict[str, dict[str, Any]]:
    """Every shipped preset, name → ``{beschreibung, kategorien}``, documentation keys dropped.

    Read raw here; ``tests/test_lage_grundgeruest.py`` validates each through the SAME schema a
    station's own lists pass (``schemas.LageSlot``), so a shipped preset cannot name a symbol
    the pack does not have.
    """
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(PRESET_DIR.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        kategorien = doc.get("kategorien")
        if not isinstance(kategorien, dict) or not kategorien:
            raise ImportError(f"{path}: a preset needs a non-empty «kategorien» object")
        out[path.stem] = {"beschreibung": str(doc.get("beschreibung") or ""), "kategorien": kategorien}
    if DEFAULT_PRESET not in out:
        raise ImportError(f"{PRESET_DIR}: the default preset {DEFAULT_PRESET!r} is missing")
    return out


#: The presets this build ships, read once. Served whole at ``GET /api/config``
#: (``lageGrundgeruestPresets``) — the field app resolves a category against them, and /admin
#: shows what «Auf Preset zurücksetzen» goes back to.
PRESETS: dict[str, dict[str, Any]] = _load_presets()


def effective_slots(preset: str, kategorien: dict[str, list[Any]], category: str) -> list[Any]:
    """The list one Einsatzart runs: the station's own if it set one, else its preset's.

    The Python twin of src/lib/lageGrundgeruest · slotsFor, for the CLI's listing. An empty
    station list is an ANSWER («no Grundgerüst for this Einsatzart»), not a gap to fill.
    """
    if category in kategorien:
        return list(kategorien[category])
    return list((PRESETS.get(preset) or PRESETS[DEFAULT_PRESET])["kategorien"].get(category) or [])
