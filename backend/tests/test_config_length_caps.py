"""A stored string past its length cap is served AS IT LIES (schemas · LengthCap).

A length cap is input hygiene, not integrity: a label typed before a cap existed must not cost
the station its whole config (on base, one such value made every device read the shipped
defaults), and leaving the value out or cutting it would change what the rest of the document
means. New input stays held to the cap. Every other rule still holds on the original values.
"""

import asyncio
import copy

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.admin_geodata import GeodataManifestEntry, _push
from app.deployment_config import safe_config
from app.models import DeploymentConfig
from app.schemas import DeploymentConfigIn, load_stored_config
from tests.conftest import TEST_ADMIN_SECRET

LINK = {"id": "getraenke", "title": "Getränke", "url": "https://forms.example.ch/g", "note": None}
DEST = {"id": "ablage", "siteUrl": "https://fw.sharepoint.com/sites/objekte"}

# A station with a value in every section #798 put a length guard on.
STATION = {
    "identity": {"appName": "Feuerwehr Talheim"},
    "report": {"partnerOrgs": ["Polizei BL"], "links": [LINK]},
    "objectVisits": {
        "enabled": True,
        "lockAfterHours": 48,
        "proposalFields": [{"id": "zufahrt", "label": "Zufahrt"}],
        "destinations": [DEST],
    },
    "map": {
        "objectCategories": [{"id": "pv", "label": "PV", "color": "#ff0000", "match": {"modules": ["modul5-pv*"]}}]
    },
}


# --- the means ------------------------------------------------------------------------------------


def _string_caps(node: object, path: tuple = (), wrapped: bool = False, out: list | None = None) -> list:
    """Every ``str`` core schema with a ``max_length`` in ``node``: (path, inside a LengthCap)."""
    out = [] if out is None else out
    if isinstance(node, dict):
        fn = (node.get("function") or {}).get("function") if node.get("type") == "function-wrap" else None
        wrapped = wrapped or getattr(fn, "__qualname__", "").startswith("LengthCap.")
        if node.get("type") == "str" and "max_length" in node:
            out.append((".".join(str(p) for p in path if isinstance(p, str)), wrapped))
        for key, child in node.items():
            _string_caps(child, (*path, key), wrapped, out)
    elif isinstance(node, list):
        for child in node:
            _string_caps(child, path, wrapped, out)
    return out


def test_every_capped_string_of_the_document_is_a_length_cap():
    """A `Field(max_length=…)` added to the document later would take it down on a stored read
    again – this names it."""
    caps = _string_caps(DeploymentConfigIn.__pydantic_core_schema__)
    assert len([p for p, wrapped in caps if wrapped]) >= 23
    assert [p for p, wrapped in caps if not wrapped] == []


def test_new_input_keeps_the_cap_and_a_stored_document_keeps_its_value():
    doc = {"report": {"links": [{**LINK, "title": "t" * 121}]}}
    with pytest.raises(ValidationError) as refused:
        DeploymentConfigIn.model_validate(doc)
    assert [(e["type"], e["loc"], e["ctx"]) for e in refused.value.errors()] == [
        ("string_too_long", ("report", "links", 0, "title"), {"max_length": 120})
    ]
    assert load_stored_config(doc).report.links[0].title == "t" * 121


def test_an_id_keeps_what_it_accepted_before_and_the_64_its_tables_hold():
    """`match`, as before the caps were relaxed on a read: a stored «kontakt\n» still passes. The
    64 characters are a rule of the delivery tables, not a length cap, so they hold on a read."""
    field = {"id": "kontakt\n", "label": "Kontakt"}
    assert (
        load_stored_config({"objectVisits": {"proposalFields": [field]}}).objectVisits.proposalFields[0].id
        == "kontakt\n"
    )
    with pytest.raises(ValidationError, match="lower-case"):
        load_stored_config({"objectVisits": {"destinations": [{**DEST, "id": "a" * 64 + "\n"}]}})


def test_a_stored_document_still_keeps_every_other_rule():
    with pytest.raises(ValidationError, match="too_long"):  # a list cap is not relaxed
        load_stored_config({"report": {"links": [{**LINK, "id": f"l{i}"} for i in range(31)]}})
    category = {"id": "A" * 41, "label": "L", "color": "#ff0000"}
    with pytest.raises(ValidationError, match="string_pattern_mismatch"):  # nor the pattern of a long value
        load_stored_config({"map": {"objectCategories": [category]}})
    with pytest.raises(ValidationError, match="must not be blank"):  # nor a field validator
        load_stored_config({"report": {"links": [{**LINK, "title": " " * 121}]}})


# --- what GET serves ------------------------------------------------------------------------------


async def _stored(session_factory) -> dict:
    async with session_factory() as db:
        return await db.scalar(select(DeploymentConfig.config_json))


async def _store(session_factory, document: dict) -> None:
    async with session_factory() as db:
        row = await db.get(DeploymentConfig, 1)
        if row is None:
            db.add(DeploymentConfig(id=1, config_json=copy.deepcopy(document)))
        else:
            row.config_json = copy.deepcopy(document)
        await db.commit()


def _at(doc: dict, path: tuple) -> tuple[dict | list, str | int]:
    *parents, leaf = path
    for key in parents:
        doc = doc[key]
    return doc, leaf


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("path", "long"),
    [
        (("objectVisits", "proposalFields", 0, "label"), "x" * 121),
        (("report", "links", 0, "url"), "https://forms.example.ch/" + "a" * 2048),
        (("objectVisits", "destinations", 0, "visitFolder"), "Objektbesuche/" + "v" * 190 + " {date}"),
        (("map", "objectCategories", 0, "match", "modules", 0), "m" * 61),
    ],
    ids=["proposal-label", "report-link-url", "destination-folder", "category-module"],
)
async def test_one_over_long_value_is_served_as_stored_and_changes_nothing_else(
    client, admin_login, session_factory, path, long
):
    """GET of the document with the long value = GET of its valid twin with that one value
    swapped in. On base the long one served the shipped defaults (`appName` None)."""
    await admin_login(client)
    await _store(session_factory, STATION)
    expected = (await client.get("/api/config")).json()
    parent, leaf = _at(expected, path)
    parent[leaf] = long

    document = copy.deepcopy(STATION)
    parent, leaf = _at(document, path)
    parent[leaf] = long
    await _store(session_factory, document)
    r = await client.get("/api/config")
    assert r.status_code == 200, r.text
    served = r.json()
    served.pop("version"), expected.pop("version")
    assert served == expected
    assert await _stored(session_factory) == document  # a read never rewrites the row


@pytest.mark.asyncio
async def test_a_long_value_does_not_carry_a_broken_one_past_the_read(client, viewer, session_factory):
    """The over-long root also has a `..` segment past the cap. Every other rule runs on the
    ORIGINAL value, so the document still reads as the shipped defaults, as on base: the module is
    off and the viewer cannot capture."""
    document = {
        "identity": {"appName": "Feuerwehr Talheim"},
        "objectVisits": {
            "enabled": True,
            "captureRoles": ["viewer"],
            "destinations": [{**DEST, "root": "x" * 400 + "/../Old"}],
        },
    }
    await _store(session_factory, document)
    served = safe_config(document)
    assert (served.identity.appName, served.objectVisits.enabled) == (None, False)
    r = await client.post("/api/auth/login", json={"user_id": str(viewer.id), "pin": "135790"})
    assert r.status_code == 200
    r = await client.get("/api/object-visits")
    assert r.status_code == 404 and "nicht eingeschaltet" in r.text


@pytest.mark.asyncio
async def test_neighbours_of_a_long_value_are_served_as_stored(client, admin_login, session_factory):
    """Nothing is left out, so nothing moves: two Formulare that share an id stay two, and an
    Ausrüstung a Mittel points at stays in the list."""
    camera = {"id": "local-camera", "label": "Wärmebildkamera der Nachbarfeuerwehr Talheim"}
    assert len(camera["label"]) > 40
    document = {
        "report": {"links": [{**LINK, "id": "form", "title": "t" * 121}, {**LINK, "id": "form"}]},
        "doctrine": {"equipment": [camera]},
        "mittel": {"catalogue": [{"id": "wbk", "label": "WBK", "equipment": "local-camera"}]},
    }
    await admin_login(client)
    await _store(session_factory, document)
    served = (await client.get("/api/config")).json()
    assert [(link["id"], link["title"]) for link in served["report"]["links"]] == [
        ("form", "t" * 121),
        ("form", "Getränke"),
    ]
    assert served["doctrine"]["equipment"] == [camera]
    assert served["mittel"]["catalogue"][0]["equipment"] == "local-camera"


# --- what a write does with it --------------------------------------------------------------------


def _long_label_station() -> dict:
    document = copy.deepcopy(STATION)
    document["objectVisits"]["proposalFields"][0]["label"] = "x" * 121
    return document


@pytest.mark.asyncio
async def test_a_put_that_still_carries_the_long_value_is_refused_and_stores_nothing(
    client, admin_login, session_factory
):
    """What the admin form's autosave sends after an unrelated edit: the whole document as GET
    served it. New input keeps the cap, so the PUT says which field and the row stays as it was."""
    await admin_login(client)
    document = _long_label_station()
    await _store(session_factory, document)
    body = (await client.get("/api/config")).json()
    version = body.pop("version")
    body["doctrine"]["alarmBar"] = 120  # the unrelated edit
    r = await client.put("/api/config", json=body, headers={"If-Match": version})
    assert r.status_code == 422
    [error] = r.json()["detail"]
    assert (error["type"], error["loc"]) == (
        "string_too_long",
        ["body", "objectVisits", "proposalFields", "0", "label"],
    )
    assert await _stored(session_factory) == document

    body["objectVisits"]["proposalFields"][0]["label"] = "x" * 120  # …and shortening it is the way out
    r = await client.put("/api/config", json=body, headers={"If-Match": version})
    assert r.status_code == 200, r.text
    assert (await _stored(session_factory))["objectVisits"]["proposalFields"][0]["label"] == "x" * 120


class _AppBridge:
    """`httpx.Client` for `admin_geodata._push`, which is sync: every call goes to the async test
    client on the test's own loop, so the push talks to the real app."""

    def __init__(self, client: httpx.AsyncClient, loop: asyncio.AbstractEventLoop):
        self._client, self._loop = client, loop

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return None

    def _call(self, method: str, url: str, **kw):
        return asyncio.run_coroutine_threadsafe(getattr(self._client, method)(url, **kw), self._loop).result(30)

    def post(self, url: str, **kw):
        return self._call("post", url, **kw)

    def get(self, url: str, **kw):
        return self._call("get", url, **kw)

    def put(self, url: str, **kw):
        return self._call("put", url, **kw)


@pytest.mark.asyncio
async def test_a_geodata_push_against_such_a_document_fails_loudly_and_stores_nothing(
    client, session_factory, monkeypatch, capsys, tmp_path
):
    """The nightly demo reset runs this unattended: it GETs the document, replaces
    `referenceLayers` and PUTs the whole thing back."""
    document = _long_label_station()
    await _store(session_factory, document)
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(httpx, "Client", lambda **_kw: _AppBridge(client, loop))
    entries = [GeodataManifestEntry(id="ortho", kind="wms", tiles=["https://wms.example.ch/{z}/{x}/{y}"])]

    with pytest.raises(SystemExit):
        await asyncio.to_thread(
            _push, tmp_path / "geodata.manifest.json", entries, "http://test", TEST_ADMIN_SECRET, False
        )
    assert "PUT /api/config failed (422)" in capsys.readouterr().err
    assert await _stored(session_factory) == document


# --- what Objektbesuche do with it ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_long_proposal_label_reaches_both_catalogues_and_a_visit_can_use_it(client, editor, db_session):
    """The catalogue hands the configured field out, the capture copies its label into a
    proposal, and the visit saves with it – none of the three applies the input cap to it."""
    from tests.ov_support import bearer, login, make_object, new_id, put, set_config, set_key, visit_doc

    long = "Kontakt der Eigentümerschaft " + "x" * 100
    await set_config(db_session, {"proposalFields": [{"id": "kontakt", "label": long}]})
    await set_key(db_session)
    obj = await make_object(db_session)

    r = await client.get("/api/integrations/object-visits/catalogue", headers=bearer())
    assert r.status_code == 200, r.text
    assert r.json()["proposalFields"] == [{"id": "kontakt", "label": long}]
    await login(client, editor)
    r = await client.get("/api/object-visits/catalogue")
    assert r.status_code == 200, r.text
    assert r.json()["proposalFields"] == [{"id": "kontakt", "label": long}]

    vid = new_id("ov")
    proposal = {"id": "ovp1234567", "field": "kontakt", "label": long, "proposed": "Frau Muster"}
    r = await put(client, vid, visit_doc(vid, obj, proposals=[proposal]), None)
    assert r.status_code in (200, 201), r.text
    free_text = {**proposal, "field": "andere", "label": "y" * 121}  # a label nobody configured keeps the cap
    r = await put(client, vid, visit_doc(vid, obj, proposals=[free_text]), 1)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_a_saved_long_proposal_label_survives_a_shorter_field(client, editor, db_session):
    """The station shortens the configured label after a visit stored the long one: editing that
    visit again must not be refused over a label it already holds."""
    from tests.ov_support import login, make_object, new_id, put, set_config, visit_doc

    long = "Kontakt der Eigentümerschaft " + "x" * 100
    await set_config(db_session, {"proposalFields": [{"id": "kontakt", "label": long}]})
    obj = await make_object(db_session)
    await login(client, editor)
    vid = new_id("ov")
    proposal = {"id": "ovp1234567", "field": "kontakt", "label": long, "proposed": "Frau Muster"}
    assert (await put(client, vid, visit_doc(vid, obj, proposals=[proposal]), None)).status_code in (200, 201)

    await set_config(db_session, {"proposalFields": [{"id": "kontakt", "label": "Kontakt"}]})
    r = await put(client, vid, visit_doc(vid, obj, proposals=[proposal], notes="nachgetragen"), 1)
    assert r.status_code == 200, r.text


# --- a read is a fixed point ----------------------------------------------------------------------

UNSTABLE_ROOT = {**DEST, "root": "/" + "r" * 400 + "/.. /"}  # «.. » is «..» once trimmed


@pytest.mark.asyncio
async def test_a_document_that_does_not_read_back_as_itself_reads_as_the_defaults(client, admin_login, session_factory):
    """The first pass kept a «.. » segment the second pass trims to «..» and refuses: the
    response then failed (500) where base served the defaults."""
    await admin_login(client)
    document = {
        "identity": {"appName": "Feuerwehr Talheim"},
        "objectVisits": {"enabled": True, "destinations": [UNSTABLE_ROOT]},
    }
    await _store(session_factory, document)
    r = await client.get("/api/config")
    assert r.status_code == 200, r.text
    assert (r.json()["identity"]["appName"], r.json()["objectVisits"]["enabled"]) == (None, False)
    assert await _stored(session_factory) == document


@pytest.mark.asyncio
async def test_a_snapshot_that_cannot_be_served_is_not_restored(client, admin_login, session_factory):
    from app.models import DeploymentConfigHistory

    await admin_login(client)
    await _store(session_factory, STATION)
    async with session_factory() as db:
        entry = DeploymentConfigHistory(
            config_json={"objectVisits": {"enabled": True, "destinations": [UNSTABLE_ROOT]}}, source="api"
        )
        db.add(entry)
        await db.commit()
        entry_id = entry.id
    r = await client.post(f"/api/config/history/{entry_id}/restore")
    assert r.status_code == 422 and "nicht wiederherstellen" in r.text
    assert await _stored(session_factory) == STATION


ARCHIVE = {"id": "archiv", "siteUrl": "https://fw.sharepoint.com/sites/archiv"}
LONG = "x" * 2100  # past every cap of the document

#: Every capped string of the document, as (path, its over-long value).
CAPPED: list[tuple[tuple, str]] = [
    (("identity", "shortName"), LONG),
    (("map", "objectCategories", 0, "id"), LONG),
    (("map", "objectCategories", 0, "match", "modules", 0), LONG),
    (("doctrine", "equipment", 0, "id"), LONG),
    (("doctrine", "equipment", 0, "label"), LONG),
    (("report", "links", 0, "id"), LONG),
    (("report", "links", 0, "title"), LONG),
    (("report", "links", 0, "url"), "https://forms.example.ch/" + LONG),
    (("report", "links", 0, "note"), LONG),
    (("objectVisits", "proposalFields", 0, "id"), LONG),
    (("objectVisits", "proposalFields", 0, "label"), LONG),
    (("objectVisits", "destinations", 0, "id"), LONG),
    (("objectVisits", "destinations", 0, "siteUrl"), "https://fw.sharepoint.com/sites/" + LONG),
    (("objectVisits", "destinations", 0, "library"), LONG),
    (("objectVisits", "destinations", 0, "root"), LONG),
    (("objectVisits", "destinations", 0, "objectFolder"), LONG),
    (("objectVisits", "destinations", 0, "visitFolder"), LONG),
    (("objectVisits", "destinations", 0, "locationFolder"), LONG),
    (("incidentArchive", "destinations", 0, "id"), LONG),
    (("incidentArchive", "destinations", 0, "siteUrl"), "https://fw.sharepoint.com/sites/" + LONG),
    (("incidentArchive", "destinations", 0, "library"), LONG),
    (("incidentArchive", "destinations", 0, "photoFolder"), LONG + "/{date}"),
    (("incidentArchive", "destinations", 0, "reportFolder"), LONG + "/{date}"),
]

#: What a hand-edited or older row may wrap such a value in.
SHAPES = [
    lambda v: v,
    lambda v: f"  {v}  ",
    lambda v: f"/{v}/.. /",
    lambda v: f"Basel\\{v}",
    lambda v: f"{v}/ /",
]


def test_every_over_long_value_that_reads_reads_back_as_itself():
    """Property over every capped string × the shapes above: a value past its cap that a read
    accepts dumps and validates again to the same value. Anything else is refused on the read,
    which then serves the defaults (`safe_config`) – never a document the response refuses."""
    assert len(CAPPED) == len(
        [p for p, wrapped in _string_caps(DeploymentConfigIn.__pydantic_core_schema__) if wrapped]
    )
    base = {
        "identity": {},
        "map": {"objectCategories": [{"id": "pv", "label": "PV", "color": "#ff0000", "match": {"modules": ["m"]}}]},
        "doctrine": {"equipment": [{"id": "wbk", "label": "WBK"}]},
        "report": {"links": [LINK]},
        "objectVisits": {"proposalFields": [{"id": "kontakt", "label": "Kontakt"}], "destinations": [DEST]},
        "incidentArchive": {"destinations": [ARCHIVE]},
    }
    served = 0
    for path, long in CAPPED:
        for shape in SHAPES:
            document = copy.deepcopy(base)
            parent, leaf = _at(document, path)
            parent[leaf] = shape(long)
            try:
                doc = load_stored_config(document)
            except (ValidationError, ValueError):
                continue
            served += 1
            dumped = doc.model_dump(mode="json")
            assert load_stored_config(dumped).model_dump(mode="json") == dumped, (path, shape(long)[:20])
    assert served >= 40  # the property is about values that ARE served


# --- a writer on another key ----------------------------------------------------------------------

BACKSLASH_ROOT = {**DEST, "root": "Basel\\" + "r" * 400}


@pytest.mark.asyncio
async def test_a_branding_write_refuses_rather_than_rewrite_an_over_long_value(client, admin_login, session_factory):
    """The logo delete would have written the untouched root back normalised («/» for «\\»). It
    is refused with the 422 the autosave gets, and the row stays as it was."""
    await admin_login(client)
    document = {
        "identity": {"appName": "Feuerwehr Talheim"},
        "objectVisits": {"enabled": True, "destinations": [BACKSLASH_ROOT]},
    }
    await _store(session_factory, document)

    r = await client.delete("/api/branding/logo")
    assert r.status_code == 422
    [error] = r.json()["detail"]
    assert (error["type"], error["loc"]) == ("string_too_long", ["body", "objectVisits", "destinations", "0", "root"])
    assert await _stored(session_factory) == document


@pytest.mark.asyncio
async def test_a_rank_adoption_refuses_rather_than_rewrite_an_over_long_value(db_session, session_factory):
    from app.personnel import adopt_ranks

    document = {
        "roster": {"ranks": [{"key": "wm", "label": "Wachtmeister"}]},
        "report": {"links": [{**LINK, "title": "t" * 121}]},
    }
    await _store(session_factory, document)
    with pytest.raises(ValidationError, match="string_too_long"):
        await adopt_ranks(db_session, ["Sdt"], None)
    await db_session.rollback()
    assert await _stored(session_factory) == document


@pytest.mark.asyncio
async def test_a_sharepoint_path_reads_as_on_main(client, admin_login, session_factory):
    """«/ Station /»: main's read keeps « Station » (one trim), and its GET answer trims once more
    («Station»). Neither is a reason for the defaults."""
    source = {"area": "plans", "siteUrl": "https://fw.sharepoint.com/sites/plaene", "path": "/ Station /"}
    document = {"identity": {"appName": "Feuerwehr Talheim"}, "sharepoint": {"sources": [source]}}
    assert safe_config(document).sharepoint.sources[0].path == " Station "
    await admin_login(client)
    await _store(session_factory, document)
    served = (await client.get("/api/config")).json()
    assert (served["identity"]["appName"], served["sharepoint"]["sources"][0]["path"]) == (
        "Feuerwehr Talheim",
        "Station",
    )


@pytest.mark.asyncio
async def test_an_over_long_short_name_is_refused_alike_by_every_write(client, admin_login, session_factory):
    """The autosave and a merging writer (the logo delete) give the same 422 body for it."""
    await admin_login(client)
    document = {"identity": {"appName": "Feuerwehr Talheim", "shortName": "Steintal Nord"}}
    await _store(session_factory, document)
    body = (await client.get("/api/config")).json()
    assert body["identity"]["shortName"] == "Steintal Nord"  # a read keeps it
    version = body.pop("version")
    put = await client.put("/api/config", json=body, headers={"If-Match": version})
    delete = await client.delete("/api/branding/logo")
    assert put.status_code == delete.status_code == 422
    assert put.json()["detail"] == delete.json()["detail"]
    assert "Kurzname" in put.json()["detail"][0]["msg"]
    assert await _stored(session_factory) == document


@pytest.mark.asyncio
async def test_a_refused_logo_upload_stores_no_file(client, admin_login, session_factory, monkeypatch):
    import app.api.branding as branding

    stored_files: list[str] = []
    monkeypatch.setattr(branding.storage, "put_bytes", lambda key, data: stored_files.append(key))
    await admin_login(client)
    document = {"objectVisits": {"enabled": True, "destinations": [BACKSLASH_ROOT]}}
    await _store(session_factory, document)
    svg = b"<svg xmlns='http://www.w3.org/2000/svg'/>"
    r = await client.post("/api/branding/logo", files={"file": ("logo.svg", svg, "image/svg+xml")})
    assert r.status_code == 422
    assert stored_files == []
    assert await _stored(session_factory) == document


@pytest.mark.asyncio
async def test_a_snapshot_with_a_value_past_its_cap_is_not_restored(client, admin_login, session_factory):
    """A restore STORES a whole document, so the caps hold: such a snapshot is refused (as on
    base), and the row stays as it was."""
    from app.models import DeploymentConfigHistory

    await admin_login(client)
    await _store(session_factory, STATION)
    async with session_factory() as db:
        snapshot = {"report": {"links": [{**LINK, "title": "t" * 121}]}}
        entry = DeploymentConfigHistory(config_json=snapshot, source="api")
        db.add(entry)
        await db.commit()
        entry_id = entry.id
    r = await client.post(f"/api/config/history/{entry_id}/restore")
    assert r.status_code == 422 and "nicht wiederherstellen" in r.text
    assert await _stored(session_factory) == STATION


# --- a document main serves reads exactly as on main ---------------------------------------------


@pytest.mark.parametrize("root", ["x/ /", "a/.. /", "/ Station /"])
def test_a_document_with_no_value_past_its_cap_reads_as_main_reads_it(root):
    """The new rules – the fixed point, the trim until nothing changes – are for a document main
    refused as a whole. Main trims a root ONCE («x/ /» → «x/ », «a/.. /» → «a/.. »): neither
    reads back as itself, and both are still served exactly as main serves them."""
    document = {
        "identity": {"appName": "Feuerwehr Talheim"},
        "objectVisits": {"enabled": True, "destinations": [{**DEST, "root": root}]},
    }
    once = root.replace("\\\\", "/").strip().strip("/")
    served = safe_config(document)
    assert (served.identity.appName, served.objectVisits.destinations[0].root) == ("Feuerwehr Talheim", once)
    assert load_stored_config(document) == DeploymentConfigIn.model_validate(document, context={"stored": True})


@pytest.mark.parametrize("name", ["defaults", "demo"])
def test_the_shipped_and_the_demo_config_read_as_plain_stored_mode(name):
    import json
    from pathlib import Path

    document = (
        DeploymentConfigIn().model_dump(mode="json")
        if name == "defaults"
        else json.loads((Path(__file__).parents[2] / "examples" / "demo-data" / "config.json").read_text())
    )
    plain = DeploymentConfigIn.model_validate(document, context={"stored": True}).model_dump(mode="json")
    assert load_stored_config(document).model_dump(mode="json") == plain
