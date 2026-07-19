"""Cookie helpers — httpOnly, SameSite=Lax, Secure auto-on in production, single-origin."""

from datetime import UTC, datetime

from fastapi import Response
from jose import JWTError

from ..config import settings
from .security import decode_token
from .token_blocklist import token_blocklist

ACCESS_COOKIE = "access_token"
REFRESH_COOKIE = "refresh_token"
ADMIN_COOKIE = "admin_session"


def set_auth_cookies(response: Response, access_token: str, refresh_token: str | None = None) -> None:
    common = dict(httponly=True, samesite="lax", secure=settings.cookie_secure, path="/")
    response.set_cookie(
        ACCESS_COOKIE,
        access_token,
        max_age=settings.access_token_expire_minutes * 60,
        **common,
    )
    if refresh_token is not None:
        response.set_cookie(
            REFRESH_COOKIE,
            refresh_token,
            max_age=settings.refresh_token_expire_days * 24 * 3600,
            **common,
        )


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(ACCESS_COOKIE, path="/")
    response.delete_cookie(REFRESH_COOKIE, path="/")


def set_admin_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        ADMIN_COOKIE,
        token,
        max_age=settings.admin_session_expire_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def clear_admin_cookie(response: Response) -> None:
    response.delete_cookie(ADMIN_COOKIE, path="/")


async def revoke_token(token: str | None) -> None:
    """Best-effort: add a token's JTI to the blocklist until its own expiry."""
    if not token:
        return
    try:
        payload = decode_token(token)
    except JWTError:
        return
    jti = payload.get("jti")
    exp = payload.get("exp")
    if jti and exp:
        await token_blocklist.revoke(jti, datetime.fromtimestamp(exp, tz=UTC))
