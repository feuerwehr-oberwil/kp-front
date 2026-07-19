"""Pure logic of the fake-scenario CLI: offset parsing, schema validation, payload building."""

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.fake_scenario import (
    EXAMPLE_SCENARIO,
    Scenario,
    ScenarioAlarm,
    milestones_payload,
    parse_offset,
    webhook_payload,
)

NOW = datetime(2026, 7, 18, 14, 0, tzinfo=UTC)


def test_parse_offset():
    assert parse_offset("0") == timedelta(0)
    assert parse_offset("-25m") == timedelta(minutes=-25)
    assert parse_offset("-1h5m") == timedelta(hours=-1, minutes=-5)
    assert parse_offset("+30s") == timedelta(seconds=30)
    assert parse_offset("-90s") == timedelta(seconds=-90)
    assert parse_offset("2h") == timedelta(hours=2)


@pytest.mark.parametrize("bad", ["", "yesterday", "-25", "5m3h", "--5m", "-1h5"])
def test_parse_offset_rejects_garbage(bad):
    with pytest.raises(ValueError):
        parse_offset(bad)


def test_example_scenario_is_valid():
    s = Scenario(**EXAMPLE_SCENARIO)
    assert s.alarms and s.positions


def test_scenario_rejects_unknown_keys_and_bad_offsets():
    with pytest.raises(ValidationError):
        Scenario(alarms=[{"title": "x", "adress": "typo"}])
    with pytest.raises(ValidationError):
        Scenario(alarms=[{"title": "x", "t": "later"}])
    with pytest.raises(ValidationError):
        Scenario()  # neither alarms nor positions


def test_webhook_payload_resolves_alarm_time():
    alarm = ScenarioAlarm(title="BRAND: Test", address="Weg 1", t="-25m")
    p = webhook_payload(alarm, 1752846000, NOW)
    assert p["id"] == 1752846000
    assert p["title"] == "BRAND: Test"
    ts = int((NOW - timedelta(minutes=25)).timestamp())
    assert p["ts_create"] == ts and p["ts_update"] == ts


def test_milestones_payload_resolves_offsets_and_omits_absent_times():
    alarm = ScenarioAlarm(
        title="x",
        groups=[{"id": "rot", "alarmedAt": "-25m"}],
        vehicles=[{"id": "tlf", "ausgerueckt": "-21m", "vorOrt": "-17m"}],
    )
    p = milestones_payload(alarm, 42, NOW)
    assert p["divera_id"] == 42
    assert p["groups"] == [{"id": "rot", "alarmedAt": (NOW - timedelta(minutes=25)).isoformat()}]
    (veh,) = p["vehicles"]
    assert veh["ausgerueckt"] == (NOW - timedelta(minutes=21)).isoformat()
    assert veh["vorOrt"] == (NOW - timedelta(minutes=17)).isoformat()
    assert "zurueck" not in veh
