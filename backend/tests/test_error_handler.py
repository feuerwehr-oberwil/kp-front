"""Generic 500 handler: unhandled exceptions must still answer JSON {"detail": ...}.

Clients (the capture client in particular) parse `detail` out of every error response;
Starlette's plain-text "Internal Server Error" default broke that. The handler answers a
neutral German detail and keeps the traceback server-side — nothing internal may leak.
"""

import httpx
from fastapi import APIRouter


async def test_unhandled_exception_returns_json_500():
    from app.main import app

    router = APIRouter()

    @router.get("/api/_test/boom")
    async def boom() -> dict:
        raise RuntimeError("kaputt — darf nie zum Client")

    # Insert FIRST so the SPA catch-all (mounted last) can't shadow the throwaway route.
    route = router.routes[0]
    app.router.routes.insert(0, route)
    # ServerErrorMiddleware re-raises after responding; don't let the transport re-raise too.
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.get("/api/_test/boom")
    finally:
        app.router.routes.remove(route)

    assert r.status_code == 500
    assert r.headers["content-type"].startswith("application/json")
    assert r.json() == {"detail": "Interner Fehler"}
    assert "kaputt" not in r.text  # internals stay in the server log
