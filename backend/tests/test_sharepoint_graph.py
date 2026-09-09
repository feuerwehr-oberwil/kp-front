"""The Graph transport: the token it reuses, the URLs it builds, and the two it never trusts.

These are the properties that are invisible from the sync tests because they concern the wire:
whether a run makes one token request or twenty, whether a tenant token is forwarded to a
storage host, and whether the connector can write anything at all.
"""

import httpx
import pytest

from app.sharepoint_graph import (
    GraphAuthError,
    GraphClient,
    GraphDeltaExpiredError,
    GraphError,
    RemoteFile,
    _redact,
    _token_of,
)

# No `pytestmark`: this file mixes async and plain tests, and pytest's asyncio_mode="auto"
# (backend/pyproject.toml) already runs the async ones.
TENANT = "11111111-1111-4111-8111-111111111111"


def build(handler) -> tuple[GraphClient, httpx.AsyncClient]:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return GraphClient(http, tenant_id=TENANT, client_id="client", client_secret="secret"), http


def token_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})


async def test_one_token_serves_a_whole_run():
    """A run touches four areas and dozens of files. Asking the tenant for a token per request
    would be both slow and, at Azure's rate limits, a way to get throttled mid-sync."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.path.endswith("/token"):
            return token_ok(request)
        return httpx.Response(200, json={"id": "x"})

    graph, http = build(handler)
    async with http:
        await graph.get_json("https://graph.microsoft.com/v1.0/sites/x")
        await graph.get_json("https://graph.microsoft.com/v1.0/sites/y")
    assert sum(1 for c in calls if c.endswith("/token")) == 1


async def test_the_secret_is_posted_to_the_tenant_and_nowhere_else():
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            seen["body"] = request.content.decode()
            seen["url"] = str(request.url)
            return token_ok(request)
        seen["headers"] = str(dict(request.headers))
        return httpx.Response(200, json={"id": "x"})

    graph, http = build(handler)
    async with http:
        await graph.get_json("https://graph.microsoft.com/v1.0/sites/x")

    assert seen["url"] == f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token"
    assert "grant_type=client_credentials" in seen["body"]
    assert "scope=https%3A%2F%2Fgraph.microsoft.com%2F.default" in seen["body"]
    assert "secret" not in seen["headers"], "the secret never travels to Graph itself"


async def test_an_expired_secret_is_an_auth_error_carrying_the_tenant_s_own_words():
    """AADSTS7000222 is the code an operator can search for, and Azure's message names the app,
    never the secret — so it is worth putting on the System card verbatim."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": "invalid_client", "error_description": "AADSTS7000222: client secret keys are expired."},
        )

    graph, http = build(handler)
    with pytest.raises(GraphAuthError, match="AADSTS7000222"):
        async with http:
            await graph.token()


async def test_a_410_is_its_own_signal_and_not_a_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return token_ok(request)
        return httpx.Response(410, json={"error": {"code": "resyncRequired", "message": "token too old"}})

    graph, http = build(handler)
    with pytest.raises(GraphDeltaExpiredError):
        async with http:
            await graph.delta("drive", "item", "an-old-token")


async def test_a_download_never_carries_the_tenant_token_to_the_storage_host():
    """⚠️ `@microsoft.graph.downloadUrl` points at a pre-authenticated storage host, not at
    Graph. Forwarding an Authorization header there hands a tenant token to whoever the
    redirect names."""
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.path.endswith("/token"):
            return token_ok(request)
        return httpx.Response(200, content=b"%PDF-1.4")

    graph, http = build(handler)
    file = RemoteFile("a.pdf", "id", "a.pdf", 8, "etag", download_url="https://storage.example/blob?sig=abc")
    async with http:
        data = await graph.download("drive", file, max_bytes=1024)

    assert data == b"%PDF-1.4"
    assert ("storage.example", None) in seen


async def test_the_content_fallback_resolves_its_redirect_by_hand():
    """Same rule for the item that carries no downloadUrl: the authenticated request is not
    followed, and the Location it names is fetched bare."""
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.path.endswith("/token"):
            return token_ok(request)
        if request.url.host == "graph.microsoft.com":
            return httpx.Response(302, headers={"location": "https://storage.example/blob?sig=abc"})
        return httpx.Response(200, content=b"bytes")

    graph, http = build(handler)
    async with http:
        assert await graph.download("drive", RemoteFile("a.bin", "id", "a.bin", 5, "etag"), max_bytes=1024) == b"bytes"

    assert ("graph.microsoft.com", "Bearer tok") in seen
    assert ("storage.example", None) in seen


async def test_a_file_larger_than_the_cap_is_refused_against_the_bytes_that_arrive():
    """The listing states a size, and the listing is what we are least entitled to trust."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 5000)

    graph, http = build(handler)
    file = RemoteFile("big.pdf", "id", "big.pdf", 10, "etag", download_url="https://storage.example/blob")
    with pytest.raises(GraphError, match="cap"):
        async with http:
            await graph.download("drive", file, max_bytes=1024)


async def test_the_walk_returns_paths_relative_to_the_configured_folder():
    """Every per-area convention is read off this string, so it must not shift when a station
    moves the whole tree one level down."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return token_ok(request)
        if "folder::sub" in str(request.url):
            return httpx.Response(
                200,
                json={"value": [{"id": "f1", "name": "modul1.pdf", "file": {}, "size": 3, "cTag": "e1"}]},
            )
        return httpx.Response(200, json={"value": [{"id": "folder::sub", "name": "dorfmatt", "folder": {}}]})

    graph, http = build(handler)
    async with http:
        files = await graph.walk("drive", "root")

    assert [(f.path, f.etag) for f in files] == [("dorfmatt/modul1.pdf", "e1")]


@pytest.mark.parametrize(
    ("link", "expected"),
    [
        ("https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc123", "abc123"),
        ("https://graph.microsoft.com/v1.0/me/drive/root/delta(token='abc123')", "abc123"),
        ("https://graph.microsoft.com/v1.0/me/drive/root/delta", None),
    ],
)
def test_both_shapes_of_deltalink_yield_their_token(link, expected):
    """Graph returns the query form and the function-call form, and a resume point read out of
    only one of them means a full walk on every single poll."""
    assert _token_of(link) == expected


def test_a_logged_url_carries_no_signature():
    """A deltaLink and a downloadUrl both hold credentials in their query string, and these
    errors are printed on an admin page."""
    assert _redact("https://storage.example/blob?sig=secret&x=1") == "https://storage.example/blob"


def test_the_transport_owns_no_write_verb():
    """The promise a station is given: pointing this app at a folder cannot damage the folder.
    The cheapest way to keep a promise like that is to own no code that could break it — so the
    only non-GET in this module is the POST that fetches a token from the tenant."""
    import inspect

    from app import sharepoint_graph

    body = inspect.getsource(sharepoint_graph)
    for verb in (".put(", ".patch(", ".delete(", '"PUT"', '"PATCH"', '"DELETE"'):
        assert verb not in body, f"{verb} has no business in this module"
    assert body.count("self._client.post(") == 1, "the token request is the one and only POST"
