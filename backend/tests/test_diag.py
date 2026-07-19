"""Client error sink (POST /api/diag/client-error).

Covers:
- A well-formed report is accepted (204) and logged at WARNING with its fields.
- A minimal/empty body is accepted — every field is optional.
- No auth is required (a render crash can happen before/around login).
- An oversized field is rejected by validation (422), never a 500 — the diagnostics sink
  must not become a source of server errors.

Runs against the test DB (the endpoint itself touches no DB).
"""

import logging

import pytest

pytestmark = pytest.mark.asyncio


async def test_client_error_accepted_and_logged(client, caplog):
    with caplog.at_level(logging.WARNING, logger="kpfront.clienterror"):
        r = await client.post(
            "/api/diag/client-error",
            json={
                "kind": "render",
                "message": "Cannot read properties of undefined (reading 'id')",
                "stack": "at Foo (App.tsx:42)",
                "componentStack": "at Whiteboard",
                "path": "/",
                "build": "v0.1.0+abc1234",
            },
        )
    assert r.status_code == 204
    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "client-error" in logged
    assert "kind=render" in logged
    assert "reading 'id'" in logged


async def test_minimal_body_accepted(client):
    # every field is optional — a sparse report must still be accepted
    r = await client.post("/api/diag/client-error", json={})
    assert r.status_code == 204


async def test_no_auth_required(client):
    # no login: a crash can occur before the operator is authenticated
    r = await client.post("/api/diag/client-error", json={"message": "boom"})
    assert r.status_code == 204


async def test_oversized_field_is_rejected_not_500(client):
    # The client truncates before sending, so this only guards a non-conforming client: a
    # too-long field is a 422 validation error, NOT a 500 — the sink never crashes the server.
    r = await client.post("/api/diag/client-error", json={"message": "x" * 5000})
    assert r.status_code == 422
