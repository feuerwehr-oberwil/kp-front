"""The post-Einsatz check (``app.admin_postcheck``) against a small, made-up Übung with every
fault the 23.09.2026 post-mortem dug out by hand: a Verlauf row stamped three days back, the
same Atemschutz alarm from three devices, a burst of 409s on the workspace, a PIN prompt
mid-Einsatz, a render storm and a surface re-crash, and a Fahrzeug whose «verlassen» came late
and twice. All data here is invented — no station's names, places, devices or ids.

Most tests build the evidence as a JSON dump (``--dump``, the shape a post-mortem's SELECTs are
saved in) because that path is synchronous and needs no database. The database path gets its
own tests: it must read the same thing, and it must be unable to write.
"""

import json
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app import admin_postcheck as pc

BACKEND = Path(__file__).resolve().parents[1]

INC = "11111111-2222-3333-4444-555555555555"
EDITOR = "5e1f0c2a-7b3d-4c9e-8a61-2d4f9b7e3c10"
EL = "6a2b1d3c-4e5f-4a6b-9c7d-8e9f0a1b2c3d"
T0 = datetime(2026, 9, 23, 17, 0, tzinfo=UTC)
CENTER = (46.5, 8.25)  # an invented Einsatzort

IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/18.0 Mobile/15E148 Safari/604.1"
)
WINDOWS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

D_IPAD, D_ANDROID, D_IPHONE = "D1 iPad/Mac Safari 18.0", "D2 Android Chrome 130 phone", "D3 iPhone Safari 18.0"


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


def iso(dt: datetime) -> str:
    return dt.isoformat()


def z(dt: datetime) -> str:
    """The client's own shape: milliseconds and a Z."""
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def north_of_center(metres: float) -> tuple[float, float]:
    return CENTER[0] + metres / 111_195.0, CENTER[1]


# ── the fixture Übung ────────────────────────────────────────────────────────────────────


def row(client_id: str, created: datetime, stated: datetime | str, text_: str, **extra) -> dict:
    body = {"id": client_id, "at": stated if isinstance(stated, str) else z(stated), "text": text_, **extra}
    return {"client_id": client_id, "seq": 0, "row_json": body, "created_at": created}


PRESENCE = {"kind": "symbol", "icon": "truck", "entityId": "gps-3"}


def journal_rows() -> list[dict]:
    rows = [
        row("e1790186400000-01abc", at(10), at(10), "Lagemeldung: Rauch aus dem 1. OG"),
        # root cause B: a client clock pulled back three days
        row("azcl-tr5-x", at(70), "2026-09-20T19:53:02.000Z", "Atemschutz-Alarm beendet: Trupp 5"),
        # one row, two devices, two ids — 5 s apart
        row("e1790186700000-02abc", at(15), at(15), "Wasser marsch"),
        row("e1790186705000-0bxyz", at(15) + timedelta(seconds=5), at(15) + timedelta(seconds=5), "Wasser marsch"),
        # the LF 1: arrival on time, departure 15 min late, and written a second time 5 min later
        row("vp-1-scene-gps-3", at(22), at(22), "LF 1 vor Ort", **PRESENCE),
        row("vp-2-away-gps-3", at(135), at(135), "LF 1 hat den Einsatzort verlassen", **PRESENCE),
        row("e1790195995316-25abc", at(140), at(140), "LF 1 hat den Einsatzort verlassen", **PRESENCE),
        # two lines drawn 7 s apart: the same words, two objects — NOT a duplicate
        row("e1790186372236-13abc", at(40), at(40), "Linie auf Plan gezeichnet", annoId="l1", planId="gebaeude"),
        row(
            "e1790186379055-14abc",
            at(40) + timedelta(seconds=7),
            at(40) + timedelta(seconds=7),
            "Linie auf Plan gezeichnet",
            annoId="l2",
            planId="gebaeude",
        ),
        # Durchhören: stamped when it was SAID, 90 min before it was written — on purpose
        row("e1790190000000-12abc-p", at(100), at(10), "Funkspruch nachgetragen"),
    ]
    for i, r in enumerate(rows, 1):
        r["seq"] = i
    return rows


def ev(seq: int, op: str, payload: dict, occurred: datetime, client_id: str | None, source="client", user=EDITOR):
    return {
        "id": str(uuid.UUID(int=seq)),
        "client_id": client_id,
        "seq": seq,
        "source": source,
        "user_id": user if source in ("client", "el") else None,
        "op_type": op,
        "payload_json": payload,
        "occurred_at": occurred,
        "recorded_at": occurred + timedelta(milliseconds=200),
    }


def event_rows() -> list[dict]:
    alarm = {"id": "tr1", "status": "ueberfaellig"}
    return [
        # the Atemschutz alarm clock on three devices, one login, three ordinary ids
        ev(1, "atemschutz.alarm", alarm, at(30), "audit1790186400000-0aabc"),
        ev(2, "atemschutz.alarm", alarm, at(30) + timedelta(seconds=0.5), "audit1790186400500-3fdef"),
        ev(3, "atemschutz.alarm", alarm, at(30) + timedelta(seconds=1), "audit1790186401000-7kghi"),
        ev(4, "board.add", {"id": "s1"}, at(31), "audit1790186460000-0bjkl"),
        ev(5, "workspace.save", {"rev": 2}, at(32), None),
        # the alarm system's own event: its clock is not a device's, and it is not a duplicate
        ev(6, "divera.update", {"status": "alarm"}, at(-30), None, source="divera"),
        # OBSERVED by two accounts: one per actor is how it is meant to be — not a duplicate
        ev(7, "atemschutz.alarm.cleared", {"id": "tr2"}, at(45), f"obs-azcl-tr2-1@{EDITOR}"),
        ev(
            8,
            "atemschutz.alarm.cleared",
            {"id": "tr2"},
            at(45) + timedelta(seconds=2),
            f"obs-azcl-tr2-1@{EL}",
            "el",
            EL,
        ),
    ]


def sample_rows() -> list[dict]:
    def fix(minutes: float, metres: float) -> dict:
        lat, lng = north_of_center(metres)
        return {"device_id": 3, "ts": at(minutes), "lat": lat, "lng": lng}

    # away (baseline) → inside 150 m at +20 → beyond 300 m at +120
    return [fix(0, 800), fix(20, 20), fix(25, 15), fix(120, 600), fix(125, 700)]


def workspace() -> dict:
    return {"reportMeta": {"fahrzeuge": [{"id": "lf1", "vorOrt": z(at(24))}]}}


CONFIG = {"fleet": {"vehicles": [{"id": "lf1", "label": "LF 1"}]}}


def incident_row() -> dict:
    return {
        "id": INC,
        "title": "Brand Wohnhaus",
        "status": "offen",
        "is_exercise": True,
        "started_at": at(0),
        "closed_at": None,
        "lat": CENTER[0],
        "lng": CENTER[1],
    }


def _dumpable(rows: list[dict], *, stringify: tuple[str, ...] = ()) -> list[dict]:
    """Rows the way a dump holds them: timestamps as strings, JSONB columns as JSON TEXT."""
    out = []
    for r in rows:
        d = {"incident_id": INC, **r}
        for k, v in list(d.items()):
            if isinstance(v, datetime):
                d[k] = v.isoformat().replace("T", " ")  # Postgres' own text shape
            elif k in stringify:
                d[k] = json.dumps(v)
        out.append(d)
    return out


def write_dump(directory: Path, *, clean: bool = False) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    journal = journal_rows()[:1] if clean else journal_rows()
    events = [e for e in event_rows() if e["op_type"] != "atemschutz.alarm"] if clean else event_rows()
    samples = [] if clean else sample_rows()
    (directory / "journal_entries.json").write_text(json.dumps(_dumpable(journal, stringify=("row_json",))))
    (directory / "incident_events.json").write_text(json.dumps(_dumpable(events, stringify=("payload_json",))))
    (directory / "vehicle_samples.json").write_text(
        json.dumps([{**s, "lat": str(s["lat"]), "lng": str(s["lng"])} for s in _dumpable(samples)])
    )
    (directory / "workspace.json").write_text(json.dumps({} if clean else workspace()))
    inc = incident_row()
    (directory / "incident.json").write_text(json.dumps(_dumpable([inc])[0] | {"lat": str(inc["lat"])}))
    (directory / "users.json").write_text(json.dumps([{"id": EDITOR, "role": "editor"}, {"id": EL, "role": "el"}]))
    (directory / "config.json").write_text(json.dumps(CONFIG))
    return directory


def http_line(ts: datetime, method: str, path: str, status: int, ua: str, ip: str = "192.0.2.10", dur: float = 20):
    return {
        "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%S.%f") + "123Z",  # Railway's nine digits
        "method": method,
        "path": path,
        "httpStatus": status,
        "totalDuration": dur,
        "requestId": uuid.uuid4().hex,
        "clientUa": ua,
        "srcIp": ip,
    }


def http_lines() -> list[dict]:
    base = f"/api/incidents/{INC}"
    evs = {e["seq"]: e for e in event_rows()}
    after = timedelta(milliseconds=12)  # the response leaves a few ms after the row is stored
    return [
        http_line(at(-14), "POST", "/api/print-agent/claim", 204, "Python-urllib/3.12"),  # never this incident
        http_line(at(5), "GET", f"{base}/workspace", 200, IPAD),
        http_line(at(6), "GET", f"{base}/workspace", 200, ANDROID, ip="198.51.100.20"),
        http_line(evs[1]["recorded_at"] + after, "POST", f"{base}/events", 201, IPAD),
        http_line(evs[2]["recorded_at"] + after, "POST", f"{base}/events", 201, ANDROID),
        http_line(evs[3]["recorded_at"] + after, "POST", f"{base}/events", 201, ANDROID),
        # the clock-jumped row came from the Android, which was online all along
        http_line(at(40), "GET", f"{base}/journal", 200, ANDROID),
        http_line(at(70) + timedelta(milliseconds=14), "POST", f"{base}/journal", 201, ANDROID),
        # six 409s within 30 s that straddle a clock minute (3 + 3): ONE burst over a sliding 60 s
        *[http_line(at(49.75) + timedelta(seconds=5 * i), "PUT", f"{base}/workspace", 409, ANDROID) for i in range(6)],
        http_line(at(50) + timedelta(seconds=40), "PUT", f"{base}/workspace", 200, ANDROID),
        # one 409 on the iPad, resolved at once: normal
        http_line(at(55), "PUT", f"{base}/workspace", 409, IPAD),
        http_line(at(55) + timedelta(seconds=1), "PUT", f"{base}/workspace", 200, IPAD),
        # a long-poll the app itself cancelled: not an error
        http_line(at(56), "GET", f"{base}/journal", 499, IPAD),
        # a crash report that never reached the log
        http_line(at(57), "POST", "/api/diag/client-error", 403, ANDROID),
        # two Verlauf long-polls of one User-Agent open at once: two browsers behind «one» device
        http_line(at(60), "GET", f"{base}/journal", 200, ANDROID, dur=20000),
        http_line(at(60) + timedelta(seconds=5), "GET", f"{base}/journal", 200, ANDROID, dur=20000),
        # the iPad's session expired mid-Einsatz: PIN prompt
        http_line(at(80), "GET", "/api/auth/me", 401, IPAD),
        http_line(at(80) + timedelta(seconds=1), "POST", "/api/auth/refresh", 401, IPAD),
        http_line(at(80) + timedelta(seconds=9), "POST", "/api/auth/login", 200, IPAD),
        # the Android's access token expired: renewed silently
        http_line(at(90), "GET", "/api/auth/me", 401, ANDROID),
        http_line(at(90) + timedelta(seconds=1), "POST", "/api/auth/refresh", 200, ANDROID),
        # a phone joins: logs in, THEN opens the incident — how a device starts, not a finding
        http_line(at(95), "POST", "/api/auth/login", 200, IPHONE, ip="203.0.113.7"),
        http_line(at(95) + timedelta(seconds=20), "GET", f"{base}/workspace", 200, IPHONE, ip="203.0.113.7"),
        # a browser that never opened this incident, stuck in a boot loop
        http_line(at(60), "GET", "/api/incidents", 500, WINDOWS, ip="203.0.113.30"),
        http_line(at(61), "GET", "/assets/index-old.js", 404, WINDOWS, ip="203.0.113.30"),
        http_line(at(150), "POST", "/api/print-agent/claim", 204, "Python-urllib/3.12"),
    ]


def write_http(path: Path, lines: list[dict] | None = None) -> Path:
    if lines is None:
        lines = http_lines()
        lines = [*lines, dict(lines[9])]  # a paged export repeats the boundary line (same requestId)
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
    return path


def app_line(ts: datetime, message: str) -> str:
    return json.dumps({"timestamp": ts.strftime("%Y-%m-%dT%H:%M:%S.%f") + "466Z", "level": "error", "message": message})


def write_app_log(path: Path) -> Path:
    render_storm = app_line(
        at(31),
        f"WARNING:kpfront.clienterror:client-error kind=render build=v1.0.0+aaaaaaa path=/ ua={IPAD} "
        ":: render storm: IncidentWorkspace",
    )
    lines = [
        app_line(at(-14), 'INFO:     10.0.0.1:1 - "GET /api/config HTTP/1.1" 200 OK'),
        # the format before 24.09.2026
        render_storm,
        render_storm,  # a paged export repeats the boundary line: counted once
        # the format since: srv, surface, a repeat counter, a stack
        app_line(
            at(33),
            "WARNING:kpfront.clienterror:client-error kind=surface-recrash build=v1.0.0+aaaaaaa srv=v1.1.0+bbbbbbb "
            f"surface=map repeat=×3 since=17:30:00Z last=17:33:00Z path=/ ua={ANDROID} "
            ":: Maximum update depth exceeded :: stack: Error ⏎ at TwinTeamPill (x.js:1:2)",
        ),
        # a browser that never opened this incident — listed as information
        app_line(
            at(34),
            f"WARNING:kpfront.clienterror:client-error kind=error build=v1.0.0+aaaaaaa path=/ ua={WINDOWS} :: boom",
        ),
        # outside the window
        app_line(
            at(-400),
            f"WARNING:kpfront.clienterror:client-error kind=error build=v0.9.0+ccccccc path=/ ua={IPAD} :: old",
        ),
        app_line(at(150), 'INFO:     10.0.0.1:1 - "GET /health HTTP/1.1" 200 OK'),
    ]
    path.write_text("\n".join(lines) + "\n")
    return path


@pytest.fixture
def full(tmp_path: Path) -> list[str]:
    return [
        INC,
        "--dump",
        str(write_dump(tmp_path / "dump")),
        "--logs",
        str(write_app_log(tmp_path / "app.jsonl")),
        "--http",
        str(write_http(tmp_path / "http.jsonl")),
    ]


def report_of(argv: list[str]) -> pc.Report:
    report, _as_json = pc.run(argv)
    return report


def section(report: pc.Report, key: str) -> pc.Section:
    return next(s for s in report.sections if s.key == key)


# ── the pieces ───────────────────────────────────────────────────────────────────────────


def test_timestamps_of_every_source_parse_to_utc():
    assert pc.parse_ts("2026-09-23T18:01:07.730939666Z") == datetime(2026, 9, 23, 18, 1, 7, 730939, tzinfo=UTC)
    assert pc.parse_ts("2026-09-23 17:16:19+00:00") == datetime(2026, 9, 23, 17, 16, 19, tzinfo=UTC)
    assert pc.parse_ts("2026-09-23T20:16:19+02:00") == datetime(2026, 9, 23, 18, 16, 19, tzinfo=UTC)
    assert pc.parse_ts("2026-09-23T17:00") == datetime(2026, 9, 23, 17, 0, tzinfo=UTC)  # naive = UTC
    assert pc.parse_ts("20:28") is None
    assert pc.parse_ts(None) is None


def test_a_user_agent_becomes_a_device_name_a_person_recognises():
    assert pc.ua_label(IPAD) == "iPad/Mac Safari 18.0"
    assert pc.ua_label(ANDROID) == "Android Chrome 130 phone"
    assert pc.ua_label(ANDROID.replace("Mobile ", "")) == "Android Chrome 130 tablet"
    assert pc.ua_label(IPHONE) == "iPhone Safari 18.0"
    samsung = ANDROID.replace("Chrome/130.0.0.0", "SamsungBrowser/25.0 Chrome/121.0.0.0")
    assert pc.ua_label(samsung) == "Android Samsung Internet 25.0 phone"


def test_both_crash_line_formats_are_read():
    old = pc.parse_crash_message(
        T0, f"WARNING:kpfront.clienterror:client-error kind=render build=v1 path=/ ua={IPAD} :: render storm: X"
    )
    assert old is not None
    assert (old.kind, old.build, old.ua, old.message, old.repeat) == ("render", "v1", IPAD, "render storm: X", 1)
    new = pc.parse_crash_message(
        T0,
        "WARNING:kpfront.clienterror:client-error kind=surface-recrash build=v1 srv=v2 surface=map "
        f"repeat=×37 since=20:28:14Z last=20:31:00Z path=/ ua={ANDROID} :: Boom :: stack: Error ⏎ at x "
        ":: componentStack: at Y",
    )
    assert new is not None
    assert (new.kind, new.surface, new.repeat, new.server_build, new.message) == (
        "surface-recrash",
        "map",
        37,
        "v2",
        "Boom",
    )
    assert new.ua == ANDROID
    assert pc.parse_crash_message(T0, "INFO: something else") is None


def test_an_endpoint_is_one_row_whatever_the_ids():
    assert pc.path_template(f"/api/incidents/{INC}/workspace?rev=3", INC) == "/api/incidents/{incident}/workspace"
    assert pc.path_template(f"/api/reference/plan:{uuid.uuid4()}:modul6/tiles/3/1/2.webp", INC) == (
        "/api/reference/plan:{uuid}:modul6/tiles/3/1/2.webp"
    )


def test_a_fractional_or_garbled_duration_is_read_not_fatal(tmp_path: Path):
    """Railway has always written an int — but «12.5» must not end the check (it did: exit 1)."""
    lines = [
        http_line(at(5), "GET", f"/api/incidents/{INC}/workspace", 200, IPAD, dur="12.5"),  # type: ignore[arg-type]
        http_line(at(6), "GET", f"/api/incidents/{INC}/workspace", 200, IPAD, dur="soon"),  # type: ignore[arg-type]
    ]
    http, stats = pc.read_http(write_http(tmp_path / "h.jsonl", lines), at(0), at(10))
    assert [h.duration_ms for h in http] == [12, 0]
    assert stats.in_window == 2


# ── the sections, on the fixture Übung ───────────────────────────────────────────────────


def test_devices_are_the_browsers_that_opened_this_incident(full):
    report = report_of(full)
    sec = section(report, "devices")
    devices = sec.data["devices"]
    assert [f"{d['tag']} {d['label']}" for d in devices] == [D_IPAD, D_ANDROID, D_IPHONE], (
        "the print agent and the Windows browser never touched this incident"
    )
    # the audit events are attributed through the write request that stored them
    assert devices[0]["accounts"] == {f"{EDITOR[:8]} (editor)": 1}
    assert devices[1]["accounts"] == {f"{EDITOR[:8]} (editor)": 2}
    assert "5e1f0c2a (editor) wrote from 2 devices (D1, D2)" in report.text()
    assert any("LOWER bound" in line for line in sec.lines)
    # two long-polls open at once: at least two browsers share that User-Agent
    assert devices[1]["concurrentLongPolls"] == 2
    assert any("≥2 browsers behind D2" in line for line in sec.lines)
    assert not sec.findings


def test_crashes_are_per_device_and_storms_are_highlighted(full):
    sec = section(report_of(full), "crashes")
    assert [(g["device"], g["highlight"], g["count"]) for g in sec.data["groups"]] == [
        (D_IPAD, "RENDER STORM", 1),  # the repeated boundary line is counted once
        (D_ANDROID, "SURFACE RECRASH", 3),  # the repeat counter, not one line
    ]
    assert len(sec.findings) == 2
    assert any("a client on an older release" in line for line in sec.lines), "srv ≠ build: an old precache"
    # a browser that never opened the incident is listed — a boot crash loop hides there
    assert sec.data["foreign"] == [{"browser": "Windows Chrome 130", "kind": "error", "message": "boom", "count": 1}]


def test_http_errors_the_409_bursts_and_what_is_not_an_error(full):
    sec = section(report_of(full), "http")
    assert [(e["device"], e["status"], e["path"]) for e in sec.data["errors"]] == [
        (D_ANDROID, 403, "/api/diag/client-error"),
    ]
    conflicts = sec.data["workspaceConflicts"]
    # 3 + 3 across a clock minute is still six within 60 s — one burst
    assert conflicts[D_ANDROID] == {"count": 6, "unresolved": 0, "worst60s": 6}
    assert conflicts[D_IPAD]["worst60s"] == 1
    # the 403 and the Android's burst are findings; the iPad's single 409 and the 499 are not
    assert len(sec.findings) == 2
    assert any("a crash report that never reached the log" in line for line in sec.lines)
    assert sec.data["aborted499"] == {"D1": 1}
    # the Windows browser's 500 and 404 are information, not this incident's findings
    assert sorted((f["status"], f["path"]) for f in sec.data["foreign"]) == [
        (404, "/assets/index-old.js"),
        (500, "/api/incidents"),
    ]


def test_a_verlauf_row_stamped_three_days_back_is_a_clock_jump(full):
    sec = section(report_of(full), "clock")
    [row_] = sec.data["rows"]
    assert row_["text"] == "Atemschutz-Alarm beendet: Trupp 5"
    assert row_["skewSeconds"] < -2 * 86400
    assert row_["device"] == D_ANDROID
    assert "probably its clock" in sec.lines[0], "a device that was online had a wrong clock, not a queue"
    # the Durchhören row stamped 90 min back is backdated on purpose
    assert sec.data["playerRowsSkipped"] == 1


def test_the_same_alarm_from_three_devices_is_a_duplicate_and_observed_events_are_not(full):
    sec = section(report_of(full), "duplicates")
    groups = sec.data["groups"]
    assert [(g["table"], g["kind"], len(g["ids"])) for g in groups] == [
        ("journal_entries", "row", 2),  # «Wasser marsch» at +15 min
        ("incident_events", "atemschutz.alarm", 3),  # at +30 min
    ], "the alarm cleared by two ACCOUNTS (obs-…@editor, obs-…@el) is one per actor — as designed"
    assert groups[1]["devices"] == [D_IPAD, D_ANDROID]
    assert len(sec.findings) == 2


def test_observed_ids_are_one_per_actor():
    def e(cid: str, user: str) -> pc.EventRow:
        return pc.EventRow(cid, cid, 1, "client", user, "atemschutz.alarm", {}, T0, T0)

    assert not pc.duplicate_copies([e("obs-azal-tr1-1@A", "A"), e("obs-azal-tr1-1@B", "B")])
    assert pc.duplicate_copies([e("obs-azal-tr1-1@A", "A"), e("audit1-0aabc", "A")]), "an old client beside a new one"
    assert pc.duplicate_copies([e("audit1-0aabc", "A"), e("audit2-0bxyz", "A")])
    assert pc.duplicate_copies([e("obs-azal-tr1-1@A", "A"), e("obs-azal-tr1-1@A", "A")])


def test_a_pin_prompt_mid_einsatz_is_found_and_a_login_to_start_is_not(full):
    sec = section(report_of(full), "auth")
    assert [(e["device"], e["what"]) for e in sec.data["episodes"]] == [
        (D_IPAD, "PIN entered mid-Einsatz (login succeeded) after the session expired (refresh 401 ×1)"),
        (D_IPHONE, "logged in before opening the incident (login succeeded)"),
    ]
    assert sec.data["silentRenewals"] == {D_ANDROID: 1}
    assert len(sec.findings) == 1


def test_vehicle_rows_are_held_against_the_gps(full):
    sec = section(report_of(full), "vehicles")
    [lf] = sec.data["vehicles"]
    assert lf["name"] == "LF 1"
    assert lf["firstInside"] == iso(at(20))
    assert lf["firstBeyondAfter"] == iso(at(120))
    assert [r["lagSeconds"] for r in lf["rows"]] == [120, 900, 1200]
    # the late departure, the later copy of it, and the two rows for one change
    assert len(sec.findings) == 3
    assert any("2 client rows for the one GPS change" in line for line in sec.lines)
    late = next(line for line in sec.lines if "(+15 min 0 s)" in line)
    assert "GPS 19:00:00 → expected ≈ 19:01:30 (GPS + 90 s)" in late
    assert "row stated 19:15:00 / received 19:15:00" in late
    assert "writer unknown; online then: none" in late, "no device answered around that GPS change"
    # the Zeiten grid beside it: the fleet config names «lf1» «LF 1», typed «vor Ort» 4 min after the GPS
    assert sec.data["zeiten"] == [
        {"id": "lf1", "label": "LF 1", "ausgerueckt": None, "vorOrt": z(at(24)), "zurueck": None}
    ]
    assert any("GPS inside 150 m 17:20:00 (+4 min 0 s)" in line for line in sec.lines)


def _presence_ev(rows: list[pc.JournalRow], samples: list[pc.Sample], lat=CENTER[0], lng=CENTER[1]) -> pc.Evidence:
    return pc.Evidence(
        incident=pc.IncidentInfo(INC, lat=lat, lng=lng), journal=rows, events=[], samples=samples, workspace=None
    )


def _jr(row_id: str, created: datetime, stated: datetime, text_: str, entity: str) -> pc.JournalRow:
    return pc.JournalRow(row_id, 1, {"id": row_id, "at": z(stated), "text": text_, "entityId": entity}, created)


def _fix(dev: int, minutes: float, metres: float) -> pc.Sample:
    return pc.Sample(dev, at(minutes), *north_of_center(metres))


def test_the_client_state_machine_is_replayed_fix_by_fix():
    """One fix at 320 m, ten minutes in the band at 250 m, inside again: the band clears the
    pending «away», so the client writes nothing — and neither may the check expect a row."""
    samples = [_fix(3, 0, 10), _fix(3, 5, 320), _fix(3, 5.5, 250), _fix(3, 15, 250), _fix(3, 16, 10)]
    trans = pc.presence_transitions(samples, CENTER)
    assert [(t.zone, t.baseline) for t in trans] == [("scene", True)]
    # …while a vehicle that stays out is written 90 s after its first fix out, even with no
    # further fix: the feed keeps showing it there, and the client re-reads it every poll
    trans = pc.presence_transitions([_fix(3, 0, 10), _fix(3, 5, 400), _fix(3, 30, 420)], CENTER)
    assert [(t.zone, t.gps, t.due) for t in trans[1:]] == [("away", at(5), at(6.5))]
    # a return within 90 s never happened
    trans = pc.presence_transitions([_fix(3, 0, 10), _fix(3, 10, 400), _fix(3, 10.5, 10)], CENTER)
    assert len(trans) == 1


def test_rows_one_device_wrote_in_one_second_are_one_late_batch():
    samples = [_fix(3, 0, 900), _fix(3, 5, 20), _fix(4, 0, 900), _fix(4, 6, 20)]
    batch = at(25)
    rows = [
        _jr("e1-01aaa", batch, batch, "LF 1 vor Ort", "gps-3"),
        _jr("e1-02bbb", batch + timedelta(milliseconds=300), batch, "HLF 2 vor Ort", "gps-4"),
    ]
    sec = pc.section_vehicles(_presence_ev(rows, samples), None, pc.Options())
    assert len(sec.findings) == 1
    assert "2 late presence rows" in sec.findings[0]
    assert any("wrote 2 late presence rows in one go" in line for line in sec.lines)


def test_a_row_whose_clock_is_off_is_placed_where_the_server_received_it():
    samples = [_fix(3, 0, 900), _fix(3, 5, 20)]
    # stated 3 days back (a jumped clock), received a minute after the row was due
    rows = [_jr("vp-1-scene-gps-3", at(7.5), at(-3 * 24 * 60), "LF 1 vor Ort", "gps-3")]
    sec = pc.section_vehicles(_presence_ev(rows, samples), None, pc.Options())
    assert not sec.findings
    assert sec.data["vehicles"][0]["rows"][0]["lagSeconds"] == 150


def test_a_presence_row_without_any_gps_track_is_listed_not_found():
    """No Traccar (or a dump without the table): there is nothing to hold the row against."""
    rows = [_jr("vp-1-scene-gps-9", at(5), at(5), "HLF vor Ort", "gps-9")]
    sec = pc.section_vehicles(_presence_ev(rows, []), None, pc.Options())
    assert not sec.findings
    assert any("no GPS fixes recorded for this vehicle" in line for line in sec.lines)


def test_zero_zero_is_no_location():
    rows = [_jr("vp-1-scene-gps-3", at(5), at(5), "LF 1 vor Ort", "gps-3")]
    sec = pc.section_vehicles(_presence_ev(rows, [_fix(3, 0, 10)], lat=0.0, lng=0.0), None, pc.Options())
    assert sec.skipped and "no Einsatzort" in sec.skipped


def test_the_summary_counts_the_findings_and_sets_the_exit_code(full):
    report = report_of(full)
    assert report.findings == 11
    assert report.exit_code == pc.EXIT_FINDINGS
    assert report.summary() == "FINDINGS: 11 (crashes 2, http 2, clock 1, duplicates 2, auth 1, vehicles 3)."
    doc = report.as_json()
    assert doc["findings"] == 11
    assert set(doc["sections"]) == {"devices", "crashes", "http", "clock", "duplicates", "auth", "vehicles"}
    assert [i["flag"] for i in doc["inputs"]] == ["--http", "--logs"]
    assert doc["inputs"][0]["repeatedDropped"] == 1
    json.dumps(doc)  # serialisable as it stands


def test_the_report_says_what_each_log_held(full):
    text_ = report_of(full).text()
    assert "--http http.jsonl: 32 lines read, 31 usable, 31 in the window, 1 repeated dropped" in text_
    assert "--logs app.jsonl: 7 lines read, 6 usable, 5 in the window, 1 repeated dropped" in text_
    assert "warning:" not in text_


def test_a_database_only_run_is_not_a_plain_ok(tmp_path: Path):
    report = report_of([INC, "--dump", str(write_dump(tmp_path / "dump", clean=True))])
    assert report.findings == 0
    assert report.exit_code == pc.EXIT_CLEAN
    assert report.summary() == (
        "OK: no findings. Not checked: crashes (no --logs), http (no --http), auth (no --http)."
    )


def test_a_log_that_cannot_cover_the_window_says_so(tmp_path: Path):
    """A 5000-line Railway page that stops half-way through the Einsatz."""
    base = f"/api/incidents/{INC}/workspace"
    lines = [http_line(at(5) + timedelta(seconds=i * 0.3), "GET", base, 200, IPAD) for i in range(pc._RAILWAY_PAGE)]
    report = report_of(
        [INC, "--dump", str(write_dump(tmp_path / "dump")), "--http", str(write_http(tmp_path / "h.jsonl", lines))]
    )
    assert len(report.warnings) == 2
    assert "one Railway page" in report.warnings[0]
    assert "was not checked" in report.warnings[1]
    assert report.summary().endswith("Input warnings: 2 (see Inputs).")


def test_the_window_bounds_the_logs(full):
    """--until before the PIN prompt: the logs after it are not read."""
    report = report_of([*full, "--until", iso(at(60))])
    assert not section(report, "auth").findings
    assert report.until == at(60)


def test_times_carry_their_date_when_the_window_spans_days(full):
    report = report_of([*full, "--until", "2026-09-24T02:00Z"])
    assert any("23.09. 17:05:00" in line for line in section(report, "devices").lines)


def test_since_and_until_stand_in_for_an_incident_without_times(tmp_path: Path):
    d = write_dump(tmp_path / "dump", clean=True)
    (d / "incident.json").write_text(json.dumps({"id": INC, "title": "Leer"}))
    (d / "journal_entries.json").write_text("[]")
    (d / "incident_events.json").write_text("[]")
    with pytest.raises(SystemExit) as exc:
        pc.run([INC, "--dump", str(d)])
    assert exc.value.code == pc.EXIT_ERROR
    report, _ = pc.run([INC, "--dump", str(d), "--since", "2026-09-23T17:00Z", "--until", "2026-09-23T18:00Z"])
    assert report.findings == 0


@pytest.mark.parametrize(
    ("content", "complaint"),
    [
        ("null", "not a JSON array of rows (it holds NoneType)"),
        ('{"rows": []}', "not a JSON array of rows (it holds dict)"),
        ("[1, 2]", "not a JSON array of rows (it holds an array with non-object entries)"),
    ],
)
def test_a_dump_table_that_is_not_an_array_is_refused(tmp_path: Path, capsys, content: str, complaint: str):
    """An empty-looking table is not an empty table — it would read as «OK»."""
    d = write_dump(tmp_path / "dump")
    (d / "journal_entries.json").write_text(content)
    with pytest.raises(SystemExit) as exc:
        pc.run([INC, "--dump", str(d)])
    assert exc.value.code == pc.EXIT_ERROR
    assert complaint in capsys.readouterr().err


def test_a_dump_of_several_incidents_needs_a_name(tmp_path: Path):
    d = write_dump(tmp_path / "dump")
    (d / "incident.json").unlink()
    rows = json.loads((d / "journal_entries.json").read_text())
    rows.append({**rows[0], "incident_id": str(uuid.uuid4())})
    (d / "journal_entries.json").write_text(json.dumps(rows))
    with pytest.raises(SystemExit) as exc:
        pc.run(["latest", "--dump", str(d)])
    assert exc.value.code == pc.EXIT_ERROR
    with pytest.raises(SystemExit) as exc:
        pc.run([INC[:4], "--dump", str(d)])  # too short to be a prefix, dump or not
    assert exc.value.code == pc.EXIT_ERROR


def test_a_log_with_nothing_in_the_window_is_an_error(tmp_path: Path, capsys):
    lines = [http_line(datetime(2020, 1, 1, tzinfo=UTC), "GET", f"/api/incidents/{INC}/workspace", 200, IPAD)]
    with pytest.raises(SystemExit) as exc:
        pc.run(
            [INC, "--dump", str(write_dump(tmp_path / "dump")), "--http", str(write_http(tmp_path / "h.jsonl", lines))]
        )
    assert exc.value.code == pc.EXIT_ERROR
    assert "none of its 1 lines falls in the window" in capsys.readouterr().err


def test_a_crash_of_the_check_exits_2_not_1(monkeypatch, capsys):
    def boom(argv):
        raise RuntimeError("something the check did not expect")

    monkeypatch.setattr(pc, "run", boom)
    monkeypatch.setattr(sys, "argv", ["admin_postcheck", "latest"])
    with pytest.raises(SystemExit) as exc:
        pc.main()
    assert exc.value.code == pc.EXIT_ERROR
    assert "ERROR: the check could not run: RuntimeError" in capsys.readouterr().err


# ── device attribution ───────────────────────────────────────────────────────────────────


def test_two_devices_writing_back_to_back_keep_their_own_rows():
    """The logged time is the response, after the row. The first device's answer lands 10 ms
    BEFORE the second device's row is stored — «nearest either way» handed it to the first."""
    base = f"/api/incidents/{INC}/journal"
    first_row, second_row = at(70), at(70) + timedelta(milliseconds=29)
    http = [
        pc.HttpLine(first_row + timedelta(milliseconds=19), "POST", base, 201, IPAD, "192.0.2.1", duration_ms=21),
        pc.HttpLine(second_row + timedelta(milliseconds=18), "POST", base, 201, ANDROID, "192.0.2.2", duration_ms=21),
    ]
    book = pc.DeviceBook(http, INC)
    book.assign("journal", [first_row, second_row, at(80)])
    assert book.writer("journal", first_row).label == D_IPAD
    assert book.writer("journal", second_row).label == D_ANDROID
    assert not book.writer("journal", at(80)).known, "no request stored this row"


def test_overlapping_writes_on_the_row_lock_are_matched_exclusively():
    """Two devices' appends queue on the incident row lock: rows stamped .603887 and .606624
    (their transactions' START), answers at .615 (90 ms, device A) and .618 (20 ms, device B).
    Both requests cover both rows. «First answer covering t» gave both rows to A and B vanished
    from the duplicate; exclusively, each keeps one — and which is whose is honestly unknown."""
    base = f"/api/incidents/{INC}/events"
    t = datetime(2026, 9, 23, 18, 36, 16, tzinfo=UTC)
    rows = [t.replace(microsecond=603887), t.replace(microsecond=606624)]
    http = [
        pc.HttpLine(t - timedelta(seconds=5), "GET", f"/api/incidents/{INC}", 200, ANDROID, "192.0.2.1"),
        pc.HttpLine(t - timedelta(seconds=4), "GET", f"/api/incidents/{INC}", 200, IPAD, "192.0.2.2"),
        pc.HttpLine(t.replace(microsecond=615065), "POST", base, 201, ANDROID, "192.0.2.1", duration_ms=90),
        pc.HttpLine(t.replace(microsecond=618125), "POST", base, 201, IPAD, "192.0.2.2", duration_ms=20),
    ]
    book = pc.DeviceBook(http, INC)
    book.assign("events", rows)
    atts = [book.writer("events", r) for r in rows]
    assert {a.device.label for a in atts if a.device} == {"Android Chrome 130 phone", "iPad/Mac Safari 18.0"}
    assert [a.label for a in atts] == ["D1|D2?", "D1|D2?"]


# ── the command, as an operator runs it ──────────────────────────────────────────────────


def _cli(*args: str, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in {"ENVIRONMENT", "APP_ENV"}} | (env_extra or {})
    # S603: the argv is this file's literals plus tmp paths; the exit code of a real process is the subject
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", "app.admin_postcheck", *args],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_the_exit_code_is_the_contract_a_cron_job_reads(full, tmp_path: Path):
    r = _cli(*full, "--json")
    assert r.returncode == 1, r.stderr
    assert json.loads(r.stdout)["findings"] == 11  # nothing but the JSON on stdout
    clean = _cli(INC, "--dump", str(write_dump(tmp_path / "clean", clean=True)))
    assert clean.returncode == 0, clean.stderr
    assert "OK: no findings." in clean.stdout.splitlines()[-1]
    broken = _cli(INC, "--dump", str(tmp_path / "missing"))
    assert broken.returncode == 2, "an error is not a finding"
    assert "is not a directory" in broken.stderr


def test_an_unreachable_database_exits_2(tmp_path: Path):
    """A crash of the check (here: the connection refused) must not read as «findings»."""
    r = _cli("latest", env_extra={"DATABASE_URL": "postgresql://kp:kp@127.0.0.1:1/kp"})
    assert r.returncode == 2, (r.returncode, r.stderr[-500:])
    assert "ERROR: the check could not run" in r.stderr
    assert "Traceback" not in r.stderr


# ── the database path ────────────────────────────────────────────────────────────────────


async def _seed(db_session) -> None:
    from app.models import DeploymentConfig, Incident, IncidentEvent, JournalEntry, User, VehicleSample

    db_session.add(User(id=uuid.UUID(EDITOR), username="fu", pin_hash="x", role="editor", display_name="FU"))
    db_session.add(User(id=uuid.UUID(EL), username="el", pin_hash="x", role="el", display_name="EL"))
    db_session.add(DeploymentConfig(id=1, config_json=CONFIG))
    inc = incident_row()
    db_session.add(
        Incident(
            id=uuid.UUID(INC),
            title=inc["title"],
            status=inc["status"],
            source="divera",
            is_exercise=True,
            started_at=inc["started_at"],
            lat=inc["lat"],
            lng=inc["lng"],
            map_workspace_json=workspace(),
        )
    )
    await db_session.flush()
    for r in journal_rows():
        db_session.add(JournalEntry(incident_id=uuid.UUID(INC), **r))
    for e in event_rows():
        db_session.add(
            IncidentEvent(
                id=uuid.UUID(e["id"]),
                incident_id=uuid.UUID(INC),
                client_id=e["client_id"],
                seq=e["seq"],
                source=e["source"],
                user_id=uuid.UUID(e["user_id"]) if e["user_id"] else None,
                op_type=e["op_type"],
                payload_json=e["payload_json"],
                occurred_at=e["occurred_at"],
                recorded_at=e["recorded_at"],
                hash=f"h{e['seq']}",
            )
        )
    for s in sample_rows():
        db_session.add(VehicleSample(incident_id=uuid.UUID(INC), **s))
    await db_session.commit()


async def test_the_database_reads_what_the_dump_reads(engine, db_session, tmp_path: Path):
    await _seed(db_session)
    from_db = await pc.load_db(engine, "latest")
    from_dump = pc.load_dump(write_dump(tmp_path / "dump"), INC)
    assert from_db.incident.id == INC
    assert from_db.incident.lat == pytest.approx(CENTER[0])
    assert from_db.users[EDITOR] == ("fu", "editor")
    assert from_db.fleet == from_dump.fleet == {"lf1": "LF 1"}
    opts = pc.Options()
    since, until = pc.default_window(from_db)
    assert since is not None and until is not None
    for evidence in (from_db, from_dump):
        evidence.origin = "same"
    a = pc.build_report(from_db, http=None, crashes=None, since=since, until=until, opts=opts).as_json()
    b = pc.build_report(from_dump, http=None, crashes=None, since=since, until=until, opts=opts).as_json()
    # the dump keeps roles only, so the account is named by id there and by username here
    for doc in (a, b):
        doc["sections"].pop("devices")
    assert a == b
    assert a["findings"] == 6  # clock 1, duplicates 2, vehicles 3 — the log sections are skipped
    # an id prefix finds it as well
    assert (await pc.load_db(engine, INC[:8])).incident.id == INC


async def test_the_connection_cannot_write(engine, db_session):
    await _seed(db_session)
    async with pc.readonly_connection(engine) as conn:
        with pytest.raises(DBAPIError):
            await conn.execute(text("DELETE FROM journal_entries"))
    # …and the connection handed back (SQLite shares one) is writable again for everyone else
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM vehicle_samples"))


async def test_an_unknown_incident_is_an_error_not_a_finding(engine, db_session):
    await _seed(db_session)
    with pytest.raises(SystemExit) as exc:
        await pc.load_db(engine, "ffffffff")
    assert exc.value.code == pc.EXIT_ERROR
    with pytest.raises(SystemExit):
        await pc.load_db(engine, "1111")  # too short to be a prefix


def test_an_expired_session_before_opening_the_incident_is_still_a_finding():
    """A plain login to join is not a finding — but a refresh that FAILS first means the station
    device's session had expired, and the PIN was asked at the scene before it could start."""
    base = f"/api/incidents/{INC}/workspace"
    http = [
        pc.HttpLine(at(1), "GET", "/api/auth/me", 401, IPAD, "192.0.2.1"),
        pc.HttpLine(at(1) + timedelta(seconds=1), "POST", "/api/auth/refresh", 401, IPAD, "192.0.2.1"),
        pc.HttpLine(at(1) + timedelta(seconds=9), "POST", "/api/auth/login", 200, IPAD, "192.0.2.1"),
        pc.HttpLine(at(1) + timedelta(seconds=20), "GET", base, 200, IPAD, "192.0.2.1"),
    ]
    sec = pc.section_auth(pc.DeviceBook(http, INC))
    assert len(sec.findings) == 1
    assert "session had expired (refresh 401 ×1) — PIN needed before the device could open the incident" in sec.lines[0]


# ── the two presence models: the client's (vp-) and the server's (vps-) ───────────────────


def _trip_samples() -> list[pc.Sample]:
    """away → on scene at +5 → a trip away at +30 → back at +40 → gone at +60, seen until +90."""
    return [
        _fix(3, 0, 900),
        _fix(3, 5, 20),
        _fix(3, 10, 15),
        _fix(3, 30, 600),
        _fix(3, 35, 650),
        _fix(3, 40, 20),
        _fix(3, 45, 15),
        _fix(3, 60, 700),
        _fix(3, 90, 800),
    ]


def _server_block(fahrten: int, *, owns: bool = True, vor_ort: datetime | None = None) -> dict:
    gps: dict = {"zone": "away", "fahrten": fahrten, "an": iso(at(5)), "ab": iso(at(60)), "device": 3}
    if owns:
        gps["owns"] = ["vorOrt"]
    return {"reportMeta": {"fahrzeuge": [{"id": "lf1", "vorOrt": z(vor_ort or at(5)), "gps": gps}]}}


def _model_ev(rows, samples, workspace=None, closed=None) -> pc.Evidence:
    return pc.Evidence(
        incident=pc.IncidentInfo(INC, lat=CENTER[0], lng=CENTER[1], closed_at=closed),
        journal=rows,
        events=[],
        samples=samples,
        workspace=workspace,
    )


def test_the_client_model_is_recognised_by_its_rows(full):
    sec = section(report_of(full), "vehicles")
    assert sec.data["model"] == "client"
    assert any("the CLIENT's" in line for line in sec.lines)


def test_a_server_observed_incident_is_judged_by_the_servers_rules():
    """The server stamps the FIRST fix in the zone and writes only the first arrival and the
    last departure — the trip in between is counted in gps.fahrten, not written. Held to the
    client's rules this incident would show a missing row per trip and a 20-minute-late
    departure; held to its own, it is clean."""
    rows = [
        _jr("vps-1-scene-gps-3", at(6.5), at(5), "LF 1 vor Ort", "gps-3"),
        # written 20 min after the vehicle left, stamped with the departure itself
        _jr("vps-4-away-gps-3", at(80), at(60), "LF 1 hat den Einsatzort verlassen", "gps-3"),
    ]
    sec = pc.section_vehicles(_model_ev(rows, _trip_samples(), _server_block(2)), None, pc.Options())
    assert sec.data["model"] == "server"
    assert sec.findings == []
    assert any("(server) stamped 17:05:00 = GPS 17:05:00 (+0 s)" in line for line in sec.lines)
    assert any("gps.fahrten 2, the samples show 2 stays on scene" in line for line in sec.lines)


def test_what_the_server_model_does_find():
    rows = [
        # stamped 90 s after the fix — the client's habit, not the server's
        _jr("vps-1-scene-gps-3", at(7), at(6.5), "LF 1 vor Ort", "gps-3"),
        # a row for the trip in between: the server never writes one
        _jr("vps-2-away-gps-3", at(31), at(30), "LF 1 hat den Einsatzort verlassen", "gps-3"),
    ]
    ev = _model_ev(rows, _trip_samples(), _server_block(3), closed=at(95))
    sec = pc.section_vehicles(ev, None, pc.Options())
    assert sorted(sec.findings) == sorted(
        [
            "LF 1: server row «scene» at 17:06:30 without a GPS change",
            "LF 1: no row for the first arrival at 17:05:00",
            "LF 1: server row for an in-between trip at 17:30:00",
            "LF 1: no row for the last departure at 18:00:00",  # the incident closed: owed at close
            "LF 1: gps.fahrten 3 ≠ 2",
        ]
    )


def test_a_server_departure_not_yet_due_and_a_geofence_arrival_are_not_findings():
    samples = [s for s in _trip_samples() if s.ts <= at(70)]  # observed only 10 min past the departure
    # the alarm gateway's geofence wrote «vor Ort» first (not in gps.owns): no server arrival row
    ev = _model_ev([], samples, _server_block(2, owns=False))
    sec = pc.section_vehicles(ev, None, pc.Options())
    assert sec.data["model"] == "server", "a gps block alone says the server observed"
    assert sec.findings == []
    assert any("geofence wrote «vor Ort» first — by design" in line for line in sec.lines)
    assert any("its row is due at 18:20:00 (20 min away) or at close — not yet" in line for line in sec.lines)


def test_an_incident_spanning_the_deploy_judges_each_row_by_its_own_model():
    """Before the deploy a device wrote «vor Ort» 90 s after the GPS (vp-); after it the server
    wrote the same arrival again at the GPS time (vps-), and the departure. Both arrival rows
    are right by their own model — and neither side's missing rows can be judged."""
    samples = [_fix(3, 0, 900), _fix(3, 5, 20), _fix(3, 10, 15), _fix(3, 30, 600), _fix(3, 35, 650)]
    rows = [
        _jr("vp-1-scene-gps-3", at(6.5), at(6.5), "LF 1 vor Ort", "gps-3"),
        _jr("vps-1-scene-gps-3", at(12), at(5), "LF 1 vor Ort", "gps-3"),
        _jr("vps-2-away-gps-3", at(50), at(30), "LF 1 hat den Einsatzort verlassen", "gps-3"),
    ]
    sec = pc.section_vehicles(_model_ev(rows, samples), None, pc.Options())
    assert sec.data["model"] == "mixed"
    assert any("BOTH — this incident spans the deploy" in line for line in sec.lines)
    assert sec.findings == []
    # in stated-time order: the server stamps the arrival 90 s before the device wrote it
    assert [r["model"] for r in sec.data["vehicles"][0]["rows"]] == ["server", "client", "server"]
    assert sec.data["vehicles"][0]["rows"][1]["lagSeconds"] == 90


def test_no_row_and_no_gps_block_says_the_model_is_unknown():
    sec = pc.section_vehicles(_model_ev([], _trip_samples()), None, pc.Options())
    assert sec.data["model"] == "unknown"
    assert sec.findings == [], "without a row or a gps block nothing says which rows were owed"
