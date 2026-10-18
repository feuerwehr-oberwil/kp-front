"""`identity.shortName` — the label on the Karte's menu button (review round 5, owner: «a new
short name like "fwo" that others can configure», instead of the word «Einsätze»).

The button shares the phone's 44 px bar with the search button, so the label has a cap. A value
over it is refused on the way in (German, with the rule in the message) and cut on the way out
of a stored row — never a refusal there, which would serve an empty config.
"""

import pytest
from pydantic import ValidationError

from app.schemas import SHORT_NAME_MAX, DeploymentConfigIn, IdentityConfig, load_stored_config


@pytest.mark.parametrize(
    "value,stored",
    [
        ("FWO", "FWO"),
        ("  FWO  ", "FWO"),
        ("FW  Ow", "FW Ow"),  # inner runs of space collapse: the button has one line
        ("12345678", "12345678"),  # exactly the cap
        ("", None),  # a cleared field is «unset» → the menu symbol
        ("   ", None),
        (None, None),
    ],
)
def test_a_short_name_is_trimmed_and_kept(value, stored):
    assert IdentityConfig(shortName=value).shortName == stored


@pytest.mark.parametrize("value", ["123456789", "Feuerwehr Oberwil", 42])
def test_a_long_or_odd_short_name_is_refused(value):
    with pytest.raises(ValidationError) as e:
        IdentityConfig(shortName=value)
    assert "Kurzname" in str(e.value)
    assert str(SHORT_NAME_MAX) in str(e.value)


def test_a_stored_long_short_name_is_cut_not_the_document():
    raw = {
        "identity": {"appName": "Feuerwehr Steintal", "shortName": "Steintal Nord"},
        "fleet": {"vehicles": [{"id": "tlf-31", "label": "TLF 31"}]},
    }
    doc = load_stored_config(raw)
    assert doc.identity.shortName == "Steintal"
    assert doc.identity.appName == "Feuerwehr Steintal"
    assert [v.label for v in doc.fleet.vehicles] == ["TLF 31"]
    with pytest.raises(ValidationError):
        DeploymentConfigIn.model_validate(raw)


async def test_the_api_stores_and_serves_the_short_name(client, admin_login, put_config):
    await admin_login(client)
    bad = await put_config(client, {"identity": {"shortName": "Feuerwehr Oberwil"}})
    assert bad.status_code == 422, bad.text
    # the path the Verwaltung turns into «Kurzname (Station & Karte)» (ConfigContext · rejectedFieldLabel)
    assert ["body", "identity", "shortName"] in [d["loc"] for d in bad.json()["detail"]]

    ok = await put_config(client, {"identity": {"appName": "Feuerwehr Oberwil", "shortName": " FWO "}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["identity"]["shortName"] == "FWO"
    r = await client.get("/api/config")
    assert r.json()["identity"]["shortName"] == "FWO"
