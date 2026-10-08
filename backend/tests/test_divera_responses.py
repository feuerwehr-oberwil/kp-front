"""Divera Rückmeldungen (app/divera_responses + the poll + GET /api/divera/responses/{id}).

The fixtures in tests/fixtures/divera/ have the REAL shape of Divera's `/api/v2/alarms` and
`/api/v2/pull/all` (research 08.10.2026: four independent clients agree that `ucr_answered` is
`{status id: {ucr: {ts, note}}}`, not the `int[]` Divera's Swagger claims). No test here, and no
code path, calls Divera: the HTTP layer is a MockTransport.

What is pinned:
- parsing: dict AND list `items`, `ucr_answered: []` on an alarm nobody answered, Divera's own
  «ucr_adressed» spelling, junk ids dropped, notes clipped;
- the default classification («Komme nicht» is NOT coming although it contains «komme»), the
  station override by id and by name, id beating name;
- ETA = answer + the status's minutes, only for «coming», labelled an estimate by the UI;
- the latest answer wins per person, across statuses and across a Nachalarm attached to the
  same Einsatz;
- the poll stores the answers of known alarms only, writes nothing for a no-op poll, fetches the
  status names at most once per TTL and never while holding the per-alarm locks;
- the read: logged-in only, `available: false` without a Divera alarm.
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
from app.models import DeploymentConfig, DiveraEmergency, Incident

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


def test_the_real_alarm_shape_parses_and_a_closed_alarm_without_answers_is_skipped():
    parsed = dr.parse_responses_by_alarm(ALARMS)
    assert set(parsed) == {4711, 4712}
    a = parsed[4711]
    assert sorted(a["answered"]) == ["11", "12", "13", "17"]
    assert a["answered"]["12"]["103"] == {"ts": 1791478890, "note": "5 min"}
    assert a["addressed"] == list(range(101, 111))
    assert (a["read"], a["recipients"]) == (8, 10)
    # 4712: `ucr_answered: []` (Divera's empty shape) — no answers, one addressed, no crash
    assert parsed[4712]["answered"] == {}
    assert parsed[4712]["addressed"] == [101]


def test_items_as_a_list_the_adressed_spelling_and_junk_are_handled():
    data = {
        "success": True,
        "data": {
            "items": [
                {
                    "id": 9,
                    "ucr_adressed": [5, "6", None],
                    "ucr_answered": {
                        "x": {"5": {}},
                        "3": {"5": {"ts": "1791478860", "note": "  a  b " + "z" * 200}, "bad": {}},
                    },
                },
                {"id": 0, "ucr_answered": {"3": {"1": {"ts": 1}}}},
                {"id": 10},
                "nonsense",
            ]
        },
    }
    parsed = dr.parse_responses_by_alarm(data)
    assert list(parsed) == [9]
    answer = parsed[9]["answered"]["3"]["5"]
    assert answer["ts"] == 1791478860
    assert answer["note"].startswith("a b z") and len(answer["note"]) == dr.NOTE_MAX
    assert parsed[9]["addressed"] == [5, 6]
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


# --- summarise ----------------------------------------------------------------------------


def _blob(alarm_id=4711, when=datetime(2026, 10, 8, 18, 0, tzinfo=UTC)):
    parsed = dr.parse_responses_by_alarm(ALARMS)[alarm_id]
    return dr.with_catalogue(parsed, dr.parse_status_catalogue(PULL_ALL), when)


def test_the_summary_counts_kinds_names_statuses_and_estimates_arrival():
    s = dr.summarise([_blob()])
    assert s["available"] is True
    assert s["counts"] == {
        "coming": 4,
        "not_coming": 2,
        "other": 1,
        "answered": 7,
        "addressed": 10,
        "unanswered": 3,
        "read": 8,
    }
    # in Divera's own order (statussorting_alarm), with their names
    assert [(x["id"], x["name"], x["kind"], x["count"]) for x in s["statuses"]] == [
        (11, "Komme", "coming", 2),
        (12, "Komme in 10 min", "coming", 2),
        (13, "Komme nicht", "not_coming", 2),
        (17, "Rückruf erbeten", "other", 1),
    ]
    by = {a["ucr_id"]: a for a in s["answers"]}
    assert by[103]["eta"] == datetime.fromtimestamp(1791478890 + 600, tz=UTC).isoformat()
    assert by[101]["eta"] is None  # «Komme» promises no minutes — no invented ETA
    assert by[104]["kind"] == "not_coming" and by[104]["note"] == "Ferien"
    assert by[104]["eta"] is None
    assert 999 in by  # not on anybody's roster — the device decides what to do with it


def test_the_latest_answer_wins_across_statuses_and_across_an_attached_nachalarm():
    first = _blob()
    # Nachalarm: 104 changed their mind and now comes; 101 answered the first alarm only
    second = dr.with_catalogue(
        {"answered": {"11": {"104": {"ts": 1791479500, "note": ""}}}, "addressed": [104], "read": 1, "recipients": 1},
        dr.parse_status_catalogue(PULL_ALL),
        datetime(2026, 10, 8, 18, 10, tzinfo=UTC),
    )
    s = dr.summarise([first, second])
    by = {a["ucr_id"]: a for a in s["answers"]}
    assert by[104]["kind"] == "coming"
    assert by[101]["kind"] == "coming"
    assert s["counts"]["coming"] == 5 and s["counts"]["not_coming"] == 1
    assert s["updated_at"] == datetime(2026, 10, 8, 18, 10, tzinfo=UTC).isoformat()


def test_without_a_catalogue_the_answers_still_count_as_other_with_no_name():
    parsed = dr.parse_responses_by_alarm(ALARMS)[4711]
    s = dr.summarise([dr.with_catalogue(parsed, None, datetime.now(UTC))])
    assert s["counts"]["other"] == 7 and s["counts"]["coming"] == 0
    assert all(x["name"] == "" for x in s["statuses"])
    # …unless the station says what an id means
    s = dr.summarise([dr.with_catalogue(parsed, None, datetime.now(UTC))], {"11": "coming", "13": "not_coming"})
    assert (s["counts"]["coming"], s["counts"]["not_coming"]) == (2, 2)


# --- the poll -----------------------------------------------------------------------------


async def test_the_poll_stores_answers_for_known_alarms_and_fetches_names_once(db_session, patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "divera_access_key", "unit-key")
    monkeypatch.setattr(settings, "divera_api_url", "https://app.divera247.com/api/v2")
    calls = patch_httpx(_divera)
    # an unarchived Einsatz is running, so neither alarm opens a new one; 4711 is ours already
    inc = Incident(title="B2 Brand", source="divera", status="offen", divera_id=4711, started_at=datetime.now(UTC))
    db_session.add(inc)
    await db_session.flush()
    db_session.add(DiveraEmergency(divera_id=4711, title="B2 Brand Wohnhaus", is_taken=True, taken_incident_id=inc.id))
    await db_session.commit()

    await divera_mod.fetch_and_upsert(db_session)
    await db_session.commit()
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4711))).scalar_one()
    assert em.responses_json["statuses"]["13"]["name"] == "Komme nicht"
    assert em.responses_at is not None
    first_at = em.responses_at
    assert calls.count("/api/v2/pull/all") == 1

    # same answers again: no write, and the names come from the cache — no second /pull/all
    await divera_mod.fetch_and_upsert(db_session)
    await db_session.commit()
    await db_session.refresh(em)
    assert em.responses_at == first_at
    assert calls.count("/api/v2/pull/all") == 1
    assert calls.count("/api/v2/alarms") == 2


async def test_a_failing_name_lookup_never_fails_the_alarm_poll(db_session, patch_httpx, monkeypatch, caplog):
    monkeypatch.setattr(settings, "divera_access_key", "unit-key-SECRET")
    monkeypatch.setattr(settings, "divera_api_url", "https://app.divera247.com/api/v2")

    def _handler(request):
        if request.url.path.endswith("/pull/all"):
            return httpx.Response(403)
        return _divera(request)

    patch_httpx(_handler)
    db_session.add(DiveraEmergency(divera_id=4711, title="B2", is_taken=True))
    await db_session.commit()
    await divera_mod.fetch_and_upsert(db_session)
    await db_session.commit()
    em = (await db_session.execute(select(DiveraEmergency).where(DiveraEmergency.divera_id == 4711))).scalar_one()
    assert em.responses_json["answered"]["13"]["104"]["note"] == "Ferien"
    assert em.responses_json["statuses"] == {}
    assert "unit-key-SECRET" not in caplog.text


async def test_the_fast_cadence_lasts_ten_minutes_after_an_alarm(db_session):
    now = datetime.now(UTC)
    assert await divera_mod.response_window_open(db_session, now) is False
    db_session.add(DiveraEmergency(divera_id=1, title="x", ts_create=int((now - timedelta(minutes=4)).timestamp())))
    await db_session.commit()
    assert await divera_mod.response_window_open(db_session, now) is True
    assert await divera_mod.response_window_open(db_session, now + timedelta(minutes=7)) is False


# --- the read -----------------------------------------------------------------------------


async def test_the_read_merges_the_incidents_alarms_and_applies_the_station_override(client, db_session, editor):
    inc = Incident(title="B2 Brand", source="divera", status="offen", divera_id=4711)
    other = Incident(title="anderer", source="manual", status="offen")
    db_session.add_all([inc, other])
    await db_session.flush()
    db_session.add(
        DiveraEmergency(divera_id=4711, title="B2", is_taken=True, taken_incident_id=inc.id, responses_json=_blob())
    )
    db_session.add(
        DeploymentConfig(id=1, config_json={"roster": {"diveraResponses": {"Rückruf erbeten": "not_coming"}}})
    )
    await db_session.commit()

    r = await client.get(f"/api/divera/responses/{inc.id}")
    assert r.status_code == 401  # personal data: a logged-in read only

    lr = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})
    assert lr.status_code == 200
    body = (await client.get(f"/api/divera/responses/{inc.id}")).json()
    assert body["available"] is True
    assert body["counts"]["not_coming"] == 3  # 104, 105 + the override's 106
    assert {a["ucr_id"] for a in body["answers"]} == {101, 102, 103, 104, 105, 106, 999}

    assert (await client.get(f"/api/divera/responses/{other.id}")).json() == {"available": False}
