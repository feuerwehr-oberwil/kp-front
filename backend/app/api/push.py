"""Web-Push subscriptions: VAPID key handout + endpoint registration.

Any logged-in user (editor or viewer) may subscribe their browser — alarm relevance is
crew-wide. The endpoint URL is the natural key: re-subscribing upserts, and the sender
prunes endpoints the push service reports gone.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentUser
from ..config import settings
from ..database import get_db
from ..models import PushSubscription
from ..push import push_enabled

router = APIRouter(prefix="/push", tags=["push"])


class SubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class SubscriptionIn(BaseModel):
    endpoint: str
    keys: SubscriptionKeys


@router.get("/vapid-key")
async def vapid_key(_user: CurrentUser) -> dict:
    """The deployment's VAPID public key — null while push is not configured."""
    return {"key": settings.vapid_public_key or None, "enabled": push_enabled()}


@router.post("/subscriptions", status_code=201)
async def subscribe(body: SubscriptionIn, user: CurrentUser, db: AsyncSession = Depends(get_db)) -> dict:
    existing = (
        await db.execute(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
    ).scalar_one_or_none()
    if existing:
        existing.p256dh = body.keys.p256dh
        existing.auth = body.keys.auth
        existing.user_id = user.id
    else:
        db.add(PushSubscription(user_id=user.id, endpoint=body.endpoint, p256dh=body.keys.p256dh, auth=body.keys.auth))
    await db.flush()
    return {"ok": True}


@router.delete("/subscriptions", status_code=204)
async def unsubscribe(body: SubscriptionIn, _user: CurrentUser, db: AsyncSession = Depends(get_db)) -> None:
    await db.execute(delete(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
