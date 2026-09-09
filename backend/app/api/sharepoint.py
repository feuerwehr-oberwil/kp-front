"""SharePoint connector: what it did, and a button to make it do it now.

Two admin-only endpoints, and both exist because of the same failure: this connector's most
likely end is silence. An Azure client secret expires after at most 24 months, Graph starts
answering 401, and nothing about the app looks different — the plans on the tablets are simply
the ones from before. So the state is a surface an operator can read (`GET /status`, rendered
on Verwaltung › System), and a run they can trigger while they are still standing in front of
the screen that told them it is broken (`POST /sync`).

No configuration lives here. The folders are in the deployment config (`sharepoint.sources`,
edited as config-as-code / in Verwaltung), the credentials on the Zugangsdaten page.
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentAdmin
from ..database import get_db
from ..sharepoint_sync import sharepoint_status, sync_sharepoint

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sharepoint", tags=["sharepoint"])


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
