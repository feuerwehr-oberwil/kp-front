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

DEMO ONLY. ``reset()`` itself refuses to run unless KP_DEMO_RESET=1 is set, so it can never be
pointed at a real station's database by accident — including from the in-process scheduler,
which imports and awaits it directly and therefore used to bypass the check entirely.
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
from .models import DeploymentConfig, DiveraEmergency, Incident, JournalEntry, ObjectSite, Personnel, User
from .personnel import format_name

logger = logging.getLogger(__name__)

# The static map/plan scene (tactical symbols, hose lines, Absperrkreis, building floor stack).
# backend/app/demo_reset.py → parents[2] is the repo root; the file is checked in and also the
# source for local `just demo-load`, so both paths render the same command picture.
SCENE_PATH = Path(__file__).resolve().parents[2] / "examples" / "demo-data" / "incident.workspace.json"
ZURICH = ZoneInfo("Europe/Zurich")

# The STATION plan calibration (deployment_config.plan_scales_json, see api/plan_scales.py), so
# Messen works on the demo's plans without anyone calibrating first. It is station-level rather
# than a `planScale` in the scene file on purpose: a per-incident calibration overrides the
# station one, so seeding it there would leave every OTHER incident uncalibrated — and this is
# exactly the "a plan measures out of the box" case the station layer exists for.
# Not written by `admin_config load`, which only touches config_json, so the reset script's
# step 2 cannot wipe what step 1 writes here.
DEMO_PLAN_SCALES = {
    "default": None,
    "byPlan": {
        # Modul 1 (Übersicht), calibrated against a 100 m reference on the sheet.
        "modul1": {"mPerU": 743.9113870340418, "refM": 100, "ar": 0.7070980398566116},
        # The generated Gebäude floor-stack — its own space (1/TILE_AR), so it needs its own factor.
        "gebaeude": {"mPerU": 14.970878656783539, "refM": 10, "ar": 1.3888888888888888},
    },
}

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
    "address": "Schlossgasse 9, 9999 Musterdorf",
    "lat": 47.52371857249871,
    "lng": 7.570345444795164,
    "divera_id": 990000,
    "divera_number": "2026-DEMO-000",
}

# How long the incident has been running when the demo is viewed (drives the Einsatz clock).
# Its own constant rather than a DEMO_INCIDENT key: it is the only numeric field consumed as a
# number, and inside the mixed-value dict its type is just `object`.
#
# ⚠️ It has to be OLDER than every stamp seeded below, or the demo contradicts itself: at 14 the
# first Trupp entered the building in the same minute the pager went off, and the Rapport's own
# plausibility check flags exactly that. 34 leaves an honest run-up — alarm, turnout, arrival,
# then the entries at −14 and −8. The Anwesenheit starts exactly HERE (see build_demo_workspace):
# «ab Einsatzbeginn» is the button the operator presses, so nobody's clock may start before it.
DEMO_ELAPSED_MIN = 34

# Dummy roster so Anwesenheit / Atemschutz person-assignment have people to work with. Sized like
# a real village Feuerwehr (not a dozen): the Anwesenheit list, the person pickers and the
# Personalblatt only look like the real thing when picking a name means scrolling past the ones
# who stayed home. Order is the roster order; who is actually on scene is DEMO_PRESENT below.
DEMO_PEOPLE = [
    ("Hans", "Müller"),
    ("Anna", "Meier"),
    ("Peter", "Schmid"),
    ("Laura", "Keller"),
    ("Marco", "Weber"),
    ("Sarah", "Huber"),
    ("Thomas", "Brunner"),
    ("Nina", "Frei"),
    ("Michael", "Baumann"),
    ("Céline", "Widmer"),
    ("Stefan", "Graf"),
    ("Petra", "Roth"),
    ("Daniel", "Wyss"),
    ("Sandra", "Lüthi"),
    ("Reto", "Bachmann"),
    ("Fabienne", "Steiner"),
    ("Martin", "Zbinden"),
    ("Simon", "Hofer"),
    ("Andrea", "Kunz"),
    ("Lukas", "Bieri"),
    ("Jonas", "Rüegg"),
    ("Melanie", "Schneider"),
    ("Patrick", "Amrein"),
    ("Corinne", "Studer"),
    ("Beat", "Lehmann"),
    ("Tobias", "Vogel"),
    ("Silvia", "Marti"),
    ("Roger", "Egger"),
]


def demo_display_name(first: str, last: str) -> str:
    """The seeded display name for one ``DEMO_PEOPLE`` entry — the shipped default order.

    Every demo name goes through here (roster rows, Trupp members, the Anwesenheit snapshots),
    because those three are read next to each other on one screen: a demo that seeded «Müller
    Hans» into the roster and «Hans Müller» onto the Trupp card looks like a sync bug."""
    return format_name("", first, last) or f"{last} {first}"


# A pre-filled Verlauf (journal) so the demo lands with a worked incident's log instead of the
# empty "Noch keine Ereignisse erfasst" state. Each is (minutes-before-now, text); seeded as
# human `kind: 'journal'` TimelineEvents oldest-first. Times stay within the 14-min elapsed window.
DEMO_JOURNAL = [
    (14, "Alarmierung Zimmerbrand Schlossgasse 9, Ausrücken TLF und ADF."),
    (13, "Eintreffen. Rauch aus Fenster 2. OG, Menschenrettung eingeleitet."),
    (12, "Angriffstrupp 1 (Müller) zur Personenrettung 2. OG Nord eingesetzt."),
    (10, "Wasserversorgung ab Hydrant Schlossgasse sichergestellt."),
    (8, "Angriffstrupp 2 (Schmid) zur Brandbekämpfung 2. OG eingesetzt."),
    (5, "1 Person gerettet und an Sanität übergeben."),
    (2, "Brand unter Kontrolle, Nachlöscharbeiten laufen."),
]

# Who is physically present (Anwesenheit) — the nine Trupp members, the Einsatzleiter, and the
# crew around them (Maschinist, Wasserversorgung, Verkehrsdienst, Reserve). Deliberately a SUBSET
# of the roster: the demo has to show the "who came?" question, not a fire brigade at 100 %.
#: Who leads this demo incident — named on the Rapport and on the Anwesenheit list, so the
#: «Einsatzleiter» symbol on the Lage belongs to somebody.
DEMO_EINSATZLEITER = demo_display_name("Céline", "Widmer")

#: Kept as (Vorname, Nachname) pairs and joined through ``demo_display_name`` — these have to
#: match the seeded roster's display names exactly to resolve to a Person row, so they must not
#: be spelled out independently of the name order.
DEMO_PRESENT = {
    demo_display_name(first, last)
    for first, last in [
        ("Hans", "Müller"),
        ("Anna", "Meier"),
        ("Thomas", "Brunner"),  # Trupp 1
        ("Peter", "Schmid"),
        ("Laura", "Keller"),
        ("Nina", "Frei"),  # Trupp 2
        ("Marco", "Weber"),
        ("Sarah", "Huber"),
        ("Michael", "Baumann"),  # Trupp 3
        ("Céline", "Widmer"),  # Einsatzleiterin
        ("Stefan", "Graf"),  # Maschinist TLF
        ("Petra", "Roth"),
        ("Daniel", "Wyss"),  # Wasserversorgung
        ("Sandra", "Lüthi"),
        ("Reto", "Bachmann"),  # Verkehrsdienst
        ("Fabienne", "Steiner"),
        ("Martin", "Zbinden"),  # Reserve / Bereitstellung
        # A real Zimmerbrand pulls more of the Wehr than the people with a job on the board: the
        # Bereitstellung, the second Ablösung, the ones who came and are waiting. Without them the
        # Anwesenheit read as a half-empty list beside a fully worked incident.
        ("Simon", "Hofer"),
        ("Andrea", "Kunz"),
        ("Lukas", "Bieri"),
        ("Jonas", "Rüegg"),
        ("Melanie", "Schneider"),
        ("Patrick", "Amrein"),
    ]
}


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


#: The symbol that names who is leading, and the field on it that carries the name — mirrors
#: `appConfig.symbols.einsatzleiterName` / `rosterFields` on the frontend.
_EL_SYMBOL = "VKF Einsatzleiter"


def _scene_roles(scene: dict, present: list[tuple[str, str]]) -> dict[str, str]:
    """person_id → Anwesenheits-Bemerkung, read off the symbols placed in the scene.

    The German wording is the app's (`src/config/copy/de.ts` · anwesenheit.role*), repeated here
    rather than shared: the demo dataset is German-only, and a seed that quietly diverges from
    what the app writes would teach the wrong thing. Only people who are actually present get a
    remark — a symbol naming somebody who is not on the list is a contradiction the demo should
    not seed, and one nobody would spot in a JSON file.
    """
    by_name = {name: pid for pid, name in present}
    roles: dict[str, str] = {}
    for e in scene.get("entities") or []:
        fields = e.get("fields") or {}
        for key, value in fields.items():
            pid = by_name.get((value or "").strip())
            if not pid:
                continue
            if key == "Fahrer":
                roles[pid] = f"Fahrer {e.get('label') or ''}".strip()
            elif e.get("symbol") == _EL_SYMBOL and key == "Name":
                roles[pid] = "Einsatzleiter"
            elif e.get("symbol") == _EL_SYMBOL and key == "Stv.":
                roles[pid] = "Stv. Einsatzleiter"
    return roles


def build_demo_workspace(scene: dict, present: list[tuple[str, str]], now: datetime) -> dict:
    """Return the full incident workspace: the static map/plan ``scene`` plus the live
    operational collections (Atemschutz Trupps on the clock, logged Mittel, Anwesenheit) with
    fresh, reset-relative timestamps so the clocks always read as current. ``present`` is a list
    of ``(person_id, display_name)`` for the crew to mark present. Pure — no DB/file access."""
    ws = dict(scene)  # shallow copy; we only add top-level collections + retime the board chip
    hhmm = (now - timedelta(minutes=14)).astimezone(ZURICH).strftime("%H:%M")

    # ⚠️ The Trupps carry ROSTER IDS, not just names (Trupp.leaderPersonId / memberPersonIds).
    # Seeded with names alone, every demo Trupp member was an unlinked, hand-typed name: the
    # form tagged all nine of them «Gast», and the person picker went on offering people who
    # were already in a Trupp, because the only thing tying the two together was a string that
    # had to match the served display name character for character. Which it did not the moment
    # the roster's name order differed from the seed's. Ids are what everything else in the app
    # joins on, so the demo joins on them too.
    by_name = {name: pid for pid, name in present}

    def _pid(first: str, last: str) -> str | None:
        """The roster id of a seeded demo person, or None if they were not marked present."""
        return by_name.get(demo_display_name(first, last))

    # Three Trupps: two in the field with a fresh Funkkontakt, one Sicherheitstrupp angemeldet.
    # The first links to the floor-stack chip already placed in board.gebaeude (annoId/planId).
    ws["trupps"] = [
        {
            "id": "trupp1",
            "name": demo_display_name("Hans", "Müller"),
            "members": [demo_display_name("Anna", "Meier"), demo_display_name("Thomas", "Brunner")],
            "leaderPersonId": _pid("Hans", "Müller"),
            "memberPersonIds": [_pid("Anna", "Meier"), _pid("Thomas", "Brunner")],
            "auftrag": "loeschen",
            "ziel": "2. OG",
            "lineNo": 1,
            "lineId": "d1784735796244",  # the Angriffsleitung drawn on the Lage (scene file)
            "funkkanal": 11,
            "entryPressureBar": 300,
            "entryTime": _iso(now - timedelta(minutes=14)),
            "lastContactTime": _iso(now - timedelta(minutes=2)),
            "lastPressureBar": 210,
            "lastPressureTime": _iso(now - timedelta(minutes=2)),
            "lowestBar": 210,
            "status": "aktiv",
            "annoId": "r1782915890769",
            "planId": "gebaeude",
            # Contact/pressure Verlauf shown (collapsed) on the card — the frontend rebases these
            # timestamps to page-load along with the clocks, so they always read as fresh.
            "readings": [
                {"t": _iso(now - timedelta(minutes=14)), "bar": 300, "kind": "entry"},
                {"t": _iso(now - timedelta(minutes=11)), "bar": 280, "kind": "contact"},
                {"t": _iso(now - timedelta(minutes=8)), "bar": 250, "kind": "pressure"},
                {"t": _iso(now - timedelta(minutes=5)), "bar": 230, "kind": "contact"},
                {"t": _iso(now - timedelta(minutes=2)), "bar": 210, "kind": "pressure"},
            ],
        },
        {
            "id": "trupp2",
            "name": demo_display_name("Peter", "Schmid"),
            "members": [demo_display_name("Laura", "Keller"), demo_display_name("Nina", "Frei")],
            "leaderPersonId": _pid("Peter", "Schmid"),
            "memberPersonIds": [_pid("Laura", "Keller"), _pid("Nina", "Frei")],
            "auftrag": "retten",
            "ziel": "Rettung 2OG",
            # deliberately NO lineNo: the second Trupp is working without a numbered Leitung, so
            # the demo shows both states of the hose↔Trupp link side by side (Trupp 1 carries one).
            "funkkanal": 11,
            "entryPressureBar": 300,
            "entryTime": _iso(now - timedelta(minutes=8)),
            "lastContactTime": _iso(now - timedelta(seconds=150)),
            "lastPressureBar": 250,
            "lastPressureTime": _iso(now - timedelta(seconds=150)),
            "lowestBar": 250,
            "status": "aktiv",
            "readings": [
                {"t": _iso(now - timedelta(minutes=8)), "bar": 300, "kind": "entry"},
                {"t": _iso(now - timedelta(minutes=6)), "bar": 285, "kind": "contact"},
                {"t": _iso(now - timedelta(minutes=4)), "bar": 270, "kind": "pressure"},
                {"t": _iso(now - timedelta(seconds=150)), "bar": 250, "kind": "contact"},
            ],
        },
        {
            "id": "trupp3",
            "name": demo_display_name("Marco", "Weber"),
            "members": [demo_display_name("Sarah", "Huber"), demo_display_name("Michael", "Baumann")],
            "leaderPersonId": _pid("Marco", "Weber"),
            "memberPersonIds": [_pid("Sarah", "Huber"), _pid("Michael", "Baumann")],
            "auftrag": "sichern",
            "ziel": "Sicherheitstrupp bereit",
            "funkkanal": 11,
            "entryPressureBar": 300,
            "entryTime": "",
            "lastContactTime": "",
            "status": "angemeldet",
        },
    ]

    # A few logged Mittel, keyed to the demo catalogue ids so each lands in the right group and
    # shows a stock ring ("noch N"). All of them belong to THIS incident — a Zimmerbrand: lines,
    # a fan, cones. No Ölbindemittel; the Umwelt group is a spill's material, and a demo that logs
    # it on a fire teaches the wrong reflex.
    ws["mittel"] = [
        {
            "id": "md-1",
            "materialId": "schaummittel",
            "label": "Schaummittel",
            "unit": "l",
            "sourceId": "tlf",
            "sourceLabel": "TLF",
            "menge": 40,
            "at": _iso(now - timedelta(minutes=9)),
            "by": "Führungsunterstützung",
        },
        {
            "id": "md-2",
            "materialId": "schlauch-c",
            "label": "Schlauch 40er",
            "unit": "Stk.",
            "sourceId": "tlf",
            "sourceLabel": "TLF",
            "menge": 6,
            "at": _iso(now - timedelta(minutes=7)),
            "by": "Führungsunterstützung",
        },
        {
            "id": "md-3",
            "materialId": "schlauch-b",
            "label": "Schlauch 75er",
            "unit": "Stk.",
            "sourceId": "tlf",
            "sourceLabel": "TLF",
            "menge": 4,
            "at": _iso(now - timedelta(minutes=5)),
            "by": "Führungsunterstützung",
        },
        {
            "id": "md-4",
            "materialId": "luefter",
            "label": "Drucklüfter",
            "unit": "Stk.",
            "sourceId": "tlf",
            "sourceLabel": "TLF",
            "menge": 1,
            "at": _iso(now - timedelta(minutes=4)),
            "by": "Führungsunterstützung",
            "status": "vorOrt",
        },
        {
            "id": "md-5",
            "materialId": "leitkegel",
            "label": "Verkehrsleitkegel",
            "unit": "Stk.",
            "sourceId": "mtf",
            "sourceLabel": "MTF",
            "menge": 6,
            "at": _iso(now - timedelta(minutes=3)),
            "by": "Führungsunterstützung",
        },
    ]

    # Anwesenheit: the present crew, on the clock from the ALARM — «ab Einsatzbeginn», the button
    # the operator actually presses. A fixed 20-minute offset put everybody's start 14 minutes
    # after the incident began, which is not a state anybody produces: a Wehr that turns out to a
    # Zimmerbrand is counted from the alarm, and the demo was quietly showing 14 minutes of
    # unaccounted time on every single person.
    started = now - timedelta(minutes=DEMO_ELAPSED_MIN)
    ws["attendance"] = {
        pid: {"status": "present", "checkedInAt": _iso(started), "displayNameSnapshot": name} for pid, name in present
    }
    # …and the JOB each of them is on the list for. In the app a name typed into a symbol's
    # roster field writes that Bemerkung itself (lib/roleAssignment · rosterFieldRole); seeded
    # data never passes through that path, so the demo showed «Widmer Céline» on the Anwesenheit
    # and an «Einsatzleiter» symbol carrying her name with nothing connecting the two — the one
    # place a visitor looks to understand what the field is for.
    for pid, note in _scene_roles(scene, present).items():
        ws["attendance"][pid]["note"] = note

    # Name the Einsatzleiter. The scene file leaves it empty, so the Rapport's most-asked field
    # read «nicht erfasst» on a fully worked demo incident — and nothing tied the «Einsatzleiter»
    # symbol on the map to a person on the Anwesenheit list.
    # Alarmierungs- / Ausrückzeiten: the Rapport's Zeiten grid is built from the station's
    # configured Gruppen + Fahrzeuge, and an empty grid on a fully worked demo Einsatz reads as
    # a missing feature rather than as an unfilled form. Times sit in the honest run-up the
    # incident already has — alarm, then a minute or two to the vehicles rolling — and stay
    # BEFORE the first Trupp entry at −14 (see DEMO_ELAPSED_MIN).
    #
    # No `manual` flag: these are exactly what the milestone webhook would have prefilled, and
    # marking them as human edits would tell the app to stop updating them.
    ws["reportMeta"] = {
        **(ws.get("reportMeta") or {}),
        "einsatzleiter": DEMO_EINSATZLEITER,
        "gruppen": [
            {"id": "g1", "alarmedAt": _iso(started)},
            # the second Gruppe is alarmed a minute later — a Nachalarmierung, which is what
            # the two-row grid exists to show
            {"id": "g2", "alarmedAt": _iso(started + timedelta(minutes=1))},
        ],
        "fahrzeuge": [
            {
                "id": "tlf",
                "ausgerueckt": _iso(started + timedelta(minutes=4)),
                "vorOrt": _iso(started + timedelta(minutes=9)),
            },
            {
                "id": "adf",
                "ausgerueckt": _iso(started + timedelta(minutes=5)),
                "vorOrt": _iso(started + timedelta(minutes=10)),
            },
            # the MTF rolled but has not reported vor Ort — a half-filled row is the normal
            # state of this grid mid-Einsatz, and the demo should show that too
            {"id": "mtf", "ausgerueckt": _iso(started + timedelta(minutes=6))},
        ],
    }

    # Refresh the floor-stack chip's time labels so they read as fresh instead of a frozen 16:24.
    for res in ws.get("board", {}).get("gebaeude", []):
        res["t"] = hhmm
        for pt in res.get("trail", []):
            pt["t"] = hhmm
    return ws


class NotADemoDatabaseError(RuntimeError):
    """Raised when the demo reset is aimed at a database that has not confirmed it is a demo."""


def assert_demo_database() -> None:
    """Refuse to wipe unless KP_DEMO_RESET=1 says this is a demo database.

    This check used to live in the ``__main__`` block below, which meant it only covered the
    CLI. ``scheduler.py`` imports ``reset`` and awaits it directly, so the in-process job —
    the one that runs unattended, on a timer — walked straight past it, and its victim was
    whatever DATABASE_URL named. The module docstring claimed the opposite.

    Checked HERE, in the function that does the deleting, so every caller is covered by
    construction rather than by remembering.
    """
    if os.getenv("KP_DEMO_RESET") != "1":
        raise NotADemoDatabaseError(
            "Refusing to wipe: set KP_DEMO_RESET=1 to confirm this is a DEMO database. "
            "This deletes every incident, its journal and the roster."
        )


async def reset(wipe_objects: bool = True) -> None:
    """Wipe + reseed the demo's mutable state. ``wipe_objects`` controls whether the reference
    Einsatzobjekte (+ their Module PDFs) are cleared too:
      - ``True`` (the CLI / ``scripts/demo-reset.sh`` path): clear them so the re-pushed manifest is
        authoritative — the script reloads objects in the very next step, so they're gone only for a
        blink.
      - ``False`` (the in-process scheduler): KEEP them. The in-process job only reseeds the
        incident/roster and never reloads objects, so wiping them here would strip the Schloss's
        Modul 1 / 2-3 plans until the next GitHub reload — the demo's plan rail would sit empty
        (Umrisse + Tafel only) for most of each cycle."""
    assert_demo_database()

    async with async_session_maker() as db:
        # Deleting incidents cascades to all incident-scoped tables (ON DELETE CASCADE).
        await db.execute(delete(Incident))
        # Roster is standalone (no incident FK) — clear manual/demo additions, then re-seed
        # the fixed dummy roster so Anwesenheit / person-assignment always have people. Keep the
        # generated ids so the pre-filled Anwesenheit can reference real Person rows.
        await db.execute(delete(Personnel))
        people_rows: list[tuple[str, Personnel]] = []
        for first, last in DEMO_PEOPLE:
            name = demo_display_name(first, last)
            p = Personnel(display_name=name, first_name=first, last_name=last, is_active=True)
            db.add(p)
            people_rows.append((name, p))
        # The uuid4 primary key is a COLUMN default — SQLAlchemy assigns it at flush (INSERT), not
        # at construction. Flush first, THEN read p.id, or every id is None ⇒ Anwesenheit keyed
        # "None" (a single ghost entry that matches no one).
        await db.flush()
        person_id: dict[str, str] = {name: str(p.id) for name, p in people_rows}
        # S101 suppressed: a seed-time invariant, and the demo reset is never run under `python -O`.
        assert "None" not in person_id.values(), "Personnel ids not flushed — Anwesenheit would break"  # noqa: S101
        # Clear objects so the manifest is authoritative ("these two, nothing else"). Deleting
        # an ObjectSite cascades to its plan datasets; the geo: reference layers (object_id NULL)
        # are untouched and get re-pushed by the reset script. Skipped in-process (wipe_objects=
        # False), where nothing reloads them — see the reset() docstring.
        if wipe_objects:
            await db.execute(delete(ObjectSite))
        # Clear any prior/taken alarms so the demo lands with NO incoming-alarm waiting — just
        # the one running incident below (decision 2026-07-20: the take-flow banner cluttered the
        # landing; the default running Einsatz is the demo). Re-add a DEMO_ALARM here to restore it.
        await db.execute(delete(DiveraEmergency))

        # Station plan calibration — see DEMO_PLAN_SCALES. Written on the config singleton, which
        # may not exist yet on a fresh instance (admin_config load creates it in the next step).
        cfg = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        if cfg is None:
            db.add(DeploymentConfig(id=1, plan_scales_json=DEMO_PLAN_SCALES))
        else:
            cfg.plan_scales_json = DEMO_PLAN_SCALES

        # The pre-filled running incident: static scene from the data file + live collections.
        now = datetime.now(UTC)
        scene = json.loads(SCENE_PATH.read_text(encoding="utf-8"))
        present = [(pid, name) for name, pid in person_id.items() if name in DEMO_PRESENT]
        workspace = build_demo_workspace(scene, present, now)
        started = now - timedelta(minutes=DEMO_ELAPSED_MIN)
        incident = Incident(
            title=DEMO_INCIDENT["title"],
            type=DEMO_INCIDENT["type"],
            priority="HIGH",
            text=DEMO_INCIDENT["text"],
            address=DEMO_INCIDENT["address"],
            lat=DEMO_INCIDENT["lat"],
            lng=DEMO_INCIDENT["lng"],
            status="offen",
            source="divera",
            source_ref=DEMO_INCIDENT["divera_number"],
            divera_id=DEMO_INCIDENT["divera_id"],
            auto_opened=False,
            started_at=started,
            started_at_source="alarm",
            editor_opened_at=started,
            is_archived=False,
            map_workspace_json=workspace,
            workspace_rev=1,
        )
        db.add(incident)
        # Flush so the incident's uuid4 PK (a column default assigned at INSERT) is available for
        # the Verlauf rows' incident_id FK — same flush-then-read pattern as the Personnel ids above.
        await db.flush()
        # Seed the pre-filled Verlauf: each row is a human `journal` TimelineEvent stored verbatim
        # in row_json (that's the shape the append API and the frontend Verlauf renderer expect),
        # with a monotonic per-incident `seq` giving the display order (oldest first).
        for i, (mins_ago, text) in enumerate(DEMO_JOURNAL, start=1):
            at = _iso(now - timedelta(minutes=mins_ago))
            db.add(
                JournalEntry(
                    incident_id=incident.id,
                    client_id=f"demo-journal-{i}",
                    seq=i,
                    row_json={
                        "id": f"demo-journal-{i}",
                        "t": "",
                        "at": at,
                        "icon": "type",
                        "text": text,
                        "kind": "journal",
                        "surface": "map",
                    },
                )
            )

        for u in DEMO_USERS:
            user = (await db.execute(select(User).where(User.username == u["username"]))).scalar_one_or_none()
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
        "Demo reset: seeded 1 running incident (%d Trupps, %d Mittel, %d present, %d Verlauf), no "
        "pending alarm, ensured %d user(s), %d people.",
        len(workspace["trupps"]),
        len(workspace["mittel"]),
        len(present),
        len(DEMO_JOURNAL),
        len(DEMO_USERS),
        len(DEMO_PEOPLE),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    # The guard lives in reset() itself now, so this path and the scheduler's are covered by
    # the same check. Translated to a clean exit message rather than a traceback.
    try:
        assert_demo_database()
    except NotADemoDatabaseError as exc:
        raise SystemExit(str(exc)) from None
    asyncio.run(reset())
