"""`board-template/1` (10.10.2026): the contract a station writes its Tafel pages against, and the
pipeline that carries them — the same one the checklists ride (manifest → `admin_board_templates`
→ `tafel:<id>` reference datasets → the Tafel, offline-cached).

- the bundled FKS file is valid against the model, and strict 1:1 with the poster;
- the model refuses what the app would silently ignore (`extra="forbid"`), and says where;
- docs/board-template.schema.json is exactly what the model generates (drift test);
- the manifest owns its datasets: a push uploads, validates server-side, and prunes the rest.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import select

import app.storage as storage_mod
from app.admin_board_templates import TemplateEntry, _read_manifest, expected_ids
from app.board_templates import BoardTemplate, board_template_problem, parse_board_template, template_json_schema
from app.models import ReferenceDataset

REPO = Path(__file__).resolve().parents[2]
BUNDLED = REPO / "src" / "data" / "boardTemplates" / "fks-erste-fuehrung.json"
COMMITTED_SCHEMA = REPO / "docs" / "board-template.schema.json"
repo_only = pytest.mark.skipif(not BUNDLED.exists(), reason="needs the repo checkout (the bundled template)")


def _fks() -> dict:
    return json.loads(BUNDLED.read_text(encoding="utf-8"))


@repo_only
def test_the_bundled_fks_set_is_a_valid_board_template():
    t = parse_board_template(BUNDLED.read_bytes())
    assert t.id == "fks-erste-fuehrung"
    assert [p.id for p in t.pages] == ["ef", "problem-tendenz", "mittel", "verbindungen", "konzept", "rapport"]


@repo_only
def test_the_erste_fuehrung_is_the_poster_one_to_one():
    ef = BoardTemplate.model_validate(_fks()).pages[0]
    assert [s.id for s in ef.sections] == ["problem", "lagekarte", "massnahmen", "mittel", "verbindungen", "absprachen"]
    assert ef.header is False  # the staging header line is a switch, off
    absprache = ef.sections[5]
    shown = [r.id for r in absprache.fixedRows if not r.hidden]
    assert shown == [
        "patientensammelstelle",
        "sanitaetshilfsstelle",
        "rettungsachse",
        "standort-einsatzleitung",
        "sammelstelle-unverletzte",
        "warteraum",
    ]


@repo_only
def test_the_committed_schema_is_what_the_model_generates():
    """Regenerate with `just board-template-schema` in the change that touches the model."""
    assert json.loads(COMMITTED_SCHEMA.read_text(encoding="utf-8")) == template_json_schema()


@repo_only
@pytest.mark.parametrize(
    ("patch", "where"),
    [
        (lambda t: t["pages"][0]["sections"][0].update(colour="red"), "colour"),  # a typo is refused, never ignored
        (lambda t: t.update(schema="board-template/2"), "schema"),
        (lambda t: t["pages"][0]["sections"].append(dict(t["pages"][0]["sections"][1])), "zweimal"),
        (lambda t: t["pages"][0]["sections"][5]["fixedRows"][0]["cells"].update(ort="x"), "feste Spalten"),
        (lambda t: t["pages"][0].update(title={"fr": "Première"}), "de"),
        (lambda t: t["pages"][0].update(id="Erste Führung"), "pattern"),
        (lambda t: t["pages"][0]["sections"][1].update(type="sketch"), "sketch"),
    ],
)
def test_a_broken_template_names_what_is_wrong(patch, where):
    t = _fks()
    patch(t)
    problem = board_template_problem(t)
    assert problem is not None
    assert where in problem


def test_a_label_is_a_string_or_one_per_language():
    t = {
        "schema": "board-template/1",
        "id": "x",
        "version": 1,
        "title": "X",
        "pages": [
            {
                "id": "p",
                "title": {"de": "Seite", "fr": "Page"},
                "sections": [{"id": "t", "type": "text", "fields": [{"id": "f", "label": "Feld"}]}],
            }
        ],
    }
    assert board_template_problem(t) is None
    t["pages"][0]["title"] = {"de": "Seite", "rm": "Pagina"}
    assert "rm" in board_template_problem(t)


# --- the manifest ----------------------------------------------------------------------


def test_the_manifest_owns_its_datasets(tmp_path):
    m = tmp_path / "tafel.manifest.json"
    m.write_text(
        json.dumps(
            {
                "templates": [
                    {"id": "fks-erste-fuehrung", "file": "tafel/fks.json"},
                    {"id": "zivilschutz", "file": "tafel/zs.json"},
                ]
            }
        )
    )
    entries = _read_manifest(m)
    assert expected_ids(entries) == {"tafel:fks-erste-fuehrung", "tafel:zivilschutz"}


def test_a_manifest_entry_refuses_unknown_keys(tmp_path):
    with pytest.raises(ValidationError):
        TemplateEntry(id="x", file="x.json", kind="poster")
    m = tmp_path / "tafel.manifest.json"
    m.write_text(json.dumps([{"id": "x", "file": "x.json"}, {"id": "x", "file": "y.json"}]))
    with pytest.raises(SystemExit):
        _read_manifest(m)


# --- the reference API ------------------------------------------------------------------


@pytest.fixture
def isolated_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))
    return tmp_path


async def _put(client, dataset_id: str, data: bytes):
    return await client.put(
        f"/api/reference/{dataset_id}", files={"file": ("t.json", data, "application/json")}, data={"title": "FKS"}
    )


@repo_only
async def test_an_upload_is_validated_and_stored_as_a_tafel_template(client, admin_login, db_session, isolated_storage):
    await admin_login(client)
    ok = await _put(client, "tafel:fks-erste-fuehrung", BUNDLED.read_bytes())
    assert ok.status_code == 200, ok.text
    assert ok.json()["kind"] == "tafel"
    bad = _fks()
    bad["pages"][0]["sections"][0]["colour"] = "red"
    refused = await _put(client, "tafel:kaputt", json.dumps(bad).encode())
    assert refused.status_code == 422
    assert "colour" in refused.json()["detail"]
    ids = [d.id for d in (await db_session.execute(select(ReferenceDataset))).scalars()]
    assert ids == ["tafel:fks-erste-fuehrung"]  # the broken one left nothing behind


@repo_only
async def test_prune_drops_unlisted_board_templates_only(client, admin_login, isolated_storage):
    await admin_login(client)
    for i in ("tafel:fks-erste-fuehrung", "tafel:alt"):
        assert (await _put(client, i, BUNDLED.read_bytes())).status_code == 200
    geo = await client.put(
        "/api/reference/geo:hydrant",
        files={"file": ("h.geojson", b'{"type":"FeatureCollection","features":[]}', "application/geo+json")},
    )
    assert geo.status_code == 200
    r = await client.post("/api/reference/tafel/prune", json=["tafel:fks-erste-fuehrung"])
    assert r.json() == {"pruned": ["tafel:alt"]}
    listed = sorted(d["id"] for d in (await client.get("/api/reference")).json())
    assert listed == ["geo:hydrant", "tafel:fks-erste-fuehrung"]


async def test_prune_is_admin_only(client):
    r = await client.post("/api/reference/tafel/prune", json=[])
    assert r.status_code == 401
