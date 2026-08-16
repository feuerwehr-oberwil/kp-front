"""The layer that does not depend on having enumerated the write paths.

Every writer of ``deployment_config.config_json`` replaces the WHOLE document, so a writer holding
an outdated copy costs a station its Dienstgrade, its Doktrin and its Partnerorganisationen in one
silent write. The demo lost its config three times in four days, each time through a different
path, each time fixed by closing the path that had just been observed. These cover the two things
that hold regardless of which path it is next time: the previous document is KEPT (so a bad write
is undoable, by anyone, whatever wrote it), and a load that would EMPTY something populated is
refused rather than reported as success.
"""

import pytest
from sqlalchemy import select

from app.config_history import changed_sections, emptied_sections
from app.models import DeploymentConfigHistory

# --- emptied_sections: the shape of the damage, not a diff ---------------------------


def test_reports_a_populated_section_going_empty():
    """«roster.ranks: 4 → 0» is what every one of these incidents actually looked like."""
    old = {
        "roster": {"ranks": [1, 2, 3, 4]},
        "doctrine": {"alarmBar": 100},
        "report": {"partnerOrgs": ["Polizei"]},
    }
    new = {"roster": {"ranks": []}, "doctrine": {"alarmBar": None}, "report": {"partnerOrgs": []}}
    assert sorted(emptied_sections(old, new)) == ["doctrine.alarmBar", "report.partnerOrgs", "roster.ranks"]


def test_a_section_merely_changing_is_not_reported():
    """Ordinary editing. A guard that fires on every edit is one people learn to --force past."""
    old = {"roster": {"ranks": [1, 2]}, "identity": {"appName": "Alt"}}
    new = {"roster": {"ranks": [9]}, "identity": {"appName": "Neu"}}
    assert emptied_sections(old, new) == []


def test_a_section_being_added_is_not_reported():
    old = {"identity": {"appName": "X"}}
    new = {"identity": {"appName": "X"}, "roster": {"ranks": [1]}}
    assert emptied_sections(old, new) == []


def test_zero_and_false_are_values_somebody_chose():
    """⚠️ `0` is a setting, not absence — reporting it would train people to ignore the refusal."""
    old = {"doctrine": {"contactGraceSec": 60, "x": True}}
    new = {"doctrine": {"contactGraceSec": 0, "x": False}}
    assert emptied_sections(old, new) == []


def test_a_whole_top_level_section_disappearing_is_reported():
    old = {"fleet": {"vehicles": [1, 2, 3]}, "alarms": {"groups": [1]}}
    new = {"fleet": {}, "alarms": {}}
    assert sorted(emptied_sections(old, new)) == ["alarms.groups", "fleet.vehicles"]


def test_nothing_stored_yet_means_nothing_can_be_lost():
    assert emptied_sections(None, {"identity": {"appName": "X"}}) == []
    assert emptied_sections({}, {"identity": {"appName": "X"}}) == []


# --- changed_sections: what makes one row different from the next ---------------------
#
# ⚠️ «Letzte Änderungen» used to list what a kept document CONTAINED. Since every writer replaces
# the whole document, that was the same nine section names on every row — 26 of them after one
# afternoon of setting a station up, four inside the same minute. The list could not answer the
# question it is opened with: WHICH entry do I go back to?


def test_names_only_what_the_write_touched():
    old = {"identity": {"appName": "Alt"}, "fleet": {"vehicles": [1]}, "map": {"defaultView": {"z": 14}}}
    new = {"identity": {"appName": "Alt"}, "fleet": {"vehicles": [1, 2]}, "map": {"defaultView": {"z": 14}}}
    assert changed_sections(old, new) == ["fleet.vehicles"]


def test_an_added_or_removed_section_is_a_change():
    old = {"identity": {"appName": "X"}, "report": {"partnerOrgs": ["Polizei"]}}
    new = {"identity": {"appName": "X"}, "roster": {"ranks": [1]}}
    assert changed_sections(old, new) == ["report.partnerOrgs", "roster.ranks"]


def test_an_autosave_that_rewrote_the_same_document_says_so():
    """Not an error and not a gap: an empty list is what makes such a write collapsible."""
    doc = {"identity": {"appName": "X"}, "fleet": {"vehicles": [1]}}
    assert changed_sections(doc, dict(doc)) == []


def test_it_stops_one_level_down():
    """Deeper than this a "section" is a single field and the noise the whole list suffers from
    comes straight back."""
    old = {"map": {"defaultView": {"lat": 47.0, "lon": 7.0, "zoom": 14}}}
    new = {"map": {"defaultView": {"lat": 47.5, "lon": 7.5, "zoom": 16}}}
    assert changed_sections(old, new) == ["map.defaultView"]


def test_a_missing_side_is_not_a_crash():
    assert changed_sections(None, {"identity": {"appName": "X"}}) == ["identity.appName"]
    assert changed_sections({"identity": {"appName": "X"}}, None) == ["identity.appName"]
    assert changed_sections(None, None) == []


# --- the kept document ----------------------------------------------------------------


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_a_put_keeps_the_document_it_replaced(client, editor, admin_login, session_factory):
    """THE undo. Whatever clobbers the config next time, what it replaced is still there."""
    await _login(client, editor)
    await admin_login(client)

    first = await client.put("/api/config", json={"identity": {"appName": "Erste"}})
    v = first.json()["version"]
    await client.put("/api/config", json={"identity": {"appName": "Zweite"}}, headers={"If-Match": v})

    # ⚠️ through the TEST session factory — `app.database.async_session_maker` is the app's own
    # engine and would read the dev database, not the one this test just wrote to
    async with session_factory() as db:
        kept = (await db.execute(select(DeploymentConfigHistory))).scalars().all()
    # the FIRST write had an empty row to replace and kept nothing; the second kept «Erste»
    assert [k.config_json["identity"]["appName"] for k in kept] == ["Erste"]
    assert kept[0].source == "api"
    # …and it names WHO — the question nobody could answer after any of the three incidents
    assert kept[0].replaced_by is not None


@pytest.mark.asyncio
async def test_nothing_is_kept_when_there_is_nothing_to_keep(client, editor, admin_login, session_factory):
    """A fresh install has no earlier state; a row of nulls would only be noise in `history`."""
    await _login(client, editor)
    await admin_login(client)
    await client.put("/api/config", json={"identity": {"appName": "Erste"}})
    async with session_factory() as db:
        assert (await db.execute(select(DeploymentConfigHistory))).scalars().all() == []
