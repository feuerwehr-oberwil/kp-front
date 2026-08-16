"""`admin_objects push` has to say what it did — silence with exit 0 is not success.

During a fresh-station install a push produced an Einsatzobjekt with ``"plans": []``, printed
nothing at all and exited 0; an identical rerun seven seconds later attached the plan. Whatever
made that first run drop the plan, the operator had no way to tell it apart from a clean
publish. These tests hold the reporting side of that: every run names the objects it created
and updated, counts the plan PDFs it attached, and — when a plan does NOT land — names it and
fails the exit code.
"""

import asyncio
import hashlib
import json
import uuid
from pathlib import Path

import httpx
import pytest

from app.admin_objects import _amain, object_id_for_key

BASE = "https://station.example.org"
SECRET = "admin-secret-0123456789abcd"
PDF = b"%PDF-1.4\nsheet\n"


class _Resp:
    """Just enough of httpx.Response for the CLI: a status, a body, and `.json()`."""

    def __init__(self, status_code: int, payload: object = None):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self) -> object:
        return self._payload


class _FakeClient:
    """A stand-in deployment. `stored` is what it already has; `plan_status` decides how it
    answers a plan upload, which is how the "the object is not there yet" case is reproduced."""

    def __init__(self, *, stored: list[dict], plan_status: int = 200, **_kw):
        self.stored = stored
        self.plan_status = plan_status
        self.plan_puts: list[str] = []

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def post(self, url: str, **_kw) -> _Resp:
        assert url == "/api/admin/login"
        return _Resp(200, {"ok": True})

    def get(self, url: str, **_kw) -> _Resp:
        assert url == "/api/objects"
        return _Resp(200, self.stored)

    def put(self, url: str, **_kw) -> _Resp:
        if "/plans/" in url:
            self.plan_puts.append(url)
            return _Resp(self.plan_status, {"detail": "Objekt nicht gefunden"} if self.plan_status != 200 else {})
        return _Resp(200, {})


@pytest.fixture
def deployment(monkeypatch):
    """Point the CLI's `httpx.Client` at a fake deployment the test configures."""
    holder: dict[str, _FakeClient] = {}

    def _install(*, stored: list[dict] | None = None, plan_status: int = 200) -> _FakeClient:
        fake = _FakeClient(stored=stored or [], plan_status=plan_status)
        holder["client"] = fake
        monkeypatch.setattr(httpx, "Client", lambda *a, **kw: fake)
        return fake

    return _install


def _manifest(tmp: Path, *, key: str = "schulhaus-dorfmatt", modules: tuple[str, ...] = ("modul1", "modul2")) -> Path:
    (tmp / "plans").mkdir(parents=True, exist_ok=True)
    plans = []
    for m in modules:
        (tmp / "plans" / f"{m}.pdf").write_bytes(PDF)
        plans.append({"module": m, "file": f"plans/{m}.pdf", "sha256": hashlib.sha256(PDF).hexdigest()})
    mp = tmp / "objects.manifest.json"
    mp.write_text(json.dumps({"objects": [{"key": key, "name": "Schulhaus Dorfmatt", "plans": plans}]}))
    return mp


def _push(manifest: Path, *extra: str) -> int:
    return asyncio.run(_amain(["push", str(manifest), "--base", BASE, "--admin-secret", SECRET, *extra]))


def test_a_clean_push_names_the_object_and_counts_the_plans(tmp_path: Path, deployment, capsys):
    deployment()
    assert _push(_manifest(tmp_path)) == 0
    out = capsys.readouterr().out
    assert "+ Schulhaus Dorfmatt  (2/2 plan PDF(s))" in out
    assert "1 object(s) created, 0 updated, 2 plan PDF(s) attached" in out


def test_an_object_the_deployment_already_has_counts_as_updated(tmp_path: Path, deployment, capsys):
    """«upserted 1 object» could not tell these apart, and «created» is the half that matters on
    a fresh install — an unexpected create means the manifest is addressing the wrong row."""
    oid = str(object_id_for_key("schulhaus-dorfmatt"))
    deployment(stored=[{"id": oid, "name": "Schulhaus Dorfmatt"}])
    assert _push(_manifest(tmp_path)) == 0
    out = capsys.readouterr().out
    assert "~ Schulhaus Dorfmatt" in out
    assert "0 object(s) created, 1 updated" in out


def test_a_plan_the_server_will_not_take_is_named_counted_and_fails_the_run(tmp_path: Path, deployment, capsys):
    """THE bug: the object lands, the plan does not, and the command used to be able to end at
    exit 0 with nothing on screen. Now it names every plan that did not arrive and exits 1."""
    deployment(plan_status=404)
    assert _push(_manifest(tmp_path)) == 1
    cap = capsys.readouterr()
    assert "Schulhaus Dorfmatt / modul1 — NOT attached" in cap.err
    assert "Schulhaus Dorfmatt / modul2 — NOT attached" in cap.err
    assert "INCOMPLETE" in cap.out
    assert "2 NOT attached" in cap.out


def test_a_dry_run_reports_the_same_shape_without_writing(tmp_path: Path, deployment, capsys):
    fake = deployment()
    assert _push(_manifest(tmp_path), "--dry-run") == 0
    out = capsys.readouterr().out
    assert "OK (dry-run)" in out
    assert "1 object(s) created, 0 updated, 2 plan PDF(s)" in out
    assert fake.plan_puts == [], "a dry run uploaded something"


def test_the_object_a_push_writes_is_the_manifest_key(tmp_path: Path, deployment, capsys):
    """The id the plans hang off has to be the one the object was written under, or the plans
    end up orphaned under a second UUID — the failure `key` exists to prevent."""
    fake = deployment()
    _push(_manifest(tmp_path, modules=("modul1",)))
    expected = object_id_for_key("schulhaus-dorfmatt")
    assert fake.plan_puts == [f"/api/objects/{expected}/plans/modul1"]
    assert uuid.UUID(str(expected))  # a real uuid, not a placeholder string
