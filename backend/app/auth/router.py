"""Auth endpoints: roster → login (PIN) → me / refresh / logout."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from jwt import InvalidTokenError as JWTError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models import User
from ..schemas import (
    LoginRequest,
    PinReset,
    RosterUser,
    UserAdminOut,
    UserCreate,
    UserOut,
    UserUpdate,
)
from .client_ip import client_ip
from .cookies import (
    REFRESH_COOKIE,
    clear_auth_cookies,
    revoke_token,
    set_auth_cookies,
)
from .dependencies import AUTH_GENERATION_CLAIM, CurrentAdmin, CurrentUser, OptionalUser, token_generation
from .pin_limiter import pin_limiter
from .security import (
    TRIVIAL_PINS,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_pin,
    verify_pin_async,
)
from .token_blocklist import token_blocklist

router = APIRouter(prefix="/auth", tags=["auth"])


def _claims(user: User) -> dict:
    # The generation travels in every token this app mints; `dependencies.get_current_user`
    # and /auth/refresh refuse one that is behind the row's (see revoke_sessions).
    return {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        AUTH_GENERATION_CLAIM: user.auth_generation,
    }


async def revoke_sessions(db: AsyncSession, user: User) -> None:
    """End every session this account currently holds — access cookies AND refresh tokens.

    The one lever behind «throw them out»: a PIN reset and a deactivation both pull it, so an
    admin rotating a compromised credential actually removes whoever was already inside
    (security audit SEC-05). Deactivation pulling it too is what stops a later reactivation
    from reviving the sessions the deactivation denied.

    The bump is an atomic ``gen = gen + 1`` at the row, NOT a read-modify-write on the ORM
    value: two overlapping resets that both read generation 0 would each write 1, leaving a
    session minted after the first reset alive through the second (SEC-05). Serialising at the
    row makes N resets advance the generation by N. ``synchronize_session=False`` leaves the
    identity-mapped value stale, so it is expired here — the callers' own ``db.refresh(user)``
    then re-reads the bumped value without clobbering their other pending edits.
    """
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(auth_generation=User.auth_generation + 1)
        .execution_options(synchronize_session=False)
    )
    db.expire(user, ["auth_generation"])


@router.get("/roster", response_model=list[RosterUser])
async def roster(db: AsyncSession = Depends(get_db)) -> list[User]:
    """Tappable login tiles for the kiosk — active users only, no secrets."""
    result = await db.execute(select(User).where(User.is_active.is_(True)).order_by(User.display_name))
    return list(result.scalars().all())


@router.post("/login", response_model=UserOut)
async def login(body: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> User:
    # Per (account, source): a cooldown shared by every caller of one account would be a remote
    # switch for locking the Einsatzleiter out of their own tile (pin_limiter's docstring).
    bucket = pin_limiter.key(str(body.user_id), client_ip(request))

    # Reserved, not checked: the slot is taken in the same synchronous step that decides to
    # admit the attempt, BEFORE the first await, so a concurrent burst is counted rather than
    # slipping past a check nobody has yet failed (SEC-08 round 1). A bucket already IN COOLDOWN
    # is REJECTED here, before the verify — a wrong guess AND a correct one. Rejecting the
    # correct guess too is the whole point: it is what actually throttles guessing. Round 3
    # verified even while throttled ("a correct PIN always wins"), so an attacker who exhausted
    # the bucket could keep bcrypt-checking candidates and the moment one hit it returned 200 —
    # the 6-digit space was brute-forceable (SEC-08 round 3 regression). So: cooldown ⇒ no verify.
    #
    # This is safe against locking the operator out because the cooldown is BOUNDED and
    # NON-EXTENDING. `pin_cooldown_steps_seconds` caps the ladder (currently at 120s), and
    # `pin_limiter.reserve` counts nothing while a bucket is blocked — attempts made DURING a
    # cooldown do not deepen it. So the block always elapses, opening a recovery window in which
    # the operator's correct PIN gets in. Under a sustained flood on the SAME source bucket
    # (a shared NAT/proxy, or the default TRUSTED_FORWARDED_HOPS=0) the operator faces periodic
    # bounded cooldowns and competes for those windows — never a permanent lockout. Per (account,
    # source) keying means an operator on their own address is never blocked by someone else's.
    wait = pin_limiter.reserve(bucket)
    if wait:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Zu viele Fehlversuche. Bitte {wait}s warten.",
            headers={"Retry-After": str(wait)},
        )

    user = (await db.execute(select(User).where(User.id == body.user_id))).scalar_one_or_none()
    # Spelled out rather than via an `ok` flag so the None-check actually narrows `user` for
    # everything below; short-circuiting keeps bcrypt off the unknown-user path as before.
    if user is None or not user.is_active or not await verify_pin_async(body.pin, user.pin_hash):
        cooldown = pin_limiter.retry_after(bucket)  # installed by the reservation above
        detail = "Falsche PIN" if cooldown == 0 else f"Falsche PIN. Nächster Versuch in {cooldown}s."
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)

    # Knowing the PIN gives the reserved slot back and clears any cooldown the bucket was
    # carrying, so an operator's own mistyping never follows them in once they type it right.
    pin_limiter.record_success(bucket)
    user.last_login = datetime.now(UTC)

    claims = _claims(user)
    set_auth_cookies(response, create_access_token(claims), create_refresh_token(claims))
    return user


@router.post("/refresh", response_model=UserOut)
async def refresh(
    response: Response,
    refresh_token: Annotated[str | None, Cookie(alias=REFRESH_COOKIE)] = None,
    db: AsyncSession = Depends(get_db),
) -> User:
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Kein Refresh-Token")
    try:
        payload = decode_token(refresh_token)
    except JWTError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Refresh-Token") from e
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Falscher Token-Typ")

    jti = payload.get("jti")
    exp = payload.get("exp")
    if not isinstance(jti, str) or not jti or not isinstance(exp, (int, float)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Refresh-Token")

    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, TypeError, ValueError) as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Refresh-Token") from e

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Benutzer inaktiv")
    # A refresh token outlives the access cookie it came with and mints a fresh successor every
    # time, so this is the check that decides whether a revoked session can rebuild itself.
    if token_generation(payload) != user.auth_generation:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sitzung widerrufen")

    # Atomically consume before rotating. A check followed by a separate revoke lets two
    # concurrent requests both pass the check and each mint a valid successor token.
    try:
        expires_at = datetime.fromtimestamp(exp, tz=UTC)
    except (OverflowError, OSError, ValueError) as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiges Refresh-Token") from e
    if not await token_blocklist.consume(jti, expires_at):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh-Token widerrufen")
    claims = _claims(user)
    set_auth_cookies(response, create_access_token(claims), create_refresh_token(claims))
    return user


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    access_token: Annotated[str | None, Cookie()] = None,
    refresh_token: Annotated[str | None, Cookie(alias=REFRESH_COOKIE)] = None,
) -> dict:
    await revoke_token(access_token)
    await revoke_token(refresh_token)
    clear_auth_cookies(response)
    return {"ok": True}


@router.get("/me", response_model=UserOut)
async def me(current_user: CurrentUser) -> User:
    return current_user


# --- User administration (Slice 2 — Members & access) -------------------------------
# Admin-only (the deployment ADMIN_SECRET session, NOT the incident editor role). These
# live under /api/auth/users (distinct from the PUBLIC active-only /api/auth/roster).
# pin_hash is NEVER serialised — UserAdminOut omits it. We DEACTIVATE, never hard-delete,
# so audit-log FKs (incident_events.user_id, notes, …) stay intact.


# Operator-facing German, like every other refusal this router returns ("Falsche PIN",
# "Benutzername bereits vergeben"). Both are the wording the admin PIN sheet already shows
# (src/config/copy · admin.members.pinTrivial / pinInvalid), so the sheet's own guard and the
# server's say the same sentence. `hash_pin`'s ValueError stays English: it is a console/CLI
# message and used to be the one raw English string that reached an operator's screen.
_PIN_TOO_SIMPLE = "Diese PIN ist zu einfach – bitte eine andere wählen."
_PIN_WRONG_LENGTH = f"PIN muss genau {settings.pin_length} Ziffern haben."


def _hash_pin_or_400(pin: str) -> str:
    """Hash a PIN for storage, refusing anything an operator must not be able to set.

    The single gate for BOTH PIN writers (create_user and reset_pin), so the well-known-PIN
    rule the seeder applies at boot (security.TRIVIAL_PINS) is the same rule the API applies.
    Checked before hashing — no point spending a bcrypt round on a PIN we are rejecting.
    """
    if pin in TRIVIAL_PINS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_PIN_TOO_SIMPLE)
    try:
        return hash_pin(pin)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_PIN_WRONG_LENGTH) from e


async def _count_active_editors(db: AsyncSession, *, exclude_id: uuid.UUID | None = None) -> int:
    stmt = select(func.count()).select_from(User).where(User.role == "editor", User.is_active.is_(True))
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    return int((await db.execute(stmt)).scalar_one())


@router.get("/users", response_model=list[UserAdminOut])
async def list_users(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> list[User]:
    """ALL login users incl. inactive — the admin members table."""
    result = await db.execute(select(User).order_by(User.is_active.desc(), User.display_name))
    return list(result.scalars().all())


@router.post("/users", response_model=UserAdminOut, status_code=status.HTTP_201_CREATED)
async def create_user(body: UserCreate, _admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> User:
    taken = (await db.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
    if taken is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Benutzername bereits vergeben")

    user = User(
        username=body.username,
        display_name=body.display_name,
        role=body.role,
        color=body.color,
        el_view_default=body.el_view_default,
        pin_hash=_hash_pin_or_400(body.pin),
        is_active=True,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserAdminOut)
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    _admin: CurrentAdmin,
    current: OptionalUser,
    db: AsyncSession = Depends(get_db),
) -> User:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Benutzer nicht gefunden")

    # Detect the two dangerous transitions on a currently-active editor.
    deactivating = body.is_active is False and user.is_active
    demoting = body.role == "viewer" and user.role == "editor"

    if (deactivating or demoting) and current is not None and user.id == current.id:
        verb = "deaktivieren" if deactivating else "zum Betrachter herabstufen"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Du kannst dein eigenes Konto nicht {verb}.",
        )

    # Last-active-editor guard: never let the count of active editors reach 0.
    if (deactivating or demoting) and user.role == "editor" and user.is_active:
        others = await _count_active_editors(db, exclude_id=user.id)
        if others == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Der letzte aktive Bearbeiter kann nicht deaktiviert oder herabgestuft werden.",
            )

    if body.display_name is not None:
        user.display_name = body.display_name
    if body.color is not None:
        user.color = body.color
    if body.role is not None:
        user.role = body.role
    if body.is_active is not None:
        if deactivating:
            # Denying access and leaving the sessions standing is only half a deactivation:
            # reactivating later would hand them back (SEC-05).
            await revoke_sessions(db, user)
        user.is_active = body.is_active
    if body.el_view_default is not None:
        user.el_view_default = body.el_view_default

    await db.flush()
    await db.refresh(user)
    return user


@router.post("/users/{user_id}/pin", response_model=UserAdminOut)
async def reset_pin(
    user_id: uuid.UUID,
    body: PinReset,
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
) -> User:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Benutzer nicht gefunden")
    user.pin_hash = _hash_pin_or_400(body.pin)
    # The whole point of resetting a PIN is that the old one stops working — for the sessions
    # it already opened too, not just for the login screen.
    await revoke_sessions(db, user)
    await db.flush()
    await db.refresh(user)
    return user
