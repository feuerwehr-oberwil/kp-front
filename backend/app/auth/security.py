"""PIN hashing (peppered bcrypt) and JWT token plumbing.

PIN safety model (PLAN §5): ``bcrypt( HMAC-SHA256(pin, SECRET_KEY) )``. The HMAC
pepper means a DB leak alone cannot brute-force the 1M PIN space without the app
secret. The HMAC hex digest (64 chars) stays under bcrypt's 72-byte limit.
"""

import hashlib
import hmac
import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
from jose import JWTError, jwt

from ..config import settings


def _pepper(pin: str) -> bytes:
    """HMAC-SHA256(pin, SECRET_KEY) → 64-char hex digest (bytes)."""
    return hmac.new(
        settings.secret_key.encode("utf-8"),
        pin.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest().encode("utf-8")


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


def create_access_token(data: dict) -> str:
    return _encode(data, token_type="access", expires=timedelta(minutes=settings.access_token_expire_minutes))


def create_refresh_token(data: dict) -> str:
    return _encode(data, token_type="refresh", expires=timedelta(days=settings.refresh_token_expire_days))


def create_admin_token() -> str:
    """Mint a deployment-admin session token. Carries no user identity — admin authority
    is the shared ADMIN_SECRET, not the incident role (see deps.get_current_admin)."""
    return _encode(
        {"scope": "admin"},
        token_type="admin",
        expires=timedelta(minutes=settings.admin_session_expire_minutes),
    )


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError as e:
        raise JWTError(f"Token validation failed: {e}") from e
