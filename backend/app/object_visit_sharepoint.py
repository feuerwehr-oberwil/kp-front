"""Microsoft Graph, the WRITE half — used by the Objektbesuche delivery and nothing else.

⚠️ This is deliberately NOT ``sharepoint_graph``. That module is the station-data importer and
promises to be GET-only (its docstring): pointing the pull at a folder must never be able to
damage it. Filing visit reports needs writes, so the writes live here, behind their own app
registration (credential group ``sharepoint_export``, ``Sites.Selected`` WRITE on one site) —
the importer's credentials are never used for writing.

:class:`GraphWriter` subclasses the importer's client only to reuse its token cache, its site →
drive resolution and its error types; every method that sends something other than a GET is
defined below, in this module.

What it does, and nothing more (docs/object-visits.md «Delivery»):

* look an item up by path (``GET …/root:/{path}``), 404 → None;
* create a folder (``POST …/children`` with ``@microsoft.graph.conflictBehavior: fail``) — always
  after a lookup, and a 409 answered by looking up again (a lost response that DID create it);
* upload bytes (``PUT …/root:/{path}:/content``) — idempotent by path, optionally ``If-Match``;
* move an item into another folder (``PATCH`` its ``parentReference``).

Nothing is ever deleted.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import quote

import httpx

from .credentials import get as credential
from .sharepoint_graph import GraphAuthError, GraphClient, GraphError, RemoteFile, _error_detail, _redact

logger = logging.getLogger("kpfront.objectvisits")

#: Characters SharePoint refuses in a file or folder name (plus control characters).
_FORBIDDEN = re.compile(r'["*:<>?/\\|\x00-\x1f]')
_SEGMENT_MAX = 120


class GraphPreconditionError(GraphError):
    """412: the ``If-Match`` eTag no longer matches — somebody wrote the item in between."""


def export_credentials() -> tuple[str, str, str] | None:
    """The delivery's app registration (tenant, client, secret), or None while incomplete."""
    tenant = credential("sharepoint_export_tenant_id")
    client = credential("sharepoint_export_client_id")
    secret = credential("sharepoint_export_client_secret")
    return (tenant, client, secret) if tenant and client and secret else None


def sanitize_segment(value: str) -> str:
    """One path segment SharePoint accepts: forbidden characters and leading/trailing dots and
    spaces removed, whitespace collapsed, bounded. Never empty."""
    cleaned = " ".join(_FORBIDDEN.sub("", value or "").split()).strip(" .")
    if len(cleaned) > _SEGMENT_MAX:
        cleaned = cleaned[:_SEGMENT_MAX].rstrip(" .")
    return cleaned or "_"


def join_path(*parts: str) -> str:
    return "/".join(p.strip("/") for p in parts if p and p.strip("/"))


class GraphWriter(GraphClient):
    """A Graph session that may write. See the module docstring for the four shapes it sends."""

    def __init__(self, client: httpx.AsyncClient, *, tenant_id: str, client_id: str, client_secret: str, **kw: Any):
        super().__init__(client, tenant_id=tenant_id, client_id=client_id, client_secret=client_secret, **kw)

    @property
    def root(self) -> str:
        return self._graph_root

    def _path_url(self, drive_id: str, path: str) -> str:
        if not path:
            return f"{self._graph_root}/drives/{drive_id}/root"
        return f"{self._graph_root}/drives/{drive_id}/root:/{quote(path, safe='/')}"

    async def _send(self, method: str, url: str, **kw: Any) -> httpx.Response:
        headers = {"Authorization": f"Bearer {await self.token()}", **kw.pop("headers", {})}
        try:
            resp = await self._client.request(method, url, headers=headers, **kw)
        except httpx.HTTPError as e:
            raise GraphError(f"{method} {_redact(url)}: {e}") from e
        if resp.status_code in (401, 403):
            raise GraphAuthError(_error_detail(resp), status=resp.status_code)
        if resp.status_code == 412:
            raise GraphPreconditionError(_error_detail(resp), status=412)
        if resp.status_code >= 300:
            raise GraphError(
                f"{method} {_redact(url)} → {resp.status_code}: {_error_detail(resp)}", status=resp.status_code
            )
        return resp

    async def item(self, drive_id: str, path: str) -> dict[str, Any] | None:
        """The drive item at ``path``, or None when there is none."""
        try:
            return await self.get_json(self._path_url(drive_id, path))
        except GraphError as e:
            if e.status == 404:
                return None
            raise

    async def ensure_folder(self, drive_id: str, base: str, segments: list[str]) -> str:
        """The id of ``base/segments…``, creating each missing segment below ``base``.

        ``base`` itself must exist: a destination root that is not there is a configuration
        error (404 → the delivery fails, actionable), never something this writer invents.
        """
        current = await self.item(drive_id, base)
        if current is None:
            raise GraphError(f"folder {base or '/'} does not exist", status=404)
        if "folder" not in current:
            raise GraphError(f"{base or '/'} is a file, not a folder", status=404)
        parent_id = str(current["id"])
        path = base
        for segment in segments:
            path = join_path(path, segment)
            found = await self.item(drive_id, path)
            if found is None:
                url = f"{self._graph_root}/drives/{drive_id}/items/{quote(parent_id, safe='')}/children"
                body = {"name": segment, "folder": {}, "@microsoft.graph.conflictBehavior": "fail"}
                try:
                    resp = await self._send("POST", url, json=body)
                    found = resp.json()
                except GraphError as e:
                    if e.status != 409:
                        raise
                    # A lost response that created it after all, or a parallel writer.
                    found = await self.item(drive_id, path)
                    if found is None:
                        raise
            if "folder" not in found:
                raise GraphError(f"{path} is a file, not a folder", status=409)
            parent_id = str(found["id"])
        return parent_id

    async def upload(
        self, drive_id: str, path: str, data: bytes, content_type: str, *, if_match: str | None = None
    ) -> dict[str, Any]:
        """PUT the bytes at ``path`` (replacing what is there). Returns the drive item."""
        headers = {"Content-Type": content_type}
        if if_match:
            headers["If-Match"] = if_match
        resp = await self._send("PUT", f"{self._path_url(drive_id, path)}:/content", content=data, headers=headers)
        body = resp.json()
        if not isinstance(body, dict) or not body.get("id"):
            raise GraphError(f"upload of {path} answered without an item id")
        return body

    async def move(self, drive_id: str, item_id: str, parent_id: str, name: str | None = None) -> dict[str, Any]:
        """Move an item into another folder (keeping its name unless ``name`` is given)."""
        url = f"{self._graph_root}/drives/{drive_id}/items/{quote(item_id, safe='')}"
        body: dict[str, Any] = {"parentReference": {"id": parent_id}}
        if name:
            body["name"] = name
        # rename, not fail: a target folder that already holds the name (a photo removed,
        # re-added and removed again) gets «name 1.jpg» — a 409 here used to read as «done»
        # and left the photo in Fotos/.
        resp = await self._send("PATCH", url, json=body, params={"@microsoft.graph.conflictBehavior": "rename"})
        return resp.json()

    async def read_json(self, drive_id: str, path: str) -> tuple[dict[str, Any] | None, str | None]:
        """(parsed JSON, eTag) of the file at ``path``; (None, None) when there is none."""
        found = await self.item(drive_id, path)
        if found is None or "file" not in found:
            return None, None
        remote = RemoteFile(
            path=path,
            item_id=str(found["id"]),
            name=str(found.get("name") or ""),
            size=int(found.get("size") or 0),
            etag=str(found.get("eTag") or ""),
            download_url=found.get("@microsoft.graph.downloadUrl")
            if isinstance(found.get("@microsoft.graph.downloadUrl"), str)
            else None,
        )
        data = await self.download(drive_id, remote, max_bytes=5 * 1024 * 1024)
        try:
            parsed = json.loads(data)
        except ValueError:
            return None, remote.etag or None
        return (parsed if isinstance(parsed, dict) else None), remote.etag or None
