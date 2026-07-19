"""Journal store (GET/POST /api/incidents/{id}/journal).

The Verlauf is the legal record, so the store's contract is strict:
- append assigns gapless per-incident seqs and returns them;
- replaying a batch (offline outbox retry after a lost response) inserts nothing twice;
- since_seq reads return only newer rows, oldest first — the live-poll cursor;
- viewers read but cannot write; unauthenticated requests are rejected;
- malformed rows (no id, oversized) and oversized batches are 422, unknown incident 404.
"""

import uuid

from app.api.journal import MAX_BATCH


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": "135790"})
    assert r.status_code == 200


async def _incident(client) -> str:
    r = await client.post("/api/incidents", json={"title": "Journal Test"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _rows(n, prefix="t"):
    return [{"id": f"{prefix}{i}", "t": "14:0" + str(i % 10), "icon": "flag", "text": f"Eintrag {i}"} for i in range(n)]


async def test_append_assigns_seqs_and_read_returns_them(client, editor):
    await _login(client, editor)
    inc = await _incident(client)

    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": _rows(3)})
    assert r.status_code == 201, r.text
    body = r.json()
    assert [e["seq"] for e in body["entries"]] == [1, 2, 3]
    assert body["latest_seq"] == 3

    r = await client.get(f"/api/incidents/{inc}/journal")
    page = r.json()
    assert [e["row"]["id"] for e in page["entries"]] == ["t0", "t1", "t2"]
    assert page["latest_seq"] == 3


async def test_replayed_batch_is_idempotent(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    batch = {"entries": _rows(2)}
    assert (await client.post(f"/api/incidents/{inc}/journal", json=batch)).status_code == 201

    # the outbox lost the response and retries the identical batch
    r = await client.post(f"/api/incidents/{inc}/journal", json=batch)
    assert r.status_code == 201
    assert r.json()["entries"] == []  # nothing newly accepted
    assert r.json()["latest_seq"] == 2

    # …and a mixed batch only inserts the genuinely new row, continuing the seq
    mixed = {"entries": _rows(2) + [{"id": "t9", "t": "15:00", "icon": "flag", "text": "neu"}]}
    r = await client.post(f"/api/incidents/{inc}/journal", json=mixed)
    assert [e["row"]["id"] for e in r.json()["entries"]] == ["t9"]
    assert r.json()["latest_seq"] == 3


async def test_since_seq_cursor(client, editor):
    await _login(client, editor)
    inc = await _incident(client)
    await client.post(f"/api/incidents/{inc}/journal", json={"entries": _rows(5)})

    r = await client.get(f"/api/incidents/{inc}/journal", params={"since_seq": 3})
    page = r.json()
    assert [e["seq"] for e in page["entries"]] == [4, 5]

    # cursor at head → empty page, latest_seq echoes the cursor (cheap poll tick)
    r = await client.get(f"/api/incidents/{inc}/journal", params={"since_seq": 5})
    assert r.json() == {"entries": [], "latest_seq": 5}


async def test_viewer_reads_but_cannot_write(client, editor, viewer):
    await _login(client, editor)
    inc = await _incident(client)
    await client.post(f"/api/incidents/{inc}/journal", json={"entries": _rows(1)})

    await _login(client, viewer)
    assert (await client.get(f"/api/incidents/{inc}/journal")).status_code == 200
    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": _rows(1, "x")})
    assert r.status_code == 403


async def test_unauthenticated_is_rejected(client):
    inc = uuid.uuid4()
    assert (await client.get(f"/api/incidents/{inc}/journal")).status_code == 401
    assert (await client.post(f"/api/incidents/{inc}/journal", json={"entries": []})).status_code == 401


async def test_validation_and_404(client, editor):
    await _login(client, editor)
    inc = await _incident(client)

    r = await client.post(f"/api/incidents/{inc}/journal", json={"entries": [{"text": "ohne id"}]})
    assert r.status_code == 422
    big = {"id": "tbig", "text": "x" * 40_000}
    assert (await client.post(f"/api/incidents/{inc}/journal", json={"entries": [big]})).status_code == 422
    too_many = {"entries": _rows(MAX_BATCH + 1)}
    assert (await client.post(f"/api/incidents/{inc}/journal", json=too_many)).status_code == 422

    missing = uuid.uuid4()
    assert (await client.get(f"/api/incidents/{missing}/journal")).status_code == 404
    assert (
        await client.post(f"/api/incidents/{missing}/journal", json={"entries": _rows(1)})
    ).status_code == 404


async def test_archive_stamps_einsatzende_and_documents_the_boundary(client, editor):
    await _login(client, editor)
    inc = await _incident(client)

    r = await client.patch(f"/api/incidents/{inc}", json={"is_archived": True})
    assert r.status_code == 200
    closed_at = r.json()["closed_at"]
    assert closed_at is not None  # first archive stamps the Einsatzende

    # …and self-documents in the journal
    j = (await client.get(f"/api/incidents/{inc}/journal")).json()
    assert any(e["row"]["text"] == "Einsatz abgeschlossen" for e in j["entries"])

    # reopen (the correction path) KEEPS the Einsatzende and appends its own marker
    r = await client.patch(f"/api/incidents/{inc}", json={"is_archived": False})
    assert r.json()["closed_at"] == closed_at
    j = (await client.get(f"/api/incidents/{inc}/journal")).json()
    assert any("wiedereröffnet" in e["row"]["text"] for e in j["entries"])

    # re-archiving later does NOT move the original Einsatzende
    r = await client.patch(f"/api/incidents/{inc}", json={"is_archived": True})
    assert r.json()["closed_at"] == closed_at
