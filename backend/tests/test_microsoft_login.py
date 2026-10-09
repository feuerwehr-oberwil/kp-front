"""«Mit Microsoft anmelden» (app/auth/microsoft): off unless configured, and when on, an Entra
identity reaches ONLY the account the admin listed it against.

Microsoft itself is two seams — the token endpoint (`exchange_code`) and the JWKS lookup
(`signing_key`) — replaced here by a local RSA key, so the ID-token validation that matters
(signature, audience, issuer, nonce) runs for real.
"""

import time
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.auth import microsoft
from app.config import settings
from app.credentials import CredentialRefusedError, validate

TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT = "66666666-7777-8888-9999-000000000000"
OID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("ENTRA_LOGIN_TENANT_ID", TENANT)
    monkeypatch.setenv("ENTRA_LOGIN_CLIENT_ID", CLIENT)
    monkeypatch.setenv("ENTRA_LOGIN_CLIENT_SECRET", "s3cret")
    monkeypatch.setenv("ENTRA_LOGIN_ACCOUNTS", f"anna.muster@fw.example=cmd, {OID}=view")
    monkeypatch.setattr(microsoft, "signing_key", lambda _token: KEY.public_key())


def _id_token(nonce: str, **over) -> str:
    claims = {
        "iss": f"https://login.microsoftonline.com/{TENANT}/v2.0",
        "aud": CLIENT,
        "exp": int(time.time()) + 300,
        "nonce": nonce,
        "oid": "99999999-0000-0000-0000-000000000000",
        "preferred_username": "Anna.Muster@fw.example",
    }
    claims.update(over)
    return jwt.encode(claims, KEY, algorithm="RS256")


async def _start(client) -> tuple[str, dict]:
    r = await client.get("/api/auth/microsoft/start")
    assert r.status_code == 303
    tx = jwt.decode(
        client.cookies.get(microsoft.TX_COOKIE), settings.secret_key, algorithms=["HS256"], audience=microsoft._TX_AUD
    )
    return r.headers["location"], tx


async def _callback(client, monkeypatch, *, state: str | None = None, **claims):
    _, tx = await _start(client)

    async def fake_exchange(code, verifier, redirect_uri):
        assert (code, verifier, redirect_uri) == ("the-code", tx["verifier"], tx["redirect_uri"])
        return {"id_token": _id_token(claims.pop("nonce", tx["nonce"]), **claims)}

    monkeypatch.setattr(microsoft, "exchange_code", fake_exchange)
    return await client.get("/api/auth/microsoft/callback", params={"code": "the-code", "state": state or tx["state"]})


def test_parse_accounts():
    assert microsoft.parse_accounts(" A@B.ch = amuster ; x=y,") == {"a@b.ch": "amuster", "x": "y"}
    with pytest.raises(ValueError):
        microsoft.parse_accounts("a@b.ch")


def test_allow_list_is_validated_on_write():
    assert validate("entra_login_accounts", "a@b.ch=amuster") == "a@b.ch=amuster"
    for bad in ("amuster", "=amuster", ",,"):
        with pytest.raises(CredentialRefusedError):
            validate("entra_login_accounts", bad)


async def test_unconfigured_is_invisible(client):
    """An OSS install that never heard of Entra: no button, no route."""
    assert (await client.get("/api/config")).json()["integrations"]["microsoftLoginConfigured"] is False
    assert (await client.get("/api/auth/microsoft/start")).status_code == 404
    assert (await client.get("/api/auth/microsoft/callback", params={"code": "x", "state": "y"})).status_code == 404


@pytest.mark.parametrize("field", microsoft.FIELDS)
async def test_partly_configured_is_invisible(client, configured, monkeypatch, field):
    monkeypatch.setenv(field.upper(), "")
    assert (await client.get("/api/config")).json()["integrations"]["microsoftLoginConfigured"] is False
    assert (await client.get("/api/auth/microsoft/start")).status_code == 404
    assert (await client.get("/api/auth/microsoft/callback", params={"code": "x", "state": "y"})).status_code == 404


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("ENTRA_LOGIN_TENANT_ID", "Our brigade"),
        ("ENTRA_LOGIN_CLIENT_ID", "KP Front"),
        ("ENTRA_LOGIN_ACCOUNTS", "anna.muster@fw.example"),
        ("ENTRA_LOGIN_ACCOUNTS", ",;,"),
        ("ENTRA_LOGIN_ACCOUNTS", "anna.muster@fw.example=cmd, broken"),
    ],
)
async def test_invalid_environment_config_is_invisible(client, configured, monkeypatch, field, value):
    monkeypatch.setenv(field, value)
    assert (await client.get("/api/config")).json()["integrations"]["microsoftLoginConfigured"] is False
    assert (await client.get("/api/auth/microsoft/start")).status_code == 404
    assert (await client.get("/api/auth/microsoft/callback", params={"code": "x", "state": "y"})).status_code == 404


async def test_start_redirects_with_pkce(client, configured):
    assert (await client.get("/api/config")).json()["integrations"]["microsoftLoginConfigured"] is True
    location, tx = await _start(client)
    url = urlparse(location)
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.netloc == "login.microsoftonline.com" and url.path == f"/{TENANT}/oauth2/v2.0/authorize"
    assert q["client_id"] == CLIENT and q["code_challenge_method"] == "S256"
    assert q["state"] == tx["state"] and q["nonce"] == tx["nonce"]
    assert q["redirect_uri"] == "http://test/api/auth/microsoft/callback"
    assert "verifier" not in location and tx["verifier"] not in location


async def test_listed_upn_signs_into_its_account(client, configured, monkeypatch, editor):
    r = await _callback(client, monkeypatch)
    assert r.status_code == 303 and r.headers["location"] == "/"
    me = await client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["id"] == str(editor.id)


async def test_listed_oid_wins(client, configured, monkeypatch, editor, viewer):
    await _callback(client, monkeypatch, oid=OID)
    assert (await client.get("/api/auth/me")).json()["id"] == str(viewer.id)


@pytest.mark.parametrize(
    ("over", "reason"),
    [
        ({"preferred_username": "someone@else.example"}, "unknown"),
        ({"nonce": "replayed"}, "failed"),
        ({"aud": "another-app"}, "failed"),
        ({"iss": "https://login.microsoftonline.com/other-tenant/v2.0"}, "failed"),
        ({"state": "forged"}, "failed"),
    ],
)
async def test_refusals_never_sign_in(client, configured, monkeypatch, editor, over, reason):
    r = await _callback(client, monkeypatch, **over)
    assert r.headers["location"] == f"/?msLogin={reason}"
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_listed_but_inactive_account(client, configured, monkeypatch, editor, db_session):
    editor.is_active = False
    await db_session.commit()
    r = await _callback(client, monkeypatch)
    assert r.headers["location"] == "/?msLogin=inactive"


async def test_cancel_and_missing_transaction(client, configured):
    r = await client.get("/api/auth/microsoft/callback", params={"error": "access_denied"})
    assert r.headers["location"] == "/?msLogin=cancelled"
    r = await client.get("/api/auth/microsoft/callback", params={"code": "x", "state": "y"})
    assert r.headers["location"] == "/?msLogin=expired"
