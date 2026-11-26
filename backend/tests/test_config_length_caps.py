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
    again – this names it. `identity.shortName` cuts itself on a stored read (its own validator)."""
    caps = _string_caps(DeploymentConfigIn.__pydantic_core_schema__)
    assert len([p for p, wrapped in caps if wrapped]) >= 22
    assert [p for p, wrapped in caps if not wrapped and "shortName" not in p] == []


def test_new_input_keeps_the_cap_and_a_stored_document_keeps_its_value():
    doc = {"report": {"links": [{**LINK, "title": "t" * 121}]}}
    with pytest.raises(ValidationError) as refused:
        DeploymentConfigIn.model_validate(doc)
    assert [(e["type"], e["loc"], e["ctx"]) for e in refused.value.errors()] == [
        ("string_too_long", ("report", "links", 0, "title"), {"max_length": 120})
    ]
    assert load_stored_config(doc).report.links[0].title == "t" * 121


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
