"""Cookie helpers — httpOnly, SameSite=Lax, Secure auto-on in production, single-origin."""

from datetime import UTC, datetime

from fastapi import Response
from jwt import InvalidTokenError as JWTError

from ..config import settings
from .incident_link import LINK_COOKIE
from .security import decode_token
from .token_blocklist import token_blocklist

ACCESS_COOKIE = "access_token"
REFRESH_COOKIE = "refresh_token"
ADMIN_COOKIE = "admin_session"


def _set_session_cookie(response: Response, key: str, value: str, max_age: int) -> None:
    """The one place the session-cookie flags are spelled out. Every auth cookie in this app
    is httpOnly + SameSite=Lax + Secure-in-production + site-wide; keeping that in a single
    function means a flag can't drift on one cookie and not the others."""
    response.set_cookie(
        key,
        value,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def set_auth_cookies(response: Response, access_token: str, refresh_token: str | None = None) -> None:
    _set_session_cookie(response, ACCESS_COOKIE, access_token, settings.access_token_expire_minutes * 60)
    if refresh_token is not None:
        _set_session_cookie(response, REFRESH_COOKIE, refresh_token, settings.refresh_token_expire_days * 24 * 3600)


def clear_auth_cookies(response: Response) -> None:
    """«Abmelden» sheds everything this browser is – its login AND any link session.

    The link cookie goes too, and that does not undo the decoupling. Opening a link still does
    not sign this device out, and the SPA never reads a link cookie once a page has said it is
    not one (auth/incident_link · LINK_MODE_HEADER); the direction that still matters is the
    one nothing else covers. The link cookie is site-wide and lasts 12 h, so requests the
    browser makes with NO header of ours – an address typed into the bar, an ``<img
    src="/api/media/…">``, the service worker – keep answering as the link guest long after
    the person handed the tablet back. «Abmelden» is the one gesture that means «I am done on
    this device», so it is the one place that must end that too. A link page loses nothing: it
    has no Abmelden of its own (src/App), and its token is still in its address bar.
    """
    response.delete_cookie(ACCESS_COOKIE, path="/")
    response.delete_cookie(REFRESH_COOKIE, path="/")
    response.delete_cookie(LINK_COOKIE, path="/")


def set_admin_cookie(response: Response, token: str) -> None:
    _set_session_cookie(response, ADMIN_COOKIE, token, settings.admin_session_expire_minutes * 60)


def clear_admin_cookie(response: Response) -> None:
    response.delete_cookie(ADMIN_COOKIE, path="/")


def set_link_cookie(response: Response, token: str) -> None:
    """The logged-out incident-link session (app/auth/incident_link.py) — same flags as every
    other session cookie here; only its lifetime differs."""
    _set_session_cookie(response, LINK_COOKIE, token, int(settings.incident_link_session_ttl.total_seconds()))


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
