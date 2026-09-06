"""Regressions for process crashes, unbounded requests and cross-incident alarm outages."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from PIL import Image
from pydantic import ValidationError

from app import push, scheduler
from app.models import Incident, JournalEntry
from app.schemas import JournalAppendIn, TruppsPut, WorkspacePut


@pytest.mark.parametrize("second", ["render", "reverse"])
@pytest.mark.parametrize("page_count", [1, 2])
def test_pdfium_lifetimes_never_overlap_between_report_operations(monkeypatch, second, page_count):
    import pypdfium2

    from app import kroki
    from app.api.print_relay import reverse_pdf_pages

    owners = {}
    overlaps = []
    guard = threading.Lock()
    start = threading.Barrier(2)

    class Document:
        def __init__(self, data=None):
            self.owner = threading.get_ident()
            with guard:
                overlaps.append(any(owner != self.owner for owner in owners))
                owners[self.owner] = owners.get(self.owner, 0) + 1
            time.sleep(0.02)  # Release the GIL while the other request reaches PDFium.

        new = classmethod(lambda cls: cls())

        def __getitem__(self, index):
            return SimpleNamespace(
                get_size=lambda: (100, 100),
                render=lambda **kw: SimpleNamespace(to_pil=lambda: Image.new("RGBA", (2, 2)), close=lambda: None),
            )

        def __len__(self):
            return page_count

        def import_pages(self, *args):
            pass

        def save(self, buf):
            buf.write(b"pdf")

        def close(self):
            with guard:
                owners[self.owner] -= 1
                if not owners[self.owner]:
                    del owners[self.owner]

    monkeypatch.setattr(pypdfium2, "PdfDocument", Document)
    monkeypatch.setattr(kroki, "_overlay_board_annos", lambda base, *args: base)

    def run(kind):
        start.wait(timeout=2)
        if kind == "render":
            kroki.render_plan_page(b"pdf", [], None)
        else:
            reverse_pdf_pages(b"pdf")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(run, kind) for kind in ("render", second)]
        for result in results:
            result.result(timeout=5)
    assert not any(overlaps), "PDFium documents from concurrent requests overlapped"
    assert not owners, "PDFium documents escaped the protected lifetime without closing"


async def test_print_queue_waits_for_pdfium_off_the_event_loop(db_session, monkeypatch):
    from app.api import print_relay

    threads = []

    async def compose(db, payload):
        return b"pdf", SimpleNamespace(options=SimpleNamespace(kroki=False))

    async def reverse_order(db):
        return True

    def reverse(pdf):
        threads.append(threading.get_ident())
        return pdf

    monkeypatch.setattr(print_relay, "compose_report_from_payload", compose)
    monkeypatch.setattr(print_relay, "wants_reverse_order", reverse_order)
    monkeypatch.setattr(print_relay, "relay_available", lambda: True)
    monkeypatch.setattr(print_relay, "reverse_pdf_pages", reverse)
    incident = Incident(title="Synthetic print", source="manual")
    db_session.add(incident)
    await db_session.flush()
    await print_relay.enqueue_print_job(db_session, incident, "{}", kind="report", requested_by=None)
    assert threads and threads[0] != threading.get_ident()


async def test_unauthenticated_streamed_request_stops_at_body_cap(client):
    from app.config import settings

    chunks_read = 0

    async def body():
        nonlocal chunks_read
        for _ in range(settings.max_json_body_mb + 3):
            chunks_read += 1
            yield b" " * (1024 * 1024)
        yield b"{}"

    response = await client.post("/api/auth/login", content=body(), headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert chunks_read <= settings.max_json_body_mb + 1


@pytest.mark.parametrize(
    "workspace",
    [
        {"trupps": [{"id": "bad", "entryTime": 123}]},
        {"settings": {"contactIntervalMin": "five"}},
        {"timeline": [{"id": "bad", "reminder": "broken"}]},
    ],
)
def test_new_workspace_rejects_malformed_alarm_fields(workspace):
    with pytest.raises(ValidationError):
        WorkspacePut(workspace=workspace, base_rev=0)


def test_slice_and_journal_reject_malformed_alarm_fields():
    with pytest.raises(ValidationError):
        TruppsPut(trupps=[{"id": "bad", "entryTime": 123}], base_rev=0)
    with pytest.raises(ValidationError):
        JournalAppendIn(entries=[{"id": "bad", "kind": "team", "reminder": "broken"}])


async def test_valid_trupp_slice_can_save_beside_malformed_legacy_reminders(client, editor, db_session):
    incident = Incident(
        title="Legacy incident",
        source="manual",
        map_workspace_json={"timeline": [{"id": "old", "reminder": "broken"}], "trupps": []},
    )
    db_session.add(incident)
    await db_session.commit()
    login = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert login.status_code == 200
    response = await client.put(
        f"/api/incidents/{incident.id}/workspace/trupps",
        json={"trupps": [{"id": "good"}], "base_rev": incident.workspace_rev},
    )
    assert response.status_code == 200, response.text
    saved = (await client.get(f"/api/incidents/{incident.id}/workspace")).json()["workspace"]
    assert saved == {"timeline": [{"id": "old", "reminder": "broken"}], "trupps": [{"id": "good"}]}


async def test_malformed_legacy_rows_do_not_suppress_healthy_alarms(db_session, monkeypatch):
    now = datetime.now(UTC).timestamp() * 1000
    team = {"id": "healthy", "entryTime": "2020-01-01T00:00:00Z", "entryPressureBar": 40}
    poisoned = Incident(
        title="Mixed legacy incident",
        source="manual",
        map_workspace_json={
            "settings": {"contactIntervalMin": "five"},
            "trupps": [{"id": "bad", "entryTime": 123}, team],
            "timeline": [None, {"id": "bad-legacy", "reminder": "broken"}],
        },
    )
    healthy = Incident(
        title="Other healthy incident", source="manual", map_workspace_json={"trupps": [{**team, "id": "other"}]}
    )
    db_session.add_all([poisoned, healthy])
    await db_session.flush()
    db_session.add_all(
        [
            JournalEntry(
                incident_id=poisoned.id,
                client_id="bad-journal",
                seq=1,
                row_json={"id": "bad-journal", "reminder": "broken"},
            ),
            JournalEntry(
                incident_id=poisoned.id,
                client_id="good-reminder",
                seq=2,
                row_json={
                    "id": "good-reminder",
                    "reminder": {"id": "r", "op": "created", "dueAt": "2020-01-01T00:00:00Z"},
                },
            ),
        ]
    )
    await db_session.commit()
    sent = []

    async def broadcast(db, **message):
        sent.append(message["tag"])
        return 1

    monkeypatch.setattr(push, "broadcast", broadcast)
    monkeypatch.setattr(push, "_notified", {})
    await push.check_and_push(db_session, now)
    assert set(sent) == {"atemschutz-healthy", "atemschutz-other", "reminder-r"}


@pytest.mark.parametrize("failed", ["database", "storage"])
async def test_heartbeat_does_not_report_success_for_unready_station(monkeypatch, engine, failed):
    from app import storage
    from app.config import settings

    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url):
            calls.append(url)

    monkeypatch.setattr(settings, "healthcheck_ping_url", "https://monitor.invalid/ping")
    monkeypatch.setattr(scheduler, "httpx", SimpleNamespace(AsyncClient=Client))
    if failed == "database":

        def broken():
            raise OSError("database unavailable")

        monkeypatch.setattr(scheduler, "engine", SimpleNamespace(connect=broken))
    else:
        monkeypatch.setattr(scheduler, "engine", engine)

        def broken():
            raise OSError("storage unavailable")

        monkeypatch.setattr(storage, "probe_writable", broken)
    await scheduler._heartbeat()
    assert calls == []


async def test_readiness_bounds_a_stalled_database_and_still_checks_storage(monkeypatch):
    import anyio

    from app import readiness, storage

    checked_storage = []

    class StalledConnection:
        async def __aenter__(self):
            await anyio.sleep_forever()

        async def __aexit__(self, *args):
            pass

    monkeypatch.setattr(readiness, "PROBE_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(storage, "probe_writable", lambda: checked_storage.append(True))
    with anyio.fail_after(1):
        result = await readiness.check_readiness(SimpleNamespace(connect=StalledConnection))
    assert result == {"database": "error", "storage": "ok"}
    assert checked_storage == [True]


async def test_repeated_storage_timeouts_keep_one_physical_probe_and_recover(monkeypatch):
    import anyio

    from app import readiness, storage

    release = threading.Event()
    finished = threading.Event()
    calls = []

    class HealthyConnection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def execute(self, query):
            pass

    def stalled_storage():
        calls.append(threading.get_ident())
        try:
            assert release.wait(timeout=2), "test must release the blocked filesystem probe"
        finally:
            finished.set()

    monkeypatch.setattr(readiness, "PROBE_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(storage, "probe_writable", stalled_storage)
    engine = SimpleNamespace(connect=HealthyConnection)
    try:
        with anyio.fail_after(1):
            for _ in range(6):
                assert await readiness.check_readiness(engine) == {"database": "ok", "storage": "error"}
        assert len(calls) == 1, "timed-out requests must not start more physically blocked probes"
    finally:
        release.set()
        assert await anyio.to_thread.run_sync(finished.wait, 1)

    monkeypatch.setattr(storage, "probe_writable", lambda: calls.append(threading.get_ident()))
    with anyio.fail_after(1):
        while (await readiness.check_readiness(engine))["storage"] != "ok":  # noqa: ASYNC110 -- observe recovery through the public check
            await anyio.sleep(0.001)
    assert len(calls) == 2, "a completed stuck probe must allow a fresh recovery check"
