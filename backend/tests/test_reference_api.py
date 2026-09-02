"""Reference-data HTTP surface: GET/PUT /api/reference/{id}, POST …/checklists/prune, …/fetch.

These are the datasets the field tablets pull — symbol packs, Leitungskataster layers,
checklists, Objektplan PDFs — so the contract under test is who may write them and what a
bad upload does *before* it reaches a phone:

- reading needs a session, writing/pruning/fetching needs the deployment admin;
- the type allowlist: octet-stream is tolerated ONLY on JSON-backed slots, a checklist
  diagram wants an image, anything else is 415 with the German detail /admin shows;
- a malformed checklist template is 422 and nothing is stored;
- a replace bumps the version, keeps what it wasn't given, and leaves exactly one blob;
- prune deletes every `checklists:*` not in `keep` — and touches nothing else;
- the `bbox` crop keeps intersecting features, keeps geometry-less ones (errs toward
  inclusion), and falls back to the whole file when the bbox is unusable;
- the fetch trigger maps the plan-pull outcomes onto the status codes /admin reacts to.

Storage is a per-test tmp dir. The snapshot pull itself is stubbed — its mechanism is
test_plan_snapshot's subject, the status mapping is this file's.
"""

import json
import uuid

import httpx
import pytest
from sqlalchemy import select

import app.storage as storage_mod
from app.api import reference as reference_mod
from app.api.reference import _feature_bbox, _overlaps
from app.models import ReferenceDataset

PDF = b"%PDF-1.4\nObjektplan Modul 1\n"
JPEG = b"\xff\xd8\xff\xe0fakejpegbytes"
TEMPLATE = {"id": "fu", "kind": "action", "title": "FU-Aktionen", "phases": [{"id": "p", "title": "P"}]}

# Two hydrants a canton apart plus a row the surveyor exported without a geometry.
INSIDE = {"type": "Feature", "properties": {"nr": "H1"}, "geometry": {"type": "Point", "coordinates": [7.60, 47.50]}}
OUTSIDE = {"type": "Feature", "properties": {"nr": "H2"}, "geometry": {"type": "Point", "coordinates": [9.00, 47.50]}}
NO_GEOM = {"type": "Feature", "properties": {"nr": "H3"}}


def _fc(*features: dict) -> bytes:
    return json.dumps({"type": "FeatureCollection", "features": list(features)}).encode()


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    """Point the storage root at a per-test tmp dir so uploads never touch data/storage."""
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))
    return tmp_path


def _blobs(tmp_path) -> list:
    d = tmp_path / "reference"
    return sorted(d.iterdir()) if d.is_dir() else []


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200, r.text


async def _put(client, dataset_id: str, data: bytes, content_type: str, **form: str) -> httpx.Response:
    return await client.put(
        f"/api/reference/{dataset_id}",
        files={"file": ("upload.bin", data, content_type)},
        data=form,
    )


async def _upload(client, admin_login, dataset_id: str, data: bytes, content_type: str, **form: str) -> dict:
    await admin_login(client)
    r = await _put(client, dataset_id, data, content_type, **form)
    assert r.status_code == 200, r.text
    return r.json()


# --- download ---------------------------------------------------------------------------


async def test_download_requires_a_session(client):
    r = await client.get("/api/reference/geo:hydrant")
    assert r.status_code == 401


async def test_unknown_dataset_is_404(client, viewer):
    await _login(client, viewer)
    r = await client.get("/api/reference/geo:gibtsnicht")
    assert r.status_code == 404
    assert r.json()["detail"] == "Datensatz nicht gefunden"


async def test_row_whose_blob_vanished_is_404_not_500(client, viewer, db_session):
    # A volume that lost its files (or a restored DB dump without the blobs) must read as
    # "nicht gefunden", not blow up in FileResponse.
    db_session.add(ReferenceDataset(id="geo:hydrant", kind="geojson", storage_key="reference/weg.geojson"))
    await db_session.commit()
    await _login(client, viewer)
    r = await client.get("/api/reference/geo:hydrant")
    assert r.status_code == 404


async def test_upload_then_download_roundtrip(client, viewer, admin_login):
    # An admin uploads, any signed-in user (here the read-only viewer) gets the exact bytes.
    await _upload(client, admin_login, "plan:muster:modul1", PDF, "application/pdf")
    await _login(client, viewer)
    r = await client.get("/api/reference/plan:muster:modul1")
    assert r.status_code == 200
    assert r.content == PDF
    assert r.headers["content-type"] == "application/pdf"


# --- bbox crop --------------------------------------------------------------------------


async def test_bbox_keeps_intersecting_and_geometryless_features(client, viewer, admin_login):
    await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE, OUTSIDE, NO_GEOM), "application/geo+json")
    await _login(client, viewer)
    r = await client.get("/api/reference/geo:hydrant", params={"bbox": "7.5,47.4,7.7,47.6"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/geo+json")
    body = r.json()
    assert body["type"] == "FeatureCollection"  # the rest of the collection survives the crop
    # H3 has no geometry at all — the crop errs toward inclusion rather than dropping data.
    assert [f["properties"]["nr"] for f in body["features"]] == ["H1", "H3"]


async def test_bbox_corners_may_arrive_in_any_order(client, viewer, admin_login):
    # west/south > east/north (a client that swapped the corners) must still crop, not invert.
    await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE, OUTSIDE), "application/geo+json")
    await _login(client, viewer)
    r = await client.get("/api/reference/geo:hydrant", params={"bbox": "7.7,47.6,7.5,47.4"})
    assert [f["properties"]["nr"] for f in r.json()["features"]] == ["H1"]


@pytest.mark.parametrize("bbox", ["kaputt", "7.5,47.4", "7.5,47.4,7.7,x"])
async def test_unusable_bbox_falls_back_to_the_whole_file(client, viewer, admin_login, bbox):
    # Better a big response than none: a client that garbles the bbox still gets its layer.
    await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE, OUTSIDE), "application/geo+json")
    await _login(client, viewer)
    r = await client.get("/api/reference/geo:hydrant", params={"bbox": bbox})
    assert r.status_code == 200
    assert len(r.json()["features"]) == 2


async def test_bbox_leaves_a_non_featurecollection_alone(client, viewer, admin_login):
    # A `geo:` slot holding something else (a bare array, a style doc) has nothing to crop —
    # it is handed back untouched instead of being reshaped into an empty FeatureCollection.
    await _upload(client, admin_login, "geo:hydrant", json.dumps([INSIDE]).encode(), "application/geo+json")
    await _login(client, viewer)
    r = await client.get("/api/reference/geo:hydrant", params={"bbox": "7.5,47.4,7.7,47.6"})
    assert r.status_code == 200
    assert r.json() == [INSIDE]


async def test_bbox_is_ignored_outside_geo_slots(client, viewer, admin_login):
    # Only the region-wide `geo:` layers are croppable; a symbol pack is served whole.
    await _upload(client, admin_login, "symbols:tactical", _fc(INSIDE, OUTSIDE), "application/json")
    await _login(client, viewer)
    r = await client.get("/api/reference/symbols:tactical", params={"bbox": "7.5,47.4,7.7,47.6"})
    assert len(r.json()["features"]) == 2


# --- replace: who may, and with what --------------------------------------------------


async def test_replace_is_admin_only(client, editor, admin_login):
    # A kiosk editor is not a deployment admin — reference data is a station-wide asset.
    await _login(client, editor)
    denied = await _put(client, "geo:hydrant", _fc(INSIDE), "application/geo+json")
    assert denied.status_code == 401
    assert denied.json()["detail"] == "Admin-Anmeldung erforderlich"

    await admin_login(client)
    ok = await _put(client, "geo:hydrant", _fc(INSIDE), "application/geo+json")
    assert ok.status_code == 200


async def test_type_outside_the_allowlist_is_415(client, admin_login):
    await admin_login(client)
    r = await _put(client, "geo:hydrant", b"<html>", "text/html")
    assert r.status_code == 415
    assert r.json()["detail"] == "Dateityp 'text/html' nicht erlaubt (erwartet: PDF oder GeoJSON/JSON)"


async def test_octet_stream_is_tolerated_only_on_json_slots(client, admin_login):
    # Browsers send octet-stream for .geojson — accepted there because the slot is parsed as
    # JSON below. A plan slot has no such check, so an unlabelled file stays refused.
    await admin_login(client)
    ok = await _put(client, "geo:hydrant", _fc(INSIDE), "application/octet-stream")
    assert ok.status_code == 200
    assert ok.json()["kind"] == "geojson"

    refused = await _put(client, "plan:muster:modul1", PDF, "application/octet-stream")
    assert refused.status_code == 415


async def test_checklist_diagram_slot_wants_an_image(client, admin_login):
    await admin_login(client)
    refused = await _put(client, "checklists:el-playbook:p12", PDF, "application/pdf")
    assert refused.status_code == 415
    assert (
        refused.json()["detail"] == "Dateityp 'application/pdf' nicht erlaubt (Checklisten-Diagramm erwartet ein Bild)"
    )

    ok = await _put(client, "checklists:el-playbook:p12", JPEG, "image/jpeg")
    assert ok.status_code == 200
    assert ok.json()["kind"] == "checklists"


# --- replace: the checklist template is validated before it is stored -------------------


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        (b"{nope", "Checkliste ist kein gültiges JSON:"),
        (b"[]", "Checkliste muss ein JSON-Objekt sein"),
        (json.dumps({"id": "fu", "kind": "action", "title": "  "}).encode(), "Checkliste: Feld 'title' fehlt"),
        (json.dumps({**TEMPLATE, "kind": "playbook"}).encode(), "Checkliste: unbekannte kind 'playbook'"),
        (json.dumps({"id": "fu", "kind": "action", "title": "FU"}).encode(), "Checkliste braucht genau eines von"),
    ],
)
async def test_malformed_template_is_refused_and_nothing_is_stored(
    client, admin_login, db_session, isolated_storage, payload, detail
):
    # The upload is the last place a broken checklist can be caught; at 3am the tablet only
    # gets what the store holds. So the 422 must also leave no row and no blob behind.
    await admin_login(client)
    r = await _put(client, "checklists:fu-aktion", payload, "application/json")
    assert r.status_code == 422
    assert r.json()["detail"].startswith(detail)
    assert (await db_session.execute(select(ReferenceDataset))).scalars().all() == []
    assert _blobs(isolated_storage) == []


async def test_valid_template_is_stored_as_a_checklist(client, admin_login):
    body = await _upload(client, admin_login, "checklists:fu-aktion", json.dumps(TEMPLATE).encode(), "application/json")
    assert body["kind"] == "checklists"
    # a template is JSON with no `features` — the geojson feature count must stay unset
    assert body["feature_count"] is None


# --- replace: what it stores and returns ------------------------------------------------


async def test_first_upload_creates_the_row_and_counts_features(client, admin_login):
    data = _fc(INSIDE, OUTSIDE)
    body = await _upload(client, admin_login, "geo:hydrant", data, "application/geo+json")
    assert body["kind"] == "geojson"
    assert body["feature_count"] == 2
    assert body["size_bytes"] == len(data)
    assert body["current_version"] == 1
    assert body["source_type"] == "uploaded"
    assert body["title"] == "geo:hydrant"  # untitled uploads fall back to the slot id


async def test_replace_bumps_the_version_keeps_the_title_and_leaves_one_blob(
    client, viewer, admin_login, isolated_storage
):
    await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE), "application/geo+json", title="Hydranten BL")
    # second upload omits title/source_note: an unchanged field must not be blanked
    second = await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE, OUTSIDE), "application/geo+json")
    assert second["current_version"] == 2
    assert second["title"] == "Hydranten BL"
    assert second["feature_count"] == 2

    # the superseded blob is dropped once the row stopped pointing at it
    assert len(_blobs(isolated_storage)) == 1
    await _login(client, viewer)
    served = await client.get("/api/reference/geo:hydrant")
    assert len(served.json()["features"]) == 2


async def test_broken_geojson_is_stored_without_a_feature_count(client, admin_login):
    # Deliberate leniency: the parse exists to count features, not to gate the upload. A layer
    # this server can't parse is still served to clients that can — but it reports no count.
    body = await _upload(client, admin_login, "geo:hydrant", b"{ not really geojson", "application/geo+json")
    assert body["feature_count"] is None
    assert body["size_bytes"] == len(b"{ not really geojson")


async def test_updated_by_stamps_the_person_but_not_the_cli(client, editor, admin_login, db_session):
    # Both doors carry the admin secret; only the /admin UI also carries a user session, and
    # only then may the audit stamp name someone.
    await _login(client, editor)
    await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE), "application/geo+json")
    row = (await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.id == "geo:hydrant"))).scalar_one()
    assert row.updated_by == editor.id

    client.cookies.delete("access_token")  # the CLI: admin secret, no user
    await _upload(client, admin_login, "symbols:tactical", _fc(INSIDE), "application/json")
    row = (
        await db_session.execute(select(ReferenceDataset).where(ReferenceDataset.id == "symbols:tactical"))
    ).scalar_one()
    assert row.updated_by is None


# --- prune ------------------------------------------------------------------------------


async def test_prune_is_admin_only(client, editor):
    await _login(client, editor)
    r = await client.post("/api/reference/checklists/prune", json=["checklists:fu-aktion"])
    assert r.status_code == 401


async def test_prune_drops_unlisted_checklists_only(client, admin_login, isolated_storage):
    # After a push the manifest is the truth: a renamed or deleted checklist must not stay
    # behind as a ghost the Checkliste surface would still fetch. Nothing else may be touched.
    await _upload(client, admin_login, "checklists:fu-aktion", json.dumps(TEMPLATE).encode(), "application/json")
    await _upload(client, admin_login, "checklists:alt-liste", json.dumps(TEMPLATE).encode(), "application/json")
    await _upload(client, admin_login, "checklists:el-playbook:p12", JPEG, "image/jpeg")
    await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE), "application/geo+json")
    assert len(_blobs(isolated_storage)) == 4

    r = await client.post(
        "/api/reference/checklists/prune",
        json=["checklists:fu-aktion", "checklists:el-playbook:p12"],
    )
    assert r.status_code == 200
    assert r.json() == {"pruned": ["checklists:alt-liste"]}
    assert len(_blobs(isolated_storage)) == 3  # the pruned dataset's blob goes with the row

    listed = await client.get("/api/reference")
    assert sorted(d["id"] for d in listed.json()) == [
        "checklists:el-playbook:p12",
        "checklists:fu-aktion",
        "geo:hydrant",
    ]


async def test_prune_with_an_empty_keep_list_clears_all_checklists(client, admin_login):
    await _upload(client, admin_login, "checklists:fu-aktion", json.dumps(TEMPLATE).encode(), "application/json")
    await _upload(client, admin_login, "geo:hydrant", _fc(INSIDE), "application/geo+json")
    r = await client.post("/api/reference/checklists/prune", json=[])
    assert r.json() == {"pruned": ["checklists:fu-aktion"]}
    listed = await client.get("/api/reference")
    assert [d["id"] for d in listed.json()] == ["geo:hydrant"]


# --- fetch trigger ----------------------------------------------------------------------


async def test_fetch_is_admin_only(client, editor):
    await _login(client, editor)
    r = await client.post("/api/reference/geo:hydrant/fetch")
    assert r.status_code == 401


async def test_fetch_unknown_dataset_is_404(client, admin_login):
    await admin_login(client)
    r = await client.post("/api/reference/geo:gibtsnicht/fetch")
    assert r.status_code == 404
    assert r.json()["detail"] == "Datensatz nicht gefunden"


@pytest.mark.parametrize(
    ("fetch_url", "detail"),
    [
        (None, "Kein Auto-Fetch konfiguriert (manueller Upload)"),
        ("https://example.org/hydranten.geojson", "Auto-Fetch für diesen Datensatz ist nicht aktiv"),
    ],
)
async def test_fetch_answers_501_for_datasets_with_no_live_source(client, admin_login, db_session, fetch_url, detail):
    # Two different "not now": nothing configured vs. configured but the puller isn't built.
    db_session.add(ReferenceDataset(id="geo:hydrant", kind="geojson", fetch_url=fetch_url))
    await db_session.commit()
    await admin_login(client)
    r = await client.post("/api/reference/geo:hydrant/fetch")
    assert r.status_code == 501
    assert r.json()["detail"] == detail


@pytest.fixture
def plan_pull(monkeypatch):
    """Stub the Objektplan snapshot pull: this file covers how the fetch button maps the
    pull's OUTCOMES onto HTTP; the pull itself is test_plan_snapshot's subject."""

    def install(outcome):
        async def _pull(db, dataset_id):
            if isinstance(outcome, Exception):
                raise outcome
            return {**outcome, "dataset_id": dataset_id}

        monkeypatch.setattr(reference_mod, "plans_pull_enabled", lambda: True)
        monkeypatch.setattr(reference_mod, "pull_one_plan", _pull)

    return install


@pytest.mark.parametrize(
    ("outcome", "status", "detail"),
    [
        ({"status": "absent"}, 404, "Dieser Plan steht nicht im Objektplan-Index"),
        ({"status": "unknown_object"}, 409, "Zu diesem Plan gibt es kein Einsatzobjekt"),
        (ValueError("plans[0].sha256 fehlt"), 502, "Objektplan-Index unbrauchbar: plans[0].sha256 fehlt"),
        (httpx.ConnectError("kein Netz"), 502, "Objektplan-Speicher nicht erreichbar: kein Netz"),
    ],
)
async def test_plan_fetch_reports_why_it_could_not_pull(client, admin_login, plan_pull, outcome, status, detail):
    plan_pull(outcome)
    await admin_login(client)
    r = await client.post(f"/api/reference/plan:{uuid.uuid4()}:modul1/fetch")
    assert r.status_code == status
    assert r.json()["detail"] == detail


async def test_plan_fetch_returns_the_pull_result(client, admin_login, plan_pull):
    plan_pull({"status": "updated"})
    await admin_login(client)
    dataset_id = f"plan:{uuid.uuid4()}:modul1"
    r = await client.post(f"/api/reference/{dataset_id}/fetch")
    assert r.status_code == 200
    assert r.json() == {"status": "updated", "dataset_id": dataset_id}


# --- bbox helpers (pure) ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("geometry", "expected"),
    [
        ({"type": "Point", "coordinates": [7.6, 47.5]}, (7.6, 47.5, 7.6, 47.5)),
        ({"type": "LineString", "coordinates": [[7.6, 47.5], [7.4, 47.7]]}, (7.4, 47.5, 7.6, 47.7)),
        (
            {"type": "Polygon", "coordinates": [[[7.6, 47.5], [7.8, 47.5], [7.8, 47.7], [7.6, 47.5]]]},
            (7.6, 47.5, 7.8, 47.7),
        ),
        (
            {
                "type": "MultiPolygon",
                "coordinates": [
                    [[[7.6, 47.5], [7.7, 47.5], [7.7, 47.6], [7.6, 47.5]]],
                    [[[8.0, 47.9], [8.1, 47.9], [8.1, 48.0], [8.0, 47.9]]],
                ],
            },
            (7.6, 47.5, 8.1, 48.0),
        ),
        (
            {
                "type": "GeometryCollection",
                "geometries": [
                    {"type": "Point", "coordinates": [7.6, 47.5]},
                    {"type": "LineString", "coordinates": [[9.0, 46.0], [9.2, 46.1]]},
                ],
            },
            (7.6, 46.0, 9.2, 47.5),
        ),
    ],
)
def test_feature_bbox_spans_every_nesting(geometry, expected):
    # One recursion has to cope with the whole GeoJSON zoo — the Leitungskataster ships all of it.
    assert _feature_bbox({"type": "Feature", "geometry": geometry}) == expected


@pytest.mark.parametrize(
    "feature",
    [
        {"type": "Feature"},  # no geometry at all
        {"type": "Feature", "geometry": None},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": []}},
        {"type": "Feature", "geometry": {"type": "GeometryCollection", "geometries": []}},
        "not a feature",
    ],
)
def test_feature_bbox_is_none_without_usable_coordinates(feature):
    # None is the "can't tell" answer the crop reads as «keep it» — never an exception.
    assert _feature_bbox(feature) is None


def test_overlaps_counts_touching_boxes_and_rejects_disjoint_ones():
    area = (7.5, 47.4, 7.7, 47.6)
    assert _overlaps(area, (7.6, 47.5, 8.0, 48.0))  # partial
    assert _overlaps(area, (7.0, 47.0, 9.0, 48.0))  # fully contains
    assert _overlaps(area, (7.7, 47.6, 7.9, 47.8))  # touching corner still counts
    assert not _overlaps(area, (7.8, 47.4, 7.9, 47.6))  # east of it
    assert not _overlaps(area, (7.5, 47.7, 7.7, 47.9))  # north of it
