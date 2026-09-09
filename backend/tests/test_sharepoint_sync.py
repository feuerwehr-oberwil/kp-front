"""The SharePoint pull: what one run imports, what it refuses, and what it never deletes.

Every test here drives a whole fake tenant over `httpx.MockTransport` (tests/sharepoint_fake)
rather than patching the connector's internals, so the URL building, the paging, the delta gate
and the 410 path are all exercised — and no test touches a network.

What is pinned is BEHAVIOUR at the two doors this connector has: what lands in the deployment's
own tables, and what a listing is allowed to take away. Those are the properties that would
still matter if the module were rewritten.
"""

import pytest
from sharepoint_fake import CLIENT_ID, CLIENT_SECRET, TENANT_ID, FakeTenant, geojson, source
from sqlalchemy import select

from app import credentials as creds
from app.admin_objects import object_id_for_key
from app.config import settings
from app.models import DeploymentConfig, ObjectSite, ReferenceDataset, SharePointSyncState
from app.services.station_workbook import build_workbook
from app.sharepoint_sync import sync_sharepoint

pytestmark = pytest.mark.asyncio

PDF = b"%PDF-1.4 a modul sheet"


@pytest.fixture
def storage_root(tmp_path, monkeypatch):
    """Blobs land in the test's own directory, never in the repo's `data/storage`."""
    from app import storage

    root = tmp_path / "blobs"
    root.mkdir()
    monkeypatch.setattr(storage, "_ROOT", str(root))
    return root


@pytest.fixture
def blank_env(monkeypatch):
    """A deployment whose `.env` names none of these — the state a fresh station is in."""
    for f in creds.FIELDS:
        if f.declared:
            monkeypatch.setattr(settings, f.name, f.default, raising=False)
        else:
            monkeypatch.delenv(f.env, raising=False)
    creds.reset_cache()


async def configure(db, sources: list[dict], *, intervalMinutes: int = 60) -> None:  # noqa: N803 — config key
    """Credentials + a `sharepoint` config section, the way an admin would set both."""
    for name, value in (
        ("sharepoint_tenant_id", TENANT_ID),
        ("sharepoint_client_id", CLIENT_ID),
        ("sharepoint_client_secret", CLIENT_SECRET),
    ):
        await creds.set_value(db, name, value, actor_id=None)
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    section = {"intervalMinutes": intervalMinutes, "sources": sources}
    if row is None:
        db.add(DeploymentConfig(id=1, config_json={"sharepoint": section}))
    else:
        row.config_json = {**(row.config_json or {}), "sharepoint": section}
    await db.flush()


async def datasets(db, prefix: str) -> list[str]:
    # The test session is `autoflush=False`; a real caller commits (api/sharepoint · run_sync,
    # scheduler · _sharepoint_pull), so flush here to read what the run actually wrote.
    await db.flush()
    rows = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id.like(f"{prefix}%")))).scalars()
    return sorted(r.id for r in rows)


async def state_of(db, area: str) -> SharePointSyncState:
    return (await db.execute(select(SharePointSyncState).where(SharePointSyncState.area == area))).scalar_one()


# --- Objektpläne ------------------------------------------------------------------------


async def test_a_plan_lands_under_the_object_id_the_cli_would_have_minted(db_session, blank_env, storage_root):
    """The identity rule the whole connector hangs on: the folder name is hashed with the SAME
    uuid5 `admin_objects` uses, so a station that loads plans by hand and then points at
    SharePoint updates its Einsatzobjekte instead of growing a second copy of each."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF, "dorfmatt/modul2-3.pdf": PDF})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 2
    oid = object_id_for_key("dorfmatt")
    obj = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == oid))).scalar_one()
    assert obj.name == "dorfmatt"
    assert await datasets(db_session, "plan:") == [f"plan:{oid}:modul1", f"plan:{oid}:modul2-3"]
    stored = (
        await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.id == f"plan:{oid}:modul1"))
    ).scalar_one()
    assert stored.source_type == "sharepoint"
    assert stored.kind == "pdf"


async def test_an_existing_object_keeps_its_name_and_address(db_session, blank_env, storage_root):
    """A plan arriving for an object somebody already named and geocoded must not reset it to
    a folder name — the connector creates, it does not curate."""
    oid = object_id_for_key("dorfmatt")
    db_session.add(ObjectSite(id=oid, name="Schulhaus Dorfmatt", address="Schulstrasse 7"))
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})

    await sync_sharepoint(db_session, transport=tenant.transport)

    obj = (await db_session.execute(select(ObjectSite).where(ObjectSite.id == oid))).scalar_one()
    assert (obj.name, obj.address) == ("Schulhaus Dorfmatt", "Schulstrasse 7")


async def test_an_unchanged_folder_costs_one_request_and_imports_nothing(db_session, blank_env, storage_root):
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)

    tenant.quiet()
    tenant.seen.clear()
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "unchanged"
    assert result["areas"]["plans"]["imported"] == 0
    assert not any("/children" in url for url in tenant.seen), "an unchanged folder must not be walked"


async def test_only_the_changed_plan_is_fetched_again(db_session, blank_env, storage_root):
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF, "dorfmatt/modul2.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)

    tenant.put("dorfmatt/modul2.pdf", b"%PDF-1.4 a redrawn sheet")
    tenant.seen.clear()
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert (result["areas"]["plans"]["imported"], result["areas"]["plans"]["skipped"]) == (1, 1)
    downloads = [u for u in tenant.seen if "/download/" in u]
    assert downloads == ["https://storage.example/download/dorfmatt/modul2.pdf"]


async def test_a_module_slug_the_column_could_not_hold_is_skipped(db_session, blank_env, storage_root):
    """⚠️ SQLite does not enforce `String(16)`, so a 40-character module name would pass every
    local test and 500 on the station's Postgres. The length rule lives in the connector."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul-mit-einem-viel-zu-langen-namen.pdf": PDF, "dorfmatt/modul1.pdf": PDF})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 1
    assert await datasets(db_session, "plan:") == [f"plan:{object_id_for_key('dorfmatt')}:modul1"]


async def test_a_file_that_is_not_a_pdf_is_skipped(db_session, blank_env, storage_root):
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": b"this is a Word document, renamed"})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 0
    assert await datasets(db_session, "plan:") == []


# --- the two safety rules ---------------------------------------------------------------


async def test_an_empty_listing_never_empties_a_populated_area(db_session, blank_env, storage_root):
    """`admin_config load`'s refusal, in a connector: a folder that suddenly lists nothing is
    far more often a broken sync than a decision, and being wrong runs one way."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)
    before = await datasets(db_session, "plan:")

    tenant.remove("dorfmatt/modul1.pdf")
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "refused"
    assert "imported from it before" in (result["areas"]["plans"]["detail"] or "")
    assert await datasets(db_session, "plan:") == before, "a refused run changes nothing"


async def test_a_first_run_against_an_empty_folder_is_not_a_refusal(db_session, blank_env, storage_root):
    """Nothing to protect yet — refusing here would make a station's very first sync look
    broken on the System card."""
    await configure(db_session, [source("plans")])
    result = await sync_sharepoint(db_session, transport=FakeTenant({}).transport)
    assert result["areas"]["plans"]["status"] == "ok"


async def test_a_vanished_file_is_recorded_as_missing_and_nothing_is_deleted(db_session, blank_env, storage_root):
    """Soft deletion: the record stays, the state row says the source no longer has it."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF, "dorfmatt/modul2.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)

    tenant.remove("dorfmatt/modul2.pdf")
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["missing"] == 1
    state = await state_of(db_session, "plans")
    assert [m["path"] for m in state.missing] == ["dorfmatt/modul2.pdf"]
    oid = object_id_for_key("dorfmatt")
    assert f"plan:{oid}:modul2" in await datasets(db_session, "plan:")


# --- auth + health ----------------------------------------------------------------------


async def test_an_expired_client_secret_is_its_own_state_and_freezes_the_green_tick(
    db_session, blank_env, storage_root
):
    """The guaranteed failure two years in. `last_success_at` must NOT move — a green tick left
    standing through a week of 401s is exactly the silent death this status surface exists for."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)
    first_success = (await state_of(db_session, "plans")).last_success_at

    tenant.fail_auth()
    tenant.put("dorfmatt/modul2.pdf", PDF)
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "auth_failed"
    assert "AADSTS7000222" in (result["areas"]["plans"]["detail"] or "")
    state = await state_of(db_session, "plans")
    assert state.last_success_at == first_success
    assert state.last_run_at > first_success


async def test_nothing_runs_without_all_three_credentials(db_session, blank_env, storage_root):
    """Fail-closed, like every other integration: half an app registration stays off."""
    await creds.set_value(db_session, "sharepoint_tenant_id", TENANT_ID, actor_id=None)
    db_session.add(DeploymentConfig(id=1, config_json={"sharepoint": {"sources": [source("plans")]}}))
    await db_session.flush()

    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["status"] == "disabled"
    assert tenant.seen == []


async def test_repointing_a_source_forgets_the_resume_point(db_session, blank_env, storage_root):
    """A delta token belongs to ONE folder. Resuming against a different one would report «no
    changes» for a folder we have never read."""
    await configure(db_session, [source("plans", "kp-data")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF}, root_path="andere-daten")
    await sync_sharepoint(db_session, transport=FakeTenant({"dorfmatt/modul1.pdf": PDF}).transport)
    assert (await state_of(db_session, "plans")).delta_token

    await configure(db_session, [source("plans", "andere-daten")])
    tenant.quiet()
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "ok", "a repointed source is walked, not resumed"
    assert result["areas"]["plans"]["imported"] == 1


async def test_an_expired_delta_token_falls_back_to_a_full_walk(db_session, blank_env, storage_root):
    """Graph's documented 410: the token is too old. Not an error — enumerate again."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)

    tenant.delta_gone = True
    tenant.put("dorfmatt/modul2.pdf", PDF)
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "ok"
    assert result["areas"]["plans"]["imported"] == 1


# --- Geodaten ---------------------------------------------------------------------------


async def test_a_layer_lands_in_the_store_beside_the_layers_it_did_not_pull(db_session, blank_env, storage_root):
    """⚠️ Merged by id, never assigned. A wholesale write would delete the canton's WMS layers
    — which have no file in SharePoint — on the very first poll."""
    db_session.add(
        DeploymentConfig(
            id=1,
            config_json={
                "referenceLayers": [{"id": "bl-wms", "kind": "wms", "tiles": ["https://geo.example/{bbox-epsg-3857}"]}]
            },
        )
    )
    await db_session.flush()
    await configure(db_session, [source("geodata")])
    tenant = FakeTenant(
        {
            "hydranten.geojson": geojson(3),
            "hydranten.json": b'{"label": "Hydranten", "group": "Wasser", "color": "#0f52b5"}',
        }
    )

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["geodata"]["imported"] == 1
    assert await datasets(db_session, "geo:") == ["geo:hydranten"]
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    layers = {layer["id"]: layer for layer in row.config_json["referenceLayers"]}
    assert set(layers) == {"bl-wms", "hydranten"}
    assert layers["hydranten"]["label"] == "Hydranten"
    assert layers["hydranten"]["geojson"] == "/api/reference/geo:hydranten"


async def test_a_projected_export_is_refused_rather_than_drawn_off_the_coast_of_africa(
    db_session, blank_env, storage_root
):
    await configure(db_session, [source("geodata")])
    lv95 = b'{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[2610000,1259000]},"properties":{}}]}'
    tenant = FakeTenant({"hydranten.geojson": lv95})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["geodata"]["imported"] == 0
    assert await datasets(db_session, "geo:") == []


async def test_a_sidecar_edit_alone_still_reaches_the_map(db_session, blank_env, storage_root):
    """A colour change touches no feature. The layer CONFIG is rebuilt whenever anything in the
    folder changed, precisely so «make the hydrants blue» is not invisible to the connector."""
    await configure(db_session, [source("geodata")])
    tenant = FakeTenant({"hydranten.geojson": geojson(), "hydranten.json": b'{"label": "Hydranten"}'})
    await sync_sharepoint(db_session, transport=tenant.transport)

    tenant.put("hydranten.json", b'{"label": "Hydranten", "color": "#ff0000"}')
    await sync_sharepoint(db_session, transport=tenant.transport)

    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    layer = next(layer for layer in row.config_json["referenceLayers"] if layer["id"] == "hydranten")
    assert layer["color"] == "#ff0000"


# --- Checklisten ------------------------------------------------------------------------


async def test_a_template_and_its_diagram_become_the_datasets_the_app_reads(db_session, blank_env, storage_root):
    await configure(db_session, [source("checklists")])
    template = b'{"id": "fu-aktion", "kind": "action", "title": "Aufgaben FU", "phases": [{"id": "a"}]}'
    tenant = FakeTenant({"fu-aktion.json": template, "fu-aktion-p12.jpg": b"\xff\xd8jpeg"})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["checklists"]["imported"] == 2
    assert await datasets(db_session, "checklists:") == ["checklists:fu-aktion", "checklists:fu-aktion:p12"]


async def test_a_json_file_that_is_not_a_template_is_skipped(db_session, blank_env, storage_root):
    """The id in the file has to be the id in the name — otherwise a stray notes.json becomes a
    checklist rail entry nobody put there."""
    await configure(db_session, [source("checklists")])
    tenant = FakeTenant({"notizen.json": b'{"hello": "world"}'})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["checklists"]["imported"] == 0
    assert await datasets(db_session, "checklists:") == []


async def test_a_removed_template_is_reported_missing_and_not_pruned(db_session, blank_env, storage_root):
    """Unlike `admin_checklists load`, which holds a complete manifest and may prune. A poll
    holds a folder listing, which may be a broken one."""
    await configure(db_session, [source("checklists")])
    files = {
        "fu-aktion.json": b'{"id": "fu-aktion", "kind": "action", "title": "FU", "phases": [{"id": "a"}]}',
        "lagerapport.json": b'{"id": "lagerapport", "kind": "rapport", "title": "LR", "phases": [{"id": "a"}]}',
    }
    tenant = FakeTenant(dict(files))
    await sync_sharepoint(db_session, transport=tenant.transport)

    tenant.remove("lagerapport.json")
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["checklists"]["missing"] == 1
    assert "checklists:lagerapport" in await datasets(db_session, "checklists:")


# --- Arbeitsmappe -----------------------------------------------------------------------


def workbook_bytes(config: dict, people: list = []) -> bytes:  # noqa: B006 — read-only default
    """A real .xlsx, built by the exporter the admin page hands out."""
    from app.schemas import load_stored_config

    return build_workbook(load_stored_config(config).model_dump(mode="json"), people, {}, "last-first")


async def test_a_workbook_that_only_adds_is_applied_unattended(db_session, blank_env, storage_root):
    await configure(db_session, [source("workbook")])
    book = workbook_bytes({"fleet": {"vehicles": [{"id": "tlf", "label": "TLF Oberwil"}]}})
    tenant = FakeTenant({"arbeitsmappe.xlsx": book})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["workbook"]["status"] == "ok"
    assert result["areas"]["workbook"]["imported"] == 1
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    assert [v["id"] for v in row.config_json["fleet"]["vehicles"]] == ["tlf"]


async def test_a_workbook_that_would_deactivate_people_waits_for_a_person(db_session, blank_env, storage_root):
    """⚠️ The interactive import ASKS before it deactivates. This path has nobody to ask, so the
    confirmation becomes a condition — the area reports `needs_review` and writes nothing."""
    from app.models import Personnel

    db_session.add(Personnel(display_name="Muster Hans", is_active=True))
    await db_session.flush()
    await configure(db_session, [source("workbook")])
    # A workbook whose Mannschaft sheet is present and does NOT list Hans.
    tenant = FakeTenant({"arbeitsmappe.xlsx": workbook_bytes({}, [])})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["workbook"]["status"] == "needs_review"
    assert "deactivate" in (result["areas"]["workbook"]["detail"] or "")
    person = (await db_session.execute(select(Personnel))).scalar_one()
    assert person.is_active is True


async def test_two_workbooks_in_one_folder_are_a_question_not_a_guess(db_session, blank_env, storage_root):
    await configure(db_session, [source("workbook")])
    book = workbook_bytes({})
    tenant = FakeTenant({"arbeitsmappe.xlsx": book, "arbeitsmappe-alt.xlsx": book})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["workbook"]["status"] == "needs_review"
    assert "leave exactly one" in (result["areas"]["workbook"]["detail"] or "")


# --- several areas at once ---------------------------------------------------------------


async def test_each_area_carries_its_own_folder_and_its_own_failure(db_session, blank_env, storage_root):
    """The amendment's whole point: areas are configured and fail independently. A geodata
    folder that was renamed must not cost the station its Objektpläne."""
    await configure(db_session, [source("plans", "kommando/plaene"), source("geodata", "gis/layer")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF}, root_path="kommando/plaene")

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 1
    assert result["areas"]["geodata"]["status"] == "unreachable"
    assert await datasets(db_session, "plan:") != []
