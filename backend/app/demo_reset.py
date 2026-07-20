"""Reset the DEMO deployment's mutable state.

Wipes all incident data (deleting ``incidents`` cascades to people/notes/media/events/
snapshots/vehicle_samples) and the roster, upserts the two fixed demo accounts with known
PINs, and re-seeds the prepared demo scene: one **pre-filled running incident** (a Zimmerbrand
at Schloss Musterdorf, already worked — tactical symbols + hose lines on the map, three
Atemschutz Trupps, logged Mittel, crew marked present) plus one still-pending **incoming
alarm** so the demo always shows both the live command picture and the one-tap-take flow.
Reference config/geodata/objects are reloaded separately by the CLIs — see
``scripts/demo-reset.sh``.

    DATABASE_URL=<demo db> uv run python -m app.demo_reset

DEMO ONLY. Refuses to run unless KP_DEMO_RESET=1 is set, so it can never be pointed at a
real station's database by accident.
"""

import asyncio
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select

from .auth.security import hash_pin
from .database import async_session_maker
from .models import DiveraEmergency, Incident, ObjectSite, Personnel, User

logger = logging.getLogger(__name__)

# The static map/plan scene (tactical symbols, hose lines, Absperrkreis, building floor stack).
# backend/app/demo_reset.py → parents[2] is the repo root; the file is checked in and also the
# source for local `just demo-load`, so both paths render the same command picture.
SCENE_PATH = Path(__file__).resolve().parents[2] / "examples" / "demo-data" / "incident.workspace.json"
ZURICH = ZoneInfo("Europe/Zurich")

# The fixed demo accounts. Both PINs are shown on the demo login screen (identity.demoNote).
DEMO_USERS = [
    {"username": "fu", "display_name": "Führungsunterstützung", "role": "editor", "color": "#c0392b", "pin": "000000"},
    {"username": "demo-viewer", "display_name": "Betrachter", "role": "viewer", "color": "#2c7a5b", "pin": "000000"},
]

# The pre-filled running incident: a Zimmerbrand at Schloss Musterdorf. Its coordinates match
# the Schloss Einsatzobjekt, so the object's Module plans attach automatically at view time.
DEMO_INCIDENT = {
    "title": "Zimmerbrand",
    "type": "Brand",
    "text": "Gemeldeter Zimmerbrand im 2. OG, Rauch sichtbar. Menschenrettung läuft.",
    "address": "Schlossgasse 9, 4104 Oberwil",
    "lat": 47.52382,
    "lng": 7.57037,
    "divera_id": 990000,
    "divera_number": "2026-DEMO-000",
    # how long the incident has been running when the demo is viewed (drives the Einsatz clock)
    "elapsed_min": 14,
}

# A SECOND, still-pending alarm at a different address — the pool GET reads this straight from
# the DB (no Divera key needed), so the demo editor sees the incoming-alarm banner and can
# one-tap-take it. autoOpen is off in the demo config, and the running incident's split-dispatch
# guard would hold it anyway, so it stays pending. received_at defaults to now() ⇒ always fresh.
DEMO_ALARM = {
    "divera_id": 990002,
    "divera_number": "2026-DEMO-002",
    "title": "Automatische Brandmeldeanlage",
    "text": "BMA-Auslösung im Untergeschoss, Ursache noch unklar. Erkundung läuft.",
    "address": "Hauptstrasse 40, 4104 Oberwil",
    "lat": 47.5262,
    "lng": 7.5748,
}

# Dummy roster so Anwesenheit / Atemschutz person-assignment have people to work with.
DEMO_PEOPLE = [
    ("Hans", "Müller"), ("Anna", "Meier"), ("Peter", "Schmid"), ("Laura", "Keller"),
    ("Marco", "Weber"), ("Sarah", "Huber"), ("Thomas", "Brunner"), ("Nina", "Frei"),
    ("Michael", "Baumann"), ("Céline", "Widmer"), ("Stefan", "Graf"), ("Petra", "Roth"),
]

# Who is physically present (Anwesenheit) — all nine Trupp members plus the Einsatzleiter.
DEMO_PRESENT = {
    "Hans Müller", "Anna Meier", "Thomas Brunner",   # Trupp 1
    "Peter Schmid", "Laura Keller", "Nina Frei",      # Trupp 2
    "Marco Weber", "Sarah Huber", "Michael Baumann",  # Trupp 3
    "Céline Widmer",                                  # Einsatzleiter
}


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def build_demo_workspace(scene: dict, present: list[tuple[str, str]], now: datetime) -> dict:
    """Return the full incident workspace: the static map/plan ``scene`` plus the live
    operational collections (Atemschutz Trupps on the clock, logged Mittel, Anwesenheit) with
    fresh, reset-relative timestamps so the clocks always read as current. ``present`` is a list
    of ``(person_id, display_name)`` for the crew to mark present. Pure — no DB/file access."""
    ws = dict(scene)  # shallow copy; we only add top-level collections + retime the board chip
    hhmm = (now - timedelta(minutes=14)).astimezone(ZURICH).strftime("%H:%M")

    # Three Trupps: two in the field with a fresh Funkkontakt, one Sicherheitstrupp angemeldet.
    # The first links to the floor-stack chip already placed in board.gebaeude (annoId/planId).
    ws["trupps"] = [
        {
            "id": "trupp1", "name": "Hans Müller", "members": ["Anna Meier", "Thomas Brunner"],
            "auftrag": "retten", "ziel": "2. OG Wohnung Nord, 2 Personen vermisst",
            "lineNumber": "1", "funkkanal": 11, "entryPressureBar": 300,
            "entryTime": _iso(now - timedelta(minutes=14)),
            "lastContactTime": _iso(now - timedelta(minutes=2)),
            "lastPressureBar": 210, "lastPressureTime": _iso(now - timedelta(minutes=2)),
            "lowestBar": 210, "status": "aktiv",
            "annoId": "r1782915890769", "planId": "gebaeude",
        },
        {
            "id": "trupp2", "name": "Peter Schmid", "members": ["Laura Keller", "Nina Frei"],
            "auftrag": "loeschen", "ziel": "Brandbekämpfung 2. OG",
            "lineNumber": "2", "funkkanal": 11, "entryPressureBar": 300,
            "entryTime": _iso(now - timedelta(minutes=8)),
            "lastContactTime": _iso(now - timedelta(seconds=150)),
            "lastPressureBar": 250, "lastPressureTime": _iso(now - timedelta(seconds=150)),
            "lowestBar": 250, "status": "aktiv",
        },
        {
            "id": "trupp3", "name": "Marco Weber", "members": ["Sarah Huber", "Michael Baumann"],
            "auftrag": "sichern", "ziel": "Sicherheitstrupp bereit",
            "funkkanal": 11, "entryPressureBar": 300,
            "entryTime": "", "lastContactTime": "", "status": "angemeldet",
        },
    ]

    # A few logged Mittel, keyed to the demo catalogue ids so each lands in the right group and
    # shows a stock ring ("noch N").
    ws["mittel"] = [
        {"id": "md-1", "materialId": "schaummittel", "label": "Schaummittel", "unit": "l",
         "sourceId": "tlf", "sourceLabel": "TLF", "menge": 40,
         "at": _iso(now - timedelta(minutes=9)), "by": "Führungsunterstützung"},
        {"id": "md-2", "materialId": "schlauch-c", "label": "Schlauch 40er", "unit": "Stk",
         "sourceId": "tlf", "sourceLabel": "TLF", "menge": 6,
         "at": _iso(now - timedelta(minutes=7)), "by": "Führungsunterstützung"},
        {"id": "md-3", "materialId": "oelbindemittel", "label": "Ölbindemittel", "unit": "Sack",
         "sourceId": "depot", "sourceLabel": "Depot", "menge": 2,
         "at": _iso(now - timedelta(minutes=5)), "by": "Führungsunterstützung"},
        {"id": "md-4", "materialId": "luefter", "label": "Drucklüfter", "unit": "Stk",
         "sourceId": "tlf", "sourceLabel": "TLF", "menge": 1,
         "at": _iso(now - timedelta(minutes=4)), "by": "Führungsunterstützung", "status": "vorOrt"},
    ]

    # Anwesenheit: the present crew, checked in shortly after the alarm.
    ws["attendance"] = {
        pid: {"status": "present", "checkedInAt": _iso(now - timedelta(minutes=20)),
              "displayNameSnapshot": name}
        for pid, name in present
    }

    # Refresh the floor-stack chip's time labels so they read as fresh instead of a frozen 16:24.
    for res in ws.get("board", {}).get("gebaeude", []):
        res["t"] = hhmm
        for pt in res.get("trail", []):
            pt["t"] = hhmm
    return ws


async def reset() -> None:
    async with async_session_maker() as db:
        # Deleting incidents cascades to all incident-scoped tables (ON DELETE CASCADE).
        await db.execute(delete(Incident))
        # Roster is standalone (no incident FK) — clear manual/demo additions, then re-seed
        # the fixed dummy roster so Anwesenheit / person-assignment always have people. Keep the
        # generated ids so the pre-filled Anwesenheit can reference real Person rows.
        await db.execute(delete(Personnel))
        people_rows: list[tuple[str, Personnel]] = []
        for first, last in DEMO_PEOPLE:
            name = f"{first} {last}"
            p = Personnel(display_name=name, first_name=first, last_name=last, is_active=True)
            db.add(p)
            people_rows.append((name, p))
        # The uuid4 primary key is a COLUMN default — SQLAlchemy assigns it at flush (INSERT), not
        # at construction. Flush first, THEN read p.id, or every id is None ⇒ Anwesenheit keyed
        # "None" (a single ghost entry that matches no one).
        await db.flush()
        person_id: dict[str, str] = {name: str(p.id) for name, p in people_rows}
        assert "None" not in person_id.values(), "Personnel ids not flushed — Anwesenheit would break"
        # Clear objects so the manifest is authoritative ("these two, nothing else"). Deleting
        # an ObjectSite cascades to its plan datasets; the geo: reference layers (object_id NULL)
        # are untouched and get re-pushed by the reset script.
        await db.execute(delete(ObjectSite))
        # Clear any prior/taken alarms, then re-seed the one prepared pending alarm fresh.
        await db.execute(delete(DiveraEmergency))
        db.add(DiveraEmergency(**DEMO_ALARM, is_taken=False, is_archived=False))

        # The pre-filled running incident: static scene from the data file + live collections.
        now = datetime.now(UTC)
        scene = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
        present = [(pid, name) for name, pid in person_id.items() if name in DEMO_PRESENT]
        workspace = build_demo_workspace(scene, present, now)
        started = now - timedelta(minutes=DEMO_INCIDENT["elapsed_min"])
        db.add(Incident(
            title=DEMO_INCIDENT["title"], type=DEMO_INCIDENT["type"], priority="HIGH",
            text=DEMO_INCIDENT["text"], address=DEMO_INCIDENT["address"],
            lat=DEMO_INCIDENT["lat"], lng=DEMO_INCIDENT["lng"],
            status="offen", source="divera", source_ref=DEMO_INCIDENT["divera_number"],
            divera_id=DEMO_INCIDENT["divera_id"], auto_opened=False,
            started_at=started, editor_opened_at=started, is_archived=False,
            map_workspace_json=workspace, workspace_rev=1,
        ))

        for u in DEMO_USERS:
            user = (
                await db.execute(select(User).where(User.username == u["username"]))
            ).scalar_one_or_none()
            if user is None:
                user = User(username=u["username"])
                db.add(user)
            # Re-assert display/role/PIN/active every time so a demo visitor can't lock anyone out.
            user.display_name = u["display_name"]
            user.role = u["role"]
            user.color = u["color"]
            user.pin_hash = hash_pin(u["pin"])
            user.is_active = True
        await db.commit()
    logger.info(
        "Demo reset: seeded 1 running incident (%d Trupps, %d Mittel, %d present) + 1 pending "
        "alarm, ensured %d user(s), %d people.",
        len(workspace["trupps"]), len(workspace["mittel"]), len(present),
        len(DEMO_USERS), len(DEMO_PEOPLE),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if os.getenv("KP_DEMO_RESET") != "1":
        raise SystemExit("Refusing to run: set KP_DEMO_RESET=1 to confirm this is a DEMO database.")
    asyncio.run(reset())
