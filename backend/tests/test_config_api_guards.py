"""What `PUT /api/config` refuses, carries and warns about — and the dry run in front of it.

The refuse-to-empty check, the carried runtime sections and the dropped-key report all existed
in `admin_config`, where a person reads the output at a terminal. Over the API none of them did,
so the writers that matter now — a script, an agent, a curl one-liner — could publish an old
document, empty a station's Dienstgrade and be answered 200. These tests pin the server half:
the guards apply to whoever is writing, and `POST /api/config/validate` answers the same
questions without writing anything.

Optimistic concurrency itself (`If-Match`, the 428 for a blind write) lives in
test_config_branding, beside the incidents that produced it.
"""

import pytest
from sqlalchemy import select

from app.models import DeploymentConfig

pytestmark = pytest.mark.asyncio

#: A station document with three sections somebody had to sit down and fill in.
STATION = {
    "identity": {"appName": "Feuerwehr Musterdorf"},
    "report": {"partnerOrgs": ["Polizei", "Sanität"]},
    "roster": {"ranks": [{"key": "of", "label": "Offizier"}]},
    "referenceLayers": [{"id": "hydranten", "kind": "geojson", "geojson": "/api/reference/geo:hydranten"}],
}


async def _seed(client, put_config) -> str:
    """The station document, stored. Returns the version to write against."""
    r = await put_config(client, STATION)
    assert r.status_code == 200, r.text
    return r.json()["version"]


async def _stored(client) -> dict:
    return (await client.get("/api/config")).json()


# --- refuse to empty ------------------------------------------------------------------


async def test_a_write_that_would_empty_a_populated_section_is_refused(client, admin_login, put_config):
    """⚠️ The shape of every one of these incidents: an OLD document published over a newer one,
    reporting success while a station quietly loses its Dienstgrade and its Partnerorganisationen.
    `admin_config load` has refused this for months; the API answered 200 to the identical write.
    """
    await admin_login(client)
    version = await _seed(client, put_config)

    refused = await client.put(
        "/api/config",
        json={"identity": {"appName": "Feuerwehr Musterdorf"}, "referenceLayers": STATION["referenceLayers"]},
        headers={"If-Match": version},
    )
    assert refused.status_code == 409, refused.text
    detail = refused.json()["detail"]
    # structured, because the caller is as likely to be a program as a person
    assert detail["error"] == "would_empty_sections"
    assert set(detail["emptiedSections"]) == {"roster.ranks", "report.partnerOrgs"}
    assert detail["override"] == "?force=true"
    # …and nothing was written
    assert (await _stored(client))["report"]["partnerOrgs"] == ["Polizei", "Sanität"]


async def test_a_section_this_build_does_not_know_is_not_held_against_the_caller(
    client, admin_login, put_config, db_session
):
    """⚠️ The refusal has to be ACTIONABLE. A section the schema does not declare — one dropped
    from the model, or one a newer build wrote into the row — is removed by normalization
    whatever the caller sends, so reporting it would refuse every write with a reason nobody can
    act on: the admin UI cannot put back a key it is not allowed to send."""
    await admin_login(client)
    await _seed(client, put_config)
    # the row as an older (or newer) build left it
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    row.config_json = {**row.config_json, "symbols": {"quickPick": ["a", "b"]}}
    await db_session.commit()

    r = await put_config(client, STATION)
    assert r.status_code == 200, r.text
    assert "symbols" not in (await _stored(client))


async def test_force_performs_the_emptying_it_named(client, admin_login, put_config):
    """A station dropping its Partnerliste is a real edit — it just has to say so."""
    await admin_login(client)
    version = await _seed(client, put_config)

    forced = await client.put(
        "/api/config",
        json={"identity": {"appName": "Feuerwehr Musterdorf"}, "referenceLayers": STATION["referenceLayers"]},
        headers={"If-Match": version},
        params={"force": "true"},
    )
    assert forced.status_code == 200, forced.text
    after = await _stored(client)
    assert after["report"]["partnerOrgs"] == []
    assert after["roster"]["ranks"] == []


# --- the sections nobody types --------------------------------------------------------


async def test_a_document_that_never_mentions_the_layers_keeps_them(client, admin_login, put_config):
    """⚠️ An agent writing three identity fields over the API used to delete the station's
    hydrants. `referenceLayers` is written by the geodata push and the SharePoint pull, and a
    caller that does not name the section is not asking for anything to happen to it."""
    await admin_login(client)
    await _seed(client, put_config)

    r = await put_config(client, {**_populated(), "identity": {"appName": "Feuerwehr Talheim"}})
    assert r.status_code == 200, r.text
    assert r.json()["identity"]["appName"] == "Feuerwehr Talheim"
    assert [layer["id"] for layer in r.json()["referenceLayers"]] == ["hydranten"]
    assert (await _stored(client))["referenceLayers"][0]["geojson"] == "/api/reference/geo:hydranten"


async def test_an_explicitly_emptied_layer_list_is_a_refusal_not_a_carry(client, admin_login, put_config):
    """Absence and `[]` are different requests, and only the raw body can tell them apart —
    by the time the model has filled its defaults in, both are an empty list. A caller that
    NAMES the section is asking for something, so it goes to the refuse-to-empty guard rather
    than being quietly undone."""
    await admin_login(client)
    version = await _seed(client, put_config)

    refused = await client.put(
        "/api/config",
        json={**_populated(), "referenceLayers": []},
        headers={"If-Match": version},
    )
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["emptiedSections"] == ["referenceLayers"]

    cleared = await client.put(
        "/api/config",
        json={**_populated(), "referenceLayers": []},
        headers={"If-Match": version},
        params={"force": "true"},
    )
    assert cleared.status_code == 200, cleared.text
    assert (await _stored(client))["referenceLayers"] == []


def _populated() -> dict:
    """The sections a test is not trying to empty, so the refusal under test is the only one."""
    return {"identity": STATION["identity"], "report": STATION["report"], "roster": STATION["roster"]}


# --- warnings -------------------------------------------------------------------------


async def test_the_response_names_the_keys_the_schema_dropped(client, admin_login, put_config):
    """Every model is `extra="ignore"`, so `identitiy` configures nothing — and used to be
    answered with a plain 200. A warning is not a refusal: the write happened."""
    await admin_login(client)
    r = await put_config(client, {"identitiy": {"appName": "X"}, "doctrine": {"alarmBarr": 100}})
    assert r.status_code == 200, r.text
    warnings = r.json()["warnings"]
    assert any("identitiy" in w and "did you mean identity?" in w for w in warnings)
    assert any("doctrine.alarmBarr" in w for w in warnings)


async def test_a_document_read_and_written_back_warns_about_nothing(client, admin_login, put_config):
    """⚠️ The response carries `version`, `integrations`, `alarmVocabulary` and `warnings`, and
    the admin UI PUTs its draft back with them still in it. They are not typos — four bogus
    warnings on every autosave is how a report nobody reads is made."""
    await admin_login(client)
    await _seed(client, put_config)
    draft = await _stored(client)

    r = await put_config(client, draft)
    assert r.status_code == 200, r.text
    assert r.json()["warnings"] == []


# --- the dry run ----------------------------------------------------------------------


async def test_validate_answers_what_a_write_would_change_and_empty(client, admin_login, put_config):
    await admin_login(client)
    await _seed(client, put_config)

    r = await client.post("/api/config/validate", json={"identity": {"appName": "Feuerwehr Talheim"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is True
    assert body["errors"] == []
    assert set(body["emptiedSections"]) == {"roster.ranks", "report.partnerOrgs"}
    assert "identity.appName" in body["changedSections"]
    # the layers are NOT reported: an unnamed section is carried, so it changes nothing
    assert "referenceLayers" not in body["changedSections"]
    # …and the token to come back with, so the follow-up PUT is not a blind one
    assert body["version"] == (await _stored(client))["version"]
    # nothing was written
    assert (await _stored(client))["identity"]["appName"] == "Feuerwehr Musterdorf"


async def test_validate_reports_a_broken_document_as_a_verdict_not_an_error(client, admin_login):
    """⚠️ 200 with `valid: false`, never 422. This endpoint's job is to report on a document;
    a 422 would make «this document is wrong» and «this request is wrong» the same answer."""
    await admin_login(client)
    r = await client.post(
        "/api/config/validate",
        json={"identity": {"accentColor": "nicht-eine-farbe"}, "identitiy": {}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is False
    assert any(e.startswith("identity.accentColor:") for e in body["errors"])
    # the typo is still reported — it hides well behind an unrelated validation error
    assert any("identitiy" in w for w in body["warnings"])


async def test_validate_writes_nothing_even_for_a_document_that_would_pass(client, admin_login, put_config):
    await admin_login(client)
    await _seed(client, put_config)
    before = (await _stored(client))["version"]

    ok = await client.post("/api/config/validate", json=STATION)
    assert ok.json()["valid"] is True
    assert ok.json()["changedSections"] == []  # the same document, so this write would be a no-op
    assert (await _stored(client))["version"] == before


async def test_validate_is_admin_only(client, editor):
    """Same gate as the PUT it stands in front of: a dry run reads the stored document."""
    r = await client.post("/api/config/validate", json={})
    assert r.status_code in (401, 403), r.text


async def test_a_refused_write_is_not_in_the_history(client, admin_login, put_config, session_factory):
    """A refusal writes nothing at all — including the «kept previous config» row. A history
    full of writes that never happened is worse than no history."""
    from app.models import DeploymentConfigHistory

    await admin_login(client)
    version = await _seed(client, put_config)
    async with session_factory() as db:
        before = len((await db.execute(select(DeploymentConfigHistory))).scalars().all())

    refused = await client.put("/api/config", json={"identity": {}}, headers={"If-Match": version})
    assert refused.status_code == 409

    async with session_factory() as db:
        assert len((await db.execute(select(DeploymentConfigHistory))).scalars().all()) == before
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    assert row.config_json["roster"]["ranks"], "the refused write reached the row"
