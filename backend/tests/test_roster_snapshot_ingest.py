"""The shared roster-snapshot ingestion rules (app/roster_snapshot_ingest.py), tested pure.

This file is byte-identical in KP Front and KP Rück, like the module it tests: one published
roster file must land the same way in both products, so both suites hold the same rules to the
same cases. No database here — each app has its own test of how a plan is WRITTEN
(``test_roster_snapshot_sync.py``); this one is about what the plan IS.

The cases are the ones the owner asked for by name: a fetch that fails, a snapshot that is
invalid, the deactivation cap, identity mapping (and never breaking an existing link), and
idempotence — plus the medical guard, end to end through the reconciliation.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from app.roster_snapshot import EXAMPLE_SNAPSHOT, medical_shaped
from app.roster_snapshot_ingest import (
    LastGood,
    LocalPerson,
    Reconciliation,
    SnapshotSourceError,
    deactivation_limit,
    read_source,
    reconcile,
    refused_outcome,
    status_json,
)

RANKS = ["kdt", "maj", "hptm", "oblt", "lt", "fw", "wm", "kpl", "gfr", "fwm"]


def _doc(**top: Any) -> dict[str, Any]:
    doc = copy.deepcopy(EXAMPLE_SNAPSHOT)
    doc.update(top)
    return doc


def _person(external_id: str, name: str, *, active: bool = True, rank: str | None = None, **ids: str) -> dict:
    last, _, first = name.partition(" ")
    return {
        "external_id": external_id,
        "display_name": name,
        "first_name": first or None,
        "last_name": last,
        "rank": rank,
        "active": active,
        "identities": [{"provider": p, "external_id": x} for p, x in ids.items()],
    }


def _snapshot(people: list[dict], *, complete: bool = True, at: str = "2026-10-01T04:00:00+00:00") -> bytes:
    return json.dumps(
        {
            "schema": "roster-snapshot/1",
            "schema_version": 1,
            "generated_at": at,
            "provider": "personalstamm",
            "complete": complete,
            "count": len(people),
            "people": people,
        }
    ).encode()


def _apply(people: list[LocalPerson], rec: Reconciliation) -> list[LocalPerson]:
    """What a consumer does with a plan, on the pure model — enough to test idempotence."""
    assert rec.refused is None
    by_id = {p.id: p for p in people}
    out = list(people)
    for i, w in enumerate(rec.creates):
        out.append(
            LocalPerson(
                id=f"new-{i}-{w.external_id}",
                display_name=w.fields["display_name"] or w.display_name,
                first_name=w.fields.get("first_name"),
                last_name=w.fields.get("last_name"),
                rank=w.fields.get("rank"),
                active=True,
                identities=dict(w.links),
            )
        )
    for w in rec.updates:
        p = by_id[str(w.person_id)]
        new = replace(
            p,
            **dict(w.fields),
            active=True if w.reactivate else p.active,
            identities={**p.identities, **dict(w.links)},
        )
        out[out.index(p)] = new
        by_id[p.id] = new
    for d in rec.deactivations:
        p = by_id[d.person_id]
        out[out.index(p)] = replace(p, active=False)
    return out


# --- 1. a fetch that fails ---------------------------------------------------------------


def _transport(status: int = 200, body: bytes = b"{}", seen: list | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, content=body)

    return httpx.MockTransport(handler)


async def test_a_url_is_read_and_the_token_goes_as_a_bearer_header():
    seen: list[httpx.Request] = []
    raw = await read_source("https://hr.example.ch/roster.json", "s3cret", transport=_transport(body=b"abc", seen=seen))
    assert raw == b"abc"
    assert seen[0].headers["authorization"] == "Bearer s3cret"


@pytest.mark.parametrize("status", [401, 404, 500, 503])
async def test_a_failed_fetch_names_the_status_and_never_the_address(status):
    with pytest.raises(SnapshotSourceError) as err:
        await read_source("https://hr.example.ch/roster.json?sig=TOPSECRET", "tok", transport=_transport(status))
    assert f"HTTP {status}" in str(err.value)
    assert "TOPSECRET" not in str(err.value) and "hr.example.ch" not in str(err.value) and "tok" not in str(err.value)


async def test_a_network_error_is_reported_by_type_not_by_its_message():
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("cannot reach https://hr.example.ch/roster.json?sig=TOPSECRET")

    with pytest.raises(SnapshotSourceError) as err:
        await read_source("https://hr.example.ch/roster.json?sig=TOPSECRET", transport=httpx.MockTransport(boom))
    assert "ConnectError" in str(err.value) and "TOPSECRET" not in str(err.value)


async def test_a_token_is_never_sent_over_plain_http():
    seen: list[httpx.Request] = []
    with pytest.raises(SnapshotSourceError, match="https"):
        await read_source("http://hr.local/roster.json", "s3cret", transport=_transport(seen=seen))
    assert seen == []


async def test_an_oversized_response_is_refused(monkeypatch):
    from app import roster_snapshot_ingest

    monkeypatch.setattr(roster_snapshot_ingest, "SOURCE_MAX_BYTES", 10)
    with pytest.raises(SnapshotSourceError, match="too large"):
        await read_source("https://hr.example.ch/r.json", transport=_transport(body=b"x" * 11))


async def test_a_local_file_is_read_and_a_missing_one_is_a_clean_error(tmp_path):
    f = tmp_path / "roster.json"
    f.write_bytes(b"{}")
    assert await read_source(str(f)) == b"{}"
    assert await read_source(f"file://{f}") == b"{}"
    with pytest.raises(SnapshotSourceError, match="not found"):
        await read_source(str(tmp_path / "missing.json"))
    with pytest.raises(SnapshotSourceError, match="directory"):
        await read_source(str(tmp_path))
    with pytest.raises(SnapshotSourceError):
        await read_source("relative/roster.json")


def test_a_failed_fetch_still_produces_a_valid_outcome_report():
    good = LastGood("personalstamm", "2026-10-01T04:00:00+00:00", "abc", 4)
    out = refused_outcome("fetch failed: HTTP 503", last_good=good)
    assert out.refused == "fetch failed: HTTP 503" and out.provider == "personalstamm"
    assert refused_outcome("x").provider == "unknown"  # still schema-valid with nothing to go on


# --- 2. a snapshot that is invalid ---------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(b"not json", id="not-json"),
        pytest.param(b"[]", id="not-an-object"),
        pytest.param(json.dumps(_doc(count=99)).encode(), id="count-mismatch"),
        pytest.param(json.dumps(_doc(schema="roster-snapshot/2")).encode(), id="other-version"),
        pytest.param(json.dumps(_doc(people=[], count=0)).encode(), id="empty"),
    ],
)
def test_an_invalid_snapshot_is_refused_whole_and_writes_nothing(raw):
    people = [LocalPerson("1", "Muster Hans", identities={"personalstamm": "pers-0001"})]
    rec = reconcile(raw, people, known_ranks=RANKS)
    assert rec.refused
    assert not rec.creates and not rec.updates and not rec.deactivations
    assert rec.last_good is None  # nothing applied — the previous good snapshot stays the good one


def test_a_medical_key_refuses_the_whole_file_through_the_ingestion_too():
    """The contract's guard, end to end: not a field silently dropped, the run refused."""
    doc = _doc()
    doc["people"][1]["tauglichkeit_bis"] = "2027-01-01"
    rec = reconcile(json.dumps(doc), [], known_ranks=RANKS)
    assert rec.refused and "medical" in rec.refused
    assert not rec.creates
    # …and the report a consumer stores carries no medical-shaped key either.
    status = status_json(rec, trigger="scheduled", last_good=None)

    def keys(node: Any) -> list[str]:
        if isinstance(node, dict):
            return [str(k) for k in node] + [k for v in node.values() for k in keys(v)]
        if isinstance(node, list):
            return [k for v in node for k in keys(v)]
        return []

    assert [k for k in keys(status) if medical_shaped(k)] == []


def test_a_snapshot_older_than_the_one_applied_is_refused():
    raw = _snapshot([_person("p1", "Muster Hans")], at="2026-09-01T04:00:00+00:00")
    good = LastGood("personalstamm", "2026-10-01T04:00:00+00:00", "abc", 1)
    rec = reconcile(raw, [], known_ranks=RANKS, last_good=good)
    assert rec.refused and "older" in rec.refused
    assert not rec.creates


# --- 3. the deactivation cap ---------------------------------------------------------------


def _station(n: int) -> list[LocalPerson]:
    return [LocalPerson(str(i), f"Person{i:02d} Vorname", identities={"personalstamm": f"p{i}"}) for i in range(n)]


def test_the_limit_is_a_share_with_a_floor_of_one():
    assert deactivation_limit(50, 20) == 10
    assert deactivation_limit(4, 20) == 1  # a small station can still lose one member unattended
    assert deactivation_limit(50, 0) == 0  # 0 % = never deactivate unattended
    assert deactivation_limit(50, 100) == 50


def test_a_complete_file_missing_a_third_of_the_brigade_is_held():
    people = _station(30)
    listed = [_person(f"p{i}", f"Person{i:02d} Vorname") for i in range(20)]  # 10 of 30 absent
    rec = reconcile(_snapshot(listed), people, known_ranks=RANKS, max_deactivate_pct=20)
    assert rec.held and rec.refused and "held" in rec.refused
    assert not rec.creates and not rec.updates  # a held run writes NOTHING, not just no deactivations
    assert len(rec.deactivations) == 10 and rec.deactivation_limit == 6
    assert rec.outcome.deactivated == 0
    assert {u.reason for u in rec.outcome.unmatched} == {"absent_from_snapshot"}  # who it would have been


def test_force_releases_a_held_run():
    people = _station(30)
    listed = [_person(f"p{i}", f"Person{i:02d} Vorname") for i in range(20)]
    rec = reconcile(_snapshot(listed), people, known_ranks=RANKS, max_deactivate_pct=20, force=True)
    assert rec.refused is None and not rec.held
    assert rec.outcome.deactivated == 10


def test_departures_under_the_limit_go_through():
    people = _station(30)
    listed = [_person(f"p{i}", f"Person{i:02d} Vorname") for i in range(25)]
    rec = reconcile(_snapshot(listed), people, known_ranks=RANKS, max_deactivate_pct=20)
    assert rec.refused is None
    assert sorted(d.person_id for d in rec.deactivations) == [str(i) for i in range(25, 30)]


def test_the_roster_is_never_emptied_even_when_forced():
    people = _station(3)
    everyone_inactive = [_person(f"p{i}", f"Person{i:02d} Vorname", active=False) for i in range(3)]
    rec = reconcile(_snapshot(everyone_inactive), people, known_ranks=RANKS, max_deactivate_pct=100, force=True)
    assert rec.refused and "no active person" in rec.refused
    assert not rec.held  # not releasable


def test_a_partial_file_says_nothing_about_absence():
    people = _station(10)
    rec = reconcile(_snapshot([_person("p0", "Person00 Vorname")], complete=False), people, known_ranks=RANKS)
    assert rec.refused is None and rec.deactivations == []


def test_absence_only_touches_people_this_provider_owns():
    people = [
        LocalPerson("hand", "Hand Eingetragen"),  # entered by hand: no identity at all
        LocalPerson("div", "Nur Divera", identities={"divera": "4711"}),  # known only to Divera
        LocalPerson("own", "Vom Stamm", identities={"personalstamm": "p-own"}),
        LocalPerson("own2", "Auch Stamm", identities={"personalstamm": "p-own2"}),
        LocalPerson("own3", "Noch Stamm", identities={"personalstamm": "p-own3"}),
        LocalPerson("own4", "Stamm Vier", identities={"personalstamm": "p-own4"}),
        LocalPerson("own5", "Stamm Fünf", identities={"personalstamm": "p-own5"}),
    ]
    listed = [
        _person(x, n)
        for x, n in [
            ("p-own2", "Auch Stamm"),
            ("p-own3", "Noch Stamm"),
            ("p-own4", "Stamm Vier"),
            ("p-own5", "Stamm Fünf"),
        ]
    ]
    rec = reconcile(_snapshot(listed), people, known_ranks=RANKS)
    assert [d.person_id for d in rec.deactivations] == ["own"]


# --- 4. identity mapping -----------------------------------------------------------------


def test_the_snapshot_key_matches_first_and_renames_follow_it():
    people = [LocalPerson("1", "Muster Hans", identities={"personalstamm": "p1"})]
    rec = reconcile(_snapshot([_person("p1", "Muster-Keller Hans")]), people, known_ranks=RANKS)
    assert rec.outcome.matched == 1 and rec.outcome.created == 0
    assert rec.updates[0].person_id == "1" and rec.updates[0].fields["display_name"] == "Muster-Keller Hans"


def test_a_divera_synced_person_is_adopted_by_their_divera_id_not_duplicated():
    """A station moving from Divera to a snapshot: nobody is created twice, the Divera link stays."""
    people = [LocalPerson("1", "Muster Hans", identities={"divera": "4711"})]
    rec = reconcile(_snapshot([_person("p1", "Muster Hans", divera="4711")]), people, known_ranks=RANKS)
    assert rec.outcome.created == 0 and rec.outcome.matched == 1
    assert rec.updates[0].links == [("personalstamm", "p1")]  # the divera pair is NOT re-attached


def test_an_existing_identity_link_is_never_overwritten():
    people = [LocalPerson("1", "Muster Hans", identities={"personalstamm": "p1", "divera": "4711"})]
    rec = reconcile(_snapshot([_person("p1", "Muster Hans", divera="9999")]), people, known_ranks=RANKS)
    assert [u.reason for u in rec.outcome.unmatched] == ["conflicting_identity"]
    assert not rec.updates and not rec.creates


def test_identities_pointing_at_two_people_are_a_conflict_not_a_guess():
    people = [
        LocalPerson("1", "Muster Hans", identities={"personalstamm": "p1"}),
        LocalPerson("2", "Andere Person", identities={"divera": "4711"}),
    ]
    rec = reconcile(_snapshot([_person("p1", "Muster Hans", divera="4711")]), people, known_ranks=RANKS)
    assert [u.reason for u in rec.outcome.unmatched] == ["conflicting_identity"]
    assert not rec.updates and not rec.deactivations  # still listed by key — not «absent»


def test_a_hand_entered_person_is_adopted_by_a_unique_name():
    people = [LocalPerson("1", "Müller Anna")]
    rec = reconcile(_snapshot([_person("p1", "Muller Anna")]), people, known_ranks=RANKS)
    assert rec.outcome.matched == 1 and rec.updates[0].links == [("personalstamm", "p1")]


def test_a_name_two_local_people_share_is_ambiguous_and_creates_nobody():
    people = [LocalPerson("1", "Meier Peter"), LocalPerson("2", "Meier Peter")]
    rec = reconcile(_snapshot([_person("p1", "Meier Peter")]), people, known_ranks=RANKS)
    assert [u.reason for u in rec.outcome.unmatched] == ["ambiguous_name"]
    assert not rec.creates and not rec.updates


def test_a_name_never_claims_a_person_another_key_of_the_provider_owns():
    people = [LocalPerson("1", "Meier Peter", identities={"personalstamm": "p-old"})]
    rec = reconcile(_snapshot([_person("p-new", "Meier Peter")], complete=False), people, known_ranks=RANKS)
    assert rec.outcome.created == 1  # a namesake with a different key is a different person


def test_an_unknown_rank_is_reported_and_never_wipes_the_stored_one():
    people = [LocalPerson("1", "Muster Hans", rank="wm", identities={"personalstamm": "p1"})]
    rec = reconcile(_snapshot([_person("p1", "Muster Hans", rank="xyz")]), people, known_ranks=RANKS)
    assert rec.outcome.unknown_ranks == ["xyz"]
    assert all("rank" not in u.fields for u in rec.updates)  # the stored «wm» is left alone


def test_an_inactive_stranger_is_reported_not_created():
    rec = reconcile(
        _snapshot([_person("p1", "Muster Hans"), _person("p2", "Alt Ehemals", active=False)]), [], known_ranks=RANKS
    )
    assert rec.outcome.created == 1
    assert [(u.external_id, u.reason) for u in rec.outcome.unmatched] == [("p2", "inactive_in_snapshot")]


def test_an_inactive_entry_deactivates_and_an_active_one_reactivates():
    people = [
        LocalPerson("1", "Muster Hans", identities={"personalstamm": "p1"}),
        LocalPerson("2", "Beispiel Anna", active=False, identities={"personalstamm": "p2"}),
        LocalPerson("3", "Dritte Person", identities={"personalstamm": "p3"}),
        LocalPerson("4", "Vierte Person", identities={"personalstamm": "p4"}),
        LocalPerson("5", "Fünfte Person", identities={"personalstamm": "p5"}),
    ]
    listed = [
        _person("p1", "Muster Hans", active=False),
        _person("p2", "Beispiel Anna"),
        _person("p3", "Dritte Person"),
        _person("p4", "Vierte Person"),
        _person("p5", "Fünfte Person"),
    ]
    rec = reconcile(_snapshot(listed), people, known_ranks=RANKS)
    assert [(d.person_id, d.reason) for d in rec.deactivations] == [("1", "inactive_in_snapshot")]
    assert [u.person_id for u in rec.updates if u.reactivate] == ["2"]


# --- 5. idempotence ----------------------------------------------------------------------


def test_applying_the_same_file_twice_changes_nothing_the_second_time():
    people = [
        LocalPerson("1", "Muster Hans", identities={"divera": "4711"}),
        LocalPerson("2", "Beispiel Anna"),
        LocalPerson("3", "Musterhalde Rita"),
    ]
    raw = json.dumps(EXAMPLE_SNAPSHOT).encode()
    first = reconcile(raw, people, known_ranks=RANKS)
    assert first.refused is None and (first.creates or first.updates)
    after = _apply(people, first)

    second = reconcile(raw, after, known_ranks=RANKS)
    assert second.refused is None
    assert second.creates == [] and second.updates == [] and second.deactivations == []
    assert second.outcome.matched == first.outcome.matched + first.outcome.created


def test_an_unchanged_file_is_skipped_by_a_scheduled_run_but_not_by_a_manual_one():
    raw = json.dumps(EXAMPLE_SNAPSHOT).encode()
    first = reconcile(raw, [], known_ranks=RANKS)
    good = first.last_good
    assert good is not None
    assert reconcile(raw, [], known_ranks=RANKS, last_good=good, skip_unchanged=True).unchanged
    assert not reconcile(raw, [], known_ranks=RANKS, last_good=good, skip_unchanged=False).unchanged


def test_status_keeps_the_last_good_snapshot_after_a_refused_run():
    good = LastGood("personalstamm", "2026-10-01T04:00:00+00:00", "abc", 4)
    rec = reconcile(b"not json", [], known_ranks=RANKS, last_good=good)
    status = status_json(rec, trigger="scheduled", last_good=good)
    assert status["lastGood"] == good.as_json()
    assert status["outcome"]["refused"]


def test_a_feed_that_stopped_moving_is_flagged_stale_but_still_applied():
    raw = _snapshot([_person("p1", "Muster Hans")], at="2026-10-01T04:00:00+00:00")
    now = datetime(2026, 10, 1, 4, tzinfo=UTC) + timedelta(days=8)
    rec = reconcile(raw, [], known_ranks=RANKS, now=now)
    assert rec.stale and rec.refused is None and rec.outcome.created == 1
