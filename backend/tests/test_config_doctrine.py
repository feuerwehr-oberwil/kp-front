"""Station config values whose stored form did not match what the app promised.

The first ones were found by an audit of the in-app help: the copy stated them as facts a station
could change, and in each case the shipped path made that false. The Rückzug-line bounds are the
same class of gap from the other end — the field accepted values the safety logic cannot honour.
"""

import pytest
from pydantic import ValidationError

from app.admin_config import EXAMPLE_CONFIG
from app.schemas import DeploymentConfigIn, load_stored_config


def test_the_air_estimate_numbers_survive_a_save():
    """The Truppkarte says «geschätzt mit 7 L Flasche und 50 L/min», which reads like a station
    setting. It was not one: `extra="ignore"` dropped both fields on the way in, so a Wehr with
    9-litre cylinders got the shipped estimate anyway — and that estimate is what an Überwacher
    plans a relief against."""
    cfg = DeploymentConfigIn.model_validate({"doctrine": {"cylinderLiters": 9, "estConsumptionLPerMin": 65}})
    assert cfg.doctrine.cylinderLiters == 9
    assert cfg.doctrine.estConsumptionLPerMin == 65
    # unset stays unset — the frontend then falls back to the shipped 7 L / 50 L·min⁻¹
    assert DeploymentConfigIn.model_validate({"doctrine": {}}).doctrine.cylinderLiters is None


def test_the_rueckzug_alarm_line_survives_a_save():
    """Killed-app alarms need the same lower line the frontend applies during Rückzug."""
    cfg = DeploymentConfigIn.model_validate({"doctrine": {"alarmBar": 100, "alarmBarRueckzug": 45}})
    assert cfg.doctrine.alarmBarRueckzug == 45
    assert EXAMPLE_CONFIG["doctrine"]["alarmBarRueckzug"] == 50


def test_modul6_ships_as_a_viewer():
    """Modul 6 is a reference PDF you scroll; building annotation lives on the Gebäude
    floor-stack. The frontend fallback and the in-app help have both said so all along — this
    template did not, so a station seeded from it got a drawable Modul 6."""
    modul6 = next(m for m in EXAMPLE_CONFIG["modules"] if m["id"] == "modul6")
    assert modul6.get("viewer") is True


@pytest.mark.parametrize(
    "value",
    [0, -5, 120],
    ids=["cleared-to-zero", "negative", "above-alarmBar"],
)
def test_the_rueckzug_line_cannot_be_cleared_or_inverted(value):
    """The Rückzug line is safety-critical in both directions.

    Zero looks like «switched off» in the Verwaltung and behaves like «never alarm»: push.py only
    sends while `line > 0`, and the frontend's `alarmBarRueckzug ?? alarmBar` keeps the 0 because
    `0 ?? x` is `0` — so a cleared field kills the low-pressure alarm on the server AND on the
    tablet. Above `alarmBar` it inverts the tiers instead — the Trupp already ordered out would
    alarm earlier than one still working, which is the nagging the second line exists to end."""
    with pytest.raises(ValidationError):
        DeploymentConfigIn.model_validate({"doctrine": {"alarmBar": 100, "alarmBarRueckzug": value}})


def test_the_rueckzug_line_may_equal_the_bare_alarm():
    """Equal is the documented way to switch the lower line off (src/lib/atemschutz.ts): the app
    then behaves exactly as it did before the setting existed. It must stay accepted."""
    cfg = DeploymentConfigIn.model_validate({"doctrine": {"alarmBar": 100, "alarmBarRueckzug": 100}})
    assert cfg.doctrine.alarmBarRueckzug == 100


def test_zero_alarmdruck_is_allowed_only_on_the_public_demo():
    with pytest.raises(ValidationError):
        DeploymentConfigIn.model_validate({"doctrine": {"alarmBar": 0}})

    cfg = DeploymentConfigIn.model_validate(
        {"identity": {"demoMode": True}, "doctrine": {"alarmBar": 0, "alarmBarRueckzug": 50}}
    )
    assert cfg.doctrine.alarmBar == 0


def test_a_legacy_station_zero_degrades_to_the_safe_defaults_without_losing_config():
    doc = load_stored_config(
        {
            "identity": {"appName": "Feuerwehr Steintal"},
            "doctrine": {"alarmBar": 0, "alarmBarRueckzug": 75},
            "fleet": {"vehicles": [{"id": "tlf-31", "label": "TLF 31"}]},
        }
    )
    assert doc.identity.appName == "Feuerwehr Steintal"
    assert [vehicle.id for vehicle in doc.fleet.vehicles] == ["tlf-31"]
    assert doc.doctrine.alarmBar is None
    assert doc.doctrine.alarmBarRueckzug is None


@pytest.mark.parametrize("value", [-1, 301])
def test_alarmdruck_stays_within_its_supported_range(value):
    with pytest.raises(ValidationError):
        DeploymentConfigIn.model_validate({"doctrine": {"alarmBar": value}})
