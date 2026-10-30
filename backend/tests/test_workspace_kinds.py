"""A build older than a board kind must not delete objects of that kind (review of #338).

An old client drops a `form` object (a Tafel page) at its load gate and saves a workspace without
it. The server puts it back — it is not a deletion — while a build that knows the kind may delete.
"""

import json
from pathlib import Path

from app import workspace_kinds
from app.workspace_kinds import BOARD_KIND_SINCE, keep_newer_board_kinds

PAGE = {"id": "fm1", "kind": "form", "form": {"v": 1, "at": "2026-10-10T09:00:00Z", "values": {}}}
INK = {"id": "l1", "kind": "draw", "pts": [[0.1, 0.1], [0.2, 0.2]]}


def _blob(sv: int, *annos: dict) -> dict:
    return {
        "schemaVersion": sv,
        "objects": [{"id": a["id"], "sheet": {"planId": "tafel", "anno": a}} for a in annos],
        "board": {"tafel": list(annos)},
    }


def test_an_older_build_cannot_delete_a_page_it_never_saw():
    stored = _blob(3, INK, PAGE)
    incoming = _blob(2, INK)  # what a v2 build saves: its gate dropped the page
    assert keep_newer_board_kinds(incoming, stored) == ["fm1"]
    assert [o["id"] for o in incoming["objects"]] == ["l1", "fm1"]
    assert [a["id"] for a in incoming["board"]["tafel"]] == ["l1", "fm1"]
    assert incoming["objects"][1] == stored["objects"][1]  # exactly as stored


def test_a_build_that_knows_the_kind_may_delete_it():
    incoming = _blob(3, INK)
    assert keep_newer_board_kinds(incoming, _blob(3, INK, PAGE)) == []
    assert [o["id"] for o in incoming["objects"]] == ["l1"]


def test_a_legacy_blob_without_objects_gets_it_back_in_its_board_view():
    incoming = {"board": {"tafel": [INK]}}  # no schemaVersion: v1
    keep_newer_board_kinds(incoming, _blob(3, INK, PAGE))
    assert [a["id"] for a in incoming["board"]["tafel"]] == ["l1", "fm1"]


async def test_end_to_end_an_old_save_is_refused_and_the_pages_stay(client, editor):
    # since 30.10.2026 a save from an older build is refused whole (workspace_kinds ·
    # refuse_older_build, tests/test_older_build_guard.py); the kind guard stays as the inner line
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200
    inc = (await client.post("/api/incidents", json={"title": "Brand"})).json()["id"]
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": _blob(3, INK, PAGE), "base_rev": 0})
    assert r.status_code == 200, r.text
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": _blob(2, INK), "base_rev": 1})
    assert r.status_code == 409, r.text
    ws = (await client.get(f"/api/incidents/{inc}/workspace")).json()["workspace"]
    assert [o["id"] for o in ws["objects"]] == ["l1", "fm1"]
    # …and the build that drew the page may still take it off
    r = await client.put(f"/api/incidents/{inc}/workspace", json={"workspace": _blob(3, INK), "base_rev": 1})
    assert r.status_code == 200, r.text
    ws = (await client.get(f"/api/incidents/{inc}/workspace")).json()["workspace"]
    assert [o["id"] for o in ws["objects"]] == ["l1"]


def test_the_version_table_is_the_shared_file():
    # the client checks the same file against its BoardKind union (src/lib/boardKinds.test.ts)
    data = json.loads((Path(workspace_kinds.__file__).parent / "data" / "board_kinds.json").read_text("utf-8"))
    assert data["since"] == BOARD_KIND_SINCE
    assert BOARD_KIND_SINCE["form"] == 3  # Tafel pages: the kind the server protects today
    assert all(isinstance(v, int) and v >= 1 for v in BOARD_KIND_SINCE.values())
