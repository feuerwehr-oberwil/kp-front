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
    # COUNTS only — no per-person read receipt or addressed list is kept
    assert (a["addressed"], a["read"]) == (10, 8)
    # 4712: `ucr_answered: []` (Divera's empty shape) — no answers, one addressed, no crash
    assert parsed[4712]["answered"] == {}
    assert parsed[4712]["addressed"] == 1


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
    assert parsed[9]["addressed"] == 2
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


#: the Mannschaftsliste of the tests: Divera user → our personnel id; 999 is on nobody's roster
ROSTER = {str(u): f"p{u}" for u in range(101, 107)}


def test_the_summary_counts_kinds_names_statuses_and_estimates_arrival():
    s = dr.summarise([_blob()], None, ROSTER)
    assert s["available"] is True
    assert s["counts"] == {
        "coming": 4,
        "not_coming": 2,
        "other": 1,
        "answered": 7,
        "addressed": 10,
        "unanswered": 3,
        "unmapped": 1,
        "read": 8,
    }
    # in Divera's own order (statussorting_alarm), with their names
    assert [(x["id"], x["name"], x["kind"], x["count"]) for x in s["statuses"]] == [
        (11, "Komme", "coming", 2),
        (12, "Komme in 10 min", "coming", 2),
        (13, "Komme nicht", "not_coming", 2),
        (17, "Rückruf erbeten", "other", 1),
    ]
    by = {a["person_id"]: a for a in s["answers"]}
    assert by["p103"]["eta"] == datetime.fromtimestamp(1791478890 + 600, tz=UTC).isoformat()
    assert by["p101"]["eta"] is None  # «Komme» promises no minutes — no invented ETA
    assert by["p104"]["kind"] == "not_coming" and by["p104"]["note"] == "Ferien"
    assert by["p104"]["eta"] is None
    # 999 is on nobody's roster: counted, but no row — no Divera id, no note leaves the server
    assert len(s["answers"]) == 6
    assert all("ucr_id" not in a for a in s["answers"])


def test_a_viewer_never_reads_the_notes():
    s = dr.summarise([_blob()], None, ROSTER, with_notes=False)
    assert all(a["note"] == "" for a in s["answers"])


def test_a_junk_timestamp_or_count_never_takes_the_summary_down():
    blob = _blob()
    blob["answered"]["11"]["101"]["ts"] = 10**20
    blob["answered"]["11"]["102"]["ts"] = "gestern"
    blob["read"] = "viele"
    s = dr.summarise([blob], None, ROSTER)
    by = {a["person_id"]: a for a in s["answers"]}
    assert by["p101"]["answered_at"] is None and by["p102"]["answered_at"] is None
    assert s["counts"]["read"] == 0


def test_nothing_stored_reads_as_no_data():
    s = dr.summarise([], None, ROSTER)
    assert s["available"] is False and s["reason"] == "no_data"


def test_the_latest_answer_wins_across_statuses_and_across_an_attached_nachalarm():
    first = _blob()
    # Nachalarm: 104 changed their mind and now comes; 101 answered the first alarm only
    second = dr.with_catalogue(
        {"answered": {"11": {"104": {"ts": 1791479500, "note": ""}}}, "addressed": 1, "read": 1},
        dr.parse_status_catalogue(PULL_ALL),
        datetime(2026, 10, 8, 18, 10, tzinfo=UTC),
    )
    s = dr.summarise([first, second], None, ROSTER)
    by = {a["person_id"]: a for a in s["answers"]}
    assert by["p104"]["kind"] == "coming"
    assert by["p101"]["kind"] == "coming"
    assert s["counts"]["coming"] == 5 and s["counts"]["not_coming"] == 1
    assert s["updated_at"] == datetime(2026, 10, 8, 18, 10, tzinfo=UTC).isoformat()


def test_without_a_catalogue_the_answers_still_count_as_other_with_no_name():
    parsed = dr.parse_responses_by_alarm(ALARMS)[4711]
    s = dr.summarise([dr.with_catalogue(parsed, None, datetime.now(UTC))])
    assert s["counts"]["other"] == 7 and s["counts"]["coming"] == 0
    assert all(x["name"] == "" for x in s["statuses"])
    # …and a failed lookup never overwrites the names a row already has
    named = _blob()
    again = dr.with_catalogue(parsed, None, datetime.now(UTC), previous=named)
    assert again["statuses"]["13"]["name"] == "Komme nicht"
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


async def test_a_status_the_names_list_does_not_know_refetches_it_within_the_backoff(patch_httpx, monkeypatch):
    monkeypatch.setattr(settings, "divera_access_key", "unit-key")
    calls = patch_httpx(_divera)
    clock = [1000.0]
    monkeypatch.setattr(dr, "_now", lambda: clock[0])
    await dr.ensure_catalogue({"11"})
    assert calls.count("/api/v2/pull/all") == 1
    # a known id: the cached list answers
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
    rows = [
        DiveraEmergency(
            divera_id=1, title="a", ts_create=fresh, is_taken=True, taken_incident_id=running.id, responses_json=_blob()
        ),
        DiveraEmergency(
            divera_id=2, title="b", ts_create=fresh, is_taken=True, taken_incident_id=closed.id, responses_json=_blob()
        ),
        DiveraEmergency(
            divera_id=3, title="c", ts_create=old, is_taken=True, taken_incident_id=running.id, responses_json=_blob()
        ),
        # its incident was deleted: the link is nulled, the row stays taken
        DiveraEmergency(divera_id=4, title="d", ts_create=fresh, is_taken=True, responses_json=_blob()),
    ]
    db_session.add_all(rows)
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


async def test_the_read_is_editor_only_roster_mapped_and_forgets_old_alarms(client, db_session, editor, viewer):
    from app.models import Personnel, PersonnelExternalIdentity

    now = datetime.now(UTC)
    inc = Incident(title="B2 Brand", source="divera", status="offen", divera_id=4711)
    # a MANUAL Einsatz with the alarm attached — no divera_id, still has answers
    manual = Incident(title="manuell", source="manual", status="offen")
    other = Incident(title="anderer", source="manual", status="offen")
    archived = Incident(title="alt", source="divera", status="offen", is_archived=True)
    db_session.add_all([inc, manual, other, archived])
    await db_session.flush()
    for ucr in range(101, 107):
        p = Personnel(display_name=f"P {ucr}", is_active=True)
        db_session.add(p)
        await db_session.flush()
        db_session.add(PersonnelExternalIdentity(personnel_id=p.id, provider="divera", external_id=str(ucr)))
    recent = int((now - timedelta(minutes=5)).timestamp())
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
            # the first night's alarm on the same Einsatz: 7 h old, no longer «anrückend»
            DiveraEmergency(
                divera_id=4700,
                title="B1",
                ts_create=int((now - timedelta(hours=7)).timestamp()),
                is_taken=True,
                taken_incident_id=inc.id,
                responses_json=dr.with_catalogue(
                    {
                        "answered": {"11": {"999": {"ts": 1, "note": "x"}, "101": {"ts": 2**31, "note": ""}}},
                        "addressed": 50,
                        "read": 0,
                    },
                    None,
                    now,
                ),
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
    db_session.add(
        DeploymentConfig(id=1, config_json={"roster": {"diveraResponses": {"Rückruf erbeten": "not_coming"}}})
    )
    await db_session.commit()

    assert (await client.get(f"/api/divera/responses/{inc.id}")).status_code == 401
    # personal data: editor-only, like the rest of /api/divera
    assert (await client.post("/api/auth/login", json={"user_id": str(viewer.id), "pin": PIN})).status_code == 200
    assert (await client.get(f"/api/divera/responses/{inc.id}")).status_code == 403

    assert (await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": PIN})).status_code == 200
    body = (await client.get(f"/api/divera/responses/{inc.id}")).json()
    assert body["available"] is True
    assert body["counts"]["addressed"] == 10  # the 7 h old alarm's 50 no longer count
    assert body["counts"]["not_coming"] == 3  # 104, 105 + the override's 106
    assert body["counts"]["unmapped"] == 1
    # our ids only — 999 is a count, never a Divera id or a note
    assert len(body["answers"]) == 6
    assert all(set(a) == {"person_id", "status_id", "kind", "answered_at", "eta", "note"} for a in body["answers"])
    assert "999" not in str(body)

    # the attached alarm counts on a manual Einsatz too
    assert (await client.get(f"/api/divera/responses/{manual.id}")).json()["available"] is True
    assert (await client.get(f"/api/divera/responses/{other.id}")).json() == {"available": False, "reason": "no_data"}
    assert (await client.get(f"/api/divera/responses/{archived.id}")).json() == {"available": False, "reason": "closed"}
