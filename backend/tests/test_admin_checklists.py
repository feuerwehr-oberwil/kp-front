"""Unit tests for the checklists-as-code manifest loader + the reference-API checklist helpers
(no DB, no network).

Covers the pure layers: manifest parsing/validation (ids, kinds, assets), template-file shape
checks, and the API's `checklists:` id classification + template-shape guard. Run `uv run pytest`.
"""

import json

import pytest

from app.admin_checklists import (
    ChecklistEntry,
    _expected_ids,
    _read_manifest,
    _template_bytes,
    _validate_files,
)
from app.api.reference import _checklist_role, _validate_checklist_template


def _write(tmp_path, name, obj):
    p = tmp_path / name
    p.write_text(json.dumps(obj), encoding="utf-8")
    return p


# --- manifest parsing -------------------------------------------------------------------


def test_reads_list_and_checklists_wrapper(tmp_path):
    entry = {"id": "fu", "kind": "action", "title": "FU", "file": "fu.json"}
    assert len(_read_manifest(_write(tmp_path, "a.json", [entry]))) == 1
    assert len(_read_manifest(_write(tmp_path, "b.json", {"checklists": [entry]}))) == 1


def test_duplicate_id_rejected(tmp_path):
    m = _write(tmp_path, "m.json", [
        {"id": "x", "kind": "action", "title": "A", "file": "a.json"},
        {"id": "x", "kind": "action", "title": "B", "file": "b.json"},
    ])
    with pytest.raises(SystemExit):
        _read_manifest(m)


def test_unknown_key_rejected(tmp_path):
    m = _write(tmp_path, "m.json", [{"id": "x", "kind": "action", "title": "A", "file": "a.json", "typo": 1}])
    with pytest.raises(SystemExit):
        _read_manifest(m)


def test_id_with_colon_rejected():
    # ':' is the reference-dataset id separator (checklists:<id>:p<N>) — an entry id must not use it.
    with pytest.raises(ValueError):
        ChecklistEntry(id="bad:id", kind="action", title="A", file="a.json")


def test_unknown_kind_and_bad_file_rejected():
    with pytest.raises(ValueError):
        ChecklistEntry(id="x", kind="mystery", title="A", file="a.json")
    with pytest.raises(ValueError):
        ChecklistEntry(id="x", kind="action", title="A", file="a.pdf")  # not .json


def test_assets_only_on_reference():
    asset = {"page": 12, "file": "assets/p12.jpg"}
    # a reference template may carry diagram assets…
    ChecklistEntry(id="pb", kind="reference", title="PB", file="pb.json", assets=[asset])
    # …but an action list may not
    with pytest.raises(ValueError):
        ChecklistEntry(id="fu", kind="action", title="FU", file="fu.json", assets=[asset])


def test_duplicate_asset_page_rejected():
    with pytest.raises(ValueError):
        ChecklistEntry(
            id="pb", kind="reference", title="PB", file="pb.json",
            assets=[{"page": 4, "file": "assets/p4.jpg"}, {"page": 4, "file": "assets/p4b.jpg"}],
        )


# --- template-file validation (checks the referenced JSON, not just the manifest) --------


def test_validate_files_checks_template_shape(tmp_path):
    _write(tmp_path, "fu.json", {"id": "fu", "kind": "action", "title": "FU", "phases": [{"id": "p", "title": "P", "items": []}]})
    m = _write(tmp_path, "m.json", [{"id": "fu", "kind": "action", "title": "FU", "file": "fu.json"}])
    entries = _read_manifest(m)
    assert _validate_files(m, entries) == (1, 0)


def test_validate_files_rejects_id_mismatch(tmp_path):
    _write(tmp_path, "fu.json", {"id": "other", "kind": "action", "title": "FU", "phases": [{"id": "p", "title": "P", "items": []}]})
    m = _write(tmp_path, "m.json", [{"id": "fu", "kind": "action", "title": "FU", "file": "fu.json"}])
    entries = _read_manifest(m)
    with pytest.raises(SystemExit):
        _validate_files(m, entries)


def test_validate_files_missing_template(tmp_path):
    m = _write(tmp_path, "m.json", [{"id": "fu", "kind": "action", "title": "FU", "file": "nope.json"}])
    entries = _read_manifest(m)
    with pytest.raises(SystemExit):
        _validate_files(m, entries)


# --- prune reconciliation ---------------------------------------------------------


def test_expected_ids_covers_templates_and_assets():
    entries = [
        ChecklistEntry(id="fu", kind="action", title="FU", file="fu.json"),
        ChecklistEntry(
            id="pb", kind="reference", title="PB", file="pb.json",
            assets=[{"page": 4, "file": "a/p4.jpg"}, {"page": 9, "file": "a/p9.jpg"}],
        ),
    ]
    assert _expected_ids(entries) == {"checklists:fu", "checklists:pb", "checklists:pb:p4", "checklists:pb:p9"}
    # a dataset id NOT produced here (e.g. a renamed template's old id) is what prune deletes.
    assert "checklists:el-playbook" not in _expected_ids(entries)


# --- config-driven order injection ------------------------------------------------


def test_template_bytes_stamps_order(tmp_path):
    src = _write(tmp_path, "fu.json", {"id": "fu", "kind": "action", "title": "FU", "phases": [{"id": "p"}]})
    out = json.loads(_template_bytes(src, 3))
    assert out["order"] == 3
    # source file is untouched (order only in the served copy)
    assert "order" not in json.loads(src.read_text())


def test_manifest_entry_order_optional():
    assert ChecklistEntry(id="fu", kind="action", title="FU", file="fu.json").order is None
    assert ChecklistEntry(id="fu", kind="action", title="FU", file="fu.json", order=2).order == 2


# --- reference-API helpers --------------------------------------------------------------


def test_checklist_role_classification():
    assert _checklist_role("checklists:fu-aktion") == "template"
    assert _checklist_role("checklists:el-playbook:p12") == "asset"
    assert _checklist_role("geo:hydrant") is None
    assert _checklist_role("plan:abc:modul1") is None


def test_validate_checklist_template_accepts_valid():
    _validate_checklist_template(json.dumps({"id": "fu", "kind": "action", "title": "FU", "phases": [{"id": "p"}]}).encode())
    _validate_checklist_template(json.dumps({"id": "pb", "kind": "reference", "title": "PB", "entries": [{"id": "e"}]}).encode())


def test_validate_checklist_template_rejects_bad():
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        _validate_checklist_template(b"not json")
    with pytest.raises(HTTPException):
        _validate_checklist_template(json.dumps({"id": "fu", "kind": "action", "title": "FU"}).encode())  # neither phases nor entries
    with pytest.raises(HTTPException):
        # both phases and entries → ambiguous
        _validate_checklist_template(json.dumps({"id": "x", "kind": "action", "title": "X", "phases": [{}], "entries": [{}]}).encode())
