"""Statistics export (/api/stats/*) — the read-only feed for fwo-stats.

Contract under test:
- fail-closed: no stats secret in the DB → 403 for the export; wrong token → 401;
- the record is FLAT and complete: incident metadata + reportMeta slices + derived
  attendance / current-Mittel / rapport state — never the raw workspace blob;
- `year` filters on the LOCAL (Europe/Zurich) calendar year of started_at;
- UNCONFIRMED incidents (no editor ever opened them) are omitted by default and returned by
  ?include_unconfirmed=1 — the guard that keeps auto-opened alarms nobody attended out of the
  figures reported to the canton;
- the admin endpoints (ADMIN_SECRET session) rotate/disable the token.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig, Incident

TOKEN = "stats-token-123"


@pytest.fixture
async def stats_secret(db_session):
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.stats_secret = TOKEN
    await db_session.commit()
    return TOKEN


WS = {
    "attendance": {
        "p1": {
            "status": "left",
            "checkedInAt": "2026-03-01T14:00:00Z",
            "leftAt": "2026-03-01T16:30:00Z",
            "displayNameSnapshot": "Meier Anna",
        },
        "p2": {"status": "present", "checkedInAt": "2026-03-01T14:05:00Z", "displayNameSnapshot": "Huber Beat"},
    },
    # append-only running totals: the LATER Ölbinder entry wins; the zeroed line drops out
    "mittel": [
        {"id": "m1", "label": "Ölbinder", "unit": "Sack", "menge": 2, "at": "2026-03-01T14:10:00Z"},
        {"id": "m2", "label": "Ölbinder", "unit": "Sack", "menge": 5, "at": "2026-03-01T15:00:00Z"},
        {"id": "m3", "label": "Handlöscher", "unit": "Stk", "menge": 1, "at": "2026-03-01T14:20:00Z"},
        {"id": "m4", "label": "Handlöscher", "unit": "Stk", "menge": 0, "at": "2026-03-01T15:30:00Z"},
    ],
    "reportMeta": {
        "endedAt": "2026-03-01T16:45:00Z",
        "ausgeruecktAt": "2026-03-01T14:03:00Z",
        "einsatzleiter": "Maj Muster",
        "kontaktperson": "Frau Beispiel",
        "summary": "Öl gebunden.",
        "partnerContacts": [{"org": "Polizei", "name": "Wm Graf"}],
    },
    "entities": [{"id": "e1"}],  # operational blob content must never leak into the export
}


def _incident(**kw) -> Incident:
    """A CONFIRMED incident by default — an editor had it open, so it counts. The unconfirmed
    case is the subject of its own tests below, never an accident of a fixture."""
    base = {
        "title": "Ölspur Hauptstrasse",
        "source": "manual",
        "status": "offen",
        "editor_opened_at": datetime(2026, 3, 1, 14, 0, tzinfo=UTC),
    }
    return Incident(**{**base, **kw})


async def test_stats_fails_closed_without_secret(client):
    r = await client.get("/api/stats/incidents")
    assert r.status_code == 403


async def test_stats_rejects_wrong_token(client, stats_secret):
    r = await client.get("/api/stats/incidents?t=nope")
    assert r.status_code == 401
    r = await client.get("/api/stats/incidents", headers={"X-Stats-Token": "nope"})
    assert r.status_code == 401


async def test_stats_record_shape(client, stats_secret, db_session):
    inc = _incident(
        started_at=datetime(2026, 3, 1, 13, 55, tzinfo=UTC),
        map_workspace_json=WS,
        address="Hauptstrasse 1",
        type="Elementarereignisse",
    )
    db_session.add(inc)
    await db_session.commit()

    r = await client.get(f"/api/stats/incidents?t={TOKEN}")
    assert r.status_code == 200
    recs = r.json()
    assert len(recs) == 1
    rec = recs[0]
    assert rec["title"] == "Ölspur Hauptstrasse"
    assert rec["kategorie"] == "Elementarereignisse"
    assert rec["einsatzleiter"] == "Maj Muster"
    assert rec["endedAt"] == "2026-03-01T16:45:00Z"
    assert rec["rapport"] == "open"
    assert rec["partner"] == [{"org": "Polizei", "name": "Wm Graf"}]
    # derived attendance, alphabetical, von–bis carried through
    assert [a["name"] for a in rec["attendance"]] == ["Huber Beat", "Meier Anna"]
    assert rec["attendance"][1]["bis"] == "2026-03-01T16:30:00Z"
    # derived Mittel: latest-per-key, zeroed line gone
    assert rec["mittel"] == [{"label": "Ölbinder", "menge": 5, "unit": "Sack", "source": None}]
    # the operational blob must not leak
    assert "entities" not in rec and "map_workspace_json" not in rec


async def test_stats_attendance_is_one_row_per_presence_block(client, stats_secret, db_session):
    """Someone who left and came back must not be exported as one inflated span.

    Blocks fan out to a row each; an entry from before blocks existed carries no ``intervals``
    and projects its checkedInAt/leftAt pair, so both shapes reach fwo-stats identically.
    """
    ws = {
        "attendance": {
            "p1": {
                "status": "left",
                "checkedInAt": "2026-03-01T14:00:00Z",
                "leftAt": "2026-03-01T20:00:00Z",
                "displayNameSnapshot": "Rueck Kehr",
                "intervals": [
                    {"from": "2026-03-01T14:00:00Z", "to": "2026-03-01T16:00:00Z"},
                    {"from": "2026-03-01T19:00:00Z", "to": "2026-03-01T20:00:00Z"},
                ],
            },
            # legacy entry, no intervals — must still export exactly one row
            "p2": {
                "status": "present",
                "checkedInAt": "2026-03-01T14:05:00Z",
                "displayNameSnapshot": "Alt Bestand",
            },
        }
    }
    db_session.add(_incident(started_at=datetime(2026, 3, 1, 13, 55, tzinfo=UTC), map_workspace_json=ws))
    await db_session.commit()

    rec = (await client.get(f"/api/stats/incidents?t={TOKEN}")).json()[0]
    assert [(a["name"], a["von"], a["bis"]) for a in rec["attendance"]] == [
        ("Alt Bestand", "2026-03-01T14:05:00Z", None),
        ("Rueck Kehr", "2026-03-01T14:00:00Z", "2026-03-01T16:00:00Z"),
        ("Rueck Kehr", "2026-03-01T19:00:00Z", "2026-03-01T20:00:00Z"),
    ]


async def test_stats_rapport_state_done_vs_changed(client, stats_secret, db_session):
    now = datetime.now(UTC)
    done = _incident(title="Done", started_at=now, report_done_at=now)
    changed = _incident(title="Changed", started_at=now, report_done_at=now - timedelta(hours=2))
    db_session.add_all([done, changed])
    await db_session.commit()  # updated_at = now for both → 'changed' only for the older done-stamp

    r = await client.get(f"/api/stats/incidents?t={TOKEN}")
    by_title = {rec["title"]: rec["rapport"] for rec in r.json()}
    assert by_title["Done"] == "done"
    assert by_title["Changed"] == "changed"


async def test_stats_year_filter_uses_local_year(client, stats_secret, db_session):
    # 31.12.2025 23:30 UTC = 01.01.2026 00:30 local (Europe/Zurich, UTC+1) → belongs to 2026
    sylvester = _incident(title="Silvester", started_at=datetime(2025, 12, 31, 23, 30, tzinfo=UTC))
    summer = _incident(title="Sommer", started_at=datetime(2025, 7, 1, 12, 0, tzinfo=UTC))
    db_session.add_all([sylvester, summer])
    await db_session.commit()

    r = await client.get(f"/api/stats/incidents?t={TOKEN}&year=2026")
    assert [rec["title"] for rec in r.json()] == ["Silvester"]
    r = await client.get(f"/api/stats/incidents?t={TOKEN}&year=2025")
    assert [rec["title"] for rec in r.json()] == ["Sommer"]


# --- the join keys --------------------------------------------------------------------
# The feed shares no id with a station's record system, so a consumer joins on time+address
# and pays for it. `source`/`source_ref`/`alarm_ref` are the neutral way out — and the trap
# they close is that the two look interchangeable and are not: `source_ref` is the alerting
# system's id for the ALARM (a bare integer for a Divera deployment), while `alarm_ref` is the
# reference PRINTED on the alarm, which is the string a human transcribes into the record
# system. Exporting only the first would look like the path is open while it stays dark.


async def test_stats_exports_the_neutral_source_pair(client, stats_secret, db_session):
    db_session.add(_incident(title="Vom Intake", source="leitstelle", source_ref="E-2026-0815"))
    await db_session.commit()

    rec = (await client.get(f"/api/stats/incidents?t={TOKEN}")).json()[0]
    assert (rec["source"], rec["source_ref"]) == ("leitstelle", "E-2026-0815")
    # nothing stated a printed reference for this alarm — null, not the source id laundered
    assert rec["alarm_ref"] is None


async def test_stats_exports_the_printed_alarm_reference(client, stats_secret, db_session):
    """The reference the alerting system printed on the alarm reaches the consumer VERBATIM.

    Byte-identity is the entire value of the field: the same string is printed on the Einsatz
    slip and typed into the record system's case-number field, so the join is a byte
    comparison. Anything that trims, cases or prettifies it here breaks that silently.
    """
    from app.models import DiveraEmergency

    inc = _incident(title="Aus dem Pool", source="divera", source_ref="4711")
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    db_session.add(
        DiveraEmergency(
            divera_id=4711,
            divera_number="fwo-sms-761610d931ac",
            title="Aus dem Pool",
            is_taken=True,
            taken_incident_id=inc.id,
        )
    )
    await db_session.commit()

    rec = (await client.get(f"/api/stats/incidents?t={TOKEN}")).json()[0]
    assert rec["alarm_ref"] == "fwo-sms-761610d931ac"
    # …and the alarm's own id stays where it is. Publishing it AS the printed reference is the
    # failure this test exists to catch: it joins to nothing and looks like it works.
    assert rec["source_ref"] == "4711"


async def test_a_second_pool_alarm_on_one_incident_does_not_duplicate_the_record(client, stats_secret, db_session):
    """Split dispatch: a re-dispatched group's alarm is attached to the Einsatz already
    running, so two pool rows point at one incident. Looking the reference up with a join
    would emit that incident twice and double it in the canton's figures."""
    from app.models import DiveraEmergency

    inc = _incident(title="Nachalarm", source="divera", source_ref="4712")
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    db_session.add_all(
        [
            DiveraEmergency(
                divera_id=4712,
                divera_number="fwo-sms-aaaaaaaaaaaa",
                title="Erstalarm",
                received_at=datetime(2026, 3, 1, 14, 0, tzinfo=UTC),
                is_taken=True,
                taken_incident_id=inc.id,
            ),
            DiveraEmergency(
                divera_id=4713,
                divera_number="fwo-sms-bbbbbbbbbbbb",
                title="Nachalarm",
                received_at=datetime(2026, 3, 1, 14, 20, tzinfo=UTC),
                is_taken=True,
                taken_incident_id=inc.id,
            ),
        ]
    )
    await db_session.commit()

    recs = (await client.get(f"/api/stats/incidents?t={TOKEN}")).json()
    assert len(recs) == 1
    # the first alarm's reference — the one whose slip was printed
    assert recs[0]["alarm_ref"] == "fwo-sms-aaaaaaaaaaaa"


async def test_an_untaken_pool_alarm_lends_its_reference_to_nobody(client, stats_secret, db_session):
    from app.models import DiveraEmergency

    db_session.add(_incident(title="Unabhängig", source="manual"))
    db_session.add(DiveraEmergency(divera_id=9999, divera_number="fwo-sms-cccccccccccc", title="Im Pool"))
    await db_session.commit()

    rec = (await client.get(f"/api/stats/incidents?t={TOKEN}")).json()[0]
    assert rec["alarm_ref"] is None


# --- the confirmed/unconfirmed line ---------------------------------------------------


async def test_stats_omits_incidents_no_editor_ever_opened(client, stats_secret, db_session):
    """The honesty guard. Since alarms open themselves, an incident exists for every alarm that
    ever arrived — a test alarm, a Nachbarhilfe dispatch, an Einsatz-Link tapped for a turnout
    that never happened. None of those are Einsätze, and this feed is what the canton's figures
    are built from."""
    now = datetime.now(UTC)
    worked = _incident(title="Gearbeitet", started_at=now)
    untouched = _incident(title="Nie geöffnet", started_at=now, editor_opened_at=None, auto_opened=True)
    db_session.add_all([worked, untouched])
    await db_session.commit()

    recs = (await client.get(f"/api/stats/incidents?t={TOKEN}")).json()
    assert [r["title"] for r in recs] == ["Gearbeitet"]
    assert recs[0]["confirmed_at"] is not None


async def test_stats_counts_an_auto_opened_incident_once_an_editor_opens_it(client, stats_secret, db_session, editor):
    """The other half: the latch is stamped by an ordinary editor workspace read, so an alarm
    the station DID turn out to lands in the figures without anyone doing bookkeeping for it."""
    inc = _incident(title="Auto-eröffnet", source="divera", source_ref="4711", auto_opened=True, editor_opened_at=None)
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    assert (await client.get(f"/api/stats/incidents?t={TOKEN}")).json() == []

    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200
    assert (await client.get(f"/api/incidents/{inc.id}/workspace")).status_code == 200

    recs = (await client.get(f"/api/stats/incidents?t={TOKEN}")).json()
    assert [r["title"] for r in recs] == ["Auto-eröffnet"]
    assert recs[0]["confirmed_at"] is not None


async def test_stats_include_unconfirmed_returns_the_alarm_volume(client, stats_secret, db_session):
    """A consumer that wants «how many alarms arrived» rather than «how many Einsätze» asks."""
    now = datetime.now(UTC)
    db_session.add_all(
        [
            _incident(title="Gearbeitet", started_at=now),
            _incident(title="Nie geöffnet", started_at=now, editor_opened_at=None, auto_opened=True),
        ]
    )
    await db_session.commit()

    recs = (await client.get(f"/api/stats/incidents?t={TOKEN}&include_unconfirmed=1")).json()
    assert sorted(r["title"] for r in recs) == ["Gearbeitet", "Nie geöffnet"]
    assert {r["title"]: r["confirmed_at"] is None for r in recs} == {"Gearbeitet": False, "Nie geöffnet": True}


async def test_a_viewer_open_does_not_confirm_an_incident(client, stats_secret, db_session, viewer):
    """A viewer — the EL-Ansicht, and every Einsatz-Link responder — reads the workspace without
    latching. If it did, a single tap on a link would count the Einsatz for the station."""
    inc = _incident(title="Nur gelesen", editor_opened_at=None, auto_opened=True)
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)

    r = await client.post("/api/auth/login", json={"user_id": str(viewer.id), "pin": "135790"})
    assert r.status_code == 200
    assert (await client.get(f"/api/incidents/{inc.id}/workspace")).status_code == 200

    assert (await client.get(f"/api/stats/incidents?t={TOKEN}")).json() == []


async def test_admin_rotate_and_disable(client, admin_login, db_session):
    await admin_login(client)
    r = await client.post("/api/stats/secret/rotate")
    assert r.status_code == 200
    token = r.json()["token"]
    assert token and r.json()["configured"] is True

    lr = await client.get(f"/api/stats/incidents?t={token}")
    assert lr.status_code == 200

    r = await client.delete("/api/stats/secret")
    assert r.status_code == 200
    lr = await client.get(f"/api/stats/incidents?t={token}")
    assert lr.status_code == 403  # fail-closed again


async def test_admin_endpoints_require_admin(client, stats_secret):
    r = await client.get("/api/stats/secret")
    assert r.status_code in (401, 403)
    r = await client.post("/api/stats/secret/rotate")
    assert r.status_code in (401, 403)
