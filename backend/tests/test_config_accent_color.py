"""`identity.accentColor` had no validation anywhere.

A fresh-station setup typed «nicht-eine-farbe» into Akzentfarbe. The PUT answered 200, the
badge said «Gespeichert», and the value went on to the login screen, the splash, the PWA
manifest's `theme_color` and the Rapport letterhead. The map centre one field below has had a
range guard for months; the colour had nothing.

The rule is set by the narrowest consumer: `theme_color` is hex-only (webmanifest · _HEX_COLOR).
The other half of the fix is that a value ALREADY IN THE ROW must not be answered by refusing
the whole document — that fallback serves an EMPTY config, and a station would lose its name,
its fleet and its roster off the login screen over one colour.
"""

import pytest
from pydantic import ValidationError

from app.schemas import DeploymentConfigIn, IdentityConfig, load_stored_config
from app.webmanifest import build_manifest


@pytest.mark.parametrize(
    "value,stored",
    [
        ("#e8392b", "#e8392b"),
        ("#E8392B", "#e8392b"),  # normalised, so what is stored is what the manifest trusts
        ("e8392b", "#e8392b"),  # a value pasted without its «#» is a typo, not a refusal
        ("#abc", "#abc"),  # the short form CSS accepts
        ("#e8392bcc", "#e8392bcc"),  # …and the one with alpha
        ("  #e8392b  ", "#e8392b"),
        ("", None),  # a cleared field is «unset», never the empty string
        (None, None),
    ],
)
def test_a_colour_is_accepted_and_normalised(value, stored):
    assert IdentityConfig(accentColor=value).accentColor == stored


@pytest.mark.parametrize("value", ["nicht-eine-farbe", "red", "rgb(232,57,43)", "#12345", "#", 42])
def test_a_non_colour_is_refused(value):
    with pytest.raises(ValidationError) as e:
        IdentityConfig(accentColor=value)
    # German, and it says what a colour looks like — this message reaches `admin_config load`
    assert "Hex-Farbwert" in str(e.value)


async def test_the_api_refuses_a_non_colour_and_names_the_field(client, admin_login):
    await admin_login(client)
    r = await client.put("/api/config", json={"identity": {"accentColor": "nicht-eine-farbe"}})
    assert r.status_code == 422, r.text
    # the path the Verwaltung turns into «Akzentfarbe (Station & Karte)» (ConfigContext ·
    # rejectedFieldLabel) — without it the browser can only say «invalid»
    assert ["body", "identity", "accentColor"] in [d["loc"] for d in r.json()["detail"]]

    ok = await client.put("/api/config", json={"identity": {"accentColor": "#1D6F5C"}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["identity"]["accentColor"] == "#1d6f5c"


def test_a_colour_already_in_the_row_never_takes_the_document_with_it():
    """The lock-out case. A row written before this rule existed is read with
    `load_stored_config`: the colour is dropped, everything else survives — so GET keeps serving
    the station and the Verwaltung page stays savable instead of 422-ing every later edit."""
    raw = {
        "identity": {"appName": "Feuerwehr Steintal", "accentColor": "nicht-eine-farbe"},
        "fleet": {"vehicles": [{"id": "tlf-31", "label": "TLF 31"}]},
        "roster": {"ranks": [{"key": "kdt", "label": "Kommandant"}]},
    }
    doc = load_stored_config(raw)
    assert doc.identity.accentColor is None
    assert doc.identity.appName == "Feuerwehr Steintal"
    assert [v.label for v in doc.fleet.vehicles] == ["TLF 31"]
    assert [r.key for r in doc.roster.ranks] == ["kdt"]
    # …and the same row read strictly is exactly what would have bricked it
    with pytest.raises(ValidationError):
        DeploymentConfigIn.model_validate(raw)


async def test_a_stored_non_colour_still_serves_the_whole_config(client, admin_login, db_session):
    """End to end: a row that predates the rule is written straight into the DB (as the CLI or
    an older build would have), and GET still answers with the station — not the empty
    last-good fallback."""
    from sqlalchemy import select

    from app.models import DeploymentConfig

    await admin_login(client)
    seed = await client.put("/api/config", json={"identity": {"appName": "Feuerwehr Steintal"}})
    assert seed.status_code == 200, seed.text
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    row.config_json = {**row.config_json, "identity": {"appName": "Feuerwehr Steintal", "accentColor": "grün"}}
    await db_session.commit()

    r = await client.get("/api/config")
    assert r.status_code == 200, r.text
    assert r.json()["identity"]["appName"] == "Feuerwehr Steintal"  # NOT the empty fallback
    assert r.json()["identity"]["accentColor"] is None


def test_the_manifest_and_the_schema_agree_on_what_a_colour_is():
    """These two rules must not drift: the manifest silently keeps the build-time colour for
    anything it cannot parse, so a value the schema let through but the manifest rejects is a
    station whose installed app is a different colour from its login screen — with nothing
    anywhere saying so."""
    base = {"theme_color": "#1b2330"}
    for value in ["#e8392b", "#abc", "#e8392bcc"]:
        accepted = IdentityConfig(accentColor=value).accentColor
        assert build_manifest(base, {"accentColor": accepted})["theme_color"] == accepted
