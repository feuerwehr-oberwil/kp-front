"""A stored value past a length limit costs its entry, not the document.

`GET /api/config` reads through `deployment_config.safe_config`. Until 26.11.2026 one over-long
field there served the WHOLE document as the shipped defaults: every device lost the station's
name and settings, and the admin form – which PUTs the whole document back – was one «Trotzdem
leeren» away from storing those defaults.
"""

import copy

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig

DEST = {"id": "ablage", "siteUrl": "https://fw.sharepoint.com/sites/objekte"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("section", "part", "bad", "served"),
    [
        # the entry that holds the value goes: the proposal field, the link, the destination…
        ("objectVisits", "proposalFields", {"id": "kontakt", "label": "x" * 121}, ["zufahrt"]),
        ("report", "links", {"id": "lang", "title": "Lang", "url": "https://x.ch/" + "a" * 2048}, ["zufahrt"]),
        ("objectVisits", "destinations", {**DEST, "id": "lang", "visitFolder": "v" * 201}, ["zufahrt"]),
        # …and the WHOLE colour rule, never only its filter: without one it would match everything
        (
            "map",
            "objectCategories",
            {"id": "lang", "label": "L", "color": "#ff0000", "match": {"modules": ["m" * 61]}},
            ["zufahrt"],
        ),
    ],
    ids=["proposal-label", "report-link-url", "destination-folder", "category-module"],
)
async def test_one_over_long_field_costs_its_entry_and_nothing_else(
    client, admin_login, db_session, session_factory, section, part, bad, served
):
    good = {
        "proposalFields": {"id": "zufahrt", "label": "Zufahrt"},
        "links": {"id": "zufahrt", "title": "Zufahrt", "url": "https://x.ch/z"},
        "destinations": {**DEST, "id": "zufahrt"},
        "objectCategories": {"id": "zufahrt", "label": "Z", "color": "#00ff00"},
    }[part]
    stored = {
        "identity": {"appName": "Feuerwehr Talheim"},
        "report": {"partnerOrgs": ["Polizei BL"]},
        "objectVisits": {"enabled": True, "lockAfterHours": 48},
    }
    stored.setdefault(section, {})[part] = [bad, good]
    await admin_login(client)
    db_session.add(DeploymentConfig(id=1, config_json=copy.deepcopy(stored)))
    await db_session.commit()

    r = await client.get("/api/config")
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["identity"]["appName"] == "Feuerwehr Talheim"
    assert got["report"]["partnerOrgs"] == ["Polizei BL"]
    assert (got["objectVisits"]["enabled"], got["objectVisits"]["lockAfterHours"]) == (True, 48)
    assert [e["id"] for e in got[section][part]] == served
    async with session_factory() as db:
        assert await db.scalar(select(DeploymentConfig.config_json)) == stored  # a read changes nothing


def test_two_over_long_entries_both_go_and_a_list_past_its_cap_reads_as_the_defaults():
    """Two entries of one list in one round (indices from the back), and the one length that is
    not repaired: a cut tail could hide a duplicate id."""
    from app.deployment_config import safe_config

    links = [{"id": f"l{i}", "title": "T", "url": f"https://x.ch/{i}"} for i in range(4)]
    links[1]["title"] = "x" * 121
    links[3]["note"] = "x" * 201
    served = safe_config({"identity": {"appName": "Talheim"}, "report": {"links": links}})
    assert (served.identity.appName, [link.id for link in served.report.links]) == ("Talheim", ["l0", "l2"])

    over_cap = [{"id": f"l{i}", "title": "T", "url": f"https://x.ch/{i}"} for i in range(31)]
    served = safe_config({"identity": {"appName": "Talheim"}, "report": {"links": over_cap}})
    assert (served.identity.appName, served.report.links) == (None, [])


def test_a_fault_hidden_behind_the_length_reads_as_the_defaults():
    """Pydantic skips the section's unique-id check while a field inside it fails. Leaving out the
    over-long destination would serve the OTHER one under the same id – at another site, where
    the queued visits for that id would then be filed."""
    from app.deployment_config import safe_config

    same_id = [
        {**DEST, "visitFolder": "v" * 201},
        {**DEST, "siteUrl": "https://fw.sharepoint.com/sites/andere"},
    ]
    served = safe_config(
        {"identity": {"appName": "Talheim"}, "objectVisits": {"enabled": True, "destinations": same_id}}
    )
    assert served.identity.appName is None
    assert served.objectVisits.destinations == []
