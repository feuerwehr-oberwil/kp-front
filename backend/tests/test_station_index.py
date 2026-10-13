"""The station index (app/station_index.py) and its stdlib builder, tested pure.

Byte-identical in KP Front and KP Rück, like the module: one index a station publishes must
resolve to the same files in both products. Each app tests separately that a roster read
THROUGH the index lands like one read directly (``test_roster_snapshot_sync.py``).
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from app import station_index
from app.roster_snapshot import EXAMPLE_SNAPSHOT
from app.roster_snapshot_ingest import SnapshotSourceError
from app.station_index import EXAMPLE_INDEX, parse_index, read_kind, resolve

ROOT = Path(__file__).resolve().parents[2]
BUILDER = ROOT / "scripts" / "station_index_build.py"
SCHEMA_FILE = ROOT / "docs" / "station-index.schema.json"
EXAMPLE_FILE = ROOT / "docs" / "station-index.example.json"

repo_only = pytest.mark.skipif(not BUILDER.exists(), reason="repo root not available (running from the image)")


def _index(**changes: Any) -> dict[str, Any]:
    doc = copy.deepcopy(EXAMPLE_INDEX)
    doc.update(changes)
    return doc


def _folder(tmp_path: Path, roster: bytes | None = None) -> tuple[Path, bytes]:
    raw = roster if roster is not None else json.dumps(EXAMPLE_SNAPSHOT).encode()
    (tmp_path / "roster.json").write_bytes(raw)
    index = _index(
        files=[
            {
                "kind": "roster",
                "path": "roster.json",
                "schema": "roster-snapshot/1",
                "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw),
            },
            {"kind": "vehicles", "path": "vehicles.json", "schema": "vehicles-snapshot/1", "sha256": "1" * 64},
        ]
    )
    (tmp_path / "index.json").write_text(json.dumps(index))
    return tmp_path / "index.json", raw


# --- the document ------------------------------------------------------------------------


def test_the_example_is_a_valid_index():
    assert parse_index(json.dumps(EXAMPLE_INDEX)).entry("roster") is not None


@repo_only
def test_the_committed_schema_and_example_match_the_module():
    assert json.loads(SCHEMA_FILE.read_text()) == station_index.index_json_schema(), (
        "docs/station-index.schema.json is stale — regenerate with `python -m app.station_index schema`"
    )
    assert json.loads(EXAMPLE_FILE.read_text()) == EXAMPLE_INDEX


@pytest.mark.parametrize(
    "path",
    ["../roster.json", "/etc/passwd", "a/../../b.json", "https://elsewhere.example/r.json", "a\\b.json", "", "a//b"],
)
def test_a_path_that_could_leave_the_folder_is_refused(path):
    doc = _index(files=[{**EXAMPLE_INDEX["files"][0], "path": path}])
    with pytest.raises(ValueError):
        parse_index(json.dumps(doc))


def test_one_file_per_kind():
    doc = _index(files=[EXAMPLE_INDEX["files"][0], {**EXAMPLE_INDEX["files"][0], "path": "other.json"}])
    with pytest.raises(ValueError, match="listed twice"):
        parse_index(json.dumps(doc))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update({"schema": "station-index/2"}),
        lambda d: d.update({"files": []}),
        lambda d: d.update({"generated_at": "2026-10-09T04:00:00"}),
        lambda d: d["files"][0].update({"sha256": "abc"}),
        lambda d: d.update({"extra": 1}),
    ],
)
def test_a_malformed_index_is_refused(mutate):
    doc = _index()
    mutate(doc)
    with pytest.raises(ValueError):
        parse_index(json.dumps(doc))


# --- resolving and reading ---------------------------------------------------------------


def test_siblings_resolve_next_to_the_index():
    assert (
        resolve("https://data.example.ch/wehr/index.json", "roster.json") == "https://data.example.ch/wehr/roster.json"
    )
    assert (
        resolve("https://data.example.ch/wehr/index.json", "p/roster.json")
        == "https://data.example.ch/wehr/p/roster.json"
    )
    assert resolve("/srv/data/index.json", "roster.json") == "/srv/data/roster.json"
    assert resolve("file:///srv/data/index.json", "roster.json") == "/srv/data/roster.json"


async def test_a_listed_file_is_read_and_checked_against_the_index(tmp_path):
    index_path, raw = _folder(tmp_path)
    index = parse_index(index_path.read_bytes())
    assert await read_kind(str(index_path), index, "roster") == raw
    assert await read_kind(str(index_path), index, "groups") is None  # not listed


async def test_a_file_that_changed_since_the_index_was_written_is_refused(tmp_path):
    index_path, _ = _folder(tmp_path)
    (tmp_path / "roster.json").write_text(json.dumps({**EXAMPLE_SNAPSHOT, "provider": "anders"}))
    with pytest.raises(SnapshotSourceError, match="sha256"):
        await read_kind(str(index_path), parse_index(index_path.read_bytes()), "roster")


async def test_a_version_this_build_does_not_read_is_refused(tmp_path):
    index_path, _ = _folder(tmp_path)
    doc = json.loads(index_path.read_text())
    doc["files"][0]["schema"] = "roster-snapshot/2"
    with pytest.raises(SnapshotSourceError, match="this version reads"):
        await read_kind(str(index_path), parse_index(json.dumps(doc)), "roster")


async def test_the_token_goes_to_the_index_host_and_the_sibling_on_the_same_host():
    roster = json.dumps(EXAMPLE_SNAPSHOT).encode()
    index = _index(
        files=[
            {
                "kind": "roster",
                "path": "roster.json",
                "schema": "roster-snapshot/1",
                "sha256": hashlib.sha256(roster).hexdigest(),
            }
        ]
    )
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.dumps(index).encode() if request.url.path.endswith("index.json") else roster
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    src = "https://data.example.ch/wehr/index.json"
    parsed, _sha = await station_index.read_index(src, "tok", transport=transport)
    assert await read_kind(src, parsed, "roster", "tok", transport=transport) == roster
    assert [str(r.url) for r in seen] == [src, "https://data.example.ch/wehr/roster.json"]
    assert all(r.headers["authorization"] == "Bearer tok" for r in seen)


def test_the_summary_says_which_kinds_were_read_and_which_this_version_ignores():
    index = parse_index(
        json.dumps(
            _index(
                files=[
                    EXAMPLE_INDEX["files"][0],
                    {"kind": "vehicles", "path": "v.json", "schema": "vehicles-snapshot/1", "sha256": "1" * 64},
                ]
            )
        )
    )
    files = station_index.summary(index, "x", read={"roster"})["files"]
    assert files == [
        {"kind": "roster", "schema": "roster-snapshot/1", "read": True, "known": True},
        {"kind": "vehicles", "schema": "vehicles-snapshot/1", "read": False, "known": False},
    ]


# --- the builder -------------------------------------------------------------------------


def _builder():
    spec = importlib.util.spec_from_file_location("station_index_build", BUILDER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@repo_only
def test_the_builder_writes_an_index_both_apps_accept(tmp_path):
    (tmp_path / "roster.json").write_text(json.dumps(EXAMPLE_SNAPSHOT))
    (tmp_path / "notes.json").write_text('{"hello": 1}')
    assert _builder().main([str(tmp_path), "--provider", "musterdorf"]) == 0
    index = parse_index((tmp_path / "index.json").read_bytes())
    assert [f.kind for f in index.files] == ["roster"]
    assert index.files[0].sha256 == hashlib.sha256((tmp_path / "roster.json").read_bytes()).hexdigest()
    assert not (tmp_path / "index.json.tmp").exists()


@repo_only
def test_the_builder_refuses_two_files_of_one_kind_and_an_empty_folder(tmp_path):
    gen = _builder()
    with pytest.raises(ValueError, match="no station-data file"):
        gen.build(tmp_path, provider="wehr")
    (tmp_path / "a.json").write_text(json.dumps(EXAMPLE_SNAPSHOT))
    (tmp_path / "b.json").write_text(json.dumps(EXAMPLE_SNAPSHOT))
    with pytest.raises(ValueError, match="one per kind"):
        gen.build(tmp_path, provider="wehr")


async def test_the_index_wins_and_the_direct_source_is_only_the_fallback(tmp_path):
    index_path, raw = _folder(tmp_path)
    direct = tmp_path / "direct.json"
    direct.write_text(json.dumps({**EXAMPLE_SNAPSHOT, "provider": "direkt"}))

    got, via, listed = await station_index.read_via_index(
        "roster", index_source=str(index_path), direct_source=str(direct)
    )
    assert (got, via) == (raw, "index") and listed is not None

    got, via, listed = await station_index.read_via_index(
        "groups", index_source=str(index_path), direct_source=str(direct)
    )
    assert via == "direct" and listed is not None  # the index lists no groups → the fallback, and it says so

    got, via, listed = await station_index.read_via_index("roster", index_source=None, direct_source=str(direct))
    assert via == "direct" and listed is None  # no index at all: exactly the old behaviour


async def test_an_index_that_cannot_be_read_never_falls_back_silently(tmp_path):
    direct = tmp_path / "direct.json"
    direct.write_text(json.dumps(EXAMPLE_SNAPSHOT))
    with pytest.raises(SnapshotSourceError, match="not found"):
        await station_index.read_via_index(
            "roster", index_source=str(tmp_path / "missing.json"), direct_source=str(direct)
        )
    with pytest.raises(SnapshotSourceError, match="no roster source"):
        await station_index.read_via_index("roster", index_source=None, direct_source=None)
