"""The station index: ONE address that lists every station-data file a station publishes.

Owner decision X6/X7 (09.10.2026): «one index file». A station keeps its shared data in one
place — a folder on a web server, an object store, a directory next to a self-hosted stack —
and publishes an ``index.json`` there that lists the sibling files **by kind** (``roster``,
later ``vehicles``, ``groups``, ``keywords`` …) with each file's contract version and sha256.
Each app gets ONE setting, the address of that index, and reads the kinds it understands.

Byte-identical in KP Front and KP Rück (listed in ``shared/MANIFEST.json``, compared by both
CIs' «Shared files» job), like ``roster_snapshot.py`` and ``roster_snapshot_ingest.py``:
the same index must resolve to the same files in both products. Neither app imports the other.

WHAT IT GUARANTEES
------------------
* **A sibling is read only if it is the file the index promised.** Its sha256 is checked after
  the download; a file that changed between the index being written and being read (a half
  finished upload, a stale cache) is refused for that run — the last good data stays.
* **A sibling never leaves the index's folder.** Paths are relative, segment by segment
  (``roster.json``, ``personal/roster.json``), with no ``..``, no absolute path, no scheme; a URL
  index resolves its siblings on the same origin, so the index's bearer token is never sent to
  another host.
* **An index names versions, a reader checks them.** A kind this build knows is read only at the
  contract version it implements (``KNOWN_KINDS``); any other kind is listed as «not read by this
  version» and otherwise ignored, so a station can publish ahead of its apps.

Run from ``backend/`` via ``uv run python -m app.station_index <cmd>``:

    schema            print the JSON Schema of an index (docs/station-index.schema.json)
    example           print an example index
    validate <file>   parse + validate an index (no network)

To WRITE an index from a folder of files, use ``scripts/station_index_build.py`` (stdlib only).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .roster_snapshot import ProviderKey
from .roster_snapshot_ingest import SnapshotSourceError, digest, read_source, source_kind

SCHEMA_ID = "station-index/1"
SCHEMA_VERSION = 1

#: The kinds a reader may know, and the ONE contract version this build reads for each. Only
#: ``roster`` has a published contract today; the others are reserved names (docs: «Station
#: index» · «The other kinds») so two stations do not invent two spellings for the same thing.
KNOWN_KINDS: dict[str, str] = {
    "roster": "roster-snapshot/1",
}
RESERVED_KINDS: tuple[str, ...] = ("roster", "vehicles", "groups", "keywords")

KIND_PATTERN = r"^[a-z][a-z0-9_-]{1,31}$"
SHA256_PATTERN = r"^[0-9a-f]{64}$"
#: One path segment: letters, digits, dot, dash, underscore — and not «.» or «..».
_SEGMENT_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

Kind = Annotated[str, Field(pattern=KIND_PATTERN, max_length=32)]


class IndexFile(BaseModel):
    """One sibling file: what it is, where it is (relative to the index), what it must hash to."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    kind: Kind
    path: str = Field(min_length=1, max_length=255)
    #: The contract the file is written to, e.g. ``roster-snapshot/1``.
    schema_: str = Field(alias="schema", min_length=3, max_length=64, pattern=r"^[a-z][a-z0-9-]*/[0-9]+$")
    sha256: str = Field(pattern=SHA256_PATTERN)
    bytes: int | None = Field(default=None, ge=0)

    @field_validator("path")
    @classmethod
    def _relative(cls, v: str) -> str:
        if v.startswith("/") or "\\" in v or ":" in v:
            raise ValueError(f"path {v!r} must be relative to the index (no leading '/', no scheme)")
        for segment in v.split("/"):
            if segment in ("", ".", "..") or not set(segment) <= _SEGMENT_CHARS:
                raise ValueError(f"path {v!r}: segment {segment!r} is not allowed")
        return v


class StationIndex(BaseModel):
    """A station's index of published data files, whole."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    schema_: Literal["station-index/1"] = Field(alias="schema")
    schema_version: Literal[1] = 1
    generated_at: AwareDatetime
    #: Who publishes this folder — informational; each file still carries its own provider.
    provider: ProviderKey
    files: list[IndexFile] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def _check(self) -> StationIndex:
        kinds: set[str] = set()
        for f in self.files:
            if f.kind in kinds:
                raise ValueError(f"kind {f.kind!r} is listed twice — one file per kind")
            kinds.add(f.kind)
        return self

    def entry(self, kind: str) -> IndexFile | None:
        return next((f for f in self.files if f.kind == kind), None)


def parse_index(raw: bytes | str) -> StationIndex:
    """Validate a whole index, or raise ``ValueError`` naming every problem."""
    try:
        doc = json.loads(raw)
    except (ValueError, TypeError) as e:
        raise ValueError(f"index is not valid JSON: {e}") from e
    if not isinstance(doc, dict):
        raise ValueError("index must be a JSON object")
    try:
        return StationIndex.model_validate(doc)
    except ValidationError as e:
        lines = [f"index failed validation ({e.error_count()} issue(s)):"]
        for err in e.errors():
            where = ".".join(str(p) for p in err["loc"]) or "(root)"
            lines.append(f"  {where}: {err['msg']} [{err['type']}]")
        raise ValueError("\n".join(lines)) from e


def resolve(index_source: str, path: str) -> str:
    """Where a sibling lives, given where the index lives. Never outside the index's folder."""
    kind = source_kind(index_source)
    if kind == "url":
        base = index_source.strip()
        target = urljoin(base, path)
        b, t = urlsplit(base), urlsplit(target)
        if (b.scheme, b.netloc) != (t.scheme, t.netloc):
            raise SnapshotSourceError("index entry resolves to another host")
        return target
    if kind == "file":
        s = index_source.strip()
        folder = Path(s[len("file://") :] if s.startswith("file://") else s).parent
        target_path = folder / path
        if folder.resolve() not in target_path.resolve().parents:
            raise SnapshotSourceError("index entry resolves outside the index's folder")
        return str(target_path)
    raise SnapshotSourceError("source is neither an http(s):// address nor an absolute file path")


async def read_index(
    index_source: str, token: str | None = None, *, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[StationIndex, str]:
    """Fetch and validate the index. Returns it and its sha256."""
    raw = await read_source(index_source, token, transport=transport)
    return parse_index(raw), digest(raw)


async def read_kind(
    index_source: str,
    index: StationIndex,
    kind: str,
    token: str | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bytes | None:
    """The bytes of one kind, verified against the index — or None when the index lists no such kind.

    Raises :class:`SnapshotSourceError` (a ``ValueError``) when the listed version is not the one
    this build reads, when the file cannot be fetched, or when it does not hash to what the index
    says. The message never carries the address or the token.
    """
    entry = index.entry(kind)
    if entry is None:
        return None
    expected = KNOWN_KINDS.get(kind)
    if expected is not None and entry.schema_ != expected:
        raise SnapshotSourceError(f"index lists {kind} as {entry.schema_!r}; this version reads {expected!r}")
    raw = await read_source(resolve(index_source, entry.path), token, transport=transport)
    if digest(raw) != entry.sha256:
        raise SnapshotSourceError(
            f"{kind} file does not match the index's sha256 (changed since the index was written?)"
        )
    if entry.bytes is not None and len(raw) != entry.bytes:
        raise SnapshotSourceError(f"{kind} file is {len(raw)} bytes, the index says {entry.bytes}")
    return raw


async def read_via_index(
    kind: str,
    *,
    index_source: str | None,
    index_token: str | None = None,
    direct_source: str | None = None,
    direct_token: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[bytes, Literal["index", "direct"], dict[str, Any] | None]:
    """One kind's bytes, and how they were found — the rule both apps follow for every kind.

    The index wins when it is set AND lists the kind; the kind's own direct source (e.g. the older
    roster-snapshot setting) is the fallback, so a station that set it before the index existed
    changes nothing. An index that is set but cannot be read is an ERROR, never a silent fallback:
    two sources that disagree are worse than one that says why. Returns ``(bytes, via, summary)``;
    raises ``ValueError`` with a line that never carries an address or a token.
    """
    if index_source:
        index, index_sha = await read_index(index_source, index_token, transport=transport)
        raw = await read_kind(index_source, index, kind, index_token, transport=transport)
        if raw is not None:
            return raw, "index", summary(index, index_sha, read={kind})
        if not direct_source:
            raise SnapshotSourceError(f"the station index lists no {kind} file")
        listed = summary(index, index_sha, read=set())
        return await read_source(direct_source, direct_token, transport=transport), "direct", listed
    if not direct_source:
        raise SnapshotSourceError(f"no {kind} source configured")
    return await read_source(direct_source, direct_token, transport=transport), "direct", None


def summary(index: StationIndex, sha256: str, *, read: set[str]) -> dict[str, Any]:
    """What a status card says about the index: when, who, and which kinds were read or not."""
    return {
        "generatedAt": index.generated_at.isoformat(),
        "provider": index.provider,
        "sha256": sha256,
        "files": [
            {
                "kind": f.kind,
                "schema": f.schema_,
                "read": f.kind in read,
                "known": f.kind in KNOWN_KINDS,
            }
            for f in index.files
        ],
    }


# ---------------------------------------------------------------------------------------
# example + CLI
# ---------------------------------------------------------------------------------------

#: An invented station, like every other example. The sha256 is of ``roster.json`` as
#: ``python -m app.roster_snapshot example`` prints it — an example index, not a working one.
EXAMPLE_INDEX: dict[str, Any] = {
    "schema": SCHEMA_ID,
    "schema_version": SCHEMA_VERSION,
    "generated_at": "2026-10-09T04:00:00+00:00",
    "provider": "musterdorf",
    "files": [
        {
            "kind": "roster",
            "path": "roster.json",
            "schema": "roster-snapshot/1",
            "sha256": "0" * 64,
            "bytes": 1234,
        }
    ],
}


def index_json_schema() -> dict[str, Any]:
    schema = StationIndex.model_json_schema(by_alias=True)
    schema["$id"] = SCHEMA_ID
    return schema


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.station_index", description="The station-index contract.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema", help="print the index JSON Schema")
    sub.add_parser("example", help="print an example index")
    p_val = sub.add_parser("validate", help="validate an index file (no network)")
    p_val.add_argument("file")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.cmd == "schema":
        sys.stdout.write(json.dumps(index_json_schema(), indent=2, ensure_ascii=False) + "\n")
        return 0
    if args.cmd == "example":
        sys.stdout.write(json.dumps(EXAMPLE_INDEX, indent=2, ensure_ascii=False) + "\n")
        return 0
    try:
        index = parse_index(Path(args.file).read_bytes())
    except (OSError, ValueError) as e:
        print(f"ERROR: {args.file}: {e}", file=sys.stderr)
        return 1
    kinds = ", ".join(
        f"{f.kind} ({f.schema_}{'' if f.kind in KNOWN_KINDS else ', not read by this version'})" for f in index.files
    )
    print(f"OK: index from {index.provider!r}, generated {index.generated_at.isoformat()}: {kinds}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
