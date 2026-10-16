"""`emptied_declared_sections` — what a write path may refuse over, at both levels.

The CLI and the API refuse on the same function, so a field the schema retired is not held
against a file (`admin_config load/push`, the demo reset) any more than against the admin UI.
"""

from app.config_guard import emptied_declared_sections


def test_a_retired_field_is_not_reported():
    stored = {"report": {"partnerOrgs": ["Polizei"], "reversePrintOrder": True}}
    final = {"report": {"partnerOrgs": ["Polizei"]}}
    assert emptied_declared_sections(stored, final) == []


def test_a_declared_field_still_is():
    stored = {"report": {"partnerOrgs": ["Polizei"], "reversePrintOrder": True}}
    final = {"report": {"partnerOrgs": []}}
    assert emptied_declared_sections(stored, final) == ["report.partnerOrgs"]


def test_an_undeclared_section_is_not_reported():
    assert emptied_declared_sections({"symbols": {"quickPick": ["a"]}}, {}) == []
