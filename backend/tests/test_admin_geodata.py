"""Unit tests for the geodata-as-code manifest loader (no DB, no network).

Covers the pure layers: manifest parsing/validation, the WGS84 coordinate guard, and the
manifest-entry → ReferenceLayerConfig mapping (store-URL resolution). Run `uv run pytest`.
"""

import json
from pathlib import Path

import httpx
import pytest

from app.admin_geodata import (
    GeodataManifestEntry,
    _push,
    _read_manifest,
    _to_reference_layers,
    _validate_geojson_wgs84,
)


def _write(tmp_path, name, obj):
    p = tmp_path / name
    p.write_text(json.dumps(obj), encoding="utf-8")
    return p


# --- manifest parsing -------------------------------------------------------------------


def test_reads_list_and_layers_wrapper(tmp_path):
    entry = {"id": "lk-gas", "kind": "geojson", "file": "g.geojson"}
    assert len(_read_manifest(_write(tmp_path, "a.json", [entry]))) == 1
    assert len(_read_manifest(_write(tmp_path, "b.json", {"layers": [entry]}))) == 1


def test_duplicate_id_rejected(tmp_path):
    m = _write(
        tmp_path,
        "m.json",
        [
            {"id": "x", "kind": "geojson", "file": "a.geojson"},
            {"id": "x", "kind": "geojson", "file": "b.geojson"},
        ],
    )
    with pytest.raises(SystemExit):
        _read_manifest(m)


def test_unknown_key_rejected(tmp_path):
    # extra=forbid → a typo'd key fails loudly instead of being silently dropped.
    m = _write(tmp_path, "m.json", [{"id": "x", "kind": "geojson", "file": "a.geojson", "colour": "#fff"}])
    with pytest.raises(SystemExit):
        _read_manifest(m)


def test_geojson_needs_exactly_one_source():
    with pytest.raises(ValueError):
        GeodataManifestEntry(id="x", kind="geojson")  # neither file nor geojson
    with pytest.raises(ValueError):
        GeodataManifestEntry(id="x", kind="geojson", file="a.geojson", geojson="/api/reference/geo:x")  # both


def test_wms_requires_tiles():
    with pytest.raises(ValueError):
        GeodataManifestEntry(id="x", kind="wms")


def test_slug_defaults_to_file_stem():
    assert GeodataManifestEntry(id="lk-hydrant", kind="geojson", file="sub/hydrant.geojson").slug() == "hydrant"
    assert GeodataManifestEntry(id="lk-x", kind="geojson", file="a.geojson", dataset="custom").slug() == "custom"


# --- GeoJSON WGS84 guard ----------------------------------------------------------------


def _fc(coords):
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": coords}, "properties": {}},
        ],
    }


def test_valid_wgs84_passes(tmp_path):
    assert _validate_geojson_wgs84(_write(tmp_path, "ok.geojson", _fc([7.556, 47.515]))) == 1


def test_lv95_coordinates_rejected(tmp_path):
    # LV95 E/N (millions of metres) where WGS84 lon/lat is expected → must fail.
    with pytest.raises(SystemExit):
        _validate_geojson_wgs84(_write(tmp_path, "lv95.geojson", _fc([2608000.0, 1263000.0])))


def test_non_featurecollection_rejected(tmp_path):
    with pytest.raises(SystemExit):
        _validate_geojson_wgs84(_write(tmp_path, "bad.geojson", {"type": "Feature"}))


# --- mapping to the client-facing render config -----------------------------------------


def test_file_layer_resolves_store_url():
    [layer] = _to_reference_layers([GeodataManifestEntry(id="lk-hydrant", kind="geojson", file="hydrant.geojson")])
    assert layer["geojson"] == "/api/reference/geo:hydrant"
    # load-time-only fields never reach the client config
    assert "file" not in layer and "dataset" not in layer and "sourceNote" not in layer


def test_hosted_url_passthrough_and_wms():
    layers = _to_reference_layers(
        [
            GeodataManifestEntry(id="a", kind="geojson", geojson="/api/reference/geo:a"),
            GeodataManifestEntry(id="b", kind="wms", tiles=["https://x/{z}/{x}/{y}"]),
        ]
    )
    assert layers[0]["geojson"] == "/api/reference/geo:a"
    assert layers[1]["tiles"] == ["https://x/{z}/{x}/{y}"]


class _Response:
    def __init__(self, status_code: int, payload: object = None):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self):
        return self._payload


class _PushClient:
    def __init__(self, config_status: int = 200):
        self.config_status = config_status
        self.uploads: list[str] = []
        self.config_headers: dict[str, str] = {}

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return None

    def post(self, url: str, **_kw):
        assert url == "/api/admin/login"
        return _Response(200, {"ok": True})

    def get(self, url: str, **_kw):
        assert url == "/api/config"
        return _Response(200, {"identity": {"appName": "X"}, "version": "v-current"})

    def put(self, url: str, **kw):
        if url.startswith("/api/reference/"):
            self.uploads.append(url)
            return _Response(200, {})
        assert url == "/api/config"
        self.config_headers = kw.get("headers", {})
        return _Response(self.config_status, {"detail": "stale"} if self.config_status != 200 else {})


def _geojson_push_fixture(tmp_path: Path):
    source = _write(tmp_path, "hydrant.geojson", _fc([7.556, 47.515]))
    manifest = tmp_path / "geodata.manifest.json"
    return manifest, [GeodataManifestEntry(id="hydrant", kind="geojson", file=source.name)]


def test_push_sends_the_config_version_after_uploading(monkeypatch, tmp_path):
    fake = _PushClient()
    monkeypatch.setattr(httpx, "Client", lambda **_kw: fake)
    manifest, entries = _geojson_push_fixture(tmp_path)

    assert _push(manifest, entries, "https://station.example", "secret", False) == (1, 1)
    assert fake.uploads == ["/api/reference/geo:hydrant"]
    assert fake.config_headers == {"If-Match": "v-current"}


def test_push_conflict_reports_the_files_that_already_landed(monkeypatch, tmp_path, capsys):
    fake = _PushClient(config_status=409)
    monkeypatch.setattr(httpx, "Client", lambda **_kw: fake)
    manifest, entries = _geojson_push_fixture(tmp_path)

    with pytest.raises(SystemExit):
        _push(manifest, entries, "https://station.example", "secret", False)
    err = capsys.readouterr().err
    assert "1 GeoJSON file(s) were uploaded" in err
    assert "may already serve the new bytes" in err
    assert "referenceLayers was not changed" in err
