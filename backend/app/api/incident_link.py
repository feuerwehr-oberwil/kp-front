"""Incident view links (`/api/incident-link/*`) — the alert-link exchange.

An alerting system puts a URL carrying a signed token into the alarm it sends out; a
responder taps it on a personal phone and this endpoint trades that token for a logged-out,
read-only session scoped to exactly one incident (what the session may then reach is the
allowlist in `auth/incident_link.py`). The trust model is possession of the alert — the same
authority as knowing the Einsatz happened at all, and it expires with the Einsatz.

Two keys, and the split is the point. The station's `incident_link_key` (this file's admin
trio mints it) is shared with the alerting system and can do exactly one thing: ask for a
link session. It is NOT `SECRET_KEY`, which peppers PINs and mints admin sessions and never
leaves kp-front. The alerting system signs offline, with no call to us — it sits on the
life-critical path and must not depend on this app being reachable.

Fail-closed twice over: no key configured → 403, and a link only opens a session while its
incident is still running (not archived, not closed). A closed Einsatz answers the same 404
as one that never existed — a link holder must not be able to enumerate the station's
incidents by watching which refusals differ.
"""

import secrets

from fastapi import APIRouter, Depends, HTTPException, Response, status
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.cookies import set_link_cookie
from ..auth.dependencies import CurrentAdmin
from ..auth.incident_link import LINK_TOKEN_TYPE, create_link_session_token
from ..database import get_db
from ..models import DeploymentConfig, Incident

router = APIRouter(prefix="/incident-link", tags=["incident-link"])

# Pinned here rather than read from settings.algorithm: this is the signature algorithm of a
# contract with an OUTSIDE system, so it changes only when both ends do — never as a side
# effect of retuning kp-front's own tokens.
LINK_ALGORITHM = "HS256"

# Incident.status while the Einsatz is running (models.Incident default).
OPEN_STATUS = "offen"


class LinkTokenIn(BaseModel):
    token: str


# --- admin: the minting key -------------------------------------------------------------
# Gated by the deployment admin (ADMIN_SECRET session), NOT the editor role: handing this key
# to an alerting system grants it the power to open read sessions on every incident the
# station will ever have, which is deployment administration.


async def _config_row(db: AsyncSession) -> DeploymentConfig:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db.add(row)
        await db.flush()
    return row


@router.get("/secret")
async def get_link_key(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await _config_row(db)
    return {"configured": bool(row.incident_link_key), "token": row.incident_link_key}


@router.post("/secret/rotate")
async def rotate_link_key(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    """Mint a fresh minting key — every link already sent out stops working at once, so the
    alerting system has to be reconfigured with the new one in the same breath."""
    row = await _config_row(db)
    row.incident_link_key = secrets.token_urlsafe(18)
    await db.flush()
    return {"configured": True, "token": row.incident_link_key}


@router.delete("/secret")
async def disable_link(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> dict:
    row = await _config_row(db)
    row.incident_link_key = None
    await db.flush()
    return {"configured": False}


# --- the exchange (link token → session cookie) ------------------------------------------


def _invalid_token() -> HTTPException:
    """One message for every rejected token — bad signature, wrong type, missing claims and
    expiry are all «this link doesn't work», and telling them apart only helps a forger."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Einsatz-Link ungültig oder abgelaufen",
    )


@router.post("/session")
async def open_link_session(body: LinkTokenIn, response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    """Trade a link token minted by the alerting system for a link-session cookie.

    The token names its incident the way the alerting system knows it — `src`/`ref`, which
    mirror `Incident.source` / `Incident.source_ref`, the same pair the intake deduplicates
    on. That is what keeps this provider-neutral: nothing here knows what Divera is, and an
    alerting system never has to learn our incident UUIDs to link to one.
    """
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    key = row.incident_link_key if row else None
    if not key:
        # Fail CLOSED: no minting key configured → the whole link surface is off.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Einsatz-Links deaktiviert (kein Link-Schlüssel gesetzt)",
        )

    try:
        # Signature AND `exp` are checked here; an expired token raises a JWTError subclass.
        claims = jwt.decode(body.token, key, algorithms=[LINK_ALGORITHM])
    except JWTError:
        raise _invalid_token() from None

    if claims.get("type") != LINK_TOKEN_TYPE:
        # A credential minted for anything else must not become a link session, even when it
        # carries a valid signature from this key. Plain `!=`, like read_link_session does:
        # this is a discriminator compared after the signature already held, not a secret.
        raise _invalid_token()

    src, ref = claims.get("src"), claims.get("ref")
    if not isinstance(src, str) or not isinstance(ref, str | int) or not src or str(ref) == "":
        raise _invalid_token()

    inc = (
        await db.execute(select(Incident).where(Incident.source == src, Incident.source_ref == str(ref)))
    ).scalar_one_or_none()
    if inc is None or inc.is_archived or inc.status != OPEN_STATUS or inc.closed_at is not None:
        # Unknown, archived, or already closed — one answer for all three (no probing).
        raise HTTPException(status_code=404, detail="Einsatz nicht (mehr) verfügbar")

    # The session records which minting key it was born from, so rotating that key ends
    # sessions that are already open — not just links that have not been tapped yet.
    set_link_cookie(response, create_link_session_token(str(inc.id), key))
    # The id the SPA needs to open the incident; the session itself lives in the cookie.
    return {"incident_id": str(inc.id)}
