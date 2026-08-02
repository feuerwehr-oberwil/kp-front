"""Objektpläne: the one write path for a Modul-PDF, and the pull from a snapshot store.

Two doors, one ID rule. A plan can arrive by hand (an admin uploading a PDF in the admin UI,
`PUT /api/objects/{id}/plans/{module}`) or by itself (the scheduled pull below). Both go
through :func:`store_plan`, so the dataset id (`plan:<obj>:<module>`), the storage key, the
version bump and the title fallback are decided in exactly one place — the pull cannot drift
into inventing its own identity scheme for the same plans.

**Why a pull.** Until now the system that maintains the plan library pushed into this
deployment holding its full ``ADMIN_SECRET`` — a credential for everything the admin API can
do, in a process that only ever needed to write plans. Inverted, the plan library publishes to
an S3-compatible bucket and this deployment reads it with a read-only key of its own; nothing
outside holds a credential for this one.

**Nothing about a provider is compiled in.** Endpoint, bucket, prefix, region and keys are all
env (``PLANS_S3_*``), path-style addressing, plain SigV4 — MinIO, Backblaze B2, a hosted
bucket or AWS itself all work, and a self-hoster is never told which to use.

**What the store publishes** (metadata only in the index, never bytes):

    plans/index.json                  {"generated_at": …, "plans": [{object_id, module,
                                       filename, size, sha256, address_full?}, …]}
    plans/<object-id>/<module>.pdf    the PDF

**Fail-closed and fail-safe.** Unconfigured store → no job is scheduled and nothing here ever
runs. A malformed or incomplete index → the whole run is refused and nothing changes; an index
is a complete statement of what the store holds, and a partial one must not be able to touch
existing plans. **This module never deletes a plan.** A plan missing from the index is a plan
the operator still has, because the far more likely cause of a plan vanishing from an index is
a broken publish, not a decision.
"""

import hashlib
import hmac
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote, urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import storage
from .config import settings
from .models import ObjectSite, ReferenceDataset

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------------------
# the one write path (shared by the manual upload and the pull)
# ---------------------------------------------------------------------------------------


async def store_plan(
    db: AsyncSession,
    obj: ObjectSite,
    module: str,
    data: bytes,
    *,
    content_type: str = "application/pdf",
    title: str | None = None,
    source_note: str | None = None,
    actor_id: uuid.UUID | None = None,
    source_type: str = "uploaded",
    source_digest: str | None = None,
    fetch_url: str | None = None,
) -> ReferenceDataset:
    """Upsert one Modul-PDF: write the blob, create or bump the `plan:<obj>:<module>` dataset.

    `title`/`source_note` are only applied when given, so an automated refresh never wipes a
    label an admin typed. `source_type` records which door the bytes came in through
    ('uploaded' by hand, 'snapshot' from the store) and shows up in the admin data view.
    """
    ds_id = f"plan:{obj.id}:{module}"
    ds = (await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == ds_id))).scalar_one_or_none()
    key = storage.new_key(f"plans/{obj.id}", f"-{module}.pdf")
    storage.put_bytes(key, data)

    if ds is None:
        ds = ReferenceDataset(id=ds_id, object_id=obj.id, module=module, kind="pdf")
        db.add(ds)
    else:
        ds.current_version += 1
    ds.title = title or ds.title or f"{obj.name} – {module}"
    ds.source_note = source_note if source_note is not None else ds.source_note
    ds.source_type = source_type
    ds.storage_key = key
    ds.content_type = content_type
    ds.size_bytes = len(data)
    ds.source_digest = source_digest
    if fetch_url is not None:
        ds.fetch_url = fetch_url
    ds.updated_by = actor_id
    await db.flush()
    await db.refresh(ds)
    return ds


# ---------------------------------------------------------------------------------------
# snapshot store (S3-compatible, read-only)
# ---------------------------------------------------------------------------------------

# Fail-closed: all four have to be present. Nothing partial counts as configured — half a
# credential would fail per request instead of staying off.
plans_pull_enabled = lambda: bool(  # noqa: E731
    settings.plans_s3_endpoint
    and settings.plans_s3_bucket
    and settings.plans_s3_access_key_id
    and settings.plans_s3_secret_access_key
)

INDEX_PATH = "plans/index.json"
INDEX_MAX_BYTES = 8 * 1024 * 1024  # an index of tens of thousands of plans is still far below this
_MODULE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$")  # fits models.ReferenceDataset.module
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def plan_max_bytes() -> int:
    """The size cap a pulled plan is held to — the SAME one the upload path is held to
    (`MAX_UPLOAD_MB`, enforced as a request-body cap in main.py). A plan the admin UI could
    not have uploaded must not enter through the back door either, and a second knob would
    only be a second thing to get wrong."""
    return settings.max_upload_mb * 1024 * 1024


@dataclass(frozen=True)
class PlanEntry:
    """One validated row of `plans/index.json`."""

    object_id: uuid.UUID
    module: str
    filename: str
    size: int
    sha256: str
    address_full: str | None

    @property
    def path(self) -> str:
        return f"plans/{self.object_id}/{self.filename}"

    @property
    def dataset_id(self) -> str:
        return f"plan:{self.object_id}:{self.module}"


def parse_index(raw: bytes) -> list[PlanEntry]:
    """Validate the whole index up front, or raise `ValueError` and change nothing.

    Every field is checked before a single byte is downloaded, because the alternative —
    ingesting the good rows of a bad index — quietly turns a broken publish into a partial
    plan library, which is the failure an operator cannot see at 3am.
    """
    try:
        doc = json.loads(raw)
    except (ValueError, TypeError) as e:
        raise ValueError(f"index is not valid JSON: {e}") from e
    if not isinstance(doc, dict):
        raise ValueError("index must be a JSON object")
    rows = doc.get("plans")
    if not isinstance(rows, list):
        raise ValueError("index has no 'plans' list")
    if not rows:
        raise ValueError("index lists no plans at all — refusing (a store that holds none is a broken publish)")

    entries: list[PlanEntry] = []
    seen: set[str] = set()
    for i, row in enumerate(rows):
        where = f"plans[{i}]"
        if not isinstance(row, dict):
            raise ValueError(f"{where} is not an object")
        try:
            object_id = uuid.UUID(str(row.get("object_id")))
        except (ValueError, AttributeError, TypeError) as e:
            raise ValueError(f"{where}: object_id {row.get('object_id')!r} is not a UUID") from e
        module = row.get("module")
        if not isinstance(module, str) or not _MODULE_RE.match(module):
            raise ValueError(f"{where}: module {module!r} is missing or not a plain slug")
        filename = row.get("filename")
        if not isinstance(filename, str) or not filename.lower().endswith(".pdf"):
            raise ValueError(f"{where}: filename {filename!r} is missing or not a .pdf")
        if "/" in filename or "\\" in filename or ".." in filename:
            raise ValueError(f"{where}: filename {filename!r} must be a bare name, not a path")
        size = row.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ValueError(f"{where}: size {size!r} is missing or not a positive integer")
        sha256 = row.get("sha256")
        if not isinstance(sha256, str) or not _SHA256_RE.match(sha256):
            raise ValueError(f"{where}: sha256 {sha256!r} is missing or not 64 lowercase hex chars")
        address_full = row.get("address_full")
        if address_full is not None and not isinstance(address_full, str):
            raise ValueError(f"{where}: address_full must be a string when present")
        entry = PlanEntry(object_id, module, filename, size, sha256, address_full)
        if entry.dataset_id in seen:
            raise ValueError(f"{where}: {entry.dataset_id} appears twice")
        seen.add(entry.dataset_id)
        entries.append(entry)
    return entries


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _signed_get(path: str, *, now: datetime | None = None) -> tuple[str, dict[str, str]]:
    """URL + AWS SigV4 headers for a GET of `<prefix><path>`, path-style addressing.

    Forty lines instead of an SDK dependency measured in tens of megabytes, for two GETs of
    two public-shaped objects. The algorithm is frozen by its specification and implemented
    identically by every S3-compatible service, which is exactly why it is safe to sign here.
    """
    now = now or datetime.now(UTC)
    endpoint = settings.plans_s3_endpoint.rstrip("/")
    host = urlparse(endpoint).netloc
    prefix = settings.plans_s3_prefix.strip("/")
    key = f"{prefix}/{path}" if prefix else path
    canonical_uri = "/" + quote(f"{settings.plans_s3_bucket}/{key}", safe="/")

    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    headers = {"host": host, "x-amz-content-sha256": _EMPTY_SHA256, "x-amz-date": amz_date}
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in ("host", "x-amz-content-sha256", "x-amz-date"))
    canonical_request = f"GET\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{_EMPTY_SHA256}"

    scope = f"{date_stamp}/{settings.plans_s3_region}/s3/aws4_request"
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{hashlib.sha256(canonical_request.encode()).hexdigest()}"
    k_date = _sign(f"AWS4{settings.plans_s3_secret_access_key}".encode(), date_stamp)
    k_region = _sign(k_date, settings.plans_s3_region)
    k_service = _sign(k_region, "s3")
    signature = hmac.new(_sign(k_service, "aws4_request"), string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={settings.plans_s3_access_key_id}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return f"{endpoint}{canonical_uri}", headers


class TooLargeError(Exception):
    """The response body passed the caller's cap; nothing was kept."""


async def get_object(client: httpx.AsyncClient, path: str, *, max_bytes: int) -> bytes:
    """GET one object from the store, refusing to buffer more than `max_bytes`.

    Streamed and capped rather than `.read()`: the index states each plan's size, but the
    index is the thing we are least entitled to trust, so the cap is enforced against the
    bytes actually arriving.
    """
    url, headers = _signed_get(path)
    buf = bytearray()
    async with client.stream("GET", url, headers=headers) as resp:
        resp.raise_for_status()
        async for chunk in resp.aiter_bytes():
            buf += chunk
            if len(buf) > max_bytes:
                raise TooLargeError(path)
    return bytes(buf)


async def _ingest(db: AsyncSession, client: httpx.AsyncClient, entry: PlanEntry, obj: ObjectSite) -> str:
    """Bring one index entry into the deployment. Returns 'unchanged' | 'updated' | 'skipped'."""
    ds = (
        await db.execute(select(ReferenceDataset).where(ReferenceDataset.id == entry.dataset_id))
    ).scalar_one_or_none()
    # Already have exactly these bytes? Then no download — that is the whole point of the
    # index carrying checksums. `storage.exists` keeps a lost blob from staying lost.
    if ds is not None and ds.source_digest == entry.sha256 and ds.storage_key and storage.exists(ds.storage_key):
        return "unchanged"

    if entry.size > plan_max_bytes():
        logger.warning(
            "Objektplan-Pull: %s (%s) is %.1f MB, over the %d MB upload cap — skipped, not fetched",
            entry.dataset_id,
            entry.address_full or "?",
            entry.size / (1024 * 1024),
            settings.max_upload_mb,
        )
        return "skipped"

    try:
        data = await get_object(client, entry.path, max_bytes=plan_max_bytes())
    except TooLargeError:
        logger.warning(
            "Objektplan-Pull: %s exceeded the %d MB cap while downloading (the index understated it) — skipped",
            entry.dataset_id,
            settings.max_upload_mb,
        )
        return "skipped"
    except httpx.HTTPError as e:
        logger.warning("Objektplan-Pull: %s could not be fetched (%s) — skipped, keeping what we have", entry.path, e)
        return "skipped"

    got = hashlib.sha256(data).hexdigest()
    if got != entry.sha256:
        logger.warning(
            "Objektplan-Pull: %s checksum mismatch (index %s, got %s) — skipped, keeping what we have",
            entry.dataset_id,
            entry.sha256[:12],
            got[:12],
        )
        return "skipped"
    if not data.startswith(b"%PDF-"):
        logger.warning("Objektplan-Pull: %s is not a PDF — skipped", entry.dataset_id)
        return "skipped"

    await store_plan(
        db,
        obj,
        entry.module,
        data,
        title=None,  # keep whatever the object/admin already calls it
        source_type="snapshot",
        source_digest=entry.sha256,
        fetch_url=f"{settings.plans_s3_bucket}/{entry.path}",
    )
    return "updated"


async def pull_plans(db: AsyncSession) -> dict[str, int | str]:
    """One scheduled run: read the index, fetch only what changed, upsert it.

    Never raises for a store problem — a refused run leaves the deployment exactly as it was,
    which for object plans is always the safe direction: yesterday's plan opens, a missing one
    does not.
    """
    if not plans_pull_enabled():
        return {"status": "disabled"}
    counts = {"updated": 0, "unchanged": 0, "skipped": 0}
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            entries = parse_index(await get_object(client, INDEX_PATH, max_bytes=INDEX_MAX_BYTES))
        except (httpx.HTTPError, TooLargeError) as e:
            logger.warning("Objektplan-Pull: index unreachable (%s) — nothing changed", e)
            return {"status": "unreachable"}
        except ValueError as e:
            logger.error("Objektplan-Pull: refusing the whole run — %s. Nothing changed.", e)
            return {"status": "refused"}

        objs = {
            o.id: o
            for o in (
                await db.execute(select(ObjectSite).where(ObjectSite.id.in_([e.object_id for e in entries])))
            ).scalars()
        }
        for entry in entries:
            obj = objs.get(entry.object_id)
            if obj is None:
                # Objects are not created here: the index carries an address, not a name or
                # coordinates. An unknown object means the object side has not been loaded yet.
                logger.warning(
                    "Objektplan-Pull: no Einsatzobjekt %s (%s) — %s skipped",
                    entry.object_id,
                    entry.address_full or "address unknown",
                    entry.dataset_id,
                )
                counts["skipped"] += 1
                continue
            counts[await _ingest(db, client, entry, obj)] += 1
    # Deliberately no deletion pass: see the module docstring.
    return {"status": "ok", **counts}


async def pull_one_plan(db: AsyncSession, dataset_id: str) -> dict[str, str]:
    """Pull a single `plan:<obj>:<module>` on demand (the admin fetch trigger).

    Same index, same validation, same write path as the scheduled run — an operator pressing
    the button gets the mechanism, not a shortcut around it.
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        entries = parse_index(await get_object(client, INDEX_PATH, max_bytes=INDEX_MAX_BYTES))
        entry = next((e for e in entries if e.dataset_id == dataset_id), None)
        if entry is None:
            return {"status": "absent", "dataset_id": dataset_id}
        obj = (await db.execute(select(ObjectSite).where(ObjectSite.id == entry.object_id))).scalar_one_or_none()
        if obj is None:
            return {"status": "unknown_object", "dataset_id": dataset_id}
        return {"status": await _ingest(db, client, entry, obj), "dataset_id": dataset_id}
