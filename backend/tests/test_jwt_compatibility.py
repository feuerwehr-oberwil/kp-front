"""JWT-library migration contract: deployed HS256 cookies survive the swap to PyJWT."""

import jwt
import pytest
from jwt import InvalidTokenError

from app.auth.security import decode_token
from app.config import settings

# Minted by python-jose 3.5.0 with the claims and key below. Access/refresh/admin/link
# cookies all use this same compact HS256 representation, so one fixed legacy token pins
# the wire format without retaining python-jose as a test dependency.
_LEGACY_KEY = "legacy-test-key-that-is-deliberately-at-least-thirty-two-bytes"
_LEGACY_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTEyMzQtMTIzNC0xMjM0NTY3ODlhYmMiLCJ1c2VybmFtZSI6ImZ1Iiwicm9sZSI6"
    "ImVkaXRvciIsInR5cGUiOiJhY2Nlc3MiLCJqdGkiOiJsZWdhY3ktanRpIiwiaWF0IjoxNzA0MDY3MjAwLCJleHAiOjI1MjQ2"
    "MDgwMDB9.QAQTgprB07KiIMUugmF-krUFgt73-klG47Lxr5V8aqo"
)


def test_pyjwt_decodes_cookie_minted_by_python_jose(monkeypatch):
    monkeypatch.setattr(settings, "secret_key", _LEGACY_KEY)

    claims = decode_token(_LEGACY_TOKEN)

    assert claims == {
        "sub": "12345678-1234-1234-1234-123456789abc",
        "username": "fu",
        "role": "editor",
        "type": "access",
        "jti": "legacy-jti",
        "iat": 1704067200,
        "exp": 2524608000,
    }


def test_decoder_keeps_algorithm_allowlist(monkeypatch):
    """A valid signature under another algorithm must not broaden the HS256 contract."""
    monkeypatch.setattr(settings, "secret_key", _LEGACY_KEY)
    token = jwt.encode({"sub": "someone", "exp": 2524608000}, _LEGACY_KEY, algorithm="HS384")

    with pytest.raises(InvalidTokenError, match="Token validation failed"):
        decode_token(token)
