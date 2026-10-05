"""The shape a checklist template must have — one rule for the upload API and the CLI.

Three incident kinds (``action``, ``rapport``, ``reference``), since 2026-10-05 ``manual`` (an
Anleitung: read-only numbered steps for one device, never ticked — docs/STATION-DATA.md
«Anleitungen») and, since 2026-10-03, ``visit``:
the Objektbesuche template (docs/object-visits.md «Checklist templates of kind visit»). A visit
template uses ``phases`` like an action list, and its items may carry an answer type:

    {"id": "zustand", "text": "Zustand", "input": "choice",
     "options": [{"id": "gut", "label": "Gut"}, {"id": "mittel", "label": "Mittel"}]}

``input`` ∈ ``check`` (default) · ``yesno`` · ``text`` · ``number`` · ``choice`` · ``photo``.
A ``choice`` needs at least one option, each with a unique id and a label; ``required`` and
``unit`` are optional. The answer VALUES are checked nowhere here — they live in a visit
document, not in the template.
"""

from __future__ import annotations

import re
from typing import Any

TEMPLATE_KINDS = frozenset({"action", "rapport", "reference", "manual", "visit"})
VISIT_INPUTS = frozenset({"check", "yesno", "text", "number", "choice", "photo"})

#: An item id is a JSON key in every visit's ``answers`` — bounded so a template cannot make
#: every answer map unreasonable.
_ID_MAX = 80


def template_problem(tpl: Any) -> str | None:
    """A German sentence naming what is wrong with ``tpl``, or None when it is usable."""
    if not isinstance(tpl, dict):
        return "Checkliste muss ein JSON-Objekt sein"
    for field in ("id", "kind", "title"):
        if not isinstance(tpl.get(field), str) or not tpl[field].strip():
            return f"Checkliste: Feld {field!r} fehlt oder ist leer"
    if tpl["kind"] not in TEMPLATE_KINDS:
        return f"Checkliste: unbekannte kind {tpl['kind']!r}"
    if tpl["kind"] == "manual":
        return _manual_problem(tpl)
    has_phases = isinstance(tpl.get("phases"), list) and tpl["phases"]
    has_entries = isinstance(tpl.get("entries"), list) and tpl["entries"]
    if bool(has_phases) == bool(has_entries):
        return "Checkliste braucht genau eines von 'phases' (action/rapport/visit) oder 'entries' (reference)"
    if tpl["kind"] == "visit":
        if not has_phases:
            return "Besuchs-Checkliste braucht 'phases'"
        return _visit_problem(tpl["phases"])
    return None


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _manual_problem(tpl: dict[str, Any]) -> str | None:
    """An Anleitung: ``device`` (the rail groups by it) and a non-empty ``steps`` list, each step
    a ``text`` with optional ``details`` (sub-points, a list of strings), ``warning`` / ``hint``
    strings and optional ``images``
    (``[{"page": 3, "caption": "…"}]`` — the ``checklists:<id>:p<N>`` assets)."""
    if "phases" in tpl or "entries" in tpl:
        return "Anleitung hat 'steps', keine 'phases' oder 'entries'"
    if not isinstance(tpl.get("device"), str) or not tpl["device"].strip():
        return "Anleitung: Feld 'device' (Gerät) fehlt oder ist leer"
    updated = tpl.get("updated")
    if updated is not None and (not isinstance(updated, str) or not _DATE_RE.match(updated)):
        return "Anleitung: 'updated' muss ein Datum JJJJ-MM-TT sein"
    keywords = tpl.get("keywords")
    if keywords is not None and (not isinstance(keywords, list) or not all(isinstance(k, str) for k in keywords)):
        return "Anleitung: 'keywords' muss eine Liste von Texten sein"
    steps = tpl.get("steps")
    if not isinstance(steps, list) or not steps:
        return "Anleitung braucht mindestens einen Schritt in 'steps'"
    for n, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            return f"Anleitung: Schritt {n} ist kein Objekt"
        if not isinstance(step.get("text"), str) or not step["text"].strip():
            return f"Anleitung: Schritt {n} hat keinen 'text'"
        for field in ("warning", "hint"):
            if field in step and not isinstance(step[field], str):
                return f"Anleitung: Schritt {n}: {field!r} muss Text sein"
        details = step.get("details")
        if details is not None and (
            not isinstance(details, list) or not all(isinstance(d, str) and d.strip() for d in details)
        ):
            return f"Anleitung: Schritt {n}: 'details' muss eine Liste von Texten sein"
        images = step.get("images")
        if images is None:
            continue
        if not isinstance(images, list):
            return f"Anleitung: Schritt {n}: 'images' muss eine Liste sein"
        for img in images:
            page = img.get("page") if isinstance(img, dict) else None
            if not isinstance(page, int) or isinstance(page, bool) or page < 0:
                return f"Anleitung: Schritt {n}: jedes Bild braucht eine Seitennummer 'page' >= 0"
            if "caption" in img and not isinstance(img["caption"], str):
                return f"Anleitung: Schritt {n}: 'caption' muss Text sein"
    return None


def manual_pages(tpl: dict[str, Any]) -> set[int]:
    """Every asset page an Anleitung's steps show — the CLI checks the manifest carries them all."""
    pages: set[int] = set()
    for step in tpl.get("steps") or []:
        for img in (step.get("images") or []) if isinstance(step, dict) else []:
            if isinstance(img, dict) and isinstance(img.get("page"), int):
                pages.add(img["page"])
    return pages


def _visit_problem(phases: list[Any]) -> str | None:
    seen: set[str] = set()
    for p_index, phase in enumerate(phases):
        if not isinstance(phase, dict):
            return f"Besuchs-Checkliste: Abschnitt {p_index + 1} ist kein Objekt"
        items = phase.get("items")
        if not isinstance(items, list):
            return f"Besuchs-Checkliste: Abschnitt {p_index + 1} hat keine 'items'"
        for item in items:
            if not isinstance(item, dict):
                return f"Besuchs-Checkliste: ein Punkt in Abschnitt {p_index + 1} ist kein Objekt"
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > _ID_MAX:
                return f"Besuchs-Checkliste: Punkt ohne gültige 'id' in Abschnitt {p_index + 1}"
            if item_id in seen:
                return f"Besuchs-Checkliste: Punkt-id {item_id!r} kommt doppelt vor"
            seen.add(item_id)
            if not isinstance(item.get("text"), str) or not item["text"].strip():
                return f"Besuchs-Checkliste: Punkt {item_id!r} hat keinen 'text'"
            kind = item.get("input", "check")
            if kind not in VISIT_INPUTS:
                return f"Besuchs-Checkliste: Punkt {item_id!r} hat unbekanntes 'input' {kind!r}"
            if "required" in item and not isinstance(item["required"], bool):
                return f"Besuchs-Checkliste: Punkt {item_id!r}: 'required' muss true/false sein"
            if "unit" in item and not isinstance(item["unit"], str):
                return f"Besuchs-Checkliste: Punkt {item_id!r}: 'unit' muss Text sein"
            options = item.get("options")
            if kind == "choice":
                problem = _options_problem(item_id, options)
                if problem:
                    return problem
            elif options is not None:
                return f"Besuchs-Checkliste: Punkt {item_id!r}: 'options' gibt es nur bei input 'choice'"
    if not seen:
        return "Besuchs-Checkliste hat keinen einzigen Punkt"
    return None


def _options_problem(item_id: str, options: Any) -> str | None:
    if not isinstance(options, list) or not options:
        return f"Besuchs-Checkliste: Punkt {item_id!r} (choice) braucht 'options'"
    ids: set[str] = set()
    for option in options:
        if not isinstance(option, dict):
            return f"Besuchs-Checkliste: Punkt {item_id!r}: eine Option ist kein Objekt"
        oid, label = option.get("id"), option.get("label")
        if not isinstance(oid, str) or not oid.strip() or len(oid) > _ID_MAX:
            return f"Besuchs-Checkliste: Punkt {item_id!r}: Option ohne gültige 'id'"
        if oid in ids:
            return f"Besuchs-Checkliste: Punkt {item_id!r}: Option {oid!r} kommt doppelt vor"
        ids.add(oid)
        if not isinstance(label, str) or not label.strip():
            return f"Besuchs-Checkliste: Punkt {item_id!r}: Option {oid!r} hat kein 'label'"
    return None


def visit_items(tpl: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Every item of a visit template snapshot, in order, with its phase title attached."""
    out: list[dict[str, Any]] = []
    if not isinstance(tpl, dict):
        return out
    for phase in tpl.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        for item in phase.get("items") or []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                out.append({**item, "_phase": phase.get("title") or ""})
    return out
