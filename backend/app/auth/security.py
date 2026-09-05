"""PIN hashing (peppered bcrypt) and JWT token plumbing.

PIN safety model (PLAN §5): ``bcrypt( HMAC-SHA256(pin, SECRET_KEY) )``. The HMAC
pepper means a DB leak alone cannot brute-force the 1M PIN space without the app
secret. The HMAC hex digest (64 chars) stays under bcrypt's 72-byte limit.
"""

import hashlib
import hmac
import uuid
from datetime import UTC, datetime, timedelta

import anyio
import anyio.to_thread
import bcrypt
import jwt
from jwt import InvalidTokenError as JWTError

from ..config import settings

# PINs that are not secrets, whatever the deployment. Rejecting these stops "set a PIN" from
# becoming a box-ticking exercise satisfied by retyping the value we are trying to remove.
#
# ONE list, read by both ends of a PIN's life: `seed.resolve_seed_pin` at boot, and the admin
# API's `auth.router._hash_pin_or_400` on every create/reset. The API half is the half that
# matters most — SETUP.md §2 makes "change the seeded PIN" a station's first action — and was
# for a while the only place the rule was missing.
#
# Deliberately NOT enforced inside `hash_pin`: the public demo publishes 000000 on its own
# login screen (demo_reset.DEMO_USERS + identity.demoNote), which is an announced choice, and
# `hash_pin` is what that out-of-band CLI path calls.
TRIVIAL_PINS = frozenset({"000000", "111111", "123456", "654321", "999999", "012345"})


def _pepper(pin: str) -> bytes:
    """HMAC-SHA256(pin, SECRET_KEY) → 64-char hex digest (bytes)."""
    return (
        hmac.new(
            settings.secret_key.encode("utf-8"),
            pin.encode("utf-8"),
            hashlib.sha256,
        )
        .hexdigest()
        .encode("utf-8")
    )


def hash_pin(pin: str) -> str:
    """Pepper then bcrypt a 6-digit PIN."""
    if len(pin) != settings.pin_length or not pin.isdigit():
        raise ValueError(f"PIN must be exactly {settings.pin_length} digits")
    salt = bcrypt.gensalt(rounds=settings.pin_bcrypt_rounds)
    return bcrypt.hashpw(_pepper(pin), salt).decode("utf-8")


def verify_pin(pin: str, pin_hash: str) -> bool:
    """Constant-time verify of a peppered PIN against its bcrypt hash."""
    try:
        return bcrypt.checkpw(_pepper(pin), pin_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


#: Bcrypt at 12 rounds costs ~0.3 s of CPU. Run inline in an async route it stalls the event
#: loop for every other tablet on the deployment, so `verify_pin_async` hands it to a worker
#: thread — and does so through a limiter, because "off the loop" unbounded would just move a
#: login burst's cost into the thread pool that reports, uploads and tiles also share.
_PIN_VERIFY_LIMITER = anyio.CapacityLimiter(4)


async def verify_pin_async(pin: str, pin_hash: str) -> bool:
    """`verify_pin` off the event loop, with bounded concurrency (login hot path)."""
    return await anyio.to_thread.run_sync(verify_pin, pin, pin_hash, limiter=_PIN_VERIFY_LIMITER)


def _encode(data: dict, *, token_type: str, expires: timedelta) -> str:
    to_encode = data.copy()
    now = datetime.now(UTC)
    to_encode.update(
        {
            "exp": now + expires,
            "iat": now,
            "jti": str(uuid.uuid4()),
            "type": token_type,
        }
    )
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


# The S106 suppressions below are all on `token_type=` — a JWT claim discriminator, not a
# credential. S106 matches on the argument name containing "token"; there is no way to teach
# it the difference, so each site says so explicitly.
def create_access_token(data: dict) -> str:
    return _encode(data, token_type="access", expires=timedelta(minutes=settings.access_token_expire_minutes))  # noqa: S106


def create_refresh_token(data: dict) -> str:
    return _encode(data, token_type="refresh", expires=timedelta(days=settings.refresh_token_expire_days))  # noqa: S106


def _admin_secret_fingerprint() -> str:
    """Opaque version of ADMIN_SECRET, bound to SECRET_KEY and safe to carry in a JWT."""
    return hmac.new(
        settings.secret_key.encode("utf-8"),
        settings.admin_secret.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def admin_token_is_current(payload: dict) -> bool:
    """Whether an admin JWT was minted under the currently configured ADMIN_SECRET."""
    if payload.get("type") != "admin" or payload.get("scope") != "admin" or not settings.admin_secret:
        return False
    fingerprint = payload.get("admin_key")
    return isinstance(fingerprint, str) and hmac.compare_digest(fingerprint, _admin_secret_fingerprint())


def create_admin_token() -> str:
    """Mint a deployment-admin session token. Carries no user identity — admin authority
    is the shared ADMIN_SECRET, not the incident role (see deps.get_current_admin)."""
    return _encode(
        {"scope": "admin", "admin_key": _admin_secret_fingerprint()},
        token_type="admin",  # noqa: S106
        expires=timedelta(minutes=settings.admin_session_expire_minutes),
    )


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError as e:
        raise JWTError(f"Token validation failed: {e}") from e
