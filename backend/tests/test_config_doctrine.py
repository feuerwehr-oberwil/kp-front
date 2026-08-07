"""Two config values that LOOKED like station settings and were not.

Both were found by an audit of the in-app help: the copy stated them as facts a station could
change, and in each case the shipped path made that false.
"""

from app.admin_config import EXAMPLE_CONFIG
from app.schemas import DeploymentConfigIn


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


def test_modul6_ships_as_a_viewer():
    """Modul 6 is a reference PDF you scroll; building annotation lives on the Gebäude
    floor-stack. The frontend fallback and the in-app help have both said so all along — this
    template did not, so a station seeded from it got a drawable Modul 6."""
    modul6 = next(m for m in EXAMPLE_CONFIG["modules"] if m["id"] == "modul6")
    assert modul6.get("viewer") is True
