"""Recover ONE explicitly selected, completed Rapport print job for the Einsatz-Ablage.

Report only by default; ``--apply`` keeps the PDF and enqueues the normal delivery. No Graph
calls, no recomposition, no replacement of an existing kept/filed Rapport. The original print
job stays untouched. Page order is verified from the PDF's OWN numbered footer, never today's
printer setting. Run inside the deployed backend with its storage volume mounted; DATABASE_URL
alone is insufficient (PDF bytes use MEDIA_STORAGE_DIR). The storage prefix records the source
job; composed_at stays the print time.
Contract and command: docs/incident-archive.md › Recovering an older printed Rapport.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import re
import sys
import uuid
from contextlib import closing
from typing import TYPE_CHECKING, Any

import anyio
import pypdfium2 as pdfium
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from . import incident_archive as archive
from . import storage
from .database import async_session_maker
from .models import Incident, IncidentArchiveDelivery, IncidentArchiveReport, PrintJob
from .pdfium_lock import pdfium_lock

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


def reading_order_pdf(pdf: bytes) -> tuple[bytes, int, bool]:
    """Verify a complete ascending/descending Rapport footer sequence; reverse only the latter.

    Keep page contents, not a newly rendered report. Refuse missing, mixed or duplicate page
    numbers rather than guess. PDFium is process-global, also when the worker prints alongside.
    """
    with pdfium_lock, pdfium.PdfDocument(pdf) as doc:
        count = len(doc)
        numbers = []
        # report.styles._NumberedCanvas reserves this right-aligned, 8pt column. The left
        # footer may carry a long incident title/stamp all the way into the page's right half.
        number_width = stringWidth(f"{count} / {count}", "Helvetica", 8)
        for page in doc:
            with closing(page), closing(page.get_textpage()) as text:
                right = page.get_width() - 14 * mm
                footer = text.get_text_bounded(left=right - number_width - 0.5, bottom=0, right=right + 0.5, top=35)
                match = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", footer)
                if match is None or int(match[2]) != count:
                    raise ValueError("Rapport page numbering is missing or incomplete; nothing recovered")
                numbers.append(int(match[1]))
        expected = list(range(1, count + 1))
        if not count or numbers not in (expected, expected[::-1]):
            raise ValueError("Rapport page order is ambiguous; nothing recovered")
        if numbers == expected:
            return pdf, count, False
        with pdfium.PdfDocument.new() as out:
            out.import_pages(doc, list(reversed(range(count))))
            buf = io.BytesIO()
            out.save(buf)
            return buf.getvalue(), count, True


async def recover_report(db: AsyncSession, incident_id: uuid.UUID, job_id: uuid.UUID, *, apply: bool) -> dict[str, Any]:
    """Dry-run or fill a missing kept PDF. Caller owns the transaction, commit and rollback.

    The byte hash has a separate domain from a composed report's payload hash. Repeating the
    same recovery is a no-op; a different kept report or any already filed report refuses it.
    The insert also refuses a concurrent compose instead of replacing it.
    """
    query = select(Incident).where(Incident.id == incident_id)
    inc = (await db.execute(query.with_for_update() if apply else query)).scalar_one_or_none()
    if inc is None or not archive.is_filed(inc):
        raise ValueError("Recovery requires a closed, real Einsatz")
    if not archive.active(await archive.archive_config(db)):
        raise ValueError("Einsatz-Ablage is off or has no active destination")
    job = await db.get(PrintJob, job_id)
    if job is None or job.incident_id != incident_id or job.kind != "report" or job.status != "done":
        raise ValueError("Select a completed Rapport print job belonging to this Einsatz")
    sha = hashlib.sha256(b"recovered-print-job\0" + job.pdf).hexdigest()
    kept = await db.get(IncidentArchiveReport, incident_id)
    result: dict[str, Any] = {
        "incidentId": str(incident_id),
        "printJobId": str(job_id),
        "composedAt": job.created_at.isoformat(),
        "sha": sha,
    }
    if kept is not None:
        if kept.content_sha != sha:
            raise ValueError("Einsatz already has a kept Rapport; nothing replaced")
        try:
            await storage.aget_bytes(kept.storage_key)
        except OSError as e:
            raise ValueError(
                "Kept PDF is not readable in MEDIA_STORAGE_DIR; check the deployment's mounted storage"
            ) from e
        return {**result, "state": "unchanged"}
    rows = (
        (await db.execute(select(IncidentArchiveDelivery).where(IncidentArchiveDelivery.incident_id == incident_id)))
        .scalars()
        .all()
    )
    if any((r.remote_items or {}).get("reports") or (r.remote_items or {}).get("reportTry") for r in rows):
        raise ValueError("A Rapport was already filed or its upload is unconfirmed; nothing replaced")
    pdf, pages, reversed_pages = await anyio.to_thread.run_sync(reading_order_pdf, job.pdf)
    result.update(pages=pages, reversedPages=reversed_pages, bytes=len(pdf))
    if not apply:
        return {**result, "state": "ready"}
    key = storage.new_key(f"incident-archive/{incident_id}/print-job-{job_id}", ".pdf")
    await storage.aput_bytes(key, pdf)
    storage.created_in_transaction(db, key)
    inserted = await db.scalar(
        insert(IncidentArchiveReport)
        .values(
            incident_id=incident_id,
            content_sha=sha,
            storage_key=key,
            size=len(pdf),
            composed_at=job.created_at,
        )
        .on_conflict_do_nothing(index_elements=[IncidentArchiveReport.incident_id])
        .returning(IncidentArchiveReport.incident_id)
    )
    if inserted is None:
        raise ValueError("A Rapport was composed concurrently; recovery must be rolled back")
    await archive.enqueue(db, incident_id)
    return {**result, "state": "recovered"}


async def _amain(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    recover = sub.add_parser("recover-report", help="keep an older printed Rapport (default: dry-run)")
    recover.add_argument("incident", type=uuid.UUID)
    recover.add_argument("--print-job", required=True, type=uuid.UUID)
    recover.add_argument("--apply", action="store_true", help="keep the PDF and enqueue filing")
    args = parser.parse_args(argv)
    async with async_session_maker() as db:
        try:
            result = await recover_report(db, args.incident, args.print_job, apply=args.apply)
            if args.apply:
                await db.commit()
            else:
                await db.rollback()
        except (ValueError, pdfium.PdfiumError) as e:
            await db.rollback()
            print(str(e), file=sys.stderr)
            return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_amain(sys.argv[1:])))
