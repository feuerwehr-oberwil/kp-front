"""The publish door refuses a plan that will not say which bytes it is.

⚠️ Why this lives on the SERVER and not in the manifest. `objects.manifest.json` grew a per-plan
`sha256` on 09.08.2026, and hours later the public demo went back to July's generated placeholder
Objektpläne anyway — plus a Modul 6 retired the day before, plus July's deployment config —
because a reset ran from a checkout at v0.1.0. The pin could not fire: an old tree carries an old
manifest *and* an old `admin_objects`, so the digest and the code that checks it go stale
together. The server is the only participant in a publish that is never the stale one, so this is
where the refusal has to be. A client that cannot name its own bytes is, by construction, older
than this guard.

Held here:
  * a declared digest is verified on EVERY deployment (a cheap, real corruption check);
  * where the deployment requires one — the public demo does, automatically — a MACHINE publish
    without a digest is refused, and nothing is written;
  * a person uploading a PDF in the admin UI is never asked for one, on any deployment;
  * the CLI declares one for every plan, pinned in the manifest or not, so a current checkout
    keeps working against a strict server.
"""

import hashlib
import uuid

import pytest
from sqlalchemy import select

from app import storage as storage_mod
from app.config import Settings, settings
from app.models import ObjectSite, ReferenceDataset

OBJ_ID = uuid.UUID("d0000000-0000-5000-8000-00000000b077")
DRAWN = b"%PDF-1.4\nthe drawn Modul 1\n"
PLACEHOLDER = b"%PDF-1.4\na generated placeholder\n"
DRAWN_SHA = hashlib.sha256(DRAWN).hexdigest()


@pytest.fixture
def isolated_storage(tmp_path, monkeypatch):
    """Point the storage root at a per-test tmp dir so tests never touch data/storage."""
    monkeypatch.setattr(storage_mod, "_ROOT", str(tmp_path))


@pytest.fixture
async def obj(db_session):
    o = ObjectSite(id=OBJ_ID, name="Schloss Musterdorf")
    db_session.add(o)
    await db_session.commit()
    return o


@pytest.fixture
def require_digest(monkeypatch):
    """Turn the deployment into one that requires a digest, the way the demo is."""
    monkeypatch.setattr(settings, "require_plan_digest", True)


async def _dataset(db, module: str) -> ReferenceDataset | None:
    return (
        await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == f"plan:{OBJ_ID}:{module}"))
    ).scalar_one_or_none()


# --- the setting itself -----------------------------------------------------------------


def test_the_public_demo_requires_a_digest_without_anyone_setting_a_flag():
    """Auto-armed off the in-process reset schedule — the thing that MAKES a box the demo.

    Not off `identity.demoMode`: that lives in `deployment_config`, which is precisely what a
    stale publish overwrites, so a guard keyed on it would be switched off by the event it
    exists to stop.
    """
    demo = Settings(demo_reset_cron="0 0 * * *")
    assert demo.is_public_demo and demo.plan_digest_required

    station = Settings()
    assert not station.is_public_demo and not station.plan_digest_required


def test_a_station_can_force_it_either_way():
    """A self-hoster running last year's CLI against this year's server must not be locked out
    by a flag they never set — and one who wants the guard must be able to just have it."""
    assert Settings(require_plan_digest=True).plan_digest_required
    assert not Settings(demo_reset_cron="0 0 * * *", require_plan_digest=False).plan_digest_required


# --- the door ---------------------------------------------------------------------------


async def test_an_undeclared_upload_is_refused_and_writes_nothing(
    client, admin_login, db_session, obj, isolated_storage, require_digest
):
    """The v0.1.0 CLI's request, exactly: file + title, no digest. This is the one that has to
    fail, because everything else about that publish looked like a success."""
    await admin_login(client)

    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", PLACEHOLDER, "application/pdf")},
        data={"title": "Schloss Musterdorf – Übersicht"},
    )

    assert r.status_code == 400, r.text
    assert "sha256" in r.json()["detail"]
    assert await _dataset(db_session, "modul1") is None


async def test_the_retired_module_cannot_come_back_either(
    client, admin_login, db_session, obj, isolated_storage, require_digest
):
    """Modul 6 was retired on 08.08. and was republished twice by old trees. Same door, so the
    same refusal — a module nobody has published since is not a special case."""
    await admin_login(client)
    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul6",
        files={"file": ("modul6.pdf", PLACEHOLDER, "application/pdf")},
    )
    assert r.status_code == 400
    assert await _dataset(db_session, "modul6") is None


async def test_a_declared_digest_that_matches_is_stored(
    client, admin_login, db_session, obj, isolated_storage, require_digest
):
    await admin_login(client)

    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", DRAWN, "application/pdf")},
        data={"sha256": DRAWN_SHA},
    )

    assert r.status_code == 200, r.text
    ds = await _dataset(db_session, "modul1")
    assert storage_mod.get_bytes(ds.storage_key) == DRAWN


async def test_bytes_that_are_not_the_declared_ones_are_refused(client, admin_login, db_session, obj, isolated_storage):
    """Verified even where a digest is NOT required — one hash turns a truncated or swapped
    upload into a 400 instead of a plan a crew opens at 3am."""
    await admin_login(client)

    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", PLACEHOLDER, "application/pdf")},
        data={"sha256": DRAWN_SHA},
    )

    assert r.status_code == 400, r.text
    assert await _dataset(db_session, "modul1") is None


async def test_a_malformed_digest_is_a_422_not_a_silent_pass(client, admin_login, db_session, obj, isolated_storage):
    """«sha256: TODO» must not read as «unpinned»."""
    await admin_login(client)
    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", DRAWN, "application/pdf")},
        data={"sha256": "TODO"},
    )
    assert r.status_code == 422
    assert await _dataset(db_session, "modul1") is None


async def test_an_ordinary_deployment_still_takes_an_undeclared_upload(
    client, admin_login, db_session, obj, isolated_storage
):
    """Default off: every self-hoster's older CLI still works. The guard is opt-in (and auto-on
    for the demo), not a new requirement on everyone."""
    await admin_login(client)
    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", DRAWN, "application/pdf")},
    )
    assert r.status_code == 200, r.text
    assert await _dataset(db_session, "modul1") is not None


async def test_a_person_in_the_admin_ui_is_never_asked_for_a_digest(
    client, admin_login, db_session, editor, obj, isolated_storage, require_digest
):
    """Even on the strictest deployment. Somebody who picked this PDF in a file dialog, in front
    of the plan they are replacing, has no tree to be stale — telling them to update their
    checkout would be an answer to a question they did not ask. The split is the one
    `auth.dependencies.get_optional_user` already draws: admin secret + a user = a person,
    admin secret alone = `admin_objects push`."""
    await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    await admin_login(client)

    r = await client.put(
        f"/api/objects/{OBJ_ID}/plans/modul1",
        files={"file": ("modul1.pdf", DRAWN, "application/pdf")},
    )

    assert r.status_code == 200, r.text
    ds = await _dataset(db_session, "modul1")
    assert ds is not None and ds.updated_by == editor.id  # stamped as a person, not as the CLI


# --- the client side of the same contract -------------------------------------------------


def test_the_cli_declares_a_digest_for_every_plan(tmp_path, monkeypatch):
    """`admin_objects push` sends `sha256` whether or not the manifest pins one — otherwise a
    current checkout would be refused by a strict server for an unpinned plan."""
    import json

    from app import admin_objects

    (tmp_path / "plans").mkdir()
    (tmp_path / "plans" / "modul1.pdf").write_bytes(DRAWN)
    manifest = tmp_path / "objects.manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "objects": [
                    {
                        "id": str(OBJ_ID),
                        "name": "Schloss Musterdorf",
                        "plans": [{"module": "modul1", "file": "plans/modul1.pdf"}],  # NOT pinned
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    sent: list[dict] = []

    class _Resp:
        status_code = 200
        text = "{}"

        def __init__(self, payload: object = None) -> None:
            self._payload = {} if payload is None else payload

        def json(self) -> object:
            return self._payload

    class _Client:
        def __init__(self, *a, **kw) -> None: ...
        def __enter__(self) -> "_Client":
            return self

        def __exit__(self, *a) -> None: ...
        def post(self, *a, **kw) -> _Resp:
            return _Resp()

        def get(self, url: str, **kw) -> _Resp:
            # `push` reads the deployment's current objects first, so it can report which ones
            # it CREATED rather than only «upserted N». This deployment has none yet.
            return _Resp([])

        def put(self, url: str, **kw) -> _Resp:
            sent.append({"url": url, "data": kw.get("data") or {}})
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "Client", _Client)
    objects = admin_objects._read_manifest(manifest)
    admin_objects._push(manifest, objects, "https://demo.example", "secret", dry_run=False)

    plan_put = next(s for s in sent if "/plans/" in s["url"])
    assert plan_put["data"]["sha256"] == DRAWN_SHA
