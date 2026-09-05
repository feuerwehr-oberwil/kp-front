"""Web-Push subscriptions: VAPID key handout + endpoint registration.

Any logged-in user (editor or viewer) may subscribe their browser — alarm relevance is
crew-wide. The endpoint URL is the natural key: re-subscribing upserts, and the sender
prunes endpoints the push service reports gone.

⚠️ The endpoint is a DESTINATION THIS SERVER POSTS TO, not just a row. It used to be an
unconstrained string from any logged-in user, which made the alarm sender a request forwarder
(SEC-09, 05.09.). Two things bound it now: `app/egress.py` decides where an endpoint may point,
and a per-user cap decides how many of them one login can leave behind.
"""

import uuid
from datetime import UTC, datetime, timedelta

import anyio
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentUser
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import get_db
from ..egress import EgressRefusedError, require_public_https
from ..models import PushSubscription
from ..push import push_enabled

router = APIRouter(prefix="/push", tags=["push"])

#: Browsers per login. A person carries a phone, a tablet and a station PC, and a browser
#: rotates its endpoint after a while — ten leaves room for that and still bounds the fan-out
#: one login can add to every alarm sweep. The oldest registration goes when the cap is hit.
MAX_SUBSCRIPTIONS_PER_USER = 10

#: How long a registration stays a delivery target without being renewed. The SPA re-subscribes
#: on every boot (src/lib/push.ts), so a row nobody has refreshed in half a year belongs to a
#: browser profile that is gone.
SUBSCRIPTION_TTL_DAYS = 180


class SubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class SubscriptionIn(BaseModel):
    endpoint: str
    keys: SubscriptionKeys


async def _checked_endpoint(endpoint: str) -> str:
    """The endpoint, or a 422 an operator can read. Resolution runs off the event loop."""
    try:
        await anyio.to_thread.run_sync(lambda: require_public_https(endpoint, what="Push-Endpunkt", resolve=True))
    except EgressRefusedError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return endpoint.strip()


@router.get("/vapid-key")
async def vapid_key(_user: CurrentUser, db: AsyncSession = Depends(get_db)) -> dict:
    """The deployment's VAPID public key — null while push is not configured.

    Reads the credential store fresh: a station that just generated its VAPID pair in
    /admin must be able to subscribe a browser without waiting for anything, and this is
    the endpoint that browser asks first.
    """
    await load_credentials(db)
    return {"key": credential("vapid_public_key") or None, "enabled": push_enabled()}


@router.post("/subscriptions", status_code=201)
async def subscribe(body: SubscriptionIn, user: CurrentUser, db: AsyncSession = Depends(get_db)) -> dict:
    endpoint = await _checked_endpoint(body.endpoint)
    existing = (
        await db.execute(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if existing:
        # ⚠️ Ownership, not an upsert on a shared key: the endpoint is what the push service
        # delivers to, so re-pointing somebody else's row would hand their device's
        # notifications to another login's keys.
        if existing.user_id is not None and existing.user_id != user.id:
            raise HTTPException(status_code=403, detail="Dieser Push-Endpunkt gehört einem anderen Konto.")
        existing.p256dh = body.keys.p256dh
        existing.auth = body.keys.auth
        existing.user_id = user.id
        existing.created_at = now  # a renewed registration is not a stale one
    else:
        db.add(
            PushSubscription(
                user_id=user.id, endpoint=endpoint, p256dh=body.keys.p256dh, auth=body.keys.auth, created_at=now
            )
        )
    await db.flush()
    await _enforce_quota(db, user.id, now)
    await db.flush()
    return {"ok": True}


async def _enforce_quota(db: AsyncSession, user_id: uuid.UUID, now: datetime) -> None:
    """Expire this user's stale registrations, then keep only the newest MAX per user."""
    cutoff = now - timedelta(days=SUBSCRIPTION_TTL_DAYS)
    await db.execute(
        delete(PushSubscription).where(PushSubscription.user_id == user_id, PushSubscription.created_at < cutoff)
    )
    rows = list(
        (
            await db.execute(
                select(PushSubscription)
                .where(PushSubscription.user_id == user_id)
                .order_by(PushSubscription.created_at.desc(), PushSubscription.id.desc())
            )
        ).scalars()
    )
    for row in rows[MAX_SUBSCRIPTIONS_PER_USER:]:
        await db.delete(row)


@router.delete("/subscriptions", status_code=204)
async def unsubscribe(body: SubscriptionIn, user: CurrentUser, db: AsyncSession = Depends(get_db)) -> None:
    # Removes THIS user's registration of that endpoint, and says nothing either way: whether a
    # row existed is not something a caller needs to learn about another account.
    # (A comment, not a docstring — FastAPI publishes a docstring as the operation description,
    # and docs/openapi.json is a committed contract this change has no business moving.)
    await db.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == body.endpoint.strip(), PushSubscription.user_id == user.id
        )
    )
