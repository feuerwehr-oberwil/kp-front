"""Deployment-admin auth — unlock the /admin surface and the admin-write API/CLI with
the shared ADMIN_SECRET, separate from the incident editor PIN.

Fail-closed: when ADMIN_SECRET is unset the surface is OFF (login → 403, every admin
endpoint → 403 via ``get_current_admin``). A successful login mints a short admin-session
cookie carrying no user identity (admin authority is the secret, not a role).
"""

import secrets
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from pydantic import BaseModel

from ..auth.client_ip import client_ip
from ..auth.cookies import clear_admin_cookie, revoke_token, set_admin_cookie
from ..auth.pin_limiter import pin_limiter
from ..auth.security import admin_token_is_current, create_admin_token, decode_token
from ..auth.token_blocklist import token_blocklist
from ..config import settings

router = APIRouter(prefix="/admin", tags=["admin"])

# One shared credential, but the cooldown is keyed per SOURCE, not globally (security audit
# SEC-08). A single global bucket made hostile traffic from anywhere a remote lockout switch:
# it kept winning the next slot, so a correct secret from the operator's own machine was met
# with 429. Per-source, an attacker only ever throttles their own address.
_RATE_KEY = "admin-secret"


class AdminLogin(BaseModel):
    secret: str


async def _session_valid(admin_session: str | None) -> bool:
    if not (settings.admin_secret and admin_session):
        return False
    try:
        payload = decode_token(admin_session)
    except Exception:  # noqa: BLE001 — any decode error → not authenticated
        return False
    if not admin_token_is_current(payload):
        return False
    jti = payload.get("jti")
    return not (jti and await token_blocklist.is_revoked(jti))


@router.get("/session")
async def admin_session_state(admin_session: Annotated[str | None, Cookie()] = None) -> dict:
    """Let the /admin UI choose its first screen without poking a protected endpoint:
    whether admin is configured at all, and whether THIS browser already holds a valid
    admin session. Never leaks the secret."""
    return {
        "configured": bool(settings.admin_secret),
        "authenticated": await _session_valid(admin_session),
    }


@router.post("/login")
async def admin_login(body: AdminLogin, request: Request, response: Response) -> dict:
    if not settings.admin_secret:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin-Zugang ist auf diesem Server nicht eingerichtet (ADMIN_SECRET fehlt).",
        )

    # Reserve one slot for THIS source up front (like the PIN login), so a concurrent burst
    # cannot slip past a check nobody has yet failed. A throttled bucket is NOT rejected here,
    # though: a correct secret must always win, or an attacker sharing the operator's source
    # bucket (a NAT/proxy, or the default TRUSTED_FORWARDED_HOPS=0) could keep it blocked and
    # lock the operator out remotely (SEC-08). `compare_digest` is synchronous and cheap, so
    # running it under throttle costs nothing; only a WRONG attempt from a throttled bucket 429s.
    bucket = pin_limiter.key(_RATE_KEY, client_ip(request))
    throttled = pin_limiter.reserve(bucket) > 0

    if not secrets.compare_digest(body.secret, settings.admin_secret):
        if throttled:
            wait = pin_limiter.retry_after(bucket)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Zu viele Fehlversuche. Bitte {wait}s warten.",
                headers={"Retry-After": str(wait)},
            )
        cooldown = pin_limiter.retry_after(bucket)  # installed by the reservation above
        # «Adminschlüssel» — the ONE name for this credential across the whole surface (the
        # unlock screen and the docs say the same). ADMIN_SECRET stays the env-var name only.
        detail = (
            "Falscher Adminschlüssel" if cooldown == 0 else f"Falscher Adminschlüssel. Nächster Versuch in {cooldown}s."
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)

    pin_limiter.record_success(bucket)
    set_admin_cookie(response, create_admin_token())
    return {"ok": True}


@router.post("/logout")
async def admin_logout(
    response: Response,
    admin_session: Annotated[str | None, Cookie()] = None,
) -> dict:
    await revoke_token(admin_session)
    clear_admin_cookie(response)
    return {"ok": True}
