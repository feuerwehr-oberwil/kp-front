"""Shared helpers for the Objektbesuche tests (test_object_visits*.py)."""

from __future__ import annotations

import hashlib
import io
import uuid
from typing import Any

from PIL import Image
from sqlalchemy import select

from app import credentials as creds
from app.models import DeploymentConfig, ObjectSite
from tests.conftest import TEST_PIN

TEMPLATE: dict[str, Any] = {
    "id": "schluesselhuelse",
    "kind": "visit",
    "version": 1,
    "title": "Kontrolle Schlüsselhülse",
    "phases": [
        {
            "id": "huelse",
            "title": "Schlüsselhülse",
            "items": [
                {"id": "zugaenglich", "text": "Schlüsselhülse zugänglich", "input": "check"},
                {"id": "oeffnen", "text": "Lässt sich öffnen", "input": "check"},
                {"id": "gereinigt", "text": "Grob gereinigt", "input": "yesno"},
                {
                    "id": "zustand",
                    "text": "Zustand",
                    "input": "choice",
                    "options": [{"id": "gut", "label": "Gut"}, {"id": "mittel", "label": "Mittel"}],
                },
                {"id": "anzahl", "text": "Anzahl Schlüssel", "input": "number", "unit": "Stk."},
                {"id": "foto", "text": "Foto Schlüsselhülse", "input": "photo", "required": True},
            ],
        }
    ],
}

INTEGRATION_KEY = "organizer-key-0123456789-abcdefghij"


def jpeg(color: str = "red", size: tuple[int, int] = (64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def set_config(db, section: dict[str, Any] | None = None, **extra: Any) -> None:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    doc = {"objectVisits": {"enabled": True, **(section or {})}, **extra}
    if row is None:
        db.add(DeploymentConfig(id=1, config_json=doc))
    else:
        row.config_json = {**(row.config_json or {}), **doc}
    await db.commit()


async def make_object(db, name: str = "Gemeindeverwaltung", address: str | None = "Hauptstrasse 24", **kw: Any):
    obj = ObjectSite(id=uuid.uuid4(), name=name, address=address, **kw)
    db.add(obj)
    await db.commit()
    return obj


async def set_key(db) -> None:
    await creds.set_value(db, "object_visits_integration_key", INTEGRATION_KEY, actor_id=None)
    await db.commit()


def bearer() -> dict[str, str]:
    return {"Authorization": f"Bearer {INTEGRATION_KEY}"}


async def login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": TEST_PIN})
    assert r.status_code == 200, r.text


_counter = 0


def new_id(prefix: str) -> str:
    global _counter
    _counter += 1
    return f"{prefix}1759473240{_counter:03d}-{uuid.uuid4().hex[:4]}"


def visit_doc(visit_id: str, obj, **over: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "schema": "kp-front.object-visit/1",
        "id": visit_id,
        "object": {"id": str(obj.id), "name": obj.name, "address": obj.address, "folder": None, "refs": []},
        "visitedAt": "2026-10-03T08:14:00+02:00",
        "with": ["Frei Nina"],
        "lifecycle": "draft",
        "checklist": TEMPLATE,
        "answers": {},
        "notes": "",
        "photos": [],
        "proposals": [],
        "conflicts": [],
    }
    doc.update(over)
    return doc


async def put(client, visit_id: str, doc: dict[str, Any], base: int | None, op: str | None = None):
    return await client.put(
        f"/api/object-visits/{visit_id}",
        json={"opId": op or new_id("ovo"), "baseRevision": base, "doc": doc},
    )


async def upload(client, visit_id: str, att_id: str, data: bytes, ctype: str = "image/jpeg", digest: str | None = None):
    return await client.put(
        f"/api/object-visits/{visit_id}/attachments/{att_id}",
        content=data,
        headers={"Content-Type": ctype, "X-Content-SHA256": digest or sha(data)},
    )
