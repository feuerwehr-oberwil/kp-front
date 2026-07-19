"""Smoke test for Phase 2 (incidents, workspace, events, media) against a live server."""

import io
import sys

import httpx

BASE = "http://localhost:8000"


def main() -> int:
    cmd = httpx.Client(base_url=BASE)
    viewer = httpx.Client(base_url=BASE)

    roster = cmd.get("/api/auth/roster").json()
    kdt = next(u for u in roster if u["display_name"] == "Kommandant")
    vw = next(u for u in roster if u["role"] == "viewer")
    cmd.post("/api/auth/login", json={"user_id": kdt["id"], "pin": "112112"}).raise_for_status()
    viewer.post("/api/auth/login", json={"user_id": vw["id"], "pin": "000000"}).raise_for_status()
    print("logged in editor + viewer")

    # create
    inc = cmd.post("/api/incidents", json={"title": "Testbrand Hauptstrasse 1", "type": "Brand",
                                           "priority": "HIGH", "address": "Hauptstrasse 1, Musterdorf",
                                           "lat": 47.515102, "lng": 7.55604}).json()
    iid = inc["id"]
    assert inc["source"] == "manual" and inc["workspace_rev"] == 0
    print("created incident", iid)

    # viewer cannot create / save
    r = viewer.post("/api/incidents", json={"title": "x"})
    assert r.status_code == 403, r.status_code
    print("viewer create -> 403 OK")

    # save workspace rev 0 -> 1
    ws = {"schemaVersion": 1, "entities": [{"id": "e1", "kind": "symbol"}], "drawings": [], "timeline": []}
    r = cmd.put(f"/api/incidents/{iid}/workspace", json={"workspace": ws, "base_rev": 0}).json()
    assert r["workspace_rev"] == 1, r
    print("workspace saved rev ->", r["workspace_rev"])

    # stale base_rev -> 409
    r = cmd.put(f"/api/incidents/{iid}/workspace", json={"workspace": ws, "base_rev": 0})
    assert r.status_code == 409, r.status_code
    print("stale save -> 409 OK")

    # viewer save -> 403
    assert viewer.put(f"/api/incidents/{iid}/workspace", json={"workspace": ws, "base_rev": 1}).status_code == 403
    print("viewer save -> 403 OK")

    # live-follow: 304 when since == rev
    r = viewer.get(f"/api/incidents/{iid}/workspace", params={"since": 1})
    assert r.status_code == 304, r.status_code
    r = viewer.get(f"/api/incidents/{iid}/workspace", params={"since": 0})
    assert r.status_code == 200 and r.json()["workspace_rev"] == 1
    print("live-follow 304/200 OK")

    # status change emits an event
    cmd.patch(f"/api/incidents/{iid}", json={"status": "in_arbeit"}).raise_for_status()

    # ingest client tactical events
    cmd.post(f"/api/incidents/{iid}/events", json={"events": [
        {"op_type": "entity.add", "payload": {"id": "e1"}},
        {"op_type": "entity.move", "payload": {"id": "e1", "to": [7.5, 47.5]}},
    ]}).raise_for_status()
    events = cmd.get(f"/api/incidents/{iid}/events").json()
    assert len(events) >= 4, len(events)  # create + status + 2 client
    print(f"events: {len(events)} ({[e['op_type'] for e in events]})")

    # verify the hash chain
    v = cmd.get(f"/api/incidents/{iid}/verify").json()
    assert v["intact"] is True, v
    print("chain verify -> intact, head", v["head"][:12])

    # media upload + fetch
    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082")
    up = cmd.post(f"/api/incidents/{iid}/media", files={"file": ("p.png", io.BytesIO(png), "image/png")},
                  data={"kind": "photo"}).json()
    assert up["url"].startswith("/api/media/"), up
    got = viewer.get(up["url"])
    assert got.status_code == 200 and got.content == png
    print("media upload + viewer fetch OK")

    # people + notes
    cmd.put(f"/api/incidents/{iid}/people", json=[{"role": "einsatzleiter", "name": "M. Muster"}]).raise_for_status()
    assert len(cmd.get(f"/api/incidents/{iid}/people").json()) == 1
    cmd.post(f"/api/incidents/{iid}/notes", json={"text": "Erste Lage erkundet"}).raise_for_status()
    assert len(cmd.get(f"/api/incidents/{iid}/notes").json()) == 1
    print("people + notes OK")

    print("\nALL PHASE-2 SMOKE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
