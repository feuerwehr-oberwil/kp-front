"""SharePoint connector: what it did, and a button to make it do it now.

Three admin-only endpoints, and all three exist because of the same failure: this connector's
most likely end is silence. An Azure client secret expires after at most 24 months, Graph starts
answering 401, and nothing about the app looks different — the plans on the tablets are simply
the ones from before. So the state is a surface an operator can read (`GET /status`, rendered
on Verwaltung › System), a way to find that out WITHOUT waiting for the next scheduled poll
(`POST /probe`), and a run they can trigger while they are still standing in front of the screen
that told them it is broken (`POST /sync`).

No configuration lives here. The folders are in the deployment config (`sharepoint.sources`,
edited as config-as-code / in Verwaltung), the credentials on the Zugangsdaten page.
"""

import logging

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..credentials import load as load_credentials
from ..database import get_db
from ..sharepoint_graph import GraphClient, GraphError
from ..sharepoint_sync import sharepoint_credentials, sharepoint_settings, sharepoint_status, sync_sharepoint

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sharepoint", tags=["sharepoint"])

#: A probe is answered while an operator is standing at the screen — long enough for a slow
#: tenant, short enough that a dead one does not leave the button spinning for a minute.
_PROBE_TIMEOUT_SECONDS = 20.0


@router.get("/status")
async def get_status(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Per area: last run, last SUCCESSFUL run, imported/skipped/missing counts and the state.

    Also answers when the connector is off (`configured: false`) — «nicht eingerichtet» is a
    state the System page has to be able to render, and a card that draws nothing looks exactly
    like a card whose fetch failed.
    """
    return await sharepoint_status(db)


@router.post("/sync")
async def run_sync(_admin: CurrentAdmin, full: bool = False, db: AsyncSession = Depends(get_db)) -> dict:
    """Run the pull now. `full=true` forgets the delta tokens and the eTag memo first.

    The same mechanism the scheduler runs, not a shortcut around it — an operator pressing the
    button gets the mechanism (app/plans · pull_one_plan takes the same line). A full run is the
    answer to «the file is in SharePoint and the app still has the old one»: it re-imports
    everything rather than trusting what we recorded.
    """
    result = await sync_sharepoint(db, full=full)
    await db.commit()
    return result


@router.post("/probe")
async def probe(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """A cheap «are these credentials any good» check, answered while an operator is watching —
    not the same question as `POST /sync`, which imports files and can take a while. See
    :func:`sharepoint_probe`.
    """
    return await sharepoint_probe(db)


async def sharepoint_probe(db: AsyncSession, *, transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """Acquire a Graph token and, if a folder is configured, resolve the drive root of the FIRST
    source. Deliberately not a listing of the configured folder itself: a wrong `path` is a
    config mistake `POST /sync` already reports per area, and this button exists to answer one
    narrower question — is the tenant/client/secret triple even accepted by Azure. With no
    source configured at all, acquiring the token is the whole check (the connector is inert
    either way until a folder is added).

    Never raises: a probe that 500s is a worse answer than one that says why it failed, and
    `detail` carries Graph's own sentence (an AADSTS code, say) rather than a stack trace.

    `transport` is httpx's own injection point, exactly like `sync_sharepoint`'s — the tests hand
    in a fake tenant, nothing here is monkeypatched.
    """
    await load_credentials(db)
    creds = sharepoint_credentials()
    if creds is None:
        return {"ok": False, "detail": "no SharePoint credentials stored"}
    tenant, client_id, client_secret = creds
    config = await sharepoint_settings(db)
    source = config.sources[0] if config.sources else None
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_SECONDS, transport=transport) as http:
            graph = GraphClient(http, tenant_id=tenant, client_id=client_id, client_secret=client_secret)
            await graph.token()
            if source is not None:
                drive_id = await graph.resolve_drive(
                    site_url=source.siteUrl, drive_id=source.driveId, library=source.library
                )
                await graph.resolve_folder(drive_id, "")
        return {"ok": True, "detail": None}
    except GraphError as e:
        return {"ok": False, "detail": str(e)[:400]}
    except Exception:  # never a 500 — see the docstring above
        logger.exception("SharePoint probe failed unexpectedly")
        return {"ok": False, "detail": "unexpected error while probing SharePoint"}
