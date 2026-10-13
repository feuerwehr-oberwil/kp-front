"""Board objects a saving build does not know are KEPT (review of #338, 10.10.2026).

An older build drops a board kind it has never heard of at its load gate, and its next full save
then carries a workspace without those objects — which the server stored as «deleted», for every
device. The client gate now passes unknown kinds through untouched (src/lib/workspace ·
isPassengerAnno), but builds already in the field do not, so the server keeps the promise for
them: a save stamped with a `schemaVersion` below the version a STORED object's kind arrived with
never removes that object. The object is put back, into the unified `objects` and into the
legacy `board` view alike, exactly as it was stored.

A build at or above that version is trusted to delete: it knows the kind, so an absence is a
decision. Add a row to `BOARD_KIND_SINCE` with every new board kind (and bump the client's
`WORKSPACE_SCHEMA_VERSION` with it).
"""

from __future__ import annotations

from typing import Any

#: board-anno kind → the workspace schema version that introduced it (src/lib/workspace.ts)
BOARD_KIND_SINCE: dict[str, int] = {"form": 3}


def _sheet_anno(obj: Any) -> tuple[str, dict] | None:
    if not isinstance(obj, dict):
        return None
    sheet = obj.get("sheet")
    if not isinstance(sheet, dict) or not isinstance(sheet.get("planId"), str):
        return None
    anno = sheet.get("anno")
    if not isinstance(anno, dict) or not isinstance(anno.get("kind"), str):
        return None
    return sheet["planId"], anno


def keep_newer_board_kinds(workspace: dict, stored: dict | None) -> list[str]:
    """Put back every stored board object whose kind is newer than the saving build. Mutates
    `workspace` (the body about to be stored); returns the ids it put back."""
    sv = workspace.get("schemaVersion")
    version = sv if isinstance(sv, int) and not isinstance(sv, bool) else 1
    newer = {kind for kind, since in BOARD_KIND_SINCE.items() if since > version}
    if not newer or not isinstance(stored, dict):
        return []
    raw_objects = stored.get("objects")
    stored_objects: list = raw_objects if isinstance(raw_objects, list) else []
    keep = []
    for obj in stored_objects:
        hit = _sheet_anno(obj)
        if hit and hit[1]["kind"] in newer:
            keep.append(obj)
    if not keep:
        return []
    put_back: list[str] = []
    objects = workspace.get("objects")
    if isinstance(objects, list):
        have = {o.get("id") for o in objects if isinstance(o, dict)}
        for obj in keep:
            if obj.get("id") not in have:
                objects.append(obj)
                put_back.append(obj.get("id"))
    board = workspace.get("board")
    if isinstance(board, dict) or not isinstance(objects, list):
        board = board if isinstance(board, dict) else {}
        for obj in keep:
            plan_id, anno = _sheet_anno(obj)  # type: ignore[misc]
            raw_sheet = board.get(plan_id)
            sheet: list = raw_sheet if isinstance(raw_sheet, list) else []
            if not any(isinstance(a, dict) and a.get("id") == anno.get("id") for a in sheet):
                sheet = [*sheet, anno]
                if obj.get("id") not in put_back:
                    put_back.append(obj.get("id"))
            board[plan_id] = sheet
        workspace["board"] = board
    return put_back
