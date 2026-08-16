"""The CSV import's rank-mapping step: parse → group by VALUE → decide → write, in that order.

Two properties are load-bearing and each has its own tests here:

* **counted by value, never by row** — forty people spelled «Sdt» are one decision. The bug this
  replaces produced one grey bullet per row, underneath a green «40 importiert» badge, after the
  write had already happened.
* **an aborted import writes nothing** — not the people, not the ranks. Every refusal below
  asserts the database is untouched afterwards, because a half-applied import is the failure
  nobody notices until an Einsatz.
"""

import json

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig, Personnel
from app.personnel import (
    RosterCsvRow,
    append_ranks,
    group_unknown_ranks,
    parse_roster_csv,
    suggest_rank,
)

# asyncio_mode = "auto" (pyproject) runs the async tests below; the pure ones stay plain.

RANKS = [
    {"key": "hptm", "label": "Hauptmann", "abbr": "Hptm", "tier": "officer"},
    {"key": "oblt", "label": "Oberleutnant", "abbr": "Oblt", "tier": "officer"},
    {"key": "kpl", "label": "Korporal", "abbr": "Kpl", "tier": "nco"},
    {"key": "fwm", "label": "Feuerwehrmann", "abbr": "Fwm", "tier": "crew"},
]


def _row(name: str, rank: str = "") -> RosterCsvRow:
    return RosterCsvRow(line=2, name=name, rank_text=rank, provider="", external_id="")


# --- parsing (pure) -----------------------------------------------------------------


def test_parse_keeps_rows_and_names_the_line_of_each_problem():
    parsed = parse_roster_csv("name,rank\nBerger Luca,Sdt\n,Kpl\nFrei Nadja,\n")
    assert [r.name for r in parsed.rows] == ["Berger Luca", "Frei Nadja"]
    assert parsed.rows[0].rank_text == "Sdt"
    assert parsed.skipped == 1
    assert parsed.errors == ["Zeile 3: 'name' fehlt"]


def test_parse_without_a_name_column_is_not_a_roster():
    with pytest.raises(ValueError):
        parse_roster_csv("vorname,grad\nLuca,Sdt\n")


# --- grouping (pure) ----------------------------------------------------------------


def test_forty_rows_of_one_unknown_value_are_one_decision():
    rows = [_row(f"Person {i}", "Sdt") for i in range(40)]
    groups = group_unknown_ranks(rows, RANKS)
    assert len(groups) == 1
    assert (groups[0].value, groups[0].count) == ("Sdt", 40)
    # a handful of names travels with it — enough to recognise who, not the whole file
    assert groups[0].people == [f"Person {i}" for i in range(6)]


def test_spelling_variants_of_one_value_group_together_and_known_ranks_do_not_show_up():
    rows = [_row("A", "Sdt"), _row("B", " sdt "), _row("C", "Kpl"), _row("D", "Feuerwehrmann"), _row("E", "")]
    groups = group_unknown_ranks(rows, RANKS)
    assert [(g.value, g.count) for g in groups] == [("Sdt", 2)]


def test_groups_keep_file_order():
    rows = [_row("A", "Zug"), _row("B", "Sdt"), _row("C", "Zug")]
    assert [g.value for g in group_unknown_ranks(rows, RANKS)] == ["Zug", "Sdt"]


def test_a_near_miss_is_proposed_and_a_foreign_word_is_not():
    assert suggest_rank("Oblt.", RANKS) == "oblt"
    assert suggest_rank("Sdt", RANKS) is None


# --- the new rank list (pure) -------------------------------------------------------


def test_adopted_ranks_land_at_the_end_and_never_collide():
    out = append_ranks(RANKS, ["Sdt", "Fwm."])
    assert [r["key"] for r in out] == ["hptm", "oblt", "kpl", "fwm", "sdt", "fwm-2"]
    assert out[4] == {"key": "sdt", "label": "Sdt", "abbr": "Sdt", "tier": "crew"}


# --- the endpoints ------------------------------------------------------------------

# one genuinely unknown value repeated (Sdt ×2), one known (Kpl), one more unknown (Zugführer)
CSV = "name,rank\nBerger Luca,Sdt\nFrei Nadja,Kpl\nSutter Ivo,Sdt\nWeber Urs,Zugführer\n"


def _file(text: str = CSV):
    return {"file": ("mannschaft.csv", text.encode("utf-8"), "text/csv")}


def _decisions(*decisions: dict):
    return {"decisions": json.dumps(list(decisions))}


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _people(db_session) -> list[Personnel]:
    db_session.expire_all()
    return list((await db_session.execute(select(Personnel))).scalars())


async def _stored_ranks(db_session) -> list[dict] | None:
    db_session.expire_all()
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    return ((row.config_json or {}).get("roster") or {}).get("ranks") if row else None


async def test_preview_groups_by_value_and_writes_nothing(client, editor, db_session):
    await _login(client, editor)
    r = await client.post("/api/personnel/import-csv/preview", files=_file())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 4
    assert [(g["value"], g["count"]) for g in body["unknown_ranks"]] == [("Sdt", 2), ("Zugführer", 1)]
    assert body["unknown_ranks"][0]["people"] == ["Berger Luca", "Sutter Ivo"]
    # the station has no list of its own — it is running on the shipped Swiss default, which is
    # exactly why «Kpl» counts as known here
    assert body["has_own_ranks"] is False
    assert "kpl" in {k["key"] for k in body["known_ranks"]}

    assert await _people(db_session) == []
    assert await _stored_ranks(db_session) is None


async def test_an_undecided_value_imports_nobody(client, editor, db_session):
    await _login(client, editor)
    r = await client.post("/api/personnel/import-csv", files=_file())
    assert r.status_code == 409, r.text
    assert "Sdt" in r.json()["detail"]
    assert await _people(db_session) == []

    # …and neither does a partially decided one: the known rows are not a consolation prize
    r = await client.post(
        "/api/personnel/import-csv",
        files=_file(),
        data=_decisions({"value": "Sdt", "action": "skip"}),
    )
    assert r.status_code == 409
    assert "Zugführer" in r.json()["detail"]
    assert await _people(db_session) == []


async def test_a_map_onto_a_rank_that_does_not_exist_writes_nothing(client, editor, db_session):
    await _login(client, editor)
    r = await client.post(
        "/api/personnel/import-csv",
        files=_file(),
        data=_decisions(
            {"value": "Sdt", "action": "map", "rank": "admiral"},
            {"value": "Zugführer", "action": "skip"},
        ),
    )
    assert r.status_code == 422, r.text
    assert await _people(db_session) == []
    assert await _stored_ranks(db_session) is None


async def test_adopting_writes_roster_ranks_and_the_people_carry_them(client, editor, admin_login, db_session):
    await _login(client, editor)
    await admin_login(client)
    r = await client.post(
        "/api/personnel/import-csv",
        files=_file(),
        data=_decisions(
            {"value": "Sdt", "action": "adopt"},
            {"value": "Zugführer", "action": "adopt"},
        ),
    )
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 4
    assert r.json()["adopted_ranks"] == ["sdt", "zugfuhrer"]

    ranks = await _stored_ranks(db_session)
    assert ranks is not None
    # ⚠️ the shipped default was materialised, not replaced: «Kpl» has to keep resolving
    assert [r_["key"] for r_ in ranks][-2:] == ["sdt", "zugfuhrer"]
    assert "kpl" in {r_["key"] for r_ in ranks}
    assert next(r_ for r_ in ranks if r_["key"] == "zugfuhrer")["label"] == "Zugführer"

    by_name = {p.display_name: p for p in await _people(db_session)}
    assert by_name["Berger Luca"].rank == "sdt"
    assert by_name["Sutter Ivo"].rank == "sdt"
    assert by_name["Frei Nadja"].rank == "kpl"
    assert by_name["Weber Urs"].rank == "zugfuhrer"

    # the value is known from now on — the second import asks nothing
    p = await client.post("/api/personnel/import-csv/preview", files=_file())
    assert p.json()["unknown_ranks"] == []
    assert p.json()["has_own_ranks"] is True


async def test_mapping_and_skipping_touch_no_config(client, editor, admin_login, db_session):
    await _login(client, editor)
    await admin_login(client)
    r = await client.post(
        "/api/personnel/import-csv",
        files=_file(),
        data=_decisions(
            {"value": "Sdt", "action": "map", "rank": "fwm"},
            {"value": "Zugführer", "action": "skip"},
        ),
    )
    assert r.status_code == 200, r.text
    assert r.json()["adopted_ranks"] == []
    assert any("Zugführer" in e for e in r.json()["errors"])  # dropped ON PURPOSE, still reported
    assert await _stored_ranks(db_session) is None

    by_name = {p.display_name: p for p in await _people(db_session)}
    assert by_name["Berger Luca"].rank == "fwm"
    assert by_name["Weber Urs"].rank is None


async def test_an_editor_without_the_admin_surface_cannot_write_the_rank_list(client, editor, db_session):
    await _login(client, editor)  # incident editor, no admin session
    r = await client.post(
        "/api/personnel/import-csv",
        files=_file(),
        data=_decisions(
            {"value": "Sdt", "action": "adopt"},
            {"value": "Zugführer", "action": "skip"},
        ),
    )
    assert r.status_code == 403, r.text
    assert await _people(db_session) == []
    assert await _stored_ranks(db_session) is None


async def test_adopting_extends_a_stations_own_list_instead_of_the_shipped_one(client, editor, admin_login, db_session):
    db_session.add(
        DeploymentConfig(
            id=1,
            config_json={"roster": {"ranks": [{"key": "chef", "label": "Chef", "abbr": "Chef", "tier": "officer"}]}},
        )
    )
    await db_session.commit()
    await _login(client, editor)
    await admin_login(client)

    r = await client.post(
        "/api/personnel/import-csv",
        files=_file("name,rank\nBerger Luca,Sdt\n"),
        data=_decisions({"value": "Sdt", "action": "adopt"}),
    )
    assert r.status_code == 200, r.text
    assert [r_["key"] for r_ in await _stored_ranks(db_session)] == ["chef", "sdt"]
