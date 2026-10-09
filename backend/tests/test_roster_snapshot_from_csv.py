"""The reference producer (scripts/roster_snapshot_from_csv.py) writes files the apps accept.

A station without fwo-admin or an HR system has a spreadsheet. The generator is how that
spreadsheet becomes a ``roster-snapshot/1`` file, so it is held to the same contract the apps
read with — and to the one rule a producer can enforce better than any consumer: a column that
is not part of the contract (a Tauglichkeit date, a phone number) never reaches the file.
Byte-identical in KP Front and KP Rück, like the script.
"""

from __future__ import annotations

import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.roster_snapshot import medical_shaped, parse_snapshot

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "roster_snapshot_from_csv.py"
EXAMPLE_CSV = ROOT / "docs" / "roster-snapshot.example.csv"

pytestmark = pytest.mark.skipif(not SCRIPT.exists(), reason="repo root not available (running from the image)")


def _module():
    spec = importlib.util.spec_from_file_location("roster_snapshot_from_csv", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


NOW = datetime(2026, 10, 9, 4, 0, tzinfo=UTC)


def test_the_example_csv_becomes_a_valid_snapshot():
    gen = _module()
    doc, dropped = gen.convert(EXAMPLE_CSV.read_text(encoding="utf-8"), provider="musterdorf-personalstamm", now=NOW)
    snap = parse_snapshot(json.dumps(doc))
    assert snap.count == 4 and snap.complete is True
    assert [p.active for p in snap.people] == [True, True, True, False]
    assert snap.people[0].identities[0].provider == "divera"
    assert snap.people[0].identities[0].external_id == "4711"
    # The example deliberately carries a medical column, to show where it stops.
    assert dropped == ["Tauglichkeit bis"]
    assert "Tauglichkeit" not in json.dumps(doc) and "2027-03-31" not in json.dumps(doc)


def test_no_column_outside_the_contract_survives_whatever_it_is_called():
    gen = _module()
    csv = "external_id;name;Arzttermin;Telefon;fitness_for_duty\np1;Meier Anna;2026-11-01;079 000 00 00;yes\n"
    doc, dropped = gen.convert(csv, provider="wehr", now=NOW)
    assert set(dropped) == {"Arzttermin", "Telefon", "fitness_for_duty"}

    def keys(node):
        if isinstance(node, dict):
            return list(node) + [k for v in node.values() for k in keys(v)]
        if isinstance(node, list):
            return [k for v in node for k in keys(v)]
        return []

    assert not [k for k in keys(doc) if medical_shaped(k)]
    parse_snapshot(json.dumps(doc))


@pytest.mark.parametrize(
    ("csv", "message"),
    [
        ("name,rank\nMeier Anna,wm\n", "external_id"),
        ("external_id,name\np1,Meier Anna\np1,Meier Berta\n", "twice"),
        ("external_id,name,active\np1,Meier Anna,vielleicht\n", "active"),
        ("external_id,name,rank\np1,Meier Anna,Wachtmeister Grad\n", "rank key"),
        ("external_id,name\n", "nobody"),
        ("external_id,name,id:wehr\np1,Meier Anna,x\n", "--provider itself"),
    ],
)
def test_a_broken_spreadsheet_is_refused_with_the_reason(csv, message):
    gen = _module()
    with pytest.raises(gen.CsvError, match=message):
        gen.convert(csv, provider="wehr", now=NOW)


def test_partial_is_expressible_and_the_output_is_written_atomically(tmp_path):
    gen = _module()
    out = tmp_path / "roster.json"
    assert gen.main([str(EXAMPLE_CSV), "--provider", "wehr", "--partial", "--out", str(out)]) == 0
    assert parse_snapshot(out.read_bytes()).complete is False
    assert not (tmp_path / "roster.json.tmp").exists()
