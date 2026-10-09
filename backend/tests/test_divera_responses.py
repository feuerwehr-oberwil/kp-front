"""Divera Rückmeldungen (app/divera_responses + the poll + GET /api/divera/responses/{id}).

The fixtures in tests/fixtures/divera/ have the REAL shape of Divera's `/api/v2/alarms` and
`/api/v2/pull/all` (research 08.10.2026: four independent clients agree that `ucr_answered` is
`{status id: {ucr: {ts, note}}}`, not the `int[]` Divera's Swagger claims). No test here, and no
code path, calls Divera: the HTTP layer is a MockTransport.

What is pinned (yes / no only — owner, 09.10.2026):
- parsing: dict AND list `items`, `ucr_answered: []` on an alarm nobody answered, junk ids
  dropped, the latest answer per person if Divera files one twice;
- the default classification («Komme nicht» is NOT coming although it contains «komme»), the
  station override by id and by name, id beating name; «andere» is dropped, not counted;
- what is STORED is our personnel ids per yes/no and a count of unknown people — no status, no
  time, no note, no Divera id;
- a newer alarm's answer wins (Nachalarm); alarms older than 6 h no longer count;
- the poll stores known alarms only, writes nothing for a no-op poll, keeps what it had while the
  status names cannot be loaded, and refetches the names for an unknown status (backoff);
- stored answers are cleared once the Einsatz is over and 48 h after the alarm;
- the read: editor-only, open Einsätze only, `available: false` without answers.
"""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select

from app import divera as divera_mod
from app import divera_responses as dr
from app.config import settings
from app.models import DeploymentConfig, DiveraEmergency, Incident, Personnel, PersonnelExternalIdentity

FIX = Path(__file__).parent / "fixtures" / "divera"
ALARMS = json.loads((FIX / "alarms_with_responses.json").read_text())
PULL_ALL = json.loads((FIX / "pull_all_statuses.json").read_text())
PIN = "135790"


@pytest.fixture(autouse=True)
def _fresh_catalogue():
    dr.reset_catalogue_cache()
    yield
    dr.reset_catalogue_cache()


@pytest.fixture
def patch_httpx(monkeypatch):
    calls: list[str] = []

    def _install(handler):
        def _counting(request: httpx.Request):
            calls.append(request.url.path)
            return handler(request)

        transport = httpx.MockTransport(_counting)
        orig_init = httpx.AsyncClient.__init__

        def patched_init(self, *args, **kwargs):
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)
        return calls

    return _install


def _divera(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/alarms"):
        return httpx.Response(200, json=ALARMS)
    if request.url.path.endswith("/pull/all"):
        return httpx.Response(200, json=PULL_ALL)
    return httpx.Response(404)


# --- parsing ------------------------------------------------------------------------------


def test_the_real_alarm_shape_parses_and_an_alarm_without_answers_is_skipped():
    parsed = dr.parse_responses_by_alarm(ALARMS)
    # 4712: `ucr_answered: []` (Divera's empty shape) — nothing to record, no crash
    assert list(parsed) == [4711]
    assert parsed[4711] == {"101": "11", "102": "11", "103": "12", "999": "12", "104": "13", "105": "13", "106": "17"}


def test_items_as_a_list_junk_and_a_double_answer_are_handled():
    data = {
        "success": True,
        "data": {
            "items": [
                {
                    "id": 9,
                    "ucr_answered": {
                        "x": {"5": {}},
                        "3": {"5": {"ts": "1791478860"}, "bad": {}},
                        # 5 answered twice: the later answer is the one that counts
                        "4": {"5": {"ts": 1791478900}, "6": {"ts": 10**20}},
                    },
                },
                {"id": 0, "ucr_answered": {"3": {"1": {"ts": 1}}}},
                {"id": 10},
                "nonsense",
            ]
        },
    }
    assert dr.parse_responses_by_alarm(data) == {9: {"5": "4", "6": "4"}}
    assert dr.parse_responses_by_alarm({"success": False}) == {}


# --- classification -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "minutes", "kind"),
    [
        ("Komme", 0, "coming"),
        ("Komme in 10 min", 10, "coming"),
        ("Komme später", 0, "coming"),
        ("Komme nicht", 0, "not_coming"),
        ("Nicht einsatzbereit", 0, "not_coming"),
        ("Abwesend", 0, "not_coming"),
        ("Einsatzbereit", 0, "coming"),
        ("Rückruf erbeten", 0, "other"),
        ("Bin unterwegs", 0, "coming"),
        ("Je viens", 0, "coming"),
        ("Je ne viens pas", 0, "not_coming"),
        ("Vengo", 0, "coming"),
        ("Non vengo", 0, "not_coming"),
        ("Grün", 5, "coming"),
        ("", 0, "other"),
    ],
)
def test_the_default_reads_the_status_name_not_coming_first(name, minutes, kind):
    assert dr.default_kind(name, minutes) == kind


def test_the_station_override_wins_by_id_then_by_name():
    ov = dr.normalise_overrides({"17": "coming", "komme nicht": "other", "Rückruf erbeten": "not_coming", "x": "bogus"})
    status = PULL_ALL["data"]["cluster"]["status"]
    assert dr.classify("17", status["17"], ov) == "coming"  # id beats the name entry
    assert dr.classify("13", status["13"], ov) == "other"  # by name, accent/case-insensitive
    assert dr.classify("11", status["11"], ov) == "coming"  # untouched → default
    assert dr.classify("99", None, ov) == "other"  # nobody can name it


# --- what is stored, what is read -----------------------------------------------------------

#: the Mannschaftsliste of the tests: Divera user → our personnel id; 999 is on nobody's roster
ROSTER = {str(u): f"p{u}" for u in range(101, 107)}
CATALOGUE = dr.parse_status_catalogue(PULL_ALL)


def _blob():
    return dr.classify_answers(dr.parse_responses_by_alarm(ALARMS)[4711], CATALOGUE, None, ROSTER)


def test_only_our_ids_and_yes_no_are_stored():
    assert _blob() == {
        "coming": ["p101", "p102", "p103"],
        "not_coming": ["p104", "p105"],
        # 999 said «Komme in 10 min» and is on nobody's roster: a number, not an id
        "unmapped": {"coming": 1, "not_coming": 0},
    }
    # «Rückruf erbeten» (106) is neither — dropped, not counted
    assert "p106" not in str(_blob())


def test_the_summary_is_names_and_counts_and_nothing_else():
    s = dr.summarise([_blob()])
    assert s == {
        "available": True,
        "coming": ["p101", "p102", "p103"],
        "not_coming": ["p104", "p105"],
        "counts": {"coming": 4, "not_coming": 2, "unmapped": 1},
    }


def test_a_newer_alarm_answer_wins_and_an_unknown_person_counts_once():
    first = _blob()
    # Nachalarm: 104 changed their mind and now comes; 999 answers again
    second = dr.classify_answers({"104": "11", "999": "11"}, CATALOGUE, None, ROSTER)
    s = dr.summarise([first, second])
    assert s["coming"] == ["p101", "p102", "p103", "p104"]
    assert s["not_coming"] == ["p105"]
    assert s["counts"] == {"coming": 5, "not_coming": 1, "unmapped": 1}


def test_nothing_or_only_other_reads_as_no_data():
    assert dr.summarise([]) == {"available": False, "reason": "no_data"}
    assert dr.classify_answers({"106": "17"}, CATALOGUE, None, ROSTER) is None


def test_without_names_only_a_station_override_classifies():
    answers = dr.parse_responses_by_alarm(ALARMS)[4711]
    assert dr.classify_answers(answers, None, None, ROSTER) is None
    assert not dr.resolvable(answers, None, None)
    blob = dr.classify_answers(answers, None, {"11": "coming", "13": "not_coming"}, ROSTER)
    assert blob == {
        "coming": ["p101", "p102"],
        "not_coming": ["p104", "p105"],
        "unmapped": {"coming": 0, "not_coming": 0},
    }


# --- the poll -----------------------------------------------------------------------------


async def _roster(db_session):
    for ucr in range(101, 107):
        p = Personnel(display_name=f"P {ucr}", is_active=True)
        db_session.add(p)
        await db_session.flush()
        db_session.add(PersonnelExternalIdentity(personnel_id=p.id, provider="divera", external_id=str(ucr)))
    await db_session.flush()


async def test_the_poll_stores_yes_no_for_known_alarms_and_fetches_names_once(db_session, patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "divera_access_key", "unit-key")
    monkeypatch.setattr(settings, "divera_api_url", "https://app.divera247.com/api/v2")
    calls = patch_httpx(_divera)
    await _roster(db_session)
    # an unarchived Einsatz is running, so neither alarm opens a new one; 4711 is ours already
    inc = Incident(title="B2 Brand", source="divera", status="offen", divera_id=4711, started_at=datetime.now(UTC))
    db_session.add(inc)
    await db_session.flush()
    db_session.add(DiveraEmergency(divera_id=4711, title="B2 Brand Wohnhaus", is_taken=True, taken_incident_id=inc.id))
    await db_session.commit()

    await divera_mod.fetch_and_upsert(db_session)
    await db_session.commit()
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4711))).scalar_one()
    stored = em.responses_json
    assert len(stored["coming"]) == 3 and len(stored["not_coming"]) == 2
    assert stored["unmapped"] == {"coming": 1, "not_coming": 0}
    # nothing but that: no status, no time, no note, no Divera id
    assert set(stored) == {"coming", "not_coming", "unmapped"}
    assert "Ferien" not in json.dumps(stored) and "999" not in json.dumps(stored)
    first_at = em.responses_at
    assert calls.count("/api/v2/pull/all") == 1

    # same answers again: no write, and the names come from the cache — no second /pull/all
    await divera_mod.fetch_and_upsert(db_session)
    await db_session.commit()
    await db_session.refresh(em)
    assert em.responses_at == first_at
    assert calls.count("/api/v2/pull/all") == 1
    assert calls.count("/api/v2/alarms") == 2


async def test_a_failing_name_lookup_never_fails_the_poll_nor_wipes_what_was_stored(
    db_session, patch_httpx, monkeypatch, caplog
):
    monkeypatch.setattr(settings, "divera_access_key", "unit-key-SECRET")
    monkeypatch.setattr(settings, "divera_api_url", "https://app.divera247.com/api/v2")

    def _handler(request):
        if request.url.path.endswith("/pull/all"):
            return httpx.Response(403)
        return _divera(request)

    patch_httpx(_handler)
    await _roster(db_session)
    before = {"coming": ["x"], "not_coming": [], "unmapped": {"coming": 0, "not_coming": 0}}
    db_session.add(DiveraEmergency(divera_id=4711, title="B2", is_taken=True, responses_json=before))
    await db_session.commit()
    await divera_mod.fetch_and_upsert(db_session)
    await db_session.commit()
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4711))).scalar_one()
    assert em.responses_json == before
    assert "unit-key-SECRET" not in caplog.text


async def test_a_status_the_names_list_does_not_know_refetches_it_within_the_backoff(patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "divera_access_key", "unit-key")
    calls = patch_httpx(_divera)
    clock = [1000.0]
    monkeypatch.setattr(dr, "_now", lambda: clock[0])
    await dr.ensure_catalogue({"11"})
    assert calls.count("/api/v2/pull/all") == 1
    clock[0] += 60
    await dr.ensure_catalogue({"11", "13"})
    assert calls.count("/api/v2/pull/all") == 1
    # an id the list lacks: not within the backoff, but after it — long before the 6 h TTL
    await dr.ensure_catalogue({"42"})
    assert calls.count("/api/v2/pull/all") == 1
    clock[0] += dr.CATALOGUE_RETRY_SECONDS
    await dr.ensure_catalogue({"42"})
    assert calls.count("/api/v2/pull/all") == 2


async def test_answers_are_cleared_once_the_einsatz_is_over_or_past_retention(db_session):
    now = datetime.now(UTC)
    running = Incident(title="läuft", source="divera", status="offen")
    closed = Incident(title="zu", source="divera", status="offen", is_archived=True)
    db_session.add_all([running, closed])
    await db_session.flush()
    fresh = int((now - timedelta(minutes=10)).timestamp())
    old = int((now - timedelta(hours=49)).timestamp())
    blob = _blob()
    db_session.add_all(
        [
            DiveraEmergency(
                divera_id=1,
                title="a",
                ts_create=fresh,
                is_taken=True,
                taken_incident_id=running.id,
                responses_json=blob,
            ),
            DiveraEmergency(
                divera_id=2, title="b", ts_create=fresh, is_taken=True, taken_incident_id=closed.id, responses_json=blob
            ),
            DiveraEmergency(
                divera_id=3, title="c", ts_create=old, is_taken=True, taken_incident_id=running.id, responses_json=blob
            ),
            # its incident was deleted: the link is nulled, the row stays taken
            DiveraEmergency(divera_id=4, title="d", ts_create=fresh, is_taken=True, responses_json=blob),
        ]
    )
    await db_session.commit()
    assert await divera_mod.prune_responses(db_session, now) == 3
    await db_session.commit()
    kept = (
        (await db_session.execute(select(DiveraEmergency.divera_id).where(DiveraEmergency.responses_json.is_not(None))))
        .scalars()
        .all()
    )
    assert kept == [1]
    # the alarms themselves stay — the intake history is not personal
    assert len((await db_session.execute(select(DiveraEmergency))).scalars().all()) == 4


async def test_the_fast_cadence_lasts_ten_minutes_after_an_alarm(db_session):
    now = datetime.now(UTC)
    assert await divera_mod.response_window_open(db_session, now) is False
    db_session.add(DiveraEmergency(divera_id=1, title="x", ts_create=int((now - timedelta(minutes=4)).timestamp())))
    await db_session.commit()
    assert await divera_mod.response_window_open(db_session, now) is True
    assert await divera_mod.response_window_open(db_session, now + timedelta(minutes=7)) is False


# --- the read -----------------------------------------------------------------------------


async def test_the_read_is_editor_only_and_forgets_old_alarms(client, db_session, editor, viewer):
    now = datetime.now(UTC)
    inc = Incident(title="B2 Brand", source="divera", status="offen", divera_id=4711)
    # a MANUAL Einsatz with the alarm attached — no divera_id, still has answers
    manual = Incident(title="manuell", source="manual", status="offen")
    other = Incident(title="anderer", source="manual", status="offen")
    archived = Incident(title="alt", source="divera", status="offen", is_archived=True)
    db_session.add_all([inc, manual, other, archived])
    await db_session.flush()
    recent = int((now - timedelta(minutes=5)).timestamp())
    earlier = int((now - timedelta(minutes=30)).timestamp())
    db_session.add_all(
        [
            DiveraEmergency(
                divera_id=4711,
                title="B2",
                ts_create=recent,
                is_taken=True,
                taken_incident_id=inc.id,
                responses_json=_blob(),
            ),
            # a first alarm 30 min earlier: 101 said no then — the newer «komme» wins
            DiveraEmergency(
                divera_id=4710,
                title="B1",
                ts_create=earlier,
                is_taken=True,
                taken_incident_id=inc.id,
                responses_json={"coming": [], "not_coming": ["p101"], "unmapped": {"coming": 0, "not_coming": 0}},
            ),
            # the first night's alarm, 7 h old: no longer «anrückend»
            DiveraEmergency(
                divera_id=4700,
                title="B0",
                ts_create=int((now - timedelta(hours=7)).timestamp()),
                is_taken=True,
                taken_incident_id=inc.id,
                responses_json={"coming": ["p999"], "not_coming": [], "unmapped": {"coming": 0, "not_coming": 0}},
            ),
            DiveraEmergency(
                divera_id=4712,
                title="N",
                ts_create=recent,
                is_taken=True,
                taken_incident_id=manual.id,
                responses_json=_blob(),
            ),
            DiveraEmergency(
                divera_id=4713,
                title="A",
                ts_create=recent,
                is_taken=True,
                taken_incident_id=archived.id,
                responses_json=_blob(),
            ),
        ]
    )
    await db_session.commit()

    assert (await client.get(f"/api/divera/responses/{inc.id}")).status_code == 401
    assert (await client.post("/api/auth/login", json={"user_id": str(viewer.id), "pin": PIN})).status_code == 200
    assert (await client.get(f"/api/divera/responses/{inc.id}")).status_code == 403

    assert (await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})).status_code == 200
    body = (await client.get(f"/api/divera/responses/{inc.id}")).json()
    assert body == {
        "available": True,
        "coming": ["p101", "p102", "p103"],
        "not_coming": ["p104", "p105"],
        "counts": {"coming": 4, "not_coming": 2, "unmapped": 1},
    }
    assert (await client.get(f"/api/divera/responses/{manual.id}")).json()["available"] is True
    assert (await client.get(f"/api/divera/responses/{other.id}")).json() == {"available": False, "reason": "no_data"}
    assert (await client.get(f"/api/divera/responses/{archived.id}")).json() == {"available": False, "reason": "closed"}


async def test_the_station_override_applies_when_the_poll_stores(db_session, patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "divera_access_key", "unit-key")
    monkeypatch.setattr(settings, "divera_api_url", "https://app.divera247.com/api/v2")
    patch_httpx(_divera)
    await _roster(db_session)
    db_session.add(
        DeploymentConfig(id=1, config_json={"roster": {"diveraResponses": {"Rückruf erbeten": "not_coming"}}})
    )
    db_session.add(DiveraEmergency(divera_id=4711, title="B2", is_taken=True))
    await db_session.commit()
    await divera_mod.fetch_and_upsert(db_session)
    await db_session.commit()
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4711))).scalar_one()
    assert len(em.responses_json["not_coming"]) == 3  # 104, 105 + the override's 106
