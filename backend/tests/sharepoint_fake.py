"""A whole SharePoint tenant on an `httpx.MockTransport` — the test suite's only Graph.

Nothing in the connector is monkeypatched anywhere: `sync_sharepoint(transport=…)` hands httpx
its own injection point, and this module answers the four request shapes app/sharepoint_graph
actually makes. So what the tests exercise is the code a station runs, including its URL
building, its paging and its 410 handling.

Build one with a folder tree and drive it:

    tenant = FakeTenant({"dorfmatt/modul1.pdf": b"%PDF-1.4 …"})
    await sync_sharepoint(db, transport=tenant.transport)
    tenant.put("dorfmatt/modul2.pdf", b"%PDF-…")   # a change the next poll sees
    tenant.fail_auth()                             # an expired client secret

A tenant can also fail the way a real one does — one file, one folder listing or the delta call,
each on its own, and `heal()` when the weather passes:

    tenant.fail_download("dorfmatt/modul2.pdf")    # a 429 on ONE file
    tenant.fail_listing("dorfmatt")                # the walk dies half way down
    tenant.fail_delta(503)                         # the change feed, not the walk
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import httpx

SITE_URL = "https://feuerwehr.sharepoint.com/sites/kp"
SITE_ID = "feuerwehr.sharepoint.com,1111,2222"
DRIVE_ID = "b!drive-id"
TENANT_ID = "11111111-1111-4111-8111-111111111111"
CLIENT_ID = "22222222-2222-4222-8222-222222222222"
CLIENT_SECRET = "a-client-secret"


@dataclass
class FakeFile:
    data: bytes
    etag: str


@dataclass
class FakeTenant:
    """A drive with a flat map of `path → bytes`, served as a Graph folder tree."""

    files: dict[str, bytes] = field(default_factory=dict)
    #: folder path the config points at; requests for anything else 404 like the real thing
    root_path: str = "kp-data"
    library: str | None = None
    _store: dict[str, FakeFile] = field(default_factory=dict)
    #: bumped on every write so an unchanged file keeps its eTag and a changed one does not —
    #: and so `delta` can answer «has anything happened since the token you hold», which is the
    #: one question a cursor exists to answer
    _seq: int = 0
    auth_ok: bool = True
    #: an answer `delta` gives whatever token it is handed — `quiet()` sets it. None means the
    #: honest answer, read off `_seq`.
    delta_changes: list[dict[str, Any]] | None = None
    delta_gone: bool = False
    #: HTTP status the delta call fails with, independently of the walk (a 429 or a 503)
    delta_status: int | None = None
    #: {folder path inside the source folder: status} — a listing that dies part way down the
    #: tree. '' is the configured folder itself.
    listing_status: dict[str, int] = field(default_factory=dict)
    #: {file path: status} — one file the storage host refuses while the listing is fine
    download_status: dict[str, int] = field(default_factory=dict)
    #: every URL this tenant was asked for, in order — the tests assert on shape, not counts
    seen: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        for path, data in self.files.items():
            self.put(path, data)

    # --- driving the fixture ------------------------------------------------------------

    def put(self, path: str, data: bytes) -> None:
        """Add or replace a file, with a fresh eTag — i.e. a change a poll must notice."""
        self._seq += 1
        self._store[path] = FakeFile(data, f"etag-{self._seq}")
        self.delta_changes = None

    def remove(self, path: str) -> None:
        self._seq += 1
        self._store.pop(path, None)
        self.delta_changes = None

    def quiet(self) -> None:
        """Nothing has changed, whatever token the caller resumes from."""
        self.delta_changes = []

    def fail_auth(self) -> None:
        self.auth_ok = False

    def fail_delta(self, status: int = 503) -> None:
        """The change feed is throttled or down while the rest of the tenant answers fine."""
        self.delta_status = status

    def fail_listing(self, folder: str = "", status: int = 503) -> None:
        """One folder's listing fails — the walk dies part way through the tree. `folder` is a
        path inside the configured folder, '' being that folder itself."""
        self.listing_status[folder] = status

    def fail_download(self, path: str, status: int = 429) -> None:
        """One file the storage host refuses. The listing still names it, with its eTag."""
        self.download_status[path] = status

    def heal(self) -> None:
        """The weather passes: every injected failure is over, the data is unchanged."""
        self.delta_status = None
        self.listing_status.clear()
        self.download_status.clear()
        self.auth_ok = True

    # --- the transport ------------------------------------------------------------------

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.seen.append(url)
        path = urlsplit(url).path

        if path.endswith("/oauth2/v2.0/token"):
            if not self.auth_ok:
                return httpx.Response(
                    401,
                    json={
                        "error": "invalid_client",
                        "error_description": "AADSTS7000222: The provided client secret keys are expired.",
                    },
                )
            return httpx.Response(200, json={"access_token": "a-token", "expires_in": 3600})

        if not self.auth_ok:
            return httpx.Response(401, json={"error": {"code": "InvalidAuthenticationToken"}})

        if path.startswith("/download/"):
            name = unquote(path[len("/download/") :])
            failed = self.download_status.get(name)
            if failed:
                return _fails(failed, f"download of {name}")
            entry = self._store.get(name)
            return httpx.Response(200, content=entry.data) if entry else httpx.Response(404)

        if "/sites/" in path and "/drives" in path:
            return httpx.Response(200, json={"value": [{"id": DRIVE_ID, "name": self.library or "Dokumente"}]})
        if "/sites/" in path and path.endswith("/drive"):
            return httpx.Response(200, json={"id": DRIVE_ID})
        if "/sites/" in path:
            return httpx.Response(200, json={"id": SITE_ID, "webUrl": SITE_URL})

        if "/delta" in path or "delta" in urlsplit(url).query:
            if self.delta_gone:
                return httpx.Response(410, json={"error": {"code": "resyncRequired"}})
            if self.delta_status:
                return _fails(self.delta_status, "delta")
            return httpx.Response(
                200,
                json={
                    "value": self._changes_since(parse_qs(urlsplit(url).query).get("token", [None])[0]),
                    "@odata.deltaLink": f"https://graph.microsoft.com/v1.0/x/delta?token=t{self._seq}",
                },
            )

        if path.endswith("/children"):
            folder = _folder_of(path)
            failed = self.listing_status.get(folder)
            if failed:
                return _fails(failed, f"listing of {folder or '/'}")
            return httpx.Response(200, json={"value": self._children(folder)})

        # `/drives/{id}/root:/kp-data` — resolving the configured folder to an item id
        if ":/" in url or path.endswith("/root"):
            folder = url.split("root:/", 1)[1] if "root:/" in url else ""
            folder = unquote(folder)
            if folder not in (self.root_path, ""):
                return httpx.Response(404, json={"error": {"code": "itemNotFound"}})
            return httpx.Response(200, json={"id": _folder_id(""), "folder": {}})

        return httpx.Response(404, json={"error": {"code": "itemNotFound", "message": path}})

    def _changes_since(self, token: str | None) -> list[dict[str, Any]]:
        """What `delta` reports to a caller holding `token`.

        Answered off the write counter rather than from a flag, because «the cursor I stored is
        the one I am resuming from» is the property the connector's retry after a failed walk
        depends on: a run that advanced the cursor without importing anything sees nothing here
        the next time, which is precisely the bug this models.

        `token=latest` is Graph's «hand me a cursor for now, report nothing» — the shape the pull
        uses when it has no resume point at all.
        """
        if self.delta_changes is not None:
            return self.delta_changes
        if token == "latest":
            return []
        if token and token.startswith("t") and token[1:].isdigit():
            return [{"id": "changed"}] if self._seq > int(token[1:]) else []
        return [{"id": "initial"}]

    def _children(self, folder: str) -> list[dict[str, Any]]:
        prefix = f"{folder}/" if folder else ""
        seen_dirs: set[str] = set()
        out: list[dict[str, Any]] = []
        for name, entry in sorted(self._store.items()):
            if not name.startswith(prefix):
                continue
            rest = name[len(prefix) :]
            head, slash, _tail = rest.partition("/")
            if slash:
                if head not in seen_dirs:
                    seen_dirs.add(head)
                    out.append({"id": _folder_id(f"{prefix}{head}"), "name": head, "folder": {}})
                continue
            out.append(
                {
                    "id": f"item::{name}",
                    "name": head,
                    "file": {},
                    "size": len(entry.data),
                    "cTag": entry.etag,
                    "@microsoft.graph.downloadUrl": f"https://storage.example/download/{name}",
                }
            )
        return out


def _fails(status: int, what: str) -> httpx.Response:
    """A refusal in Graph's own error shape — a throttle or an outage, never an auth failure
    (401/403 are their own state in the connector and their own fixture, `fail_auth`)."""
    code = "activityLimitReached" if status == 429 else "serviceNotAvailable"
    return httpx.Response(status, json={"error": {"code": code, "message": f"{what} failed ({status})"}})


def _folder_id(path: str) -> str:
    return f"folder::{path}"


def _folder_of(path: str) -> str:
    """`/v1.0/drives/x/items/folder::plans/children` → `plans`."""
    marker = "/items/"
    rest = path.split(marker, 1)[1] if marker in path else ""
    item = unquote(rest.rsplit("/children", 1)[0])
    return item[len("folder::") :] if item.startswith("folder::") else ""


def source(area: str, path: str = "kp-data", *, ignore: list[str] | None = None) -> dict[str, Any]:
    """One `sharepoint.sources` entry against this fake tenant."""
    entry: dict[str, Any] = {"area": area, "siteUrl": SITE_URL, "path": path}
    if ignore is not None:
        entry["ignore"] = ignore
    return entry


def geojson(features: int = 1) -> bytes:
    return json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [7.57, 47.52]}, "properties": {}}
            ]
            * features,
        }
    ).encode()
