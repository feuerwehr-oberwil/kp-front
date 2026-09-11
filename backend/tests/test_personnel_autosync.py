"""The unattended Mannschaft sync (`roster.autoSync`) and what it is allowed to do.

Until this existed the roster was as current as the last time somebody remembered to press
«Mannschaft synchronisieren». Running it nightly is easy; running it nightly WITHOUT it being
able to quietly empty the Wehr is the part with a judgement in it, and that judgement is the
three levels:

* ``off``  — nothing unattended, the manual button unchanged;
* ``safe`` — joins, renames and Dienstgrade are applied; a member who left Divera is COUNTED
  and left active, because a disappearance is as often a broken feed as a resignation;
* ``full`` — the same, and the stale ones are deactivated (never deleted: every past Einsatz
  keeps its names).

Plus the honesty rule the SharePoint connector already lives by: a run that fetched nothing is
not a success, and here it must not even be applied — an empty consumer list makes every member
of the station stale at once.
"""

import pytest
from sqlalchemy import select

from app import connector_state, scheduler
from app import personnel as personnel_svc
from app.config import settings
from app.models import ConnectorState, DeploymentConfig, Personnel, PersonnelExternalIdentity


class _SessionCtx:
    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def _memo():
    connector_state.reset_memo()
    yield
    connector_state.reset_memo()


@pytest.fixture
def run_job(db_session, monkeypatch):
    monkeypatch.setattr(scheduler, "async_session_maker", lambda: _SessionCtx(db_session))

    async def _run(job) -> None:
        await job()

    return _run


@pytest.fixture
def divera(monkeypatch):
    """The Divera member feed the test drives, plus the key that makes the job run at all."""
    monkeypatch.setattr(settings, "divera_access_key", "k")
    feed: list[dict] = []

    async def _fetch(order="last-first"):
        if feed and feed[0] == "boom":
            raise ValueError("Divera API returned success=false")
        return [dict(m) for m in feed]

    monkeypatch.setattr(personnel_svc, "fetch_divera_members", _fetch)
    return feed


async def _level(db, value: str | None) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json={})
        db.add(row)
    row.config_json = {**(row.config_json or {}), "roster": {} if value is None else {"autoSync": value}}
    await db.commit()


async def _member(db, *, divera_id: int, name: str, active: bool = True) -> Personnel:
    person = Personnel(display_name=name, is_active=active)
    db.add(person)
    await db.flush()
    db.add(PersonnelExternalIdentity(personnel_id=person.id, provider="divera", external_id=str(divera_id)))
    await db.commit()
    return person


async def _state(db) -> ConnectorState | None:
    return (
        await db.execute(select(ConnectorState).where(ConnectorState.name == connector_state.DIVERA_PERSONNEL))
    ).scalar_one_or_none()


# --- the levels ---------------------------------------------------------------------------


async def test_the_shipped_default_is_safe(db_session):
    """A station that has never chosen: the roster follows Divera, and nobody is deactivated
    behind anyone's back."""
    assert await personnel_svc.load_roster_auto_sync(db_session) == "safe"


async def test_off_touches_nothing_and_reports_nothing(db_session, divera, run_job):
    await _level(db_session, "off")
    divera.append({"divera_id": 1, "name": "Müller Hans", "first_name": "Hans", "last_name": "Müller"})

    await run_job(scheduler._personnel_autosync)

    assert (await db_session.execute(select(Personnel))).scalars().all() == []
    # Nothing was ATTEMPTED, so there is nothing to report — a status row here would make the
    # card claim a connector this station switched off.
    assert await _state(db_session) is None


async def test_safe_applies_the_joins_and_counts_the_leavers_without_touching_them(db_session, divera, run_job):
    await _level(db_session, "safe")
    gone = await _member(db_session, divera_id=9, name="Weber Ruth")
    divera.append({"divera_id": 1, "name": "Müller Hans", "first_name": "Hans", "last_name": "Müller"})

    await run_job(scheduler._personnel_autosync)

    names = {p.display_name for p in (await db_session.execute(select(Personnel))).scalars()}
    assert names == {"Weber Ruth", "Müller Hans"}
    await db_session.refresh(gone)
    assert gone.is_active is True  # a departure is a decision, not a poll result

    state = await _state(db_session)
    assert state.last_success_at is not None and state.last_error is None
    assert state.detail == {
        "trigger": "scheduled",
        "level": "safe",
        "added": 1,
        "updated": 0,
        "reactivated": 0,
        "deactivated": 0,
        # The number the card nudges with («N Abgänge warten»). Without it the departures sit
        # in the roster unremarked and «safe» becomes «never finishes».
        "staleOutstanding": 1,
    }


async def test_safe_still_follows_a_rename(db_session, divera, run_job):
    """The updates are the point of running at all — «safe» is not «read-only»."""
    await _level(db_session, "safe")
    person = await _member(db_session, divera_id=1, name="Müller Hans")
    divera.append({"divera_id": 1, "name": "Müller-Meier Hans", "first_name": "Hans", "last_name": "Müller-Meier"})

    await run_job(scheduler._personnel_autosync)

    await db_session.refresh(person)
    assert person.display_name == "Müller-Meier Hans"
    assert (await _state(db_session)).detail["updated"] == 1


async def test_full_deactivates_the_leavers_and_deletes_nobody(db_session, divera, run_job):
    await _level(db_session, "full")
    gone = await _member(db_session, divera_id=9, name="Weber Ruth")
    divera.append({"divera_id": 1, "name": "Müller Hans", "first_name": "Hans", "last_name": "Müller"})

    await run_job(scheduler._personnel_autosync)

    await db_session.refresh(gone)
    assert gone.is_active is False
    assert gone.display_name == "Weber Ruth"  # still there — every past Einsatz references it
    detail = (await _state(db_session)).detail
    assert detail["deactivated"] == 1
    assert detail["staleOutstanding"] == 0  # this run already dealt with them


async def test_without_a_key_the_nightly_run_is_a_no_op(db_session, monkeypatch, run_job):
    """Registered unconditionally, idle without a credential — the standing rule for every job
    whose key can be pasted into Verwaltung while the process is already running."""
    monkeypatch.setattr(settings, "divera_access_key", "")
    await _level(db_session, "full")

    await run_job(scheduler._personnel_autosync)

    assert await _state(db_session) is None


# --- the honesty rule ---------------------------------------------------------------------


async def test_an_empty_feed_applies_nothing_and_is_not_a_success(db_session, divera, run_job):
    """⚠️ The one that would have hurt: against an empty consumer list every member of the
    station is stale, so at level «full» a single API hiccup would deactivate the whole Wehr —
    overnight, with nobody watching."""
    await _level(db_session, "full")
    person = await _member(db_session, divera_id=1, name="Müller Hans")

    await run_job(scheduler._personnel_autosync)

    await db_session.refresh(person)
    assert person.is_active is True
    state = await _state(db_session)
    assert state.last_success_at is None
    assert state.last_error == "Divera returned no members"


async def test_a_failed_run_never_moves_the_last_success(db_session, divera, run_job):
    await _level(db_session, "safe")
    divera.append({"divera_id": 1, "name": "Müller Hans", "first_name": "Hans", "last_name": "Müller"})
    await run_job(scheduler._personnel_autosync)
    succeeded_at = (await _state(db_session)).last_success_at

    divera[:] = ["boom"]
    await run_job(scheduler._personnel_autosync)

    state = await _state(db_session)
    assert state.last_success_at == succeeded_at
    assert state.last_error == "Divera API returned success=false"


# --- the manual button writes the same row ------------------------------------------------


async def test_a_hand_triggered_sync_is_the_same_last_synced(db_session, client, editor, divera):
    """«zuletzt synchronisiert» has to be true whoever pressed it — a card that counted only the
    unattended runs would report a station as stale on the day somebody sat down and synced it."""
    divera.append({"divera_id": 1, "name": "Müller Hans", "first_name": "Hans", "last_name": "Müller"})
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})

    r = await client.post("/api/personnel/sync/execute", json={"deactivate_stale": False})
    assert r.status_code == 200, r.text

    state = await _state(db_session)
    assert state.last_success_at is not None
    assert state.detail == {
        "trigger": "manual",
        "level": None,  # a hand-triggered run applies what the operator asked for, not a level
        "added": 1,
        "updated": 0,
        "reactivated": 0,
        "deactivated": 0,
        "staleOutstanding": 0,
    }


async def test_a_failed_hand_triggered_sync_records_the_reason(db_session, client, editor, divera):
    divera[:] = ["boom"]
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})

    r = await client.post("/api/personnel/sync/execute", json={"deactivate_stale": False})
    assert r.status_code == 502

    state = await _state(db_session)
    assert state.last_success_at is None
    assert state.last_error == "Divera API returned success=false"
