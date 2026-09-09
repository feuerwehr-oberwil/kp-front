"""Microsoft Graph, the thin read-only half: a token, a folder, its files, their bytes.

**What this module is for.** A station already keeps its Objektpläne, Geodaten, Checklisten
and the Arbeitsmappe in SharePoint. This is the transport that fetches them; deciding what a
file MEANS is `sharepoint_sync`, and writing it is the existing importers. Nothing here knows
what an Objektplan is.

**Read-only, always.** Every request below is a GET. There is no write path in this module and
there must never be one: the app's promise to a station is that pointing it at a folder cannot
damage that folder, and the cheapest way to keep a promise like that is to have no code that
could break it. The app registration is expected to hold `Sites.Selected` (scoped to the one
site) or, where per-site consent is too fiddly for a volunteer with tenant access,
`Files.Read.All` — see docs/sharepoint-connector.md.

**No SDK.** `msgraph-sdk` pulls in Kiota, its serializers and an auth stack for four request
shapes we make with the httpx that is already here. The four are frozen public REST contracts
(learn.microsoft.com), so the risk of writing them out is knowing them, not maintaining them.

**Injectable client, so the tests never touch a network.** Every call goes through the
`httpx.AsyncClient` handed to :class:`GraphClient`; `sharepoint_sync` builds a real one and the
tests hand in an `httpx.MockTransport`. That is the whole mocking strategy — there is no
monkeypatching of internals anywhere in the suite.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

logger = logging.getLogger(__name__)

GRAPH_ROOT = "https://graph.microsoft.com/v1.0"
LOGIN_ROOT = "https://login.microsoftonline.com"
#: The client-credentials scope for application permissions: «everything this app was consented
#: for», which is the only form Graph accepts for this flow.
GRAPH_SCOPE = "https://graph.microsoft.com/.default"

#: A token is good for roughly an hour. Renewed a minute early so a request never starts with
#: a token that expires while it is in flight.
_TOKEN_SKEW_SECONDS = 60

#: How many pages of a listing we will follow before calling the folder unreasonable. A station
#: plan library is hundreds of files; a hundred pages of 200 is twenty thousand.
MAX_PAGES = 100
#: Depth of the recursive walk. Deeper than any convention in docs/sharepoint-connector.md and
#: shallow enough that a symlinked loop (or a mistake) cannot become an unbounded crawl.
MAX_DEPTH = 6


class GraphError(Exception):
    """A Graph request failed. Carries the HTTP status where there was one."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class GraphAuthError(GraphError):
    """The tenant refused the app registration — wrong id, wrong secret, or (the one that
    happens on its own, two years in) an EXPIRED client secret.

    Separate from :class:`GraphError` because it is the one failure an operator has to be told
    about in words rather than left to find in a log: nothing this connector does will start
    working again by itself."""


class GraphDeltaExpiredError(GraphError):
    """Graph answered 410 Gone: the stored deltaLink is too old or the server state moved on.
    Not an error condition — the caller drops the token and enumerates from scratch."""


@dataclass(frozen=True)
class RemoteFile:
    """One file in a source folder, as the sync needs it.

    ``path`` is relative to the CONFIGURED folder (``dorfmatt/modul1.pdf``), never the drive
    root: it is the string the per-area conventions are read against, and it must not change
    because somebody moved the whole tree one level down.
    """

    path: str
    item_id: str
    name: str
    size: int
    #: Graph's eTag for this item. The change detector — the same eTag means the same bytes,
    #: so an unchanged file is never downloaded twice.
    etag: str
    #: Short-lived pre-authenticated download URL. Absent on some items; the client then falls
    #: back to `/content`.
    download_url: str | None = None

    @property
    def suffix(self) -> str:
        """Lower-case extension including the dot ('.pdf'), or '' for a name without one."""
        _, dot, ext = self.name.rpartition(".")
        return f".{ext.lower()}" if dot else ""


def _path_url(root: str, drive_id: str, path: str) -> str:
    """Address a folder INSIDE a drive by its path, Graph's colon syntax.

    ``/drives/{id}/root:/kp-data/plans`` — the colon after ``root`` is what turns the rest into
    a path. An empty path is the drive root, which has no colon form at all.
    """
    if not path:
        return f"{root}/drives/{drive_id}/root"
    return f"{root}/drives/{drive_id}/root:/{quote(path, safe='/')}"


class GraphClient:
    """One tenant's Graph session: caches a token, makes GETs, raises German-free errors.

    Deliberately not a context manager and not the owner of its `httpx.AsyncClient` — the
    caller opens one for the whole sync run and closes it there, so a run of four areas makes
    one connection pool and one token.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        login_root: str = LOGIN_ROOT,
        graph_root: str = GRAPH_ROOT,
    ) -> None:
        self._client = client
        self._tenant_id = tenant_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._login_root = login_root.rstrip("/")
        self._graph_root = graph_root.rstrip("/")
        self._token: str | None = None
        self._token_expires_at = 0.0

    # --- auth ---------------------------------------------------------------------------

    async def token(self) -> str:
        """A valid access token, from cache or from the tenant's token endpoint."""
        if self._token and time.monotonic() < self._token_expires_at:
            return self._token
        url = f"{self._login_root}/{quote(self._tenant_id, safe='')}/oauth2/v2.0/token"
        try:
            resp = await self._client.post(
                url,
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "scope": GRAPH_SCOPE,
                    "grant_type": "client_credentials",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except httpx.HTTPError as e:
            raise GraphError(f"token endpoint unreachable: {e}") from e
        if resp.status_code != 200:
            # ⚠️ The tenant's own description is the useful half («AADSTS7000222: The provided
            # client secret keys for app … are expired»), and it names no secret — Azure echoes
            # the app id, never the value. Truncated so a stray HTML error page cannot become a
            # paragraph on the System card.
            raise GraphAuthError(_error_detail(resp), status=resp.status_code)
        body = resp.json()
        token = body.get("access_token")
        if not isinstance(token, str) or not token:
            raise GraphAuthError("token response carried no access_token")
        self._token = token
        expires_in = body.get("expires_in")
        seconds = float(expires_in) if isinstance(expires_in, (int, float, str)) and str(expires_in).isdigit() else 3600
        self._token_expires_at = time.monotonic() + max(0.0, seconds - _TOKEN_SKEW_SECONDS)
        return token

    # --- requests -----------------------------------------------------------------------

    async def get_json(self, url: str) -> dict[str, Any]:
        """GET a Graph URL and return its JSON body, or raise a typed :class:`GraphError`."""
        headers = {"Authorization": f"Bearer {await self.token()}", "Accept": "application/json"}
        try:
            resp = await self._client.get(url, headers=headers)
        except httpx.HTTPError as e:
            raise GraphError(f"{_redact(url)}: {e}") from e
        if resp.status_code == 410:
            raise GraphDeltaExpiredError(_error_detail(resp), status=410)
        if resp.status_code in (401, 403):
            raise GraphAuthError(_error_detail(resp), status=resp.status_code)
        if resp.status_code != 200:
            raise GraphError(f"{_redact(url)} → {resp.status_code}: {_error_detail(resp)}", status=resp.status_code)
        body = resp.json()
        if not isinstance(body, dict):
            raise GraphError(f"{_redact(url)}: expected a JSON object")
        return body

    # --- resolution ---------------------------------------------------------------------

    async def resolve_drive(self, *, site_url: str | None, drive_id: str | None, library: str | None) -> str:
        """The document library id this source addresses.

        A configured ``driveId`` is taken as given (a tenant admin handed it over). A
        ``siteUrl`` is split into hostname + server-relative path and resolved through
        ``GET /sites/{hostname}:/{path}``, which is the only addressing form that works from
        what an operator can see in a browser. ``library`` then picks a named document library
        instead of the site's default one.
        """
        if drive_id:
            return drive_id
        if not site_url:
            raise GraphError("source has neither siteUrl nor driveId")
        parts = urlsplit(site_url)
        host, site_path = parts.netloc, parts.path.strip("/")
        if not host:
            raise GraphError(f"siteUrl {site_url!r} has no hostname")
        url = f"{self._graph_root}/sites/{quote(host, safe='')}"
        if site_path:
            url += f":/{quote(site_path, safe='/')}"
        site = await self.get_json(url)
        site_id = site.get("id")
        if not isinstance(site_id, str) or not site_id:
            raise GraphError(f"site {site_url!r} carried no id")
        if not library:
            drive = await self.get_json(f"{self._graph_root}/sites/{quote(site_id, safe='')}/drive")
            got = drive.get("id")
            if not isinstance(got, str) or not got:
                raise GraphError(f"site {site_url!r} has no default document library")
            return got
        drives = await self.get_json(f"{self._graph_root}/sites/{quote(site_id, safe='')}/drives")
        for entry in drives.get("value") or []:
            if isinstance(entry, dict) and entry.get("name") == library and isinstance(entry.get("id"), str):
                return str(entry["id"])
        names = ", ".join(str(e.get("name")) for e in (drives.get("value") or []) if isinstance(e, dict))
        raise GraphError(f"no document library named {library!r} on {site_url} (found: {names or 'none'})")

    async def resolve_folder(self, drive_id: str, path: str) -> str:
        """The item id of the configured folder — the anchor both the walk and delta hang off.

        Resolved rather than re-derived on every request because ids are what survive a rename:
        a station that renames its folder breaks the configured path, which is a state an
        operator can read on the System card, and NOT a state where the connector silently
        starts importing a different folder.
        """
        item = await self.get_json(_path_url(self._graph_root, drive_id, path))
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise GraphError(f"folder {path or '/'} carried no id")
        if "folder" not in item:
            raise GraphError(f"{path or '/'} is a file, not a folder")
        return item_id

    # --- listing ------------------------------------------------------------------------

    async def delta(self, drive_id: str, item_id: str, token: str | None) -> tuple[list[dict[str, Any]], str | None]:
        """Ask Graph what changed under this folder since ``token``.

        Used as a GATE and nothing more: an empty change list means the whole area can be
        skipped without a single further request, and anything else sends the caller to a full
        walk. That is deliberate — delta says an item changed but does not reliably say WHERE
        it lives (`parentReference.path` is documented as absent, ids are the stable handle),
        and the per-area conventions in this connector are read off paths. So delta answers
        «is there anything to do», the walk answers «what is there», and neither is asked to do
        the other's job.

        Returns ``(changed items, new delta token)``. Raises :class:`GraphDeltaExpiredError` when
        the stored token is too old — the caller drops it and walks.
        """
        if token:
            url = f"{self._graph_root}/drives/{drive_id}/items/{item_id}/delta?token={quote(token, safe='')}"
        else:
            url = f"{self._graph_root}/drives/{drive_id}/items/{item_id}/delta"
        changed: list[dict[str, Any]] = []
        next_token: str | None = None
        for _ in range(MAX_PAGES):
            body = await self.get_json(url)
            changed.extend(v for v in (body.get("value") or []) if isinstance(v, dict))
            delta_link = body.get("@odata.deltaLink")
            if isinstance(delta_link, str):
                next_token = _token_of(delta_link)
                break
            next_link = body.get("@odata.nextLink")
            if not isinstance(next_link, str) or not next_link:
                break
            url = next_link
        return changed, next_token

    async def walk(self, drive_id: str, item_id: str, *, prefix: str = "", depth: int = 0) -> list[RemoteFile]:
        """Every FILE under a folder, recursively, as paths relative to it.

        The authoritative listing, and the reason the refuse-to-empty guard can mean anything:
        a walk is a complete statement of what the folder holds, so «it holds nothing» is a
        claim the caller may act on — or, far more often, refuse to.
        """
        if depth > MAX_DEPTH:
            logger.warning("SharePoint: folder nesting past %d levels ignored below %r", MAX_DEPTH, prefix)
            return []
        out: list[RemoteFile] = []
        url = f"{self._graph_root}/drives/{drive_id}/items/{item_id}/children?$top=200"
        children: list[dict[str, Any]] = []
        for _ in range(MAX_PAGES):
            body = await self.get_json(url)
            children.extend(v for v in (body.get("value") or []) if isinstance(v, dict))
            next_link = body.get("@odata.nextLink")
            if not isinstance(next_link, str) or not next_link:
                break
            url = next_link
        for child in children:
            name = child.get("name")
            child_id = child.get("id")
            if not isinstance(name, str) or not isinstance(child_id, str) or not name or not child_id:
                continue
            path = f"{prefix}{name}"
            if "folder" in child:
                out.extend(await self.walk(drive_id, child_id, prefix=f"{path}/", depth=depth + 1))
                continue
            if "file" not in child:
                continue  # a OneNote section, a package — not a file we can fetch bytes for
            out.append(
                RemoteFile(
                    path=path,
                    item_id=child_id,
                    name=name,
                    size=int(child.get("size") or 0),
                    # cTag changes with the CONTENT, eTag also with metadata. Either is a
                    # correct change detector; cTag simply avoids re-downloading a file whose
                    # only change was somebody editing its SharePoint column. Falls back to
                    # eTag, and to the modification stamp where a tenant sends neither.
                    etag=str(child.get("cTag") or child.get("eTag") or child.get("lastModifiedDateTime") or ""),
                    download_url=_download_url(child),
                )
            )
        return out

    # --- bytes --------------------------------------------------------------------------

    async def download(self, drive_id: str, file: RemoteFile, *, max_bytes: int) -> bytes:
        """The file's bytes, refusing to buffer more than ``max_bytes``.

        Streamed and capped rather than `.read()`: the listing states each file's size, but the
        listing is the thing we are least entitled to trust, so the cap is enforced against the
        bytes actually arriving — the same rule the S3 plan pull follows (app/plans · get_object).

        ⚠️ The bytes are fetched from the pre-authenticated ``@microsoft.graph.downloadUrl``
        WITHOUT an Authorization header, and the `/content` fallback's redirect is resolved by
        hand rather than followed. Both point at a storage host, not at Graph: a tenant token
        forwarded to a redirect target is a token leaked to whoever the redirect names.
        """
        url = file.download_url
        if not url:
            url = await self._content_url(drive_id, file)
        buf = bytearray()
        try:
            async with self._client.stream("GET", url, headers={}) as resp:
                if resp.status_code != 200:
                    raise GraphError(f"download of {file.path} failed ({resp.status_code})", status=resp.status_code)
                async for chunk in resp.aiter_bytes():
                    buf += chunk
                    if len(buf) > max_bytes:
                        raise GraphError(f"{file.path} is over the {max_bytes // (1024 * 1024)} MB cap")
        except httpx.HTTPError as e:
            raise GraphError(f"download of {file.path} failed: {e}") from e
        return bytes(buf)

    async def _content_url(self, drive_id: str, file: RemoteFile) -> str:
        """The storage URL behind `/items/{id}/content`, for an item that carried no
        `@microsoft.graph.downloadUrl`. One authenticated request that is NOT followed — the
        Location is the pre-authenticated URL, and it is fetched bare."""
        url = f"{self._graph_root}/drives/{drive_id}/items/{file.item_id}/content"
        headers = {"Authorization": f"Bearer {await self.token()}"}
        try:
            resp = await self._client.get(url, headers=headers, follow_redirects=False)
        except httpx.HTTPError as e:
            raise GraphError(f"download of {file.path} failed: {e}") from e
        if resp.status_code in (401, 403):
            raise GraphAuthError(f"download of {file.path} refused ({resp.status_code})", status=resp.status_code)
        location = resp.headers.get("location")
        if resp.status_code in (301, 302, 303, 307, 308) and location:
            return location
        raise GraphError(f"download of {file.path} gave no content URL ({resp.status_code})", status=resp.status_code)


def _download_url(item: dict[str, Any]) -> str | None:
    url = item.get("@microsoft.graph.downloadUrl")
    return url if isinstance(url, str) and url.startswith("https://") else None


def _token_of(delta_link: str) -> str | None:
    """The opaque token inside a deltaLink, in either shape Graph returns it.

    ⚠️ BOTH shapes, because Graph uses both — `…/delta?token=abc` and `…/delta(token='abc')`
    appear in its own examples, sometimes in successive responses. A parser that knows only one
    silently returns nothing, and «nothing» reads as «no resume point», i.e. a full walk of the
    whole library on every single poll, forever, with no error anywhere.
    """
    quoted = "token='"
    if quoted in delta_link:
        rest = delta_link.split(quoted, 1)[1]
        return rest.split("'", 1)[0] or None
    if "token=" in delta_link:
        rest = delta_link.split("token=", 1)[1]
        return rest.split("&", 1)[0].split(")", 1)[0] or None
    return None


def _redact(url: str) -> str:
    """A URL safe to log: the path only. A deltaLink and a downloadUrl both carry credentials
    in their query string, and this module's errors end up on an admin page."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def _error_detail(resp: httpx.Response) -> str:
    """Graph's own message for a failed response, trimmed. Graph error bodies name apps and
    ids, never secrets — the value is the AADSTS code an operator can search for."""
    try:
        body = resp.json()
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict):
                return str(error.get("message") or error.get("code") or "")[:400]
            if isinstance(error, str):
                return f"{error}: {str(body.get('error_description') or '')[:300]}"[:400]
    except ValueError:
        pass
    return resp.text[:200]
