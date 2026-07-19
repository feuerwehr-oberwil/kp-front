# Fake-Szenarien

Test scenarios for `python -m app.fake_scenario` — fake Divera alarms, group/vehicle
milestone times (offsets relative to run time, e.g. `"-25m"`), and Traccar positions for
the Fahrzeuge layer. They exercise the real webhook endpoints of a running deployment;
taking the alarm, Anwesenheit, Mittel and Journal stay manual in the app.

```bash
cd backend
uv run python -m app.fake_scenario config                                 # target's group/vehicle ids
uv run python -m app.fake_scenario run ../examples/scenarios/zimmerbrand.json
```

Requirements on the target: `DIVERA_WEBHOOK_SECRET` (alarms), `ALARM_WEBHOOK_SECRET`
(milestone times), `TRACCAR_FAKE=1` (vehicle positions; skipped with a warning otherwise).
The group/vehicle ids here (`rot`/`gruen`, `tlf`/`adl`/`mtf`) are placeholders — check
them against your deployment with the `config` subcommand and adjust a copy; a station's
real scenarios belong in its private data repo, not here.
