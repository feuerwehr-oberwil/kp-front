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

The exchange also *opens* an alarm that is still waiting in an intake pool (2026-08-02): the
link used to be dead until an editor had taken the alarm on a tablet, which put a colleague
between the responder and the Lage. Opening grants nothing extra — the session that follows
is the same read-only viewer — and the incident stays unconfirmed (`editor_opened_at` NULL),
so a link nobody at the station ever worked never reaches the statistics.

THE SECOND KIND OF LINK (2026-09-01)
------------------------------------
`/l/v<secret>` is the Rapport's own view link, minted in the app by an editor
(api/incidents · the `view-link` trio) and handed to somebody OUTSIDE the station: a Gemeinde,
a Nachbarwehr, an insurer — «so they can see in one go what we did». It lands on the same door
and opens the same read-only session, and every other rule above still holds: one incident,
the same allowlist, the same scope check.

Two things differ, and both follow from who it is for:
  · it does NOT expire with the Einsatz — the Einsatz being over is the normal case for it;
  · it is revoked ON ITS OWN, per incident, by clearing `Incident.view_link_key`, rather than
    by rotating the station's minting key, which would take every alarm link with it.
Because it cannot expire, revoking has to be complete: the check runs on every request, so a
session already open on somebody's phone dies together with the URL.
"""

import secrets

import jwt
from fastapi import APIRouter, Depends, HTTPException, Response, status
from jwt import InvalidTokenError as JWTError
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alarms import open_pooled_alarm
from ..auth.cookies import set_link_cookie
from ..auth.dependencies import CurrentAdmin
from ..auth.incident_link import LINK_TOKEN_TYPE, create_link_session_token, create_view_session_token
from ..database import get_db
from ..models import DeploymentConfig, Incident

router = APIRouter(prefix="/incident-link", tags=["incident-link"])

# Pinned here rather than read from settings.algorithm: this is the signature algorithm of a
# contract with an OUTSIDE system, so it changes only when both ends do — never as a side
# effect of retuning kp-front's own tokens.
LINK_ALGORITHM = "HS256"


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
    # HS256 requires at least 256 bits of key material (RFC 7518 §3.2). Older releases
    # minted 18 bytes; those keys remain valid for compatibility, while every rotation now
    # meets the full requirement.
    row.incident_link_key = secrets.token_urlsafe(32)
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


#: A Rapport view-link URL carries the incident's own secret, not a signed token — so the two
#: kinds of link have to be told apart before anything tries to verify a signature. The marker is
#: the leading character, and it cannot collide: a JWT is three base64url segments and always
#: starts with `eyJ` (the encoded `{"`), so no alerting-system token begins with this.
VIEW_TOKEN_PREFIX = "v"  # noqa: S105 — a URL marker, not a credential


async def _open_view_session(token: str, response: Response, db: AsyncSession) -> dict:
    """Trade a Rapport view link for a session on the ONE incident that link belongs to.

    No signature to check and none needed: the secret IS the credential, 32 bytes from
    `secrets.token_urlsafe`, and it is looked up rather than decoded. Which means there is
    nothing to expire and exactly one way to end it — the station revoking the link, which
    clears the column and takes every open session with it (auth/incident_link ·
    `_view_key_unchanged`).

    Deliberately says nothing about WHY a token failed. An unknown secret, a revoked link and
    a deleted Einsatz answer alike; telling them apart only helps somebody guessing.
    """
    secret = token[len(VIEW_TOKEN_PREFIX) :]
    if not secret:
        raise _invalid_token()
    inc = (await db.execute(select(Incident).where(Incident.view_link_key == secret))).scalar_one_or_none()
    if inc is None:
        raise _invalid_token()
    # NOTE: `is_open` is NOT consulted, and that is the whole point of this link — it is handed
    # out to show a FINISHED Einsatz to somebody outside the station.
    set_link_cookie(response, create_view_session_token(str(inc.id), secret))
    return {"incident_id": str(inc.id)}


@router.post("/session")
async def open_link_session(body: LinkTokenIn, response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    """Trade a link token minted by the alerting system for a link-session cookie.

    The token names its incident the way the alerting system knows it — `src`/`ref`, which
    mirror `Incident.source` / `Incident.source_ref`, the same pair the intake deduplicates
    on. That is what keeps this provider-neutral: nothing here knows what Divera is, and an
    alerting system never has to learn our incident UUIDs to link to one.
    """
    # One door, two kinds of link — the SPA forwards whatever stood in `/l/<…>` and does not
    # need to know which it is holding.
    if body.token.startswith(VIEW_TOKEN_PREFIX):
        return await _open_view_session(body.token, response, db)

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
    if inc is None:
        # No incident under that (src, ref) — but the alarm may still be waiting in an intake
        # pool, in which case the responder holding this link is the reason to open it. This
        # is the whole point of the exchange: the link must not depend on someone else having
        # picked the alarm up on a tablet first (production, 2026-08-02). The lookup is
        # source-agnostic and lives in `alarms`, so nothing here learns what Divera is.
        inc = await open_pooled_alarm(db, source=src, ref=str(ref))
    if inc is None or not inc.is_open:
        # Unknown, archived, or already closed — one answer for all three (no probing). An
        # alarm that no pool knows either falls in here, indistinguishable from the rest.
        raise HTTPException(status_code=404, detail="Einsatz nicht (mehr) verfügbar")

    # The session records which minting key it was born from, so rotating that key ends
    # sessions that are already open — not just links that have not been tapped yet.
    set_link_cookie(response, create_link_session_token(str(inc.id), key))
    # The id the SPA needs to open the incident; the session itself lives in the cookie.
    return {"incident_id": str(inc.id)}
