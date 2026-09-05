"""What a RAPPORT VIEW link (`vk`) may read (SEC-02).

The three incident-link kinds share one door and one allowlist. That was right while they
shared a lifecycle too, and stopped being right when the view link was added: it is handed to
somebody OUTSIDE the station — a Gemeinde, a Nachbarwehr, an insurer — it can be forwarded, and
it deliberately outlives the Einsatz. Giving that holder the alarm link's list gave them the
station's object register, the roster including people who have left, every Objektplan PDF, and
the live position of every vehicle, none of which is in the Rapport they were sent.

Contract under test:
- a view session reads its own incident's record — Einsatz, workspace, Verlauf, replay, audit
  chain, the objects surfaced FOR it, its media — and the station material that record points
  at (branding, config, plan scales, checklist/geo reference data, the active roster);
- and reaches nothing that lets it enumerate the station: the object register, an Objektplan of
  an object this Einsatz never surfaced, personnel who are no longer active, live vehicle
  positions/trails, the weather proxy, the admin door;
- it writes nothing at all — not even the one position write the alarm link has;
- the alarm and Atemschutz links are untouched by the split;
- revocation still ends an open view session on its next request.

Plus the ambient-admin hardening: a page that says `X-Incident-Link: use` has asked for the
restricted identity, and an admin cookie sitting in the same browser must not silently hand it
the whole API back.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app import storage
from app.auth.cookies import ACCESS_COOKIE
from app.auth.incident_link import LINK_ALLOWED, LINK_COOKIE, VIEW_LINK_ALLOWED
from app.models import DeploymentConfig, Incident, Media, ObjectSite, Personnel, ReferenceDataset

DENIED_DETAIL = "Für diesen Einsatz-Link nicht freigegeben"

BARE_SITE = {"X-Incident-Link": "off"}
LINK_PAGE = {"X-Incident-Link": "use"}

MINT_KEY = "link-mint-key-0123456789-at-least-32-bytes"  # gitleaks:allow

#: The incident's own address — an object carrying it is «surfaced» for this Einsatz
#: (api/objects · objects_near_incident matches on address before distance).
ADDRESS = "Hauptstrasse 4"


# --- fixtures -----------------------------------------------------------------------------


#: How the alerting system names this Einsatz — the alarm link's token resolves through them.
SRC, REF = "divera", "alarm-4711"


@pytest.fixture
async def incident(db_session):
    inc = Incident(title="Brand Hauptstrasse 4", source=SRC, source_ref=REF, status="offen", address=ADDRESS)
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)
    return inc


@pytest.fixture
async def link_key(db_session):
    """The station's ALARM minting key — only needed by the tests that prove the alarm link is
    unaffected by the split."""
    row = (await db_session.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    if row is None:
        row = DeploymentConfig(id=1, config_json=None)
        db_session.add(row)
    row.incident_link_key = MINT_KEY
    await db_session.commit()
    return MINT_KEY


async def _login_editor(client, editor) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(editor.id), "pin": "135790"})
    assert r.status_code == 200, r.text


async def _open_view_link(client, editor, incident) -> None:
    """Mint the Rapport's view link as an editor, then become the outsider holding the URL."""
    await _login_editor(client, editor)
    r = await client.post(f"/api/incidents/{incident.id}/view-link")
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    client.cookies.delete(ACCESS_COOKIE)
    r = await client.post("/api/incident-link/session", json={"token": token})
    assert r.status_code == 200, r.text


async def _open_alarm_link(client) -> None:
    from datetime import timedelta as _td

    import jwt

    from app.auth.incident_link import LINK_TOKEN_TYPE

    token = jwt.encode(
        {"type": LINK_TOKEN_TYPE, "src": SRC, "ref": REF, "exp": datetime.now(UTC) + _td(hours=2)},
        MINT_KEY,
        algorithm="HS256",
    )
    r = await client.post("/api/incident-link/session", json={"token": token})
    assert r.status_code == 200, r.text


DEVICE = "dev-aaaaaaaaaaaa"


def _position_body(person) -> dict:
    return {
        "person_id": str(person.id),
        "display_name": person.display_name,
        "device_id": DEVICE,
        "lat": 47.5,
        "lng": 7.5,
        "ts": datetime.now(UTC).isoformat(),
    }


async def _object_with_plan(db, *, name: str, address: str | None, dataset_id: str) -> tuple[ObjectSite, str]:
    obj = ObjectSite(name=name, address=address)
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    key = storage.new_key("reference", ".pdf")
    storage.put_bytes(key, b"%PDF-1.4 not-a-real-plan")
    db.add(ReferenceDataset(id=dataset_id, object_id=obj.id, module="modul1", kind="pdf", storage_key=key))
    await db.commit()
    return obj, dataset_id


async def _unbound_dataset(db, *, dataset_id: str, kind: str, ext: str, content_type: str | None = None) -> str:
    """A reference dataset with NO object behind it. ``kind`` decides whether it is genuine
    station furniture (geojson/symbols/checklists) or a document that only looks unbound (pdf)."""
    key = storage.new_key("reference", ext)
    storage.put_bytes(
        key, b"%PDF-1.4 not-a-real-plan" if kind == "pdf" else b'{"type":"FeatureCollection","features":[]}'
    )
    db.add(ReferenceDataset(id=dataset_id, object_id=None, kind=kind, storage_key=key, content_type=content_type))
    await db.commit()
    return dataset_id


# --- the list itself ----------------------------------------------------------------------


def test_the_view_list_is_a_narrowing_of_the_alarm_list():
    """The two lists are not independent inventories: a route the alarm link may not reach must
    not become reachable by handing somebody the Rapport instead."""
    assert VIEW_LINK_ALLOWED <= LINK_ALLOWED, sorted(VIEW_LINK_ALLOWED - LINK_ALLOWED)
    assert VIEW_LINK_ALLOWED != LINK_ALLOWED


# --- SEC-02: what a forwarded Rapport link must NOT reach ---------------------------------


async def test_view_link_cannot_enumerate_the_station_objects(client, editor, incident):
    """The reported finding, verbatim: a view session for one closed Einsatz listed every
    Einsatzobjekt the station has."""
    await _open_view_link(client, editor, incident)
    r = await client.get("/api/objects")
    assert r.status_code == 403, f"the station's object register answered a report link: {r.text[:200]}"
    assert r.json()["detail"] == DENIED_DETAIL


async def test_view_link_cannot_read_personnel_who_are_no_longer_active(client, editor, incident, db_session):
    """`?include_inactive=true` is how the roster route hands out people who have left the
    corps. That is administration, not a Rapport."""
    gone = Personnel(display_name="Weg Werner", is_active=False)
    db_session.add(gone)
    await db_session.commit()

    await _open_view_link(client, editor, incident)
    r = await client.get("/api/personnel?include_inactive=true")
    assert r.status_code == 403, f"a report link read inactive personnel: {r.text[:300]}"
    assert r.json()["detail"] == DENIED_DETAIL


async def test_view_link_cannot_read_an_unrelated_objects_plan(client, editor, incident, db_session):
    """An Objektplan is the inside of somebody's building. A Rapport link may see the plans of
    the object its own Einsatz was at, and no others."""
    _, foreign = await _object_with_plan(
        db_session, name="Alterszentrum", address="Weit weg 99", dataset_id="plan:foreign:modul1"
    )
    await _open_view_link(client, editor, incident)

    r = await client.get(f"/api/reference/{foreign}")
    assert r.status_code == 403, f"a report link read an unrelated object's plan: {r.text[:200]}"
    assert r.json()["detail"] == DENIED_DETAIL

    r = await client.get("/api/objects/00000000-0000-0000-0000-0000000000ff")
    assert r.status_code == 403, r.text


async def test_view_link_cannot_read_an_unbound_reference_pdf(client, editor, incident, db_session):
    """SEC-02 round-2: the reference branch authorised EVERY dataset whose ``object_id`` is None,
    so a station-object PDF that simply carried no object link leaked whole to a forwarded Rapport
    link. Only genuine map/report furniture (geojson/symbols/checklists) may pass without an
    object; a PDF must clear the surfaced-object bar it cannot meet here. Tested raw AND
    percent-encoded, because the dataset id decode must not open a second door."""
    ds = await _unbound_dataset(
        db_session, dataset_id="plan:unbound:modul1", kind="pdf", ext=".pdf", content_type="application/pdf"
    )
    await _open_view_link(client, editor, incident)

    r = await client.get(f"/api/reference/{ds}")
    assert r.status_code == 403, f"an unbound reference PDF leaked to a report link: {r.text[:200]}"
    assert r.json()["detail"] == DENIED_DETAIL

    r = await client.get("/api/reference/plan%3Aunbound%3Amodul1")
    assert r.status_code == 403, f"a percent-encoded unbound PDF leaked to a report link: {r.text[:200]}"
    assert r.json()["detail"] == DENIED_DETAIL


async def test_view_link_still_reads_unbound_station_furniture(client, editor, incident, db_session):
    """The legitimate ``object_id``-None datasets a Rapport viewer needs: the hydrant/GeoJSON
    layers, the bundled symbol pack, the Checklisten templates. The SEC-02 narrowing must keep
    these reachable — refusing them would replace one defect with a link not worth tapping."""
    for dataset_id, kind, ext in [
        ("geo:hydranten", "geojson", ".geojson"),
        ("symbols:tactical", "symbols", ".json"),
        ("checklists:fu-aktion", "checklists", ".json"),
    ]:
        await _unbound_dataset(db_session, dataset_id=dataset_id, kind=kind, ext=ext)

    await _open_view_link(client, editor, incident)
    for dataset_id in ("geo:hydranten", "symbols:tactical", "checklists:fu-aktion"):
        r = await client.get(f"/api/reference/{dataset_id}")
        assert r.status_code == 200, f"station furniture {dataset_id} was refused a report link: {r.text[:200]}"


async def test_view_link_cannot_see_where_the_vehicles_are(client, editor, incident):
    """Live fleet telemetry is neither in the Rapport nor about the Einsatz being shown — and it
    is an outbound call somebody outside the station would be triggering."""
    await _open_view_link(client, editor, incident)
    for url in ("/api/traccar/positions", "/api/traccar/trails", "/api/traccar/status", "/api/weather"):
        r = await client.get(url)
        assert r.status_code == 403, f"GET {url} answered {r.status_code} for a report link"
        assert r.json()["detail"] == DENIED_DETAIL


async def test_view_link_writes_nothing_at_all(client, editor, incident, db_session):
    """The alarm link's one write — a responder's own live position — has no counterpart here:
    whoever is reading a finished Rapport is not on the Einsatz."""
    person = Personnel(display_name="Meier Hans", is_active=True)
    db_session.add(person)
    await db_session.commit()
    await db_session.refresh(person)

    await _open_view_link(client, editor, incident)
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_position_body(person))
    assert r.status_code == 403, r.text
    r = await client.request("DELETE", f"/api/incidents/{incident.id}/positions/{person.id}?device={DEVICE}")
    assert r.status_code == 403, r.text


async def test_view_link_cannot_knock_on_the_admin_door(client, editor, incident):
    await _open_view_link(client, editor, incident)
    r = await client.post("/api/admin/login", json={"secret": "whatever"})
    assert r.status_code == 403
    assert r.json()["detail"] == DENIED_DETAIL


async def test_view_link_stays_scoped_to_its_own_incident(client, editor, incident, db_session):
    other = Incident(title="Anderer Einsatz", source="manual", status="offen")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    await _open_view_link(client, editor, incident)
    assert (await client.get(f"/api/incidents/{other.id}/workspace")).status_code == 403


# --- …and what it must keep --------------------------------------------------------------


async def test_the_rapport_view_still_works_end_to_end(client, editor, incident, db_session):
    """Every read the report viewer makes for ITS incident. A containment fix that leaves the
    link not worth tapping has replaced one defect with another."""
    key = storage.new_key("media", ".bin")
    storage.put_bytes(key, b"not-a-real-photo")
    media = Media(incident_id=incident.id, kind="photo", storage_key=key, content_type="image/jpeg")
    db_session.add(media)
    # station reference material the map and the Checklisten need: no object behind it, so it
    # is not somebody's building plan
    geo_key = storage.new_key("reference", ".geojson")
    storage.put_bytes(geo_key, b'{"type":"FeatureCollection","features":[]}')
    db_session.add(ReferenceDataset(id="geo:hydrant", kind="geojson", storage_key=geo_key))
    await db_session.commit()

    await _open_view_link(client, editor, incident)
    inc = incident.id
    for url in [
        "/api/config",
        "/api/plan-scales",
        "/api/auth/me",
        f"/api/incidents/{inc}",
        f"/api/incidents/{inc}/workspace",
        f"/api/incidents/{inc}/journal",
        f"/api/incidents/{inc}/events",
        f"/api/incidents/{inc}/snapshot?at={datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%S')}",
        f"/api/incidents/{inc}/samples",
        f"/api/incidents/{inc}/verify",
        f"/api/incidents/{inc}/objects",
        "/api/reference",
        "/api/reference/geo:hydrant",
        "/api/personnel",
        f"/api/media/{media.id}",
    ]:
        r = await client.get(url)
        assert r.status_code == 200, f"GET {url} answered {r.status_code}: {r.text[:200]}"


async def test_the_rapport_view_reads_its_own_einsatzobjekt_and_its_plans(client, editor, incident, db_session):
    """The object this Einsatz was at — matched by address, exactly as `/incidents/{id}/objects`
    surfaces it — and the module plan hanging off it."""
    obj, plan = await _object_with_plan(
        db_session, name="Schulhaus", address=ADDRESS, dataset_id="plan:schulhaus:modul1"
    )
    await _open_view_link(client, editor, incident)

    surfaced = await client.get(f"/api/incidents/{incident.id}/objects")
    assert surfaced.status_code == 200
    assert [o["id"] for o in surfaced.json()] == [str(obj.id)]

    assert (await client.get(f"/api/objects/{obj.id}")).status_code == 200
    r = await client.get(f"/api/reference/{plan}")
    assert r.status_code == 200, f"the Einsatz's own Objektplan was refused: {r.text[:200]}"


async def test_the_rapport_view_survives_the_einsatz_being_closed(client, editor, incident, db_session):
    """The whole reason this link exists — and the narrower list must not have changed it."""
    await _open_view_link(client, editor, incident)
    inc = await db_session.get(Incident, incident.id)
    inc.status = "geschlossen"
    inc.is_archived = True
    await db_session.commit()

    assert (await client.get(f"/api/incidents/{incident.id}/workspace")).status_code == 200
    assert (await client.get(f"/api/incidents/{incident.id}/journal")).status_code == 200


async def test_revoking_still_ends_an_open_view_session(client, editor, incident):
    """The one lever this link has, re-pinned on the narrower path."""
    await _open_view_link(client, editor, incident)
    assert (await client.get(f"/api/incidents/{incident.id}/workspace")).status_code == 200

    open_session = client.cookies[LINK_COOKIE]
    client.cookies.delete(LINK_COOKIE)
    await _login_editor(client, editor)
    assert (await client.delete(f"/api/incidents/{incident.id}/view-link")).status_code == 200
    client.cookies.delete(ACCESS_COOKIE)

    client.cookies.set(LINK_COOKIE, open_session)
    assert (await client.get(f"/api/incidents/{incident.id}/workspace")).status_code == 403


# --- the other two kinds are untouched ----------------------------------------------------


async def test_the_alarm_link_keeps_the_lage_map_it_was_built_for(client, link_key, incident, db_session):
    """A responder on the way to a RUNNING Einsatz still gets the station's objects, the roster
    and the live fleet — that link is not the one that leaves the building."""
    person = Personnel(display_name="Meier Hans", is_active=True)
    db_session.add(person)
    await db_session.commit()
    await db_session.refresh(person)

    await _open_alarm_link(client)
    for url in ("/api/objects", "/api/personnel"):
        r = await client.get(url)
        assert r.status_code == 200, f"GET {url} answered {r.status_code} for an alarm link: {r.text[:200]}"
    # traccar/weather answer 503 here (no upstream configured in tests) — what matters is that
    # the GATE let them through, i.e. they never answer the allowlist's 403.
    for url in ("/api/traccar/positions", "/api/traccar/trails", "/api/traccar/status", "/api/weather"):
        assert (await client.get(url)).status_code != 403, f"GET {url} was refused an alarm link"
    r = await client.post(f"/api/incidents/{incident.id}/positions", json=_position_body(person))
    assert r.status_code == 204, r.text


async def test_the_atemschutz_link_still_writes_its_trupps(client, editor, incident):
    await _login_editor(client, editor)
    r = await client.post(f"/api/incidents/{incident.id}/atemschutz-link")
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    client.cookies.delete(ACCESS_COOKIE)
    assert (await client.post("/api/incident-link/session", json={"token": token})).status_code == 200

    r = await client.put(
        f"/api/incidents/{incident.id}/workspace/trupps",
        headers=LINK_PAGE,
        json={"trupps": [], "base_rev": 0},
    )
    assert r.status_code == 200, r.text


# --- hardening: a page that says it is the link IS the link -------------------------------


async def test_a_forced_link_page_is_not_widened_by_an_admin_cookie(client, admin_login, editor, incident, db_session):
    """`X-Incident-Link: use` asks for the restricted identity, and `read_link_session` grants
    it — so the scope gate must not hand the whole API back because an admin cookie happens to
    be in the same browser. /auth/me said "link session for A" while every route answered for B.
    """
    other = Incident(title="Anderer Einsatz", source="manual", status="offen")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    # the operator's own browser: /admin unlocked first, then the link tapped on top of it
    await admin_login(client)
    await _open_view_link(client, editor, incident)

    me = await client.get("/api/auth/me", headers=LINK_PAGE)
    assert me.json()["link_incident_id"] == str(incident.id)
    r = await client.get(f"/api/incidents/{other.id}/workspace", headers=LINK_PAGE)
    assert r.status_code == 403, f"a forced link page reached another Einsatz: {r.text[:200]}"
    r = await client.get("/api/objects", headers=LINK_PAGE)
    assert r.status_code == 403, f"a forced link page reached the object register: {r.text[:200]}"

    # …and the operator's own pages, which say "off", are untouched: /admin still works
    assert (await client.get("/api/incident-link/secret", headers=BARE_SITE)).status_code == 200


async def test_forced_link_mode_with_no_link_cookie_denies_ambient_admin(client, admin_login):
    """H2: `X-Incident-Link: use` asks for the restricted link identity even when there is NO
    link cookie at all (absent or expired). An admin cookie lying in the same browser must not
    silently hand admin routes back — Codex reached /api/capture/secret this way (`use` + admin
    cookie + no link cookie). Forced mode denies the ambient admin path regardless."""
    await admin_login(client)  # the browser holds ONLY an admin session, no link cookie

    r = await client.get("/api/capture/secret", headers=LINK_PAGE)
    assert r.status_code == 403, f"forced link mode rode an ambient admin cookie to an admin route: {r.text[:200]}"
    assert r.json()["detail"] == DENIED_DETAIL

    # …and the operator's own pages (header "off") reach the very same admin route unchanged.
    assert (await client.get("/api/capture/secret", headers=BARE_SITE)).status_code == 200


async def test_an_ambient_admin_cookie_still_lifts_the_gate_for_the_ordinary_app(
    client, admin_login, link_key, incident
):
    """The regression the bypass exists to prevent: the operator taps a link to see what
    responders see, and must not thereby be locked out of /admin on that browser."""
    await admin_login(client)
    await _open_alarm_link(client)
    assert (await client.get("/api/incident-link/secret")).status_code == 200
    assert (await client.post(f"/api/incidents/{incident.id}/report/pdf", json={})).status_code != 403


# --- the residual this fix knowingly leaves ------------------------------------------------


async def test_the_active_roster_is_still_visible_to_a_report_link(client, editor, incident, db_session):
    """Documented boundary, not an oversight: the Anwesenheit list, the Trupp names and the
    Rapport all render from `/api/personnel`, and narrowing it to the people this Einsatz
    recorded needs a projection in `api/personnel` — a different file, a follow-up change.
    `?include_inactive` is refused above, which is what the finding reproduced."""
    here = Personnel(display_name="Aktiv Anna", is_active=True)
    db_session.add(here)
    await db_session.commit()

    await _open_view_link(client, editor, incident)
    r = await client.get("/api/personnel")
    assert r.status_code == 200
    assert any(p["display_name"] == "Aktiv Anna" for p in r.json())


async def test_an_old_view_session_is_narrowed_without_being_re_minted(client, editor, incident):
    """Enforcement is per request, server-side, so a link already sent out is covered the moment
    this ships — nothing is baked into the cookie a holder keeps."""
    await _open_view_link(client, editor, incident)
    cookie = client.cookies[LINK_COOKIE]  # what somebody's phone is holding
    client.cookies.delete(LINK_COOKIE)
    client.cookies.set(LINK_COOKIE, cookie)
    assert (await client.get("/api/objects")).status_code == 403
    assert (await client.get(f"/api/incidents/{incident.id}/journal")).status_code == 200


async def test_a_stale_view_cookie_does_not_narrow_a_real_login(client, editor, incident):
    """The link is «just the literal page»: the bare site ignores the cookie, so an editor whose
    browser still holds one reads the station exactly as before."""
    await _open_view_link(client, editor, incident)
    await _login_editor(client, editor)
    assert (await client.get("/api/objects", headers=BARE_SITE)).status_code == 200
    assert (await client.get("/api/traccar/positions", headers=BARE_SITE)).status_code != 403


async def test_a_plan_of_an_object_that_is_merely_elsewhere_stays_shut(client, editor, db_session):
    """Distance, not luck. Two objects, one Einsatz: the one at the Einsatz address is surfaced
    and readable, the one 15 km away is neither — even though both are ordinary station
    objects that any logged-in member reads."""
    inc = Incident(
        title="Feld",
        source="manual",
        status="offen",
        address="Feldweg 1",
        lat=47.5000,
        lng=7.5000,
        started_at=datetime.now(UTC) - timedelta(hours=1),
    )
    db_session.add(inc)
    await db_session.commit()
    await db_session.refresh(inc)

    near, near_plan = await _object_with_plan(
        db_session, name="Feldscheune", address="Feldweg 1", dataset_id="plan:near:modul1"
    )
    far, far_plan = await _object_with_plan(db_session, name="Weit", address="Anderswo 2", dataset_id="plan:far:modul1")
    far.lat, far.lng = 47.6000, 7.6000
    await db_session.commit()

    await _open_view_link(client, editor, inc)
    assert (await client.get(f"/api/objects/{near.id}")).status_code == 200
    assert (await client.get(f"/api/reference/{near_plan}")).status_code == 200
    assert (await client.get(f"/api/objects/{far.id}")).status_code == 403
    assert (await client.get(f"/api/reference/{far_plan}")).status_code == 403


async def test_an_unknown_dataset_id_is_refused_like_a_forbidden_one(client, editor, incident):
    """No probing: «kenne ich nicht» and «gehört nicht zu diesem Einsatz» are one answer, so a
    holder cannot map the station's plan store by watching status codes."""
    await _open_view_link(client, editor, incident)
    r = await client.get(f"/api/reference/plan:{uuid.uuid4()}:modul1")
    assert r.status_code == 403
    assert r.json()["detail"] == DENIED_DETAIL
