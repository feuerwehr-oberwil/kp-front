"""A second import of the same roster must not produce a second Wehr.

The bug this pins: a station imported 14 people, re-picked the SAME file, and got 28 rows and
14 names — with no preview and no confirmation, because the only confirmation the import had
was the unknown-rank mapping sheet, and after the first import every rank was known.

So two properties are covered here:

* **idempotent** — a row that resolves to somebody the station already has updates that person
  (:func:`app.personnel.plan_roster_rows`), and never adds a second one;
* **every import is previewable** — the preview says how many people are new and how many are
  updates, using the same planner the write uses, before anything is written.
"""

import uuid

import pytest
from sqlalchemy import func, select

from app.models import Personnel
from app.personnel import RosterCsvRow, RosterIndex, plan_roster_rows

# asyncio_mode = "auto" (pyproject) runs the async tests below; the pure ones stay plain.


@pytest.fixture
def person_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def other_id() -> uuid.UUID:
    return uuid.uuid4()


def _row(name: str, rank: str = "", provider: str = "", external_id: str = "") -> RosterCsvRow:
    return RosterCsvRow(line=2, name=name, rank_text=rank, provider=provider, external_id=external_id)


def _index(**kwargs) -> RosterIndex:
    return RosterIndex(
        by_external=kwargs.get("by_external", {}),
        by_name=kwargs.get("by_name", {}),
        providers=kwargs.get("providers", set()),
    )


# --- planning (pure) ----------------------------------------------------------------


def test_a_roster_the_station_does_not_have_is_all_new():
    plan = plan_roster_rows([_row("Meier Hans"), _row("Frei Nadja")], _index())
    assert (plan.creates, plan.updates) == (2, 0)
    assert [t.person_id for t in plan.targets] == [None, None]


def test_the_same_names_a_second_time_are_updates_not_inserts(person_id):
    index = _index(by_name={"meier hans": person_id})
    plan = plan_roster_rows([_row("Meier Hans"), _row("Frei Nadja")], index)
    assert (plan.creates, plan.updates) == (1, 1)
    assert plan.targets[0].person_id == person_id


def test_the_name_match_ignores_case_accents_and_spacing(person_id):
    plan = plan_roster_rows([_row("  BLÄSI   Vreni ")], _index(by_name={"blasi vreni": person_id}))
    assert (plan.creates, plan.updates) == (0, 1)


def test_one_person_named_twice_in_the_file_is_one_person():
    plan = plan_roster_rows([_row("Meier Hans", "Kpl"), _row("Meier Hans", "Wm")], _index())
    assert (plan.creates, plan.updates) == (1, 0)
    # the second row lands on the person the first one creates, and says so
    assert plan.targets[1].owner == 0
    assert plan.duplicate_names == ["Meier Hans"]


def test_the_provider_identity_still_outranks_the_name(person_id, other_id):
    index = _index(by_external={("example", "crew-7"): person_id}, by_name={"meier hans": other_id})
    plan = plan_roster_rows([_row("Meier Hans", provider="example", external_id="crew-7")], index)
    assert plan.targets[0].person_id == person_id


# --- the endpoint -------------------------------------------------------------------

ROSTER = "name,rank\nMeier Hans,Kpl\nFrei Nadja,Fwm\nBläsi Vreni,\n"


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


def _file(text: str) -> dict:
    return {"file": ("mannschaft.csv", text.encode("utf-8"), "text/csv")}


async def _count(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(Personnel))).scalar_one()


async def test_importing_the_same_file_twice_changes_nothing_the_second_time(client, editor, db_session):
    await _login(client, editor)
    first = await client.post("/api/personnel/import-csv", files=_file(ROSTER))
    assert first.json()["created"] == 3
    after_first = await _count(db_session)

    second = await client.post("/api/personnel/import-csv", files=_file(ROSTER))
    assert second.status_code == 200, second.text
    assert second.json()["created"] == 0
    assert second.json()["updated"] == 3
    assert await _count(db_session) == after_first


async def test_a_changed_field_updates_the_person_in_place(client, editor):
    await _login(client, editor)
    await client.post("/api/personnel/import-csv", files=_file(ROSTER))
    await client.post("/api/personnel/import-csv", files=_file("name,rank\nMeier Hans,Hptm\n"))

    roster = (await client.get("/api/personnel")).json()
    meier = [p for p in roster if p["display_name"] == "Meier Hans"]
    assert len(meier) == 1
    assert meier[0]["rank"] == "hptm"


async def test_a_file_without_ranks_does_not_strip_the_ranks_it_does_not_mention(client, editor):
    await _login(client, editor)
    await client.post("/api/personnel/import-csv", files=_file(ROSTER))
    await client.post("/api/personnel/import-csv", files=_file("name\nMeier Hans\n"))

    roster = (await client.get("/api/personnel")).json()
    assert next(p for p in roster if p["display_name"] == "Meier Hans")["rank"] == "kpl"


async def test_a_re_import_reactivates_somebody_who_was_deactivated(client, editor):
    await _login(client, editor)
    await client.post("/api/personnel/import-csv", files=_file(ROSTER))
    roster = (await client.get("/api/personnel")).json()
    meier = next(p for p in roster if p["display_name"] == "Meier Hans")
    assert (await client.delete(f"/api/personnel/{meier['id']}")).status_code == 200

    await client.post("/api/personnel/import-csv", files=_file(ROSTER))
    active = [p["display_name"] for p in (await client.get("/api/personnel")).json()]
    assert active.count("Meier Hans") == 1


async def test_the_preview_says_what_a_first_and_a_second_import_would_do(client, editor, db_session):
    await _login(client, editor)
    fresh = (await client.post("/api/personnel/import-csv/preview", files=_file(ROSTER))).json()
    assert (fresh["creates"], fresh["updates"], fresh["total"]) == (3, 0, 3)
    # a preview writes nothing — the second one below would report updates if it had
    assert await _count(db_session) == 0

    await client.post("/api/personnel/import-csv", files=_file(ROSTER))
    again = (await client.post("/api/personnel/import-csv/preview", files=_file(ROSTER))).json()
    assert (again["creates"], again["updates"]) == (0, 3)
    assert again["unknown_ranks"] == []  # ⚠️ the path that used to skip the confirmation entirely


async def test_the_preview_counts_unreadable_rows_and_names_the_line(client, editor):
    await _login(client, editor)
    body = (
        await client.post("/api/personnel/import-csv/preview", files=_file("name,rank\n,Kpl\nFrei Nadja,\n"))
    ).json()
    assert (body["creates"], body["skipped"]) == (1, 1)
    assert body["errors"] == ["Zeile 2: 'name' fehlt"]


async def test_a_file_that_names_one_person_twice_says_so_before_importing(client, editor):
    await _login(client, editor)
    text = "name,rank\nMeier Hans,Kpl\nMeier Hans,Wm\n"
    body = (await client.post("/api/personnel/import-csv/preview", files=_file(text))).json()
    assert (body["total"], body["creates"]) == (2, 1)
    assert body["errors"] == ["«Meier Hans» steht mehrfach in der Datei – wird als eine Person importiert."]
