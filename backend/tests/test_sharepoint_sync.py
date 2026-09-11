"""The SharePoint pull: what one run imports, what it refuses, and what it never deletes.

Every test here drives a whole fake tenant over `httpx.MockTransport` (tests/sharepoint_fake)
rather than patching the connector's internals, so the URL building, the paging, the delta gate
and the 410 path are all exercised — and no test touches a network.

What is pinned is BEHAVIOUR at the two doors this connector has: what lands in the deployment's
own tables, and what a listing is allowed to take away. Those are the properties that would
still matter if the module were rewritten.
"""

import re
import unicodedata

import pytest
from sharepoint_fake import CLIENT_ID, CLIENT_SECRET, TENANT_ID, FakeTenant, geojson, source
from sqlalchemy import select

from app import credentials as creds
from app import sharepoint_sync
from app.admin_objects import object_id_for_key
from app.config import settings
from app.models import DeploymentConfig, ObjectSite, ReferenceDataset, SharePointSyncState
from app.services.station_workbook import build_workbook
from app.sharepoint_sync import _module_for, _ModuleRule, sharepoint_status, sync_sharepoint

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


@pytest.fixture(autouse=True)
def no_geocoder(monkeypatch):
    """No test reaches swisstopo. A folder «Adresse - Name» now geocodes its address half when it
    mints an object, so without this every plans test would make a real HTTP request (and the
    fake tenant's MockTransport does not cover the geocoder's own client). The tests that care
    about geocoding patch it themselves with `geocoder(...)`."""
    monkeypatch.setattr(sharepoint_sync, "geocode", _none_geocode)


async def _none_geocode(_address):
    return None


def geocoder(monkeypatch, coords, calls=None):
    """Point the connector's geocoder at a fixed answer, recording what it was asked."""

    async def fake(address):
        if calls is not None:
            calls.append(address)
        if isinstance(coords, Exception):
            raise coords
        return coords

    monkeypatch.setattr(sharepoint_sync, "geocode", fake)


@pytest.fixture
def blank_env(monkeypatch):
    """A deployment whose `.env` names none of these — the state a fresh station is in."""
    for f in creds.FIELDS:
        if f.declared:
            monkeypatch.setattr(settings, f.name, f.default, raising=False)
        else:
            monkeypatch.delenv(f.env, raising=False)
    creds.reset_cache()


#: The shipped default Modul catalogue, `match` regexes and all — the national defaults a
#: station starts from (app/admin_config · EXAMPLE_CONFIG, mirrored in
#: src/lib/deploymentConfig · DEFAULT_MODULES). The pull reads THESE to decide which slot a PDF
#: belongs to, so they are half of every plans test.
#:
#: ⚠️ `modul5` is a family: its capture becomes the sub-slot, and it takes a trailing number so
#: «Modul 5 - Wasser 1» and «Modul 5 - Wasser 2» are two plans rather than one overwriting the
#: other. Feuerwehr Oberwil's STORED regex does not — see the collision test below.
MODULES = [
    {"id": "modul1", "code": "M1", "order": 1, "match": r"modul\s*1(?!\s*[-–/]\s*\d)"},
    {"id": "modul2", "code": "M2", "order": 2, "match": r"modul\s*2(?!\s*[-–/]\s*\d)"},
    {"id": "modul3", "code": "M3", "order": 3, "match": r"modul\s*3(?!\s*[-–/]\s*\d)"},
    {
        "id": "modul2-3",
        "code": "2/3",
        "order": 4,
        "match": r"modul\s*2\s*[-–/]\s*3",
        "combinedWith": ["modul2", "modul3"],
    },
    {"id": "modul6", "code": "M6", "order": 6, "match": r"modul\s*6"},
    {
        "id": "modul5",
        "code": "M5",
        "order": 5,
        "family": True,
        "match": r"modul\s*5(?:\s*[-–—]\s*([0-9A-Za-zÄÖÜäöü]+(?:\s+\d+)?))?",
    },
    {"id": "modul4", "code": "M4", "order": 7, "match": r"modul\s*4"},
]

#: Feuerwehr Oberwil's own `modul5` rule, copied out of its stored config. The capture stops at
#: the first space, so every «Wasser N» sheet collapses onto one slot.
OBERWIL_MODUL5_MATCH = r"modul\s*5(?:\s*[-–—]\s*([0-9A-Za-zÄÖÜäöü]+))?"


async def configure(
    db,
    sources: list[dict],
    *,
    intervalMinutes: int = 60,  # noqa: N803 — config key
    modules: list[dict] | None = MODULES,
) -> None:
    """Credentials + a `sharepoint` config section, the way an admin would set both.

    `modules` is the deployment's Objektplan catalogue — pass `None` for the station that never
    configured one, which the plans pull refuses to guess around.
    """
    for name, value in (
        ("sharepoint_tenant_id", TENANT_ID),
        ("sharepoint_client_id", CLIENT_ID),
        ("sharepoint_client_secret", CLIENT_SECRET),
    ):
        await creds.set_value(db, name, value, actor_id=None)
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    section = {"intervalMinutes": intervalMinutes, "sources": sources}
    document: dict = {"sharepoint": section, "modules": modules or []}
    if row is None:
        db.add(DeploymentConfig(id=1, config_json=document))
    else:
        row.config_json = {**(row.config_json or {}), **document}
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


async def test_a_folder_named_adresse_name_updates_the_object_the_importer_created(db_session, blank_env, storage_root):
    """⚠️ The 11.09.2026 production defect, in one test. A plans folder is «Adresse - Name», and
    the importer has always keyed the Einsatzobjekt on the NAME half with the address in its own
    column. This connector hashed the WHOLE folder string, so every folder minted a SECOND,
    address-less object beside the station's real one — the pull kept updating the copy, and
    because an object with no coordinates surfaces at no incident (`useObjectPlans` sorts by
    distance), the crew went on opening the old sheet. One object, and it is the station's."""
    oid = object_id_for_key(OBERWIL_KEY)
    db_session.add(ObjectSite(id=oid, name=OBERWIL_KEY, address=OBERWIL_ADDRESS, lat=47.5, lng=7.57))
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 1
    objects = list((await db_session.execute(select(ObjectSite))).scalars())
    assert [o.id for o in objects] == [oid], "the folder minted a second object beside the station's"
    assert (float(objects[0].lat), float(objects[0].lng)) == (47.5, 7.57)
    assert await datasets(db_session, "plan:") == [f"plan:{oid}:modul1"]


async def test_a_new_object_carries_the_split_fields_and_geocoded_coordinates(
    db_session, blank_env, storage_root, monkeypatch
):
    """A folder the station never loaded by hand. It is created with the address split out AND
    geocoded from it — coordinates are what make the plans reachable at an Einsatz at all."""
    asked: list[str] = []
    geocoder(monkeypatch, (47.49811, 7.55402), asked)
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF})

    await sync_sharepoint(db_session, transport=tenant.transport)

    obj = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert (obj.id, obj.name, obj.address) == (object_id_for_key(OBERWIL_KEY), OBERWIL_KEY, OBERWIL_ADDRESS)
    assert (float(obj.lat), float(obj.lng)) == (47.49811, 7.55402)
    assert asked == [OBERWIL_ADDRESS], "the geocoder was asked something other than the address half"
    assert obj.source_key is None, "source_key belongs to the snapshot pull's index, not to a folder name"


async def test_a_geocoder_that_fails_never_costs_the_run_a_plan(db_session, blank_env, storage_root, monkeypatch):
    """Best-effort by contract: swisstopo being down is not a reason for a Modul-PDF not to
    arrive. The object is created without coordinates, exactly as before geocoding existed."""
    geocoder(monkeypatch, RuntimeError("swisstopo timed out"))
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "ok"
    assert result["areas"]["plans"]["imported"] == 1
    obj = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert (obj.address, obj.lat, obj.lng) == (OBERWIL_ADDRESS, None, None)
    assert await datasets(db_session, "plan:") == [f"plan:{object_id_for_key(OBERWIL_KEY)}:modul1"]


async def test_a_folder_without_the_separator_keeps_its_whole_name_as_its_key(
    db_session, blank_env, storage_root, monkeypatch
):
    """«Grosspläne», «dorfmatt»: no « - », so there is no address to split and nothing changes —
    the key is the whole name, which is what it always was. The geocoder is not even asked."""
    calls: list[str] = []
    geocoder(monkeypatch, (0.0, 0.0), calls)
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})

    await sync_sharepoint(db_session, transport=tenant.transport)

    obj = (await db_session.execute(select(ObjectSite))).scalar_one()
    assert (obj.id, obj.name, obj.address) == (object_id_for_key("dorfmatt"), "dorfmatt", None)
    assert calls == []


async def test_an_object_with_plans_and_no_coordinates_is_said_out_loud(db_session, blank_env, storage_root):
    """An object nobody can reach must not be a silence. Every plan arrived, so the run is `ok`
    — the sentence belongs on the card beside it, read LIVE, because it stays true until somebody
    geocodes the thing (and would otherwise drop the delta cursor on every poll for ever)."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)  # the autouse geocoder answers nothing

    status = await sharepoint_status(db_session)
    plans = next(a for a in status["areas"] if a["area"] == "plans")
    assert plans["status"] == "ok"
    assert plans["objectsWithoutCoordinates"] == 1
    assert "carry plans but no coordinates" in (plans["detail"] or "")
    assert "repair-sharepoint-keys" in (plans["detail"] or "")

    obj = (await db_session.execute(select(ObjectSite))).scalar_one()
    obj.lat, obj.lng = 47.5, 7.57
    await db_session.flush()
    plans = next(a for a in (await sharepoint_status(db_session))["areas"] if a["area"] == "plans")
    assert (plans["objectsWithoutCoordinates"], plans["detail"]) == (0, None), "the warning outlived the defect"


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


async def test_a_file_no_module_rule_claims_is_skipped(db_session, blank_env, storage_root):
    """A PDF beside the plans that no `modules[].match` recognises. Skipped and logged — the
    object still exists, because one of its files did resolve. (The 16-character column limit
    on a GENERATED sub-slot has its own test further down.)"""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/Begehungsprotokoll 2024.pdf": PDF, "dorfmatt/modul1.pdf": PDF})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 1
    assert await datasets(db_session, "plan:") == [f"plan:{object_id_for_key('dorfmatt')}:modul1"]


async def test_a_file_that_is_not_a_pdf_is_skipped(db_session, blank_env, storage_root):
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": b"this is a Word document, renamed"})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 0
    assert await datasets(db_session, "plan:") == []


# --- the names a station actually gives its files ----------------------------------------
#
# Every string below is copied out of Feuerwehr Oberwil's «Einsatzpläne» library. They are the
# regression: the connector's first cut compared the module against the raw filename stem, and
# because every one of the station's 336 plan PDFs has a space in it, pointing the plans area
# at that library would have imported exactly nothing.

OBERWIL_FOLDER = "Am Mühlebach 1a - Am Mühlebach 1-11"
#: What that folder is KEYED on: the name half of «Adresse - Name», spelled out rather than
#: derived, because it is the convention under test. The address half is «Am Mühlebach 1a», and
#: the hyphen inside «1-11» is not a separator — only « - » is.
OBERWIL_KEY = "Am Mühlebach 1-11"
OBERWIL_ADDRESS = "Am Mühlebach 1a"


def rules(modules=MODULES):
    """The config's `modules` as the pull compiles them — the parser under test."""
    return [
        _ModuleRule(id=m["id"], match=re.compile(m["match"], re.IGNORECASE), family=bool(m.get("family")))
        for m in modules
        if m.get("match")
    ]


@pytest.mark.parametrize(
    ("filename", "module"),
    [
        ("Modul 1", "modul1"),
        ("Modul 2", "modul2"),
        ("Modul 3", "modul3"),
        ("Modul 2-3", "modul2-3"),
        ("Modul 5", "modul5"),
        ("Modul 6", "modul6"),
        # A family's capture is the sub-slot, and it needs no catalogue entry of its own —
        # every one of these is a real file and none is a configured module. A trailing number
        # fuses onto its word (modul5-wasserN, the numbered-sibling convention navRail reads);
        # `modul5-wasser-1` would render as a second identical «Wasser» tile.
        ("Modul 5 - PV", "modul5-pv"),
        ("Modul 5 - PV 15", "modul5-pv15"),
        ("Modul 5 - Wasser", "modul5-wasser"),
        ("Modul 5 - Wasser 1", "modul5-wasser1"),
        ("Modul 5 - Wasser 2", "modul5-wasser2"),
        ("Modul 5 - Evak", "modul5-evak"),
        ("Modul 5 - Adressen", "modul5-adressen"),
        # A Grossplan's name, which no rule may claim.
        ("Grenzweg 3 - BLT Park&Ride, BLT Busdepot", None),
        ("Bahnhofstrasse 6 - Gemeindebibliothek", None),
    ],
)
async def test_the_station_s_file_names_resolve_through_its_own_match_rules(filename, module):
    # `async` only because this module runs every test on the asyncio mark; nothing here awaits.
    assert _module_for(filename, rules()) == module


async def test_the_station_s_real_module_files_land_in_their_slots(db_session, blank_env, storage_root):
    """The file names this library repeats 300-odd times, resolved by the station's own `match`
    rules. Note `Modul 2-3.pdf`: one sheet, ONE stored plan — `combinedWith` is a display rule
    the app applies, and writing the same PDF under three ids here would make a combined sheet
    indistinguishable from two separately scanned ones."""
    await configure(db_session, [source("plans")])
    names = ["Modul 1", "Modul 2", "Modul 3", "Modul 2-3", "Modul 5", "Modul 6", "Modul 5 - PV", "Modul 5 - Wasser"]
    tenant = FakeTenant({f"{OBERWIL_FOLDER}/{n}.pdf": PDF for n in names})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 8
    oid = object_id_for_key(OBERWIL_KEY)
    assert await datasets(db_session, "plan:") == sorted(
        f"plan:{oid}:{m}"
        for m in ("modul1", "modul2", "modul3", "modul2-3", "modul5", "modul6", "modul5-pv", "modul5-wasser")
    )


async def test_a_family_sub_slot_needs_no_catalogue_entry(db_session, blank_env, storage_root):
    """«Modul 5 - Evak.pdf» and «Modul 5 - Adressen.pdf» are real files and neither `modul5-evak`
    nor `modul5-adressen` is a configured module. They are imported anyway, because that is what
    a `family` is for and because the admin sheet derives a family's slots from the STORED plans
    (src/admin/ObjectSheet · planSlots) — refusing them would drop 25 of this station's files."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant(
        {
            f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 5 - Evak.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 5 - Adressen.pdf": PDF,
        }
    )

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 3
    oid = object_id_for_key(OBERWIL_KEY)
    assert await datasets(db_session, "plan:") == [
        f"plan:{oid}:modul1",
        f"plan:{oid}:modul5-adressen",
        f"plan:{oid}:modul5-evak",
    ]


async def test_two_files_claiming_one_slot_are_refused_loudly_not_silently_merged(db_session, blank_env, storage_root):
    """⚠️ Feuerwehr Oberwil's STORED `modul5` capture stops at a space, so «Modul 5 - Wasser 1»
    and «Modul 5 - Wasser 2» both read as `modul5-wasser` — one file would overwrite the other
    with nothing said. Neither is imported, the area asks for a person, and the fix is one
    character in the station's config (the shipped default takes a trailing number)."""
    narrow = [{**m, "match": OBERWIL_MODUL5_MATCH} if m["id"] == "modul5" else m for m in MODULES]
    await configure(db_session, [source("plans")], modules=narrow)
    tenant = FakeTenant(
        {
            f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 5 - Wasser 1.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 5 - Wasser 2.pdf": PDF,
        }
    )

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "needs_review"
    assert "claimed by two files at once" in (result["areas"]["plans"]["detail"] or "")
    assert "modul5-wasser" in (result["areas"]["plans"]["detail"] or "")
    # Modul 1 still arrives; the two Wasser sheets do not, and no half of the pair is stored.
    assert (result["areas"]["plans"]["imported"], result["areas"]["plans"]["skipped"]) == (1, 2)
    assert await datasets(db_session, "plan:") == [f"plan:{object_id_for_key(OBERWIL_KEY)}:modul1"]


async def test_a_generated_slot_the_column_could_not_hold_is_skipped(db_session, blank_env, storage_root):
    """⚠️ SQLite does not enforce `String(16)`, so an over-long family sub-slot would pass every
    local test and 500 on the station's Postgres. A family capture is the realistic way to get
    a long one, and the file is skipped rather than carried into the write."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant(
        {
            f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 5 - Loeschwasserversorgung.pdf": PDF,
        }
    )

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert (result["areas"]["plans"]["imported"], result["areas"]["plans"]["skipped"]) == (1, 1)
    assert await datasets(db_session, "plan:") == [f"plan:{object_id_for_key(OBERWIL_KEY)}:modul1"]


async def test_the_same_name_decomposed_and_composed_is_one_einsatzobjekt(db_session, blank_env, storage_root):
    """⚠️ The defect that silently tripled this deployment's object list: 25 of its 38 duplicate
    pairs are one name spelled twice, `u`+U+0308 against U+00FC. macOS hands out decomposed file
    names and Graph hands out composed ones, `object_id_for_key` hashes the string, and the two
    identical-looking names minted two uuid5. One object, whichever spelling arrives first."""
    name = "Föhrenstrasse 15 - Behindertenheim Im Rebgarten"
    decomposed, composed = unicodedata.normalize("NFD", name), unicodedata.normalize("NFC", name)
    assert decomposed != composed, "the fixture only means anything if the two spellings differ"

    await configure(db_session, [source("plans")])
    tenant = FakeTenant({f"{decomposed}/Modul 1.pdf": PDF, f"{composed}/Modul 2-3.pdf": PDF})

    await sync_sharepoint(db_session, transport=tenant.transport)

    objects = (await db_session.execute(select(ObjectSite))).scalars().all()
    # Composed, and split: the address is «Föhrenstrasse 15», the key the name behind it.
    assert [(o.name, o.address) for o in objects] == [("Behindertenheim Im Rebgarten", "Föhrenstrasse 15")]
    oid = object_id_for_key("Behindertenheim Im Rebgarten")
    assert await datasets(db_session, "plan:") == [f"plan:{oid}:modul1", f"plan:{oid}:modul2-3"]


async def test_a_category_folder_is_skipped_when_the_source_names_it(db_session, blank_env, storage_root):
    """Bastian's ask: «Grosspläne» is a real folder of 24 overview PDFs sitting among 150 real
    Einsatzobjekte. Naming it in `ignore` states the intent, and the pull walks past it."""
    await configure(db_session, [source("plans", ignore=["Grosspläne"])])
    tenant = FakeTenant(
        {
            "Grosspläne/Bahnhofstrasse 6 - Gemeindebibliothek.pdf": PDF,
            "Grosspläne/Grenzweg 1 - BLT Tramdepot_split.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF,
        }
    )

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 1
    assert [o.name for o in (await db_session.execute(select(ObjectSite))).scalars()] == [OBERWIL_KEY]
    assert not any("Grossplaene" in u or "Gemeindebibliothek" in u for u in tenant.seen), "not downloaded either"


async def test_a_folder_nobody_ignored_still_never_becomes_an_object(db_session, blank_env, storage_root):
    """The net under the ignore list. Production carries an Einsatzobjekt called «Grosspläne»,
    address «Grosspläne», zero plans, because an earlier import created the object first and
    matched the file names afterwards. A folder whose files yield no Modul slot yields no
    object — and «Alle Modul 6.pdf», which sits loose at the top of this library, is not one
    either: a plan lives one folder deep or not at all."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant(
        {
            "Grosspläne/Bahnhofstrasse 6 - Gemeindebibliothek.pdf": PDF,
            "Grosspläne/Grenzweg 3 - BLT Park&Ride, BLT Busdepot.pdf": PDF,
            "Alle Modul 6.pdf": PDF,
        }
    )

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert (result["areas"]["plans"]["imported"], result["areas"]["plans"]["skipped"]) == (0, 3)
    assert (await db_session.execute(select(ObjectSite))).scalars().all() == []
    assert await datasets(db_session, "plan:") == []


async def test_a_sub_folder_of_an_object_is_not_a_plan(db_session, blank_env, storage_root):
    """Real objects here keep their «Vertrag» and «Zusatz» folders beside the Modul-PDFs. A
    plan is one folder deep; anything deeper is somebody's paperwork."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF, f"{OBERWIL_FOLDER}/Vertrag/Mietvertrag.pdf": PDF})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert (result["areas"]["plans"]["imported"], result["areas"]["plans"]["skipped"]) == (1, 1)


async def test_a_deployment_with_no_match_rule_imports_nothing_and_says_so(db_session, blank_env, storage_root):
    """Fail-closed rather than guess: `modules[].match` is the only thing that can tell a
    Modul-PDF from any other file, and guessing is how a deployment grows objects nobody
    created. A display-only catalogue (no `match` anywhere) counts as none."""
    await configure(db_session, [source("plans")], modules=[{"id": "modul1", "code": "M1"}])
    tenant = FakeTenant({f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["status"] == "needs_review"
    assert "carries a 'match' rule" in (result["areas"]["plans"]["detail"] or "")
    assert (await db_session.execute(select(ObjectSite))).scalars().all() == []


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


async def test_the_layer_write_keeps_a_section_this_build_does_not_know(db_session, blank_env, storage_root):
    """⚠️ The poll writes the WHOLE document, so it must write the stored JSON back as it stands.

    It used to round-trip through `load_stored_config(...).model_dump()`, and a pydantic dump
    keeps only what the RUNNING schema declares: any section a newer build wrote — the trap
    `DeploymentConfigIn.sharepoint` carries a warning about in so many words — was dropped from
    a station's config by a background job nobody triggered, on a poll that reported success.
    """
    db_session.add(DeploymentConfig(id=1, config_json={"futureSection": {"keep": "me"}}))
    await db_session.flush()
    await configure(db_session, [source("geodata")])
    tenant = FakeTenant({"hydranten.geojson": geojson(2)})

    await sync_sharepoint(db_session, transport=tenant.transport)

    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    assert row.config_json["futureSection"] == {"keep": "me"}
    assert [layer["id"] for layer in row.config_json["referenceLayers"]] == ["hydranten"]


async def test_the_layer_write_reads_the_row_as_it_stands_rather_than_as_it_read_it(
    db_session, blank_env, storage_root
):
    """⚠️ This is the one full-document writer with no `If-Match` to fall back on — nobody holds
    a version for a scheduled poll — so it takes the row FOR UPDATE and re-reads it inside the
    transaction. Without the re-read (`populate_existing`) the session hands back the copy it
    loaded before the download started, and an admin saving in the Verwaltung during the walk is
    overwritten by a document that predates their save.

    SQLite cannot show the lock half at all, so what is pinned here is the re-read: the row is
    changed underneath the session after it has already been loaded.
    """
    import json as _json

    from sqlalchemy import text

    await configure(db_session, [source("geodata")])
    loaded = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    # The session is now holding that document; an admin saves in the Verwaltung meanwhile.
    # ⚠️ Written as TEXTUAL SQL on purpose: an ORM `update()` tells this session to expire what
    # it changed, which is the one thing a write from another process cannot do — and a test the
    # ORM repairs behind the scenes would pass with or without the re-read.
    saved = {**loaded.config_json, "identity": {"appName": "Von der Verwaltung"}}
    await db_session.execute(
        text("UPDATE deployment_config SET config_json = :doc WHERE id = 1"),
        {"doc": _json.dumps(saved)},
    )
    tenant = FakeTenant({"hydranten.geojson": geojson(2)})

    await sync_sharepoint(db_session, transport=tenant.transport)

    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one()
    assert row.config_json["identity"]["appName"] == "Von der Verwaltung"
    assert [layer["id"] for layer in row.config_json["referenceLayers"]] == ["hydranten"]


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


# --- a run that fails half way -----------------------------------------------------------
#
# The class of defect this section exists for: a run that went wrong and left the card green.
# Every one of these was reachable in the shipped connector — a stranded cursor, a memoised file
# nobody fetched, an exception that took the whole run's report with it.


async def test_a_failed_walk_does_not_strand_the_changed_files_behind_a_fresh_cursor(
    db_session, blank_env, storage_root
):
    """⚠️ The delta cursor says «everything up to here has been seen». Taking the new one before
    the walk and then failing the walk moved it past files nobody read: the next poll asked
    «anything since?», heard «no», and reported «unverändert» in green over a plan that would
    never arrive. The cursor advances only after the walk returns."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)
    resume_point = (await state_of(db_session, "plans")).delta_token

    tenant.put("dorfmatt/modul2.pdf", PDF)
    tenant.fail_listing()  # the walk dies; the change is now inside the stranded window
    failed = await sync_sharepoint(db_session, transport=tenant.transport)
    assert failed["areas"]["plans"]["status"] == "unreachable"
    assert (await state_of(db_session, "plans")).delta_token == resume_point, "a failed walk is no resume point"

    tenant.heal()
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 1, "the file changed while the walk was broken"
    oid = object_id_for_key("dorfmatt")
    assert await datasets(db_session, "plan:") == [f"plan:{oid}:modul1", f"plan:{oid}:modul2"]


async def test_a_throttled_delta_call_is_not_a_resume_point_either(db_session, blank_env, storage_root):
    """The same stranding, one request earlier: the change feed itself 429s. Nothing is walked,
    nothing is recorded, and the change is still there to find when the throttle lifts."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF})
    await sync_sharepoint(db_session, transport=tenant.transport)

    tenant.put("dorfmatt/modul2.pdf", PDF)
    tenant.fail_delta(429)
    tenant.seen.clear()
    failed = await sync_sharepoint(db_session, transport=tenant.transport)

    assert failed["areas"]["plans"]["status"] == "unreachable"
    assert not any("/children" in url for url in tenant.seen), "a failed delta must not be walked past"

    tenant.heal()
    result = await sync_sharepoint(db_session, transport=tenant.transport)
    assert result["areas"]["plans"]["imported"] == 1


async def test_a_collision_stays_on_the_card_until_somebody_fixes_the_config(db_session, blank_env, storage_root):
    """⚠️ `needs_review` arises only after a walk, which advances the cursor — so the next poll
    took the «nothing changed» shortcut and wrote `detail = None` over the reason. The area went
    green within one interval while both Wasser sheets stayed unimported. A state that is not
    ok/unchanged is never resumed from: it walks, re-checks, and keeps saying so."""
    narrow = [{**m, "match": OBERWIL_MODUL5_MATCH} if m["id"] == "modul5" else m for m in MODULES]
    await configure(db_session, [source("plans")], modules=narrow)
    tenant = FakeTenant(
        {
            f"{OBERWIL_FOLDER}/Modul 1.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 5 - Wasser 1.pdf": PDF,
            f"{OBERWIL_FOLDER}/Modul 5 - Wasser 2.pdf": PDF,
        }
    )
    await sync_sharepoint(db_session, transport=tenant.transport)

    # A poll where SharePoint genuinely has nothing new to report.
    again = await sync_sharepoint(db_session, transport=tenant.transport)

    assert again["areas"]["plans"]["status"] == "needs_review"
    assert "claimed by two files at once" in (again["areas"]["plans"]["detail"] or "")
    assert (await state_of(db_session, "plans")).detail is not None

    # …and it clears the moment the collision does.
    tenant.remove(f"{OBERWIL_FOLDER}/Modul 5 - Wasser 2.pdf")
    fixed = await sync_sharepoint(db_session, transport=tenant.transport)

    assert (fixed["areas"]["plans"]["status"], fixed["areas"]["plans"]["detail"]) == ("ok", None)
    assert f"plan:{object_id_for_key(OBERWIL_KEY)}:modul5-wasser" in await datasets(db_session, "plan:")


async def test_a_plan_whose_download_failed_is_fetched_again_next_run(db_session, blank_env, storage_root):
    """⚠️ One 429 on one PDF used to lose that plan for good: the file was skipped, its NEW eTag
    was memoised anyway, and every later run compared equal and skipped it again — area `ok`.
    The memo records what was imported, never what was merely listed."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF, "dorfmatt/modul2.pdf": PDF})
    tenant.fail_download("dorfmatt/modul2.pdf")

    first = await sync_sharepoint(db_session, transport=tenant.transport)

    assert (first["areas"]["plans"]["imported"], first["areas"]["plans"]["skipped"]) == (1, 1)
    assert first["areas"]["plans"]["status"] == "needs_review", "a file that did not arrive is not a green run"
    assert "could not be fetched" in (first["areas"]["plans"]["detail"] or "")
    assert first["areas"]["plans"]["missing"] == 0, "listed and unfetched is not «gone from the source»"

    tenant.heal()
    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["plans"]["imported"] == 1
    oid = object_id_for_key("dorfmatt")
    assert await datasets(db_session, "plan:") == [f"plan:{oid}:modul1", f"plan:{oid}:modul2"]


async def test_a_layer_whose_download_failed_is_fetched_again_next_run(db_session, blank_env, storage_root):
    await configure(db_session, [source("geodata")])
    tenant = FakeTenant({"hydranten.geojson": geojson(3), "gefahren.geojson": geojson(1)})
    tenant.fail_download("gefahren.geojson")

    first = await sync_sharepoint(db_session, transport=tenant.transport)

    assert first["areas"]["geodata"]["status"] == "needs_review"
    assert await datasets(db_session, "geo:") == ["geo:hydranten"]

    tenant.heal()
    await sync_sharepoint(db_session, transport=tenant.transport)

    assert await datasets(db_session, "geo:") == ["geo:gefahren", "geo:hydranten"]


async def test_a_checklist_diagram_whose_download_failed_is_fetched_again_next_run(db_session, blank_env, storage_root):
    await configure(db_session, [source("checklists")])
    template = b'{"id": "fu-aktion", "kind": "action", "title": "Aufgaben FU", "phases": [{"id": "a"}]}'
    tenant = FakeTenant({"fu-aktion.json": template, "fu-aktion-p12.jpg": b"\xff\xd8jpeg"})
    tenant.fail_download("fu-aktion-p12.jpg")

    first = await sync_sharepoint(db_session, transport=tenant.transport)

    assert first["areas"]["checklists"]["status"] == "needs_review"
    assert await datasets(db_session, "checklists:") == ["checklists:fu-aktion"]

    tenant.heal()
    await sync_sharepoint(db_session, transport=tenant.transport)

    assert await datasets(db_session, "checklists:") == ["checklists:fu-aktion", "checklists:fu-aktion:p12"]


async def test_an_area_that_raises_reports_error_and_the_others_keep_their_run(db_session, blank_env, storage_root):
    """⚠️ `error` was enumerated everywhere and assigned nowhere: an importer raising propagated
    out of the run to the scheduler, which rolled back the data AND every state row, so the card
    kept showing the previous run for ever. A file named .xlsx that is not a workbook is the
    cheapest way to make the importer raise — and the Objektpläne beside it must not care."""
    await configure(db_session, [source("plans"), source("workbook")])
    tenant = FakeTenant({"dorfmatt/modul1.pdf": PDF, "arbeitsmappe.xlsx": b"this is not a workbook at all"})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert result["areas"]["workbook"]["status"] == "error"
    assert result["areas"]["workbook"]["detail"], "the row has to say something an operator can act on"
    workbook = await state_of(db_session, "workbook")
    assert (workbook.status, workbook.last_run_at is not None, workbook.last_success_at) == ("error", True, None)

    assert result["areas"]["plans"]["imported"] == 1
    assert await datasets(db_session, "plan:") == [f"plan:{object_id_for_key('dorfmatt')}:modul1"]
    assert (await state_of(db_session, "plans")).status == "ok"


async def test_a_path_one_level_too_high_says_what_it_skipped(db_session, blank_env, storage_root):
    """⚠️ Refuse-to-empty deliberately spares a FIRST run, so a `path` pointing one folder above
    the objects listed 336 files, matched none of them and reported `imported: 0, skipped: 336,
    status: ok`. Every skip was a log line nobody reads. The dominant reason is now the detail."""
    await configure(db_session, [source("plans")])
    tenant = FakeTenant({f"Einsatzpläne/{OBERWIL_FOLDER}/Modul {n}.pdf": PDF for n in (1, 2, 6)})

    result = await sync_sharepoint(db_session, transport=tenant.transport)

    assert (result["areas"]["plans"]["imported"], result["areas"]["plans"]["skipped"]) == (0, 3)
    assert result["areas"]["plans"]["status"] == "needs_review"
    assert "not a <Objektordner>/<Modul>.pdf" in (result["areas"]["plans"]["detail"] or "")
    assert (await db_session.execute(select(ObjectSite))).scalars().all() == []


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
