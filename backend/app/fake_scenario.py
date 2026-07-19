"""Fake-scenario CLI — inject realistic test alarms into a running deployment.

Testing the full app (pool banner, take flow, multiple concurrent incidents, the
Alarmierungs-/Ausrückzeiten grid, the Fahrzeuge layer, the Einsatzrapport) needs
realistic external inputs. This command replays what the outside world normally sends —
Divera alarms, milestone times, Traccar positions — through the SAME public endpoints
production uses, backdated so everything looks like a real Einsatz that started minutes
ago. What the operator does by hand (taking the alarm, Anwesenheit, Mittel, Journal)
deliberately stays manual: exercising those flows is part of the test.

Run from ``backend/`` against a local dev server or the demo instance:

    uv run python -m app.fake_scenario example                      # print a starter scenario
    uv run python -m app.fake_scenario validate <scenario.json>
    uv run python -m app.fake_scenario config                       # target's group/vehicle ids
    uv run python -m app.fake_scenario run <scenario.json>

Sample scenarios live in ``examples/scenarios/``. ``run`` does three things:
  1. POST /api/divera/webhook per alarm (needs DIVERA_WEBHOOK_SECRET) — the alarm lands in
     the pool exactly like a real dispatch (or auto-opens, if the deployment enables it).
  2. POST /api/traccar/fake with the scenario's vehicle positions (needs TRACCAR_FAKE=1
     server-side + ALARM_WEBHOOK_SECRET) so the Fahrzeuge layer shows the fleet.
  3. Retries POST /api/alarms/milestones until you take each alarm in the app — the
     endpoint 404s while no incident matches, the same retry contract fwo-divera uses —
     then the group/vehicle times appear in the rapport as if the pipeline sent them.

Secrets and the base URL default to the local ``.env`` (app settings) / KP_BASE_URL;
override with flags when targeting a remote instance. Each run mints fresh ``divera_id``s,
so re-running a scenario creates new alarms instead of colliding with taken ones.

Time offsets: every time field is an offset relative to "now" at run time — ``"-25m"``,
``"-1h5m"``, ``"-90s"``, ``"0"`` — so a scenario always reads as a just-happened Einsatz.
Group/vehicle ids should match the deployment's ``alarms.groups[].id`` /
``fleet.vehicles[].id`` (unknown ids still land, rendered verbatim without a label);
``config`` prints the target's ids and ``run`` warns about mismatches.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError, model_validator

from .config import settings

DEFAULT_BASE = "http://localhost:8001"  # local dev backend (:8000 is often kp-rueck)

# --- time offsets -----------------------------------------------------------------------

_OFFSET_RE = re.compile(r"^([+-]?)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$")


def parse_offset(text: str) -> timedelta:
    """``"-25m"`` / ``"-1h5m"`` / ``"+30s"`` / ``"0"`` → timedelta (``"0"`` = now)."""
    t = text.strip()
    if t == "0":
        return timedelta(0)
    m = _OFFSET_RE.match(t)
    if not m or not (m.group(2) or m.group(3) or m.group(4)):
        raise ValueError(f"invalid time offset {text!r} (expected e.g. '-25m', '-1h5m', '-90s', '0')")
    sign = -1 if m.group(1) == "-" else 1
    h, mi, s = (int(g or 0) for g in m.group(2, 3, 4))
    return sign * timedelta(hours=h, minutes=mi, seconds=s)


# --- scenario schema --------------------------------------------------------------------


class ScenarioGroup(BaseModel):
    """One alarmed group: `id` matches `alarms.groups[].id`, `alarmedAt` is an offset."""

    model_config = ConfigDict(extra="forbid")
    id: str
    alarmedAt: str

    @model_validator(mode="after")
    def _offsets(self) -> "ScenarioGroup":
        parse_offset(self.alarmedAt)
        return self


class ScenarioVehicleTimes(BaseModel):
    """Per-vehicle milestones: `id` matches `fleet.vehicles[].id`; all times are offsets."""

    model_config = ConfigDict(extra="forbid")
    id: str
    ausgerueckt: str | None = None
    vorOrt: str | None = None
    zurueck: str | None = None

    @model_validator(mode="after")
    def _offsets(self) -> "ScenarioVehicleTimes":
        for v in (self.ausgerueckt, self.vorOrt, self.zurueck):
            if v is not None:
                parse_offset(v)
        return self


class ScenarioAlarm(BaseModel):
    """One fake Divera alarm; `t` is the alarm-time offset, groups/vehicles its milestones."""

    model_config = ConfigDict(extra="forbid")
    title: str
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    number: str | None = None
    t: str = "0"
    groups: list[ScenarioGroup] = []
    vehicles: list[ScenarioVehicleTimes] = []

    @model_validator(mode="after")
    def _offsets(self) -> "ScenarioAlarm":
        parse_offset(self.t)
        return self


class ScenarioPosition(BaseModel):
    """A fake GPS position for the Fahrzeuge layer (name should match a fleet vehicle)."""

    model_config = ConfigDict(extra="forbid")
    name: str
    lat: float
    lng: float
    status: str = "online"
    speed: float | None = None  # km/h
    course: float | None = None
    address: str | None = None


class Scenario(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    alarms: list[ScenarioAlarm] = []
    positions: list[ScenarioPosition] = []

    @model_validator(mode="after")
    def _not_empty(self) -> "Scenario":
        if not self.alarms and not self.positions:
            raise ValueError("scenario has neither alarms nor positions")
        return self


EXAMPLE_SCENARIO: dict[str, Any] = {
    "name": "Zimmerbrand Schlossgasse",
    "alarms": [
        {
            "title": "BRAND: Zimmerbrand",
            "text": "Gemeldeter Zimmerbrand im Obergeschoss, Rauch sichtbar. Personen möglicherweise im Gebäude.",
            "address": "Schlossgasse 9, 4104 Musterdorf",
            "lat": 47.52382,
            "lng": 7.57037,
            "t": "-25m",
            "groups": [
                {"id": "rot", "alarmedAt": "-25m"},
                {"id": "gruen", "alarmedAt": "-22m"},
            ],
            "vehicles": [
                {"id": "tlf", "ausgerueckt": "-21m", "vorOrt": "-17m"},
                {"id": "adl", "ausgerueckt": "-19m", "vorOrt": "-15m"},
            ],
        }
    ],
    "positions": [
        {"name": "TLF", "lat": 47.5239, "lng": 7.5706, "status": "online"},
        {"name": "ADL", "lat": 47.5237, "lng": 7.5701, "status": "online"},
        {"name": "MTF", "lat": 47.521, "lng": 7.5665, "speed": 38, "course": 65, "status": "online"},
    ],
}


# --- payload builders (pure, unit-tested) -----------------------------------------------


def webhook_payload(alarm: ScenarioAlarm, divera_id: int, now: datetime) -> dict[str, Any]:
    """A `DiveraWebhookPayload` dict with the alarm time resolved to a unix timestamp."""
    ts = int((now + parse_offset(alarm.t)).timestamp())
    return {
        "id": divera_id,
        "number": alarm.number,
        "title": alarm.title,
        "text": alarm.text,
        "address": alarm.address,
        "lat": alarm.lat,
        "lng": alarm.lng,
        "ts_create": ts,
        "ts_update": ts,
    }


def milestones_payload(alarm: ScenarioAlarm, divera_id: int, now: datetime) -> dict[str, Any]:
    """A `MilestonesIn` dict with every offset resolved to an absolute ISO datetime.

    Resolved against the RUN-start `now`, not delivery time, so the backdating stays as
    authored even when the operator takes the alarm minutes later."""

    def iso(offset: str) -> str:
        return (now + parse_offset(offset)).isoformat()

    return {
        "divera_id": divera_id,
        "groups": [{"id": g.id, "alarmedAt": iso(g.alarmedAt)} for g in alarm.groups],
        "vehicles": [
            {
                "id": v.id,
                **{f: iso(val) for f, val in (("ausgerueckt", v.ausgerueckt), ("vorOrt", v.vorOrt), ("zurueck", v.zurueck)) if val is not None},
            }
            for v in alarm.vehicles
        ],
    }


# --- CLI --------------------------------------------------------------------------------


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def _read_scenario(path: Path) -> Scenario:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        _fail(f"ERROR: cannot read {path}: {e}")
    except json.JSONDecodeError as e:
        _fail(f"ERROR: {path} is not valid JSON: {e}")
    try:
        return Scenario(**data)
    except ValidationError as e:
        lines = [f"ERROR: {path} failed validation ({e.error_count()} issue(s)):"]
        for err in e.errors():
            field = ".".join(str(p) for p in err["loc"]) or "(root)"
            lines.append(f"  {field}: {err['msg']} [{err['type']}]")
        _fail("\n".join(lines))


def _fetch_config_ids(client) -> tuple[set[str], set[str]] | None:
    """(group ids, vehicle ids) from the target's deployment config, or None if unreadable."""
    try:
        r = client.get("/api/config")
        if r.status_code != 200:
            return None
        cfg = r.json()
        groups = {g.get("id") for g in (cfg.get("alarms") or {}).get("groups", []) if isinstance(g, dict)}
        vehicles = {v.get("id") for v in (cfg.get("fleet") or {}).get("vehicles", []) if isinstance(v, dict)}
        return groups, vehicles
    except Exception:
        return None


def _warn_unknown_ids(client, scenario: Scenario) -> None:
    ids = _fetch_config_ids(client)
    if ids is None:
        print("  ⚠ GET /api/config nicht lesbar — Gruppen-/Fahrzeug-Ids ungeprüft.")
        return
    groups, vehicles = ids
    for a in scenario.alarms:
        for g in a.groups:
            if g.id not in groups:
                print(f"  ⚠ Gruppe {g.id!r} fehlt in alarms.groups — Zeit erscheint ohne Beschriftung.")
        for v in a.vehicles:
            if v.id not in vehicles:
                print(f"  ⚠ Fahrzeug {v.id!r} fehlt in fleet.vehicles — Zeit erscheint ohne Beschriftung.")


def _run(scenario: Scenario, base: str, divera_secret: str, alarm_secret: str, wait_seconds: int) -> int:
    import httpx  # lazy: only `run`/`config` need the network

    now = datetime.now(UTC)
    with httpx.Client(base_url=base.rstrip("/"), timeout=30.0) as c:
        _warn_unknown_ids(c, scenario)

        # Fresh ids per run (epoch seconds + index) so a re-run never collides with an
        # already-taken pool alarm from the previous run.
        if scenario.alarms and not divera_secret:
            _fail("ERROR: kein Divera-Webhook-Secret (.env DIVERA_WEBHOOK_SECRET oder --divera-secret).")
        base_id = int(now.timestamp())
        pending: list[tuple[int, ScenarioAlarm]] = []
        for i, alarm in enumerate(scenario.alarms):
            divera_id = base_id + i
            r = c.post(
                "/api/divera/webhook",
                params={"secret": divera_secret},
                json=webhook_payload(alarm, divera_id, now),
            )
            if r.status_code != 200:
                _fail(f"ERROR: Webhook für {alarm.title!r} fehlgeschlagen ({r.status_code}): {r.text[:200]}")
            opened = r.json().get("incident_id")
            state = f"auto-geöffnet (Einsatz {opened})" if opened else "im Pool — in der App übernehmen"
            print(f"  ⚡ {alarm.title} (divera_id {divera_id}) → {state}")
            if alarm.groups or alarm.vehicles:
                pending.append((divera_id, alarm))

        if scenario.positions:
            pr = c.post(
                "/api/traccar/fake",
                params={"secret": alarm_secret},
                json=[p.model_dump(exclude_none=True) for p in scenario.positions],
            )
            if pr.status_code == 200:
                print(f"  🚒 {len(scenario.positions)} Fahrzeug-Position(en) injiziert (TRACCAR_FAKE).")
            elif pr.status_code == 403:
                print(f"  ⚠ Fahrzeug-Positionen übersprungen: {pr.json().get('detail', pr.text[:120])}")
            else:
                _fail(f"ERROR: POST /api/traccar/fake fehlgeschlagen ({pr.status_code}): {pr.text[:200]}")

        if pending and not alarm_secret:
            _fail("ERROR: kein Alarm-Webhook-Secret für Milestones (.env ALARM_WEBHOOK_SECRET oder --alarm-secret).")
        if pending:
            print("  … Zeiten folgen, sobald der jeweilige Alarm übernommen ist (Ctrl-C bricht ab).")
        deadline = time.monotonic() + wait_seconds
        while pending:
            still: list[tuple[int, ScenarioAlarm]] = []
            for divera_id, alarm in pending:
                mr = c.post(
                    "/api/alarms/milestones",
                    params={"secret": alarm_secret},
                    json=milestones_payload(alarm, divera_id, now),
                )
                if mr.status_code == 200:
                    print(f"  ⏱ {alarm.title}: {mr.json().get('applied', 0)} Zeit(en) übernommen.")
                elif mr.status_code in (404, 502, 503, 504):
                    # 404 = alarm not taken yet; 5xx = target restarting (mid-deploy) — retry both
                    still.append((divera_id, alarm))
                else:
                    _fail(f"ERROR: Milestones für {alarm.title!r} fehlgeschlagen ({mr.status_code}): {mr.text[:200]}")
            pending = still
            if not pending or time.monotonic() >= deadline:
                break
            time.sleep(3)
        if pending:
            names = ", ".join(a.title for _, a in pending)
            print(f"  ⚠ Nicht übernommen innert Frist — Zeiten fehlen für: {names}")
            return 1
    print("OK.")
    return 0


def _show_config(base: str) -> int:
    import httpx

    with httpx.Client(base_url=base.rstrip("/"), timeout=30.0) as c:
        r = c.get("/api/config")
        if r.status_code != 200:
            _fail(f"ERROR: GET /api/config fehlgeschlagen ({r.status_code}): {r.text[:200]}")
        cfg = r.json()
    groups = (cfg.get("alarms") or {}).get("groups", [])
    vehicles = (cfg.get("fleet") or {}).get("vehicles", [])
    print("alarms.groups:" if groups else "alarms.groups: (leer — Zeiten-Raster ausgeblendet)")
    for g in groups:
        print(f"  {g.get('id')}  ({g.get('label')})")
    print("fleet.vehicles:" if vehicles else "fleet.vehicles: (leer — Fahrzeugzeiten ausgeblendet)")
    for v in vehicles:
        print(f"  {v.get('id')}  ({v.get('label')})")
    return 0


def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.fake_scenario",
        description="Inject fake alarms, milestone times and vehicle positions into a running deployment.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("example", help="print a starter scenario (no network)")
    p_val = sub.add_parser("validate", help="validate a scenario file (no network)")
    p_val.add_argument("scenario")
    base_help = f"deployment base URL (env KP_BASE_URL, default {DEFAULT_BASE})"
    p_cfg = sub.add_parser("config", help="print the target's alarm-group and fleet-vehicle ids")
    p_cfg.add_argument("--base", default=None, help=base_help)
    p_run = sub.add_parser("run", help="inject the scenario into the target deployment")
    p_run.add_argument("scenario")
    p_run.add_argument("--base", default=None, help=base_help)
    p_run.add_argument("--divera-secret", default=None, help="Divera webhook secret (default: local .env)")
    p_run.add_argument("--alarm-secret", default=None, help="alarm/milestone webhook secret (default: local .env)")
    p_run.add_argument(
        "--wait", type=int, default=600, metavar="SECONDS",
        help="how long to keep retrying milestones while alarms await their take (default 600, 0 = one attempt)",
    )

    args = parser.parse_args(argv)
    base = getattr(args, "base", None) or os.environ.get("KP_BASE_URL") or DEFAULT_BASE

    if args.cmd == "example":
        print(json.dumps(EXAMPLE_SCENARIO, indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "validate":
        s = _read_scenario(Path(args.scenario))
        print(f"OK: {len(s.alarms)} Alarm(e), {len(s.positions)} Position(en).")
        return 0
    if args.cmd == "config":
        return _show_config(base)
    # run
    s = _read_scenario(Path(args.scenario))
    divera_secret = args.divera_secret or settings.divera_webhook_secret
    alarm_secret = args.alarm_secret or settings.alarm_webhook_secret
    print(f"Szenario {s.name or Path(args.scenario).stem!r} → {base}")
    return _run(s, base, divera_secret, alarm_secret, max(0, args.wait))


def main() -> None:
    sys.exit(_amain(sys.argv[1:]))


if __name__ == "__main__":
    main()
