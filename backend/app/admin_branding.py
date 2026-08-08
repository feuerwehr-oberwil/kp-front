"""Admin CLI for the branding assets — logo, report logo, favicon (sibling to admin_config).

Branding is uploaded at RUNTIME (no rebuild): the file goes into the blob store and its public
URL is written into ``identity.assets[slot]`` of the deployment-config singleton. The admin UI
does the same thing through the browser; this exists for the paths a browser is bad at —

* a **demo reset**, which reloads ``config.json`` every night and would otherwise wipe an asset
  somebody uploaded by hand (``identity.assets`` is part of the config it overwrites), and
* a **station rollout**, where the logo is a file in the station's own data folder and should be
  installed the same reproducible way the geodata and the Objektpläne are.

Run from ``backend/``::

    uv run python -m app.admin_branding push reportLogo path/to/logo.svg
    uv run python -m app.admin_branding load reportLogo path/to/logo.png
    uv run python -m app.admin_branding show

`push` goes through a RUNNING deployment's HTTP API (authenticating with ``ADMIN_SECRET``, the
same handshake ``admin_geodata push`` uses), so the server writes its own volume — which is what
makes it safe to run from a workstation against a remote deployment.

`load` is the DB-direct sibling — the same path ``admin_config load`` and ``admin_geodata load``
take, for a dataset that is loaded next to them (``examples/demo-data/load.sh``) rather than
uploaded by a person. It writes the blob under a key derived from the SLOT, so re-running it
overwrites in place instead of leaving a new orphan behind every night.

Slots: ``logo`` (login screen, header), ``reportLogo`` (letterhead of the printed
Einsatzrapport; falls back to ``logo`` when unset), ``favicon`` (browser tab).
"""

import argparse
import os
import sys
from pathlib import Path

SLOTS = ("logo", "reportLogo", "favicon")

#: Mirrors the API allowlist (app/api/branding.py). Checked here too so a typo fails on the
#: workstation with a readable message instead of as a 415 after the upload has been sent.
_CONTENT_TYPES = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


#: DB-direct `load` writes under a stable, slot-derived key. The HTTP upload mints a random one
#: per file (a person replacing a logo wants the old URL to stop resolving), but a dataset that
#: is re-loaded on every demo reset would then leave one orphaned blob per night — and the
#: config URL would change under a browser that had cached it.
def _stable_key(slot: str, suffix: str) -> str:
    return f"branding/{slot}{suffix}"


def _fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def _push(slot: str, path: Path, base: str, admin_secret: str) -> str:
    import httpx  # lazy: only `push` needs the network

    ctype = _CONTENT_TYPES.get(path.suffix.lower())
    if ctype is None:
        _fail(f"ERROR: {path.suffix or path.name!r} is not an allowed image type ({', '.join(sorted(_CONTENT_TYPES))})")
    with httpx.Client(base_url=base.rstrip("/"), timeout=120.0) as c:
        r = c.post("/api/admin/login", json={"secret": admin_secret})
        if r.status_code != 200:
            _fail(f"ERROR: admin login to {base} failed ({r.status_code}): {r.text[:200]}")
        up = c.post(f"/api/branding/{slot}", files={"file": (path.name, path.read_bytes(), ctype)})
        if up.status_code not in (200, 201):
            _fail(f"ERROR: upload of {path.name} to {slot} failed ({up.status_code}): {up.text[:300]}")
        assets = (up.json().get("identity") or {}).get("assets") or {}
        return str(assets.get(slot) or "")


async def _load(slot: str, path: Path) -> str:
    """Write the file into the blob store and point ``identity.assets[slot]`` at it."""
    from sqlalchemy import select

    from . import storage
    from .database import async_session_maker
    from .models import DeploymentConfig

    key = _stable_key(slot, path.suffix.lower())
    storage.put_bytes(key, path.read_bytes())
    url = f"/api/branding/file/{key}"
    async with async_session_maker() as db:
        row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
        doc = dict((row.config_json if row else None) or {})
        identity = dict(doc.get("identity") or {})
        assets = dict(identity.get("assets") or {})
        assets[slot] = url
        identity["assets"] = assets
        doc["identity"] = identity
        if row is None:
            db.add(DeploymentConfig(id=1, config_json=doc))
        else:
            # reassign, don't mutate: the JSON column only notices a new object
            row.config_json = doc
        await db.commit()
    return url


def _show(base: str) -> dict:
    import httpx

    with httpx.Client(base_url=base.rstrip("/"), timeout=30.0) as c:
        r = c.get("/api/config")  # public: the login screen needs branding before auth
        if r.status_code != 200:
            _fail(f"ERROR: GET /api/config failed ({r.status_code}): {r.text[:200]}")
        return (r.json().get("identity") or {}).get("assets") or {}


def main() -> None:
    ap = argparse.ArgumentParser(prog="admin_branding", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_push = sub.add_parser("push", help="upload an image into a branding slot of a RUNNING deployment")
    p_push.add_argument("slot", choices=SLOTS)
    p_push.add_argument("file")
    p_push.add_argument("--base", default=os.environ.get("KP_BASE_URL"), help="deployment base URL (env KP_BASE_URL)")
    p_push.add_argument(
        "--secret", default=os.environ.get("KP_ADMIN_SECRET"), help="ADMIN_SECRET (env KP_ADMIN_SECRET)"
    )

    p_load = sub.add_parser("load", help="write an image into a branding slot DIRECTLY (DB + blob store)")
    p_load.add_argument("slot", choices=SLOTS)
    p_load.add_argument("file")

    p_show = sub.add_parser("show", help="print the branding asset URLs a deployment currently serves")
    p_show.add_argument("--base", default=os.environ.get("KP_BASE_URL"), help="deployment base URL (env KP_BASE_URL)")

    a = ap.parse_args()

    if a.cmd == "load":
        import asyncio

        path = Path(a.file)
        if not path.is_file():
            _fail(f"ERROR: {path} not found")
        # the same allowlist the HTTP upload applies — a typo fails here, not as a broken image
        if path.suffix.lower() not in _CONTENT_TYPES:
            _fail(
                f"ERROR: {path.suffix or path.name!r} is not an allowed image type ({', '.join(sorted(_CONTENT_TYPES))})"
            )
        url = asyncio.run(_load(a.slot, path))
        print(f"OK: {a.slot} ← {path.name} → {url}")
        return

    if not a.base:
        _fail("ERROR: set --base or KP_BASE_URL to the deployment URL")

    if a.cmd == "show":
        assets = _show(a.base)  # once, not once per slot
        for slot in SLOTS:
            print(f"{slot:12} {assets.get(slot) or '– (not set)'}")
        return

    if not a.secret:
        _fail("ERROR: set --secret or KP_ADMIN_SECRET to the deployment ADMIN_SECRET")
    path = Path(a.file)
    if not path.is_file():
        _fail(f"ERROR: {path} not found")
    url = _push(a.slot, path, a.base, a.secret)
    print(f"OK: {a.slot} ← {path.name} → {url}")


if __name__ == "__main__":
    main()
