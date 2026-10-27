"""Web-Push subscriptions: VAPID key handout + endpoint registration.

Any logged-in user (editor or viewer) may subscribe their browser — alarm relevance is
crew-wide. The endpoint URL is the natural key: re-subscribing upserts, and the sender
prunes endpoints the push service reports gone.

⚠️ The endpoint is a DESTINATION THIS SERVER POSTS TO, not just a row. It used to be an
unconstrained string from any logged-in user, which made the alarm sender a request forwarder
(SEC-09, 05.09.). Two things bound it now: `app/egress.py` decides where an endpoint may point,
and a per-user cap decides how many of them one login can leave behind.
"""

import asyncio
import hmac
import json
import uuid
from datetime import UTC, datetime, timedelta

import anyio
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.dependencies import CurrentUser
from ..credentials import get as credential
from ..credentials import load as load_credentials
from ..database import get_db
from ..egress import EgressRefusedError, require_public_https
from ..models import PushSubscription, User
from ..push import SUBSCRIPTION_TTL_DAYS, _send_one, is_known_push_host, push_enabled

router = APIRouter(prefix="/push", tags=["push"])

#: Browsers per login. A person carries a phone, a tablet and a station PC, and a browser
#: rotates its endpoint after a while — ten leaves room for that and still bounds the fan-out
#: one login can add to every alarm sweep. The oldest registration goes when the cap is hit.
MAX_SUBSCRIPTIONS_PER_USER = 10

#: Absolute size ceilings on what a browser may register. A Web-Push endpoint is a URL and the
#: keys are short base64 (a P-256 point, a 16-byte auth secret); ~500 KB of «key» was accepted
#: before. Generous enough for any real push service, small enough that the row is not a store
#: (SEC-09, 05.09.). Over the line is a 422, like any other bad field.
MAX_ENDPOINT_CHARS = 2048
MAX_KEY_CHARS = 256

#: «Testalarm senden» — one per browser per minute. The push goes to ONE endpoint the caller owns,
#: so the cap only keeps a stuck finger from spamming the push service (and the person's own tray).
TEST_PUSH_INTERVAL_SECONDS = 60
_last_test: dict[str, float] = {}


class SubscriptionKeys(BaseModel):
    p256dh: str = Field(max_length=MAX_KEY_CHARS)
    auth: str = Field(max_length=MAX_KEY_CHARS)


class SubscriptionIn(BaseModel):
    endpoint: str = Field(max_length=MAX_ENDPOINT_CHARS)
    keys: SubscriptionKeys


async def _checked_endpoint(endpoint: str) -> str:
    """The endpoint, or a 422 an operator can read. Resolution runs off the event loop."""
    try:
        host = await anyio.to_thread.run_sync(
            lambda: require_public_https(endpoint, what="Push-Endpunkt", resolve=True)
        )
    except EgressRefusedError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    # SEC-09: public-HTTPS is necessary but not sufficient — an arbitrary public host would still
    # make the alarm sender a request forwarder. Accept only a known push service or an
    # admin-allowlisted one (the send path re-checks this, so a row that predates the policy
    # cannot ship either).
    if not is_known_push_host(host):
        raise HTTPException(status_code=422, detail="Push-Endpunkt: kein bekannter Push-Dienst.")
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
    now = datetime.now(UTC)
    # ⚠️ Take the parent user's `FOR UPDATE` lock BEFORE the child INSERT below (SEC-09, 05.09.).
    # On Postgres, inserting a row with an FK to `users` grabs a `KEY SHARE` lock on that user
    # row; if the quota's `FOR UPDATE` came AFTER the insert, two concurrent registrations would
    # each hold `KEY SHARE` and deadlock trying to upgrade. Locking the parent first orders the
    # acquisition so a second txn simply waits. (A no-op on SQLite, which serialises writers.)
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    existing = (
        await db.execute(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
    ).scalar_one_or_none()
    if existing:
        # ⚠️ Ownership, not an upsert on a shared key: the endpoint is what the push service
        # delivers to, so re-pointing somebody else's row would hand their device's notifications
        # to another login's keys. A NULL-owner (kiosk) row is not ours to claim either — the
        # endpoint is that browser's own capability URL; a logged-in caller who merely knows it
        # must not overwrite its keys (SEC-09, 05.09.). The kiosk row keeps delivering as a kiosk.
        if existing.user_id != user.id:
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
    """Expire this user's stale registrations, then keep only the newest MAX per user.

    ⚠️ Runs under this user's `FOR UPDATE` row lock, which serialises concurrent registrations so
    two parallel POSTs cannot each count < MAX and both insert, jointly overshooting the cap
    (SEC-09, 05.09.). `subscribe` now takes that lock BEFORE its child INSERT so FK-lock
    acquisition stays correctly ordered and cannot deadlock on Postgres; the re-acquisition here
    keeps this function safe to call on its own (a no-op inside the txn that already holds it, and
    a no-op on SQLite, which serialises writers anyway).
    """
    await db.execute(select(User.id).where(User.id == user_id).with_for_update())
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


@router.post("/subscriptions/renew")
async def renew(body: SubscriptionIn, db: AsyncSession = Depends(get_db)) -> dict:
    """Renew a registration WITHOUT a session: the subscription's own endpoint + keys are the
    credential (3am sweep §1.3, 23.10.2026).

    The 180-day TTL (``SUBSCRIPTION_TTL_DAYS``) used to be renewable only with a live login,
    so a phone whose session had lapsed silently fell out of the alarm audience. The endpoint is
    a capability URL only that browser holds, and ``p256dh``/``auth`` are its private
    registration — a caller who presents all three IS that browser. Nothing is created and no
    owner changes: an unknown endpoint or a key mismatch answers the same 404, so this cannot be
    used to probe which endpoints exist. The row keeps its user (and so its alarm audience).
    """
    endpoint = body.endpoint.strip()
    row = (await db.execute(select(PushSubscription).where(PushSubscription.endpoint == endpoint))).scalar_one_or_none()
    # Compare bytes: compare_digest(str, str) raises on a non-ASCII guess instead of refusing it.
    if row is None or not (
        hmac.compare_digest(row.p256dh.encode("utf-8"), body.keys.p256dh.encode("utf-8"))
        and hmac.compare_digest(row.auth.encode("utf-8"), body.keys.auth.encode("utf-8"))
    ):
        raise HTTPException(status_code=404, detail="Kein solches Push-Abo.")
    row.created_at = datetime.now(UTC)
    await db.flush()
    return {"ok": True, "renewed_at": row.created_at.isoformat()}


class TestPushIn(BaseModel):
    endpoint: str = Field(max_length=MAX_ENDPOINT_CHARS)


@router.post("/test")
async def test_push(body: TestPushIn, user: CurrentUser, db: AsyncSession = Depends(get_db)) -> dict:
    """«Testalarm senden»: one push to THIS browser's registration, so the person sees with their
    own eyes that an alarm would reach this phone (3am sweep §1.1, 23.10.2026).

    Only a row the caller owns — the endpoint is the device's capability URL, and sending to
    somebody else's would be a stranger ringing their phone. 409 while push is not configured,
    429 inside the per-endpoint minute, 404 for a registration this login does not hold. The
    outcome is the push service's answer, not the phone's: ``accepted`` means it took the
    message; a ``gone`` row is pruned here like in a sweep.
    """
    if not push_enabled():
        raise HTTPException(status_code=409, detail="Push ist auf dieser Installation nicht eingerichtet.")
    endpoint = body.endpoint.strip()
    row = (
        await db.execute(
            select(PushSubscription).where(PushSubscription.endpoint == endpoint, PushSubscription.user_id == user.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Dieses Gerät ist nicht für Push registriert.")
    now = asyncio.get_running_loop().time()
    last = _last_test.get(endpoint)
    if last is not None and now - last < TEST_PUSH_INTERVAL_SECONDS:
        raise HTTPException(status_code=429, detail="Testalarm: bitte eine Minute warten.")
    _last_test[endpoint] = now
    payload = json.dumps(
        {"title": "Testalarm", "body": "Dieses Gerät bekommt Alarme von KP Front.", "tag": "kp-test", "target": None}
    )
    outcome = await asyncio.to_thread(
        _send_one, {"endpoint": row.endpoint, "p256dh": row.p256dh, "auth": row.auth}, payload, urgency="high"
    )
    if outcome == "gone":
        await db.delete(row)
        await db.flush()
    return {"ok": outcome == "accepted", "outcome": outcome}


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
