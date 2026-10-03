"""The shape a checklist template must have — one rule for the upload API and the CLI.

Three incident kinds (``action``, ``rapport``, ``reference``) and, since 2026-10-03, ``visit``:
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

from typing import Any

TEMPLATE_KINDS = frozenset({"action", "rapport", "reference", "visit"})
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
    has_phases = isinstance(tpl.get("phases"), list) and tpl["phases"]
    has_entries = isinstance(tpl.get("entries"), list) and tpl["entries"]
    if bool(has_phases) == bool(has_entries):
        return "Checkliste braucht genau eines von 'phases' (action/rapport/visit) oder 'entries' (reference)"
    if tpl["kind"] == "visit":
        if not has_phases:
            return "Besuchs-Checkliste braucht 'phases'"
        return _visit_problem(tpl["phases"])
    return None


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
