"""Incident view links (/api/incident-link/*, auth/incident_link.py) — the containment test.

An alerting system mints a signed link, a responder taps it on a personal phone and gets a
logged-out, read-only session bound to exactly one Einsatz. What that session may reach is an
allowlist, not a blocklist, so this file's job is mostly to prove the *negative*.

Contract under test:
- fail-closed: no `incident_link_key` on the deployment row → the exchange answers 403;
- every rejected token (bad signature, expired, wrong `type`, missing `src`/`ref`) → 401 with
  one message; unknown / archived / closed incident → 404 with one message (no probing);
- the exchange returns the incident id and sets the `link_session` cookie, and `/api/auth/me`
  then reports a `viewer` that is `link_scoped` to that incident;
- containment: the explicitly-excluded routes (PDFs, printer, push, geocode, overpass, media
  side-effect GETs, diag) are refused, and — the test that has to survive the next three years
  of route additions — *every* route/method pair not in `LINK_ALLOWED` is refused;
- the allowlisted reads do work, but only for the token's own incident, and only while that
  incident is running: closing it revokes the session on the next request;
- a real login is never narrowed by a stale link cookie;
- the admin trio (`GET/POST/DELETE …/secret`) needs an ADMIN_SECRET session, and rotating the
  key kills every link already sent out.

Route enumeration goes through `app.openapi()`, not `app.routes`: since FastAPI 0.137
`include_router` keeps sub-routers behind `_IncludedRouter` wrappers, so `app.routes` yields
three `APIRoute`s and nothing else. The OpenAPI paths are the mounted templates and are
byte-identical to the `LINK_ALLOWED` entries. The SPA fallback is `include_in_schema=False`
and is handled explicitly wherever that matters.
"""

import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from jose import jwt
from sqlalchemy import select

from app.auth.cookies import ACCESS_COOKIE
from app.auth.incident_link import LINK_ALLOWED, LINK_COOKIE, LINK_TOKEN_TYPE
from app.models import DeploymentConfig, Incident

MINT_KEY = "link-mint-key-0123456789"  # gitleaks:allow
SRC, REF = "divera", "alarm-4711"

#: The SPA shell. On the allowlist, but never in the OpenAPI spec (include_in_schema=False).
SPA_FALLBACK = ("GET", "/{full_path:path}")

#: The two "one answer, no probing" strings. Pinned so a future edit that starts
#: distinguishing «kenne ich nicht» from «gibt es, aber nicht für dich» fails here.
INVALID_TOKEN_DETAIL = "Einsatz-Link ungültig oder abgelaufen"
NOT_AVAILABLE_DETAIL = "Einsatz nicht (mehr) verfügbar"
DENIED_DETAIL = "Für diesen Einsatz-Link nicht freigegeben"


# --- fixtures ---------------------------------------------------------------------------


async def _config_row(db) -> DeploymentConfig:
    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db.add(row)
    return row


@pytest.fixture
async def link_key(db_session):
    """The station's minting key, shared with the alerting system."""
    row = await _config_row(db_session)
    row.incident_link_key = MINT_KEY
    await db_session.commit()
    return MINT_KEY


def _incident(**kw) -> Incident:
    base = {"title": "Brand Hauptstrasse 4", "source": SRC, "source_ref": REF, "status": "offen"}
    return Incident(**{**base, **kw})


@pytest.fixture
async def incident(db_session):
    inc = _incident()
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    return inc


def _mint(key: str = MINT_KEY, *, ttl: timedelta = timedelta(hours=2), **overrides) -> str:
    """A token the way the alerting system mints it — offline, HS256, no call to us."""
    claims: dict = {
        "type": LINK_TOKEN_TYPE,
        "src": SRC,
        "ref": REF,
        "exp": datetime.now(UTC) + ttl,
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not ...}
    return jwt.encode(claims, key, algorithm="HS256")


async def _open_link(client, token: str | None = None) -> str:
    """Redeem a link token; returns the incident id and leaves the cookie in the jar."""
    r = await client.post("/api/incident-link/session", json={"token": token or _mint()})
    assert r.status_code == 200, r.text
    return r.json()["incident_id"]


def _forget_link(client) -> None:
    """Drop the link cookie — a link session cannot reach the admin surface, so tests that
    switch hats have to take the responder's phone out of their hand first."""
    client.cookies.delete(LINK_COOKIE)


# --- the exchange -----------------------------------------------------------------------


async def test_exchange_fails_closed_without_key(client, incident):
    """No minting key on the deployment row → the whole link surface is off."""
    r = await client.post("/api/incident-link/session", json={"token": _mint()})
    assert r.status_code == 403
    assert LINK_COOKIE not in r.cookies


@pytest.mark.parametrize(
    "token_kwargs, key",
    [
        pytest.param({}, "a-different-key-entirely", id="bad-signature"),
        pytest.param({"ttl": timedelta(minutes=-5)}, MINT_KEY, id="expired"),
        pytest.param({"type": "access"}, MINT_KEY, id="wrong-type-claim"),
        pytest.param({"src": ...}, MINT_KEY, id="missing-src"),
        pytest.param({"ref": ...}, MINT_KEY, id="missing-ref"),
        pytest.param({"src": ""}, MINT_KEY, id="empty-src"),
    ],
)
async def test_exchange_rejects_bad_tokens_identically(client, link_key, incident, token_kwargs, key):
    """Every rejected token is «this link doesn't work» — telling them apart helps a forger."""
    r = await client.post("/api/incident-link/session", json={"token": _mint(key, **token_kwargs)})
    assert r.status_code == 401, r.text
    assert r.json()["detail"] == INVALID_TOKEN_DETAIL
    assert LINK_COOKIE not in r.cookies


async def test_exchange_hides_unknown_archived_and_closed_alike(client, link_key, db_session):
    """Unknown, archived and closed must be indistinguishable — otherwise a link holder can
    enumerate the station's Einsätze by watching which refusal comes back."""
    archived = _incident(title="Archiviert", source_ref="alarm-arch", is_archived=True)
    closed_status = _incident(title="Geschlossen", source_ref="alarm-closed", status="geschlossen")
    closed_stamp = _incident(title="Abgeschlossen", source_ref="alarm-stamp", closed_at=datetime.now(UTC))
    db_session.add_all([archived, closed_status, closed_stamp])
    await db_session.commit()

    answers = []
    for ref in ("alarm-does-not-exist", "alarm-arch", "alarm-closed", "alarm-stamp"):
        r = await client.post("/api/incident-link/session", json={"token": _mint(ref=ref)})
        answers.append((r.status_code, r.json()["detail"]))
        assert LINK_COOKIE not in r.cookies

    assert answers == [(404, NOT_AVAILABLE_DETAIL)] * 4, answers


async def test_exchange_opens_a_session(client, link_key, incident):
    r = await client.post("/api/incident-link/session", json={"token": _mint()})
    assert r.status_code == 200, r.text
    assert r.json() == {"incident_id": str(incident.id)}
    assert r.cookies.get(LINK_COOKIE)


async def test_me_reports_a_link_scoped_viewer(client, link_key, incident):
    """The client needs to know it is link-scoped so it can hide what would 403."""
    await _open_link(client)
    r = await client.get("/api/auth/me")
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["role"] == "viewer"
    assert me["link_scoped"] is True
    assert me["link_incident_id"] == str(incident.id)


# --- containment ------------------------------------------------------------------------


async def test_explicitly_excluded_routes_are_refused(client, link_key, incident):
    """The named exclusions from auth/incident_link.py: documents carrying names, the station
    printer, another person's print job, push rows, billable outbound calls, and the GETs that
    are really writes. 403 specifically — «not 200» would pass on an unrelated breakage."""
    await _open_link(client)
    inc, media, job = incident.id, uuid.uuid4(), uuid.uuid4()
    excluded = [
        ("POST", f"/api/incidents/{inc}/report/pdf"),
        ("POST", f"/api/incidents/{inc}/zeitplan/pdf"),
        ("POST", f"/api/incidents/{inc}/report/print"),
        ("POST", f"/api/incidents/{inc}/zeitplan/print"),
        ("DELETE", f"/api/print-jobs/{job}"),
        ("POST", "/api/push/subscriptions"),
        ("GET", "/api/geocode/search?q=Hauptstrasse"),
        ("POST", "/api/overpass/buildings"),
        ("GET", f"/api/media/{media}/peaks"),
        ("GET", f"/api/media/{media}/transcription"),
        ("POST", "/api/diag/report"),
    ]
    for method, url in excluded:
        r = await client.request(method, url)
        assert r.status_code == 403, f"{method} {url} answered {r.status_code}: {r.text[:200]}"
        assert r.json()["detail"] == DENIED_DETAIL, f"{method} {url}"


def _openapi_pairs() -> set[tuple[str, str]]:
    from app.main import app

    spec = app.openapi()
    return {(method.upper(), path) for path, ops in spec["paths"].items() for method in ops}


async def test_allowlist_entries_all_name_a_real_route():
    """Integrity of the list itself: a typo'd or renamed entry enforces nothing and reads like
    it does. The SPA fallback is allowlisted but `include_in_schema=False`, so it is exempt."""
    stale = LINK_ALLOWED - _openapi_pairs() - {SPA_FALLBACK}
    assert stale == set(), f"LINK_ALLOWED entries matching no mounted route: {sorted(stale)}"


#: Values for every path param in the mounted routes. `incident_id` is deliberately the link's
#: OWN incident, so a refusal can only come from the allowlist — never from the scope check.
_PARAM_VALUES = {
    "dataset_id": "hydranten",
    "divera_id": "12345",
    "index": "0",
    "job_id": "00000000-0000-0000-0000-00000000000b",
    "key": "logo.png",
    "media_id": "00000000-0000-0000-0000-00000000000a",
    "module": "grundriss",
    "object_id": "obj-1",
    "person_id": "1",
    "slot": "logo",
    "user_id": "00000000-0000-0000-0000-000000000001",
}


async def test_every_route_not_on_the_allowlist_is_refused(client, link_key, incident):
    """The systemic one. Walk every mounted route/method pair, and assert a link session is
    refused everything `LINK_ALLOWED` doesn't name — so a route added next year is
    default-denied without anyone having to remember this file exists.
    """
    await _open_link(client)
    values = {**_PARAM_VALUES, "incident_id": str(incident.id)}

    exercised: list[tuple[str, str]] = []
    skipped: list[tuple[str, str]] = []
    offenders: list[str] = []

    for method, path in sorted(_openapi_pairs() - LINK_ALLOWED, key=lambda p: (p[1], p[0])):
        params = re.findall(r"{([^}:]+)[^}]*}", path)
        if any(p not in values for p in params):
            skipped.append((method, path))  # no plausible URL for this param — say so, loudly
            continue
        url = re.sub(r"{([^}:]+)[^}]*}", lambda m: values[m.group(1)], path)
        r = await client.request(method, url)
        exercised.append((method, path))
        if r.status_code != 403 or r.json().get("detail") != DENIED_DETAIL:
            offenders.append(f"{method} {path} → {r.status_code} {r.text[:120]}")

    assert not offenders, "reachable with a link session:\n" + "\n".join(offenders)
    # A systemic test that silently exercises nothing is worse than no test at all.
    assert len(exercised) >= 90, f"only {len(exercised)} routes exercised; skipped {sorted(skipped)}"
    assert not skipped, f"could not synthesise a URL for {sorted(skipped)} — add them to _PARAM_VALUES"


async def test_allowlisted_reads_work(client, link_key, incident):
    """The other half of the contract: the link has to be worth tapping. These are the reads
    the Lage map is unusable without."""
    inc = incident.id
    await _open_link(client)
    for url in [
        f"/api/incidents/{inc}",
        f"/api/incidents/{inc}/workspace",
        f"/api/incidents/{inc}/journal",
        "/api/reference",
        "/api/personnel",
        "/api/objects",
    ]:
        r = await client.get(url)
        assert r.status_code == 200, f"GET {url} answered {r.status_code}: {r.text[:200]}"


async def test_link_cannot_read_another_incident(client, link_key, incident, db_session):
    """Being on the allowlist is not enough — a link to A must not read B."""
    other = _incident(title="Anderer Einsatz", source_ref="alarm-other")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    await _open_link(client)
    for url in (f"/api/incidents/{other.id}", f"/api/incidents/{other.id}/journal"):
        r = await client.get(url)
        assert r.status_code == 403, f"GET {url} answered {r.status_code}: {r.text[:200]}"
        assert r.json()["detail"] == DENIED_DETAIL


async def test_closing_the_incident_revokes_a_live_link(client, link_key, incident, db_session):
    """«The link works until the Einsatz is closed» — checked per request, not once at
    exchange, or closing an Einsatz would do nothing for the rest of the cookie's 12 hours."""
    await _open_link(client)
    r = await client.get(f"/api/incidents/{incident.id}/journal")
    assert r.status_code == 200, r.text  # precondition: the same session worked a moment ago

    incident.status = "geschlossen"
    incident.closed_at = datetime.now(UTC)
    await db_session.commit()

    r = await client.get(f"/api/incidents/{incident.id}/journal")
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == DENIED_DETAIL


async def test_a_real_login_is_not_narrowed_by_a_stale_link_cookie(client, link_key, incident, editor):
    """A responder who tapped the link and then logged in on the same phone is a real user.
    The link cookie must not clamp what their account can do."""
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200, r.text
    await _open_link(client)  # both cookies in the jar now
    assert client.cookies.get(ACCESS_COOKIE) and client.cookies.get(LINK_COOKIE)

    # A non-allowlisted route: reachable for the editor, 403 for a bare link session.
    r = await client.post(f"/api/incidents/{incident.id}/report/pdf")
    assert r.status_code != 403, r.text[:200]


# --- admin: the minting key -------------------------------------------------------------


async def test_admin_endpoints_require_admin(client, link_key):
    assert (await client.get("/api/incident-link/secret")).status_code in (401, 403)
    assert (await client.post("/api/incident-link/secret/rotate")).status_code in (401, 403)
    assert (await client.delete("/api/incident-link/secret")).status_code in (401, 403)


async def test_admin_rotate_invalidates_links_already_sent_out(client, admin_login, link_key, incident):
    """Rotating is the revocation mechanism: every URL the alerting system already put into an
    alarm stops working the moment the new key is minted."""
    old_token = _mint()
    assert (await client.post("/api/incident-link/session", json={"token": old_token})).status_code == 200
    _forget_link(client)

    await admin_login(client)
    r = await client.get("/api/incident-link/secret")
    assert r.status_code == 200 and r.json() == {"configured": True, "token": MINT_KEY}

    r = await client.post("/api/incident-link/secret/rotate")
    assert r.status_code == 200, r.text
    new_key = r.json()["token"]
    assert r.json()["configured"] is True
    assert new_key and new_key != MINT_KEY

    r = await client.post("/api/incident-link/session", json={"token": old_token})
    assert r.status_code == 401, r.text
    assert r.json()["detail"] == INVALID_TOKEN_DETAIL

    assert (await client.post("/api/incident-link/session", json={"token": _mint(new_key)})).status_code == 200
    _forget_link(client)

    r = await client.delete("/api/incident-link/secret")
    assert r.status_code == 200 and r.json() == {"configured": False}
    r = await client.post("/api/incident-link/session", json={"token": _mint(new_key)})
    assert r.status_code == 403  # fail-closed again


async def test_rotating_ends_sessions_that_are_already_open(client, db_session, link_key, incident):
    """Rotation has to reach the phone that already tapped the link, not just the ones that
    haven't. The session cookie is signed with the app's own secret, so nothing about
    re-keying would otherwise invalidate it — it would outlive the rotation by up to the
    session TTL. That would make rotation useless as the emergency lever, which is the one
    job it has: a link has gone somewhere it shouldn't and the operator wants it dead now."""
    assert (await client.post("/api/incident-link/session", json={"token": _mint()})).status_code == 200
    reads_before = await client.get(f"/api/incidents/{incident.id}")
    assert reads_before.status_code == 200, reads_before.text

    # Rotate at the store rather than through the admin endpoint (covered separately): this
    # test is about the guard, and a client holding an admin cookie alongside its link one
    # would have the link session stood aside for a different reason.
    row = await _config_row(db_session)
    row.incident_link_key = "rotated-to-something-else"
    await db_session.commit()

    after = await client.get(f"/api/incidents/{incident.id}")
    assert after.status_code == 403, after.text
    assert after.json()["detail"] == DENIED_DETAIL
    _forget_link(client)


async def test_deleting_the_key_ends_sessions_that_are_already_open(client, db_session, link_key, incident):
    """Deleting the key is how a station switches the feature off; an open session must not
    survive the switch."""
    assert (await client.post("/api/incident-link/session", json={"token": _mint()})).status_code == 200
    assert (await client.get(f"/api/incidents/{incident.id}")).status_code == 200

    row = await _config_row(db_session)
    row.incident_link_key = None
    await db_session.commit()

    after = await client.get(f"/api/incidents/{incident.id}")
    assert after.status_code == 403, after.text
    _forget_link(client)
