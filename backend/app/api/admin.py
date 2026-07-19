"""Deployment-admin auth — unlock the /admin surface and the admin-write API/CLI with
the shared ADMIN_SECRET, separate from the incident editor PIN.

Fail-closed: when ADMIN_SECRET is unset the surface is OFF (login → 403, every admin
endpoint → 403 via ``get_current_admin``). A successful login mints a short admin-session
cookie carrying no user identity (admin authority is the secret, not a role).
"""

import secrets
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Response, status
from pydantic import BaseModel

from ..auth.cookies import clear_admin_cookie, revoke_token, set_admin_cookie
from ..auth.pin_limiter import pin_limiter
from ..auth.security import create_admin_token, decode_token
from ..auth.token_blocklist import token_blocklist
from ..config import settings

router = APIRouter(prefix="/admin", tags=["admin"])

# Single shared credential → one rate-limit bucket (the limiter is keyed by string).
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
    if payload.get("type") != "admin" or payload.get("scope") != "admin":
        return False
    jti = payload.get("jti")
    if jti and await token_blocklist.is_revoked(jti):
        return False
    return True


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
async def admin_login(body: AdminLogin, response: Response) -> dict:
    if not settings.admin_secret:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin-Zugang ist auf diesem Server nicht eingerichtet (ADMIN_SECRET fehlt).",
        )

    wait = pin_limiter.retry_after(_RATE_KEY)
    if wait > 0:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Zu viele Fehlversuche. Bitte {wait}s warten.",
            headers={"Retry-After": str(wait)},
        )

    if not secrets.compare_digest(body.secret, settings.admin_secret):
        cooldown = pin_limiter.record_failure(_RATE_KEY)
        detail = (
            "Falsches Admin-Passwort"
            if cooldown == 0
            else f"Falsches Admin-Passwort. Nächster Versuch in {cooldown}s."
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)

    pin_limiter.record_success(_RATE_KEY)
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
