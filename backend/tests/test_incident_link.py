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

from app import storage
from app.auth.cookies import ACCESS_COOKIE
from app.auth.incident_link import LINK_ALLOWED, LINK_COOKIE, LINK_TOKEN_TYPE
from app.models import DeploymentConfig, Incident, Media

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


# --- the exchange opens a still-pooled alarm ---------------------------------------------
# The bug this closes, verified in production 2026-08-02: an alarm landed in the pool and the
# incident only came into being when an editor took it on a tablet. Until then every responder
# holding the link — the people furthest from the Magazin, who need it most — got «Einsatz
# nicht (mehr) verfügbar». The exchange now opens the alarm it names.

DIVERA_REF = 4711


@pytest.fixture
async def pooled_alarm(db_session):
    """A Divera alarm sitting in the pool, with no incident of its own yet."""
    from app.models import DiveraEmergency

    em = DiveraEmergency(divera_id=DIVERA_REF, title="Brand Dachstock", address="Teststrasse 2")
    db_session.add(em)
    await db_session.commit()
    await db_session.refresh(em)
    return em


def _mint_divera(**overrides) -> str:
    return _mint(src="divera", ref=DIVERA_REF, **overrides)


async def _incidents(db) -> list[Incident]:
    return list((await db.execute(select(Incident))).scalars())


async def test_exchange_opens_a_pooled_alarm(client, link_key, pooled_alarm, db_session):
    """One tap, one incident — carrying the alarm's own data, and marked auto-opened."""
    r = await client.post("/api/incident-link/session", json={"token": _mint_divera()})
    assert r.status_code == 200, r.text

    rows = await _incidents(db_session)
    assert len(rows) == 1
    inc = rows[0]
    assert r.json() == {"incident_id": str(inc.id)}
    assert (inc.source, inc.source_ref) == ("divera", str(DIVERA_REF))
    assert inc.title == "Brand Dachstock"
    assert inc.auto_opened is True
    # …and the pool row knows where the alarm went, so milestones follow it
    await db_session.refresh(pooled_alarm)
    assert pooled_alarm.is_taken is True
    assert pooled_alarm.taken_incident_id == inc.id
    _forget_link(client)


async def test_a_second_exchange_does_not_open_a_second_incident(client, link_key, pooled_alarm, db_session):
    """Twenty responders tap the same link. The alerting system sends one alarm, so the
    station gets one Einsatz — every tap after the first resolves to it."""
    first = await _open_link(client, _mint_divera())
    for _ in range(3):
        assert await _open_link(client, _mint_divera()) == first

    rows = await _incidents(db_session)
    assert len(rows) == 1 and str(rows[0].id) == first
    _forget_link(client)


async def test_the_opened_incident_stays_unconfirmed(client, link_key, pooled_alarm, db_session):
    """A link opening an Einsatz must not make it a counted one. The responder is a viewer,
    the latch is editor-only, and the stats export drops what the latch never stamped —
    otherwise a link tapped for a turnout that never happened lands in the canton's figures."""
    await _open_link(client, _mint_divera())
    assert (await client.get(f"/api/incidents/{(await _incidents(db_session))[0].id}")).status_code == 200

    inc = (await _incidents(db_session))[0]
    await db_session.refresh(inc)
    assert inc.editor_opened_at is None
    _forget_link(client)


async def test_an_attached_alarm_resolves_to_the_einsatz_that_absorbed_it(client, link_key, db_session, incident):
    """Split dispatch: the EL attached the Nachalarm to the running Einsatz, so the Nachalarm's
    own (src, ref) names no incident at all — only the pool row knows where it went. Sending
    that responder to a dead end is the same bug wearing a different hat."""
    from app.models import DiveraEmergency

    em = DiveraEmergency(divera_id=DIVERA_REF, title="Nachalarm", is_taken=True, taken_incident_id=incident.id)
    db_session.add(em)
    await db_session.commit()

    r = await client.post("/api/incident-link/session", json={"token": _mint_divera()})
    assert r.status_code == 200, r.text
    assert r.json() == {"incident_id": str(incident.id)}
    assert len(await _incidents(db_session)) == 1  # nothing new was created
    _forget_link(client)


async def test_an_archived_pool_alarm_is_not_opened(client, link_key, db_session):
    """An alarm the station threw out of the pool is not a live dispatch — the same 404 as
    anything else the app doesn't know, so a link still can't probe."""
    from app.models import DiveraEmergency

    db_session.add(DiveraEmergency(divera_id=DIVERA_REF, title="Fehlalarm", is_archived=True))
    await db_session.commit()

    r = await client.post("/api/incident-link/session", json={"token": _mint_divera()})
    assert r.status_code == 404
    assert r.json()["detail"] == NOT_AVAILABLE_DETAIL
    assert await _incidents(db_session) == []


async def test_an_unknown_alarm_still_answers_the_one_404(client, link_key, db_session):
    """No incident, no pool row: indistinguishable from archived and from closed."""
    r = await client.post("/api/incident-link/session", json={"token": _mint(src="divera", ref=999999)})
    assert r.status_code == 404
    assert r.json()["detail"] == NOT_AVAILABLE_DETAIL
    assert await _incidents(db_session) == []


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
    """Route templates exactly as ``_effective_path`` builds them at request time.

    NOT the OpenAPI paths, which is what this helper used to return. OpenAPI renders a
    converter away — ``/file/{key:path}`` is published as ``/file/{key}`` — so an allowlist
    entry written in the OpenAPI form matched the schema while matching no route at runtime.
    That is exactly how ``("GET", "/api/branding/file/{key}")`` sat on the list looking
    enforced while link sessions were refused the logo, and the integrity test below could
    not see it: it was comparing the list against the same converter-stripped rendering that
    produced the mistake.

    Every API router is mounted with ``prefix=settings.api_prefix``; only ``/health`` and
    ``/ready`` sit at the root. FastAPI 0.137 leaves an ``_IncludedRouter`` in ``app.routes``
    rather than flattening, so the templates come from its ``original_router``.
    """
    from fastapi.routing import APIRoute

    from app.config import settings
    from app.main import app

    pairs: set[tuple[str, str]] = set()

    def add(route: object, base: str) -> None:
        if not isinstance(route, APIRoute) or not route.include_in_schema:
            return
        for method in (route.methods or set()) - {"HEAD", "OPTIONS"}:
            pairs.add((method.upper(), f"{base}{route.path}"))

    for r in app.routes:
        inner = getattr(r, "original_router", None)
        if inner is not None:
            for sub in inner.routes:
                add(sub, settings.api_prefix)
        else:
            add(r, "")
    return pairs


async def test_allowlist_entries_all_name_a_real_route():
    """Integrity of the list itself: a typo'd or renamed entry enforces nothing and reads like
    it does. The SPA fallback is allowlisted but `include_in_schema=False`, so it is exempt.

    Compared against the *route templates*, converters included — see `_openapi_pairs`.
    """
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


# --- the one write, and the read it does NOT come with -----------------------------------


async def test_link_may_report_its_own_position(client, link_key, incident, db_session):
    """The single write on the allowlist: a responder who opted in on their own phone tells
    the command post where they are (see «THE ONE WRITE» in auth/incident_link.py)."""
    from app.models import Personnel

    person = Personnel(display_name="Meier Hans", is_active=True)
    db_session.add(person)
    await db_session.commit()
    await db_session.refresh(person)

    await _open_link(client)
    body = {
        "person_id": str(person.id),
        "display_name": "Meier Hans",
        "device_id": "dev-aaaaaaaaaaaa",
        "lat": 47.5163,
        "lng": 7.5617,
        "ts": datetime.now(UTC).isoformat(),
    }
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=body)
    assert r.status_code == 204, r.text

    r = await client.request("DELETE", f"/api/incidents/{incident.id}/positions/{person.id}?device=dev-aaaaaaaaaaaa")
    assert r.status_code == 204, r.text


async def test_link_cannot_read_anybody_positions(client, link_key, incident):
    """The asymmetry IS the privacy model: whoever tapped the alarm link may send their own
    position and may read nobody's. That picture belongs to the command post.

    (The systemic walk above already refuses this route as a not-on-the-list one; this test
    exists so the reason is written down next to the behaviour, and so deliberately adding
    the GET to `LINK_ALLOWED` fails loudly rather than quietly widening the feature.)
    """
    await _open_link(client)
    r = await client.get(f"/api/incidents/{incident.id}/positions")
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == DENIED_DETAIL


async def test_closing_the_einsatz_stops_a_link_reporting(client, link_key, incident, db_session):
    """Sharing was promised to last exactly as long as the Einsatz."""
    await _open_link(client)
    incident.status = "geschlossen"
    incident.closed_at = datetime.now(UTC)
    await db_session.commit()

    r = await client.post(
        f"/api/incidents/{incident.id}/positions",
        json={
            "person_id": str(uuid.uuid4()),
            "display_name": "Meier Hans",
            "device_id": "dev-aaaaaaaaaaaa",
            "lat": 47.5,
            "lng": 7.5,
            "ts": datetime.now(UTC).isoformat(),
        },
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == DENIED_DETAIL


async def test_link_cannot_report_into_another_incident(client, link_key, incident, db_session):
    """The scope check covers the write too — a link to A must not put a dot on B's map."""
    other = _incident(title="Anderer Einsatz", source_ref="alarm-other-pos")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    await _open_link(client)
    r = await client.post(
        f"/api/incidents/{other.id}/positions",
        json={
            "person_id": str(uuid.uuid4()),
            "display_name": "Meier Hans",
            "device_id": "dev-aaaaaaaaaaaa",
            "lat": 47.5,
            "lng": 7.5,
            "ts": datetime.now(UTC).isoformat(),
        },
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == DENIED_DETAIL


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


async def test_a_link_works_on_a_browser_that_also_has_an_admin_session(client, admin_login, link_key, incident):
    """The operator's own browser. They unlock /admin to set the key up, then tap a link to
    see what a responder sees — on the same browser, so both cookies are present.

    Two things have to hold at once, and they pull in opposite directions. The link must
    still resolve an identity: an admin cookie authorises the admin surface but resolves to
    NO user, so treating it as a session leaves the link holder with nothing and every read
    401s. And the admin surface must stay reachable: gating it behind the link's allowlist
    would lock the operator out of /admin — including the key rotation that is their remedy
    if a link goes somewhere it shouldn't."""
    await admin_login(client)
    assert (await client.post("/api/incident-link/session", json={"token": _mint()})).status_code == 200

    # the link still reads, with the admin cookie sitting alongside it
    me = await client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["link_scoped"] is True
    assert (await client.get(f"/api/incidents/{incident.id}")).status_code == 200

    # …and /admin is not narrowed by the link cookie
    assert (await client.get("/api/incident-link/secret")).status_code == 200
    assert (await client.get("/api/personnel")).status_code == 200
    _forget_link(client)


async def test_a_garbage_admin_cookie_does_not_lift_the_allowlist(client, link_key, incident):
    """The admin bypass above is granted on a VALIDATED session, never on a cookie merely
    being present — otherwise any link holder appends `admin_session=x` and walks past the
    allowlist into the report and print routes."""
    await _open_link(client)
    client.cookies.set("admin_session", "not-a-real-token")

    denied = await client.post(f"/api/incidents/{incident.id}/report/pdf")
    assert denied.status_code == 403, denied.text
    assert denied.json()["detail"] == DENIED_DETAIL
    # and the real admin surface stays shut
    assert (await client.get("/api/incident-link/secret")).status_code in (401, 403)
    _forget_link(client)


async def test_a_dead_session_can_still_redeem_the_next_link(client, db_session, link_key, incident):
    """The trap this pins: the exchange is the recovery path, so it must not be gated on the
    liveness of the cookie it is about to replace.

    Real sequence, not a corner case — it is the SECOND alarm of the day. A responder opens
    the link for Einsatz A. A is closed, which correctly kills that session. The next alarm
    arrives and they tap its link on the same phone, still carrying A's now-dead cookie. If
    the guard checks that cookie before letting the exchange run, the tap is refused and the
    only way out is clearing browser cookies — which nobody does at 3am, and which would
    make the feature fail permanently on every phone that ever used it once."""
    assert (await client.post("/api/incident-link/session", json={"token": _mint()})).status_code == 200

    incident.status = "abgeschlossen"
    incident.closed_at = datetime.now(UTC)
    await db_session.commit()
    # the session is dead, as designed
    assert (await client.get(f"/api/incidents/{incident.id}")).status_code == 403

    nxt = _incident(title="Oelwehr Bahnhofstrasse 12", source_ref="alarm-the-next-one")
    db_session.add(nxt)
    await db_session.commit()
    await db_session.refresh(nxt)

    # …and the link to the NEW Einsatz still opens, on that same phone.
    r = await client.post("/api/incident-link/session", json={"token": _mint(ref="alarm-the-next-one")})
    assert r.status_code == 200, r.text
    assert r.json()["incident_id"] == str(nxt.id)
    assert (await client.get(f"/api/incidents/{nxt.id}")).status_code == 200
    _forget_link(client)


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


async def test_a_link_during_a_running_einsatz_joins_it_instead_of_forking(client, link_key, pooled_alarm, db_session):
    """The interaction between auto-open and the split-dispatch guard.

    A Nachalarm to a second group is parked in the pool on purpose: an Einsatz is already
    running and a second incident for it would split the Lage, the Zeiten and the GPS
    milestones in two. The guard covers the poller — but the link bypasses it, and the link
    is the likeliest way to trip it, because the re-dispatched group taps it within seconds
    while the EL is still working the first alarm.

    Joining the running Einsatz is not a lesser answer than opening one: a Nachalarm wants
    that Einsatz's Lage, not a fresh empty one. The pool row is deliberately left alone so
    the EL can still attach it properly afterwards.
    """
    running = Incident(title="Zimmerbrand", source="divera", source_ref="999000", status="offen")
    db_session.add(running)
    await db_session.commit()
    await db_session.refresh(running)

    before = len(await _incidents(db_session))
    r = await client.post("/api/incident-link/session", json={"token": _mint_divera()})
    assert r.status_code == 200, r.text
    assert r.json()["incident_id"] == str(running.id), "the link must land on the running Einsatz"

    assert len(await _incidents(db_session)) == before, "no second Einsatz may be created"
    await db_session.refresh(pooled_alarm)
    assert pooled_alarm.is_taken is False, "the pool row stays, so the EL can still attach it"


# --- scope on routes that cannot express it -----------------------------------------------
#
# `enforce_link_scope` binds an allowlisted route to the token's incident by matching an
# `incident_id` PATH PARAMETER. `/api/media/{media_id}` is on the allowlist and carries no
# such parameter, so for that route the scope check had nothing to bind to and every media
# row was readable from any link. Media ids are UUID4 so nothing was enumerable, but D57
# promises an *incident-scoped* token, and these pin that promise where the mechanism that
# normally keeps it cannot reach.


async def _media_on(db, incident_id, *, kind: str = "photo") -> Media:
    """A media row whose bytes really exist — otherwise `get_media` 404s on the missing file
    and a scope test would pass without ever exercising the scope check."""
    key = storage.new_key("media", ".bin")
    storage.put_bytes(key, b"not-a-real-photo")
    m = Media(incident_id=incident_id, kind=kind, storage_key=key, content_type="image/jpeg")
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return m


async def test_a_link_reads_media_from_its_own_incident(client, link_key, incident, db_session):
    mine = await _media_on(db_session, incident.id)
    await _open_link(client)
    r = await client.get(f"/api/media/{mine.id}")
    assert r.status_code == 200, f"a link must still see its own Einsatz's media: {r.text}"


async def test_a_link_cannot_read_media_from_another_incident(client, link_key, incident, db_session):
    """The regression. Before the fix this returned 200 with the other Einsatz's bytes."""
    other = Incident(title="Anderer Einsatz", source="manual", status="offen")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    theirs = await _media_on(db_session, other.id)

    await _open_link(client)
    r = await client.get(f"/api/media/{theirs.id}")
    assert r.status_code == 404, (
        "a link scoped to one Einsatz served another Einsatz's media — /api/media/{media_id} "
        "carries no incident_id for enforce_link_scope to bind to, so the handler must narrow "
        "it itself"
    )
    assert b"not-a-real-photo" not in r.content
