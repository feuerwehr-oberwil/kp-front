"""FastAPI auth dependencies. Two roles: editor (edit) / viewer (read-only)."""

import logging
import uuid
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, Request, status
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models import User
from .security import decode_token
from .token_blocklist import token_blocklist

logger = logging.getLogger(__name__)

_credentials_exc = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Nicht angemeldet",
    headers={"WWW-Authenticate": "Bearer"},
)

# Deployment-admin gate uses two distinct failures so the /admin UI can tell them apart:
# 403 = admin surface not configured on this server; 401 = configured but not unlocked.
_admin_disabled_exc = HTTPException(
    status_code=status.HTTP_403_FORBIDDEN,
    detail="Admin-Zugang ist auf diesem Server nicht eingerichtet (ADMIN_SECRET fehlt).",
)
_admin_auth_exc = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Admin-Anmeldung erforderlich",
)


async def get_current_user(
    request: Request,
    access_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> User:
    if not access_token:
        raise _credentials_exc
    try:
        payload = decode_token(access_token)
        if payload.get("type") != "access":
            raise _credentials_exc
        jti = payload.get("jti")
        if jti and await token_blocklist.is_revoked(jti):
            raise _credentials_exc
        sub = payload.get("sub")
        if sub is None:
            raise _credentials_exc
        user_id = uuid.UUID(sub)
    except (JWTError, ValueError) as e:
        raise _credentials_exc from e

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise _credentials_exc
    request.state.user = user
    return user


async def get_current_editor(current_user: Annotated[User, Depends(get_current_user)]) -> User:
    if current_user.role != "editor":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bearbeiter-Berechtigung erforderlich")
    return current_user


async def get_optional_user(
    request: Request,
    access_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """Resolve the logged-in user if a valid session cookie is present, else None.

    Admin endpoints authorize on the admin SECRET (``get_current_admin``), not on a user;
    this lets them still stamp ``updated_by`` for audit when a person is driving the /admin
    UI, while the CLI (admin secret, no user) cleanly stamps NULL.
    """
    if not access_token:
        return None
    try:
        return await get_current_user(request, access_token, db)
    except HTTPException:
        return None


async def get_current_admin(admin_session: Annotated[str | None, Cookie()] = None) -> None:
    """Gate the deployment-admin surface on the shared ADMIN_SECRET session, NOT the
    incident editor role. Fail-closed: with no secret configured the surface is off (403)."""
    if not settings.admin_secret:
        raise _admin_disabled_exc
    if not admin_session:
        raise _admin_auth_exc
    try:
        payload = decode_token(admin_session)
        if payload.get("type") != "admin" or payload.get("scope") != "admin":
            raise _admin_auth_exc
        jti = payload.get("jti")
        if jti and await token_blocklist.is_revoked(jti):
            raise _admin_auth_exc
    except (JWTError, ValueError) as e:
        raise _admin_auth_exc from e


async def _admin_session_valid(admin_session: str | None) -> bool:
    """True when a live admin session is presented (secret configured + valid cookie)."""
    if not (settings.admin_secret and admin_session):
        return False
    try:
        payload = decode_token(admin_session)
        if payload.get("type") != "admin" or payload.get("scope") != "admin":
            return False
        jti = payload.get("jti")
        if jti and await token_blocklist.is_revoked(jti):
            return False
        return True
    except (JWTError, ValueError):
        return False


async def get_user_or_admin(
    request: Request,
    access_token: Annotated[str | None, Cookie()] = None,
    admin_session: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """Read access for surfaces shared by the field app AND the /admin UI (roster, Traccar
    status). The /admin surface is admin-secret-only (no kiosk login), so an admin session
    must satisfy these too — resolving to None (no user identity), like the CLI."""
    if access_token:
        try:
            return await get_current_user(request, access_token, db)
        except HTTPException:
            pass
    if await _admin_session_valid(admin_session):
        return None
    raise _credentials_exc


async def get_editor_or_admin(
    request: Request,
    access_token: Annotated[str | None, Cookie()] = None,
    admin_session: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """Write access for the same shared surfaces: an incident editor OR the deployment
    admin (roster CRUD/import, Divera pool refresh). Viewers stay read-only."""
    if access_token:
        try:
            user = await get_current_user(request, access_token, db)
        except HTTPException:
            user = None
        if user is not None:
            if user.role != "editor":
                # a kiosk viewer with an admin session unlocked still counts as admin
                if await _admin_session_valid(admin_session):
                    return None
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bearbeiter-Berechtigung erforderlich")
            return user
    if await _admin_session_valid(admin_session):
        return None
    raise _credentials_exc


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentEditor = Annotated[User, Depends(get_current_editor)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]
CurrentAdmin = Annotated[None, Depends(get_current_admin)]
UserOrAdmin = Annotated[User | None, Depends(get_user_or_admin)]
EditorOrAdmin = Annotated[User | None, Depends(get_editor_or_admin)]
