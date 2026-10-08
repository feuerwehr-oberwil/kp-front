"""The Gebäude card (`app/building_facts.py`, `app/api/building.py`) — KP Front card F5.

Decoding is checked against the register's own answer for a real building (Hauptstrasse 10,
Oberwil, EGID 408319, fetched 08.10.2026); the HTTP half runs against an httpx MockTransport —
same technique as tests/test_geo_clients.py — so no test ever leaves the machine.
"""

import uuid
from datetime import UTC, date, datetime

import httpx
import pytest

from app import building_facts as bf
from app.models import DeploymentConfig, Incident, ObjectSite, ObjectVisit

PIN = "135790"

#: The GWR attributes of Hauptstrasse 10, Oberwil, trimmed to what the card reads.
GWR_ATTRS = {
    "egid": "408319",
    "strname_deinr": "Hauptstrasse 10",
    "plz_plz6": "4104/410400",
    "ggdename": "Oberwil (BL)",
    "gexpdat": "07.10.2026",
    "gstat": 1004,
    "gbauj": 1926,
    "gbaup": 8012,
    "gastw": 2,
    "ganzwhg": 2,
    "gschutzr": 0,
    "gwaerzh1": 7430,
    "genh1": 7520,
    "gwaerdath1": "29.06.2022",
    "gwaerzh2": 7400,
    "genh2": 7500,
    "genw1": 7520,
    "genw2": 7500,
}
HOME = (47.515297, 7.557682)  # the register's own point for that building

PLANT_ATTRS = {
    "address": "Hauptstrasse 10, 4104 Oberwil BL",
    "egid": 408319,
    "beginning_of_operation": "30.09.2024",
    "total_power": "35.64 kW",
    "sub_category_de": "Photovoltaik",
    "sub_category_fr": "Photovoltaïque",
    "sub_category_en": "Photovoltaic",
    "plant_type_de": "Angebaut",
}


def _feature(attrs: dict, lng: float, lat: float) -> dict:
    return {"geometry": {"type": "Point", "coordinates": [lng, lat]}, "properties": attrs}


@pytest.fixture(autouse=True)
def _fresh_cache():
    bf.clear_cache()
    yield
    bf.clear_cache()


@pytest.fixture
def registers(monkeypatch):
    """Answer GWR identify and BFE find from the given handlers; counts the calls."""
    calls = {"identify": 0, "find": 0}
    orig_init = httpx.AsyncClient.__init__  # the real one, even when a test installs twice

    def install(identify=None, find=None):
        calls.update(identify=0, find=0)

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/identify"):
                calls["identify"] += 1
                return identify(request) if identify else httpx.Response(200, json={"results": []})
            if request.url.path.endswith("/find"):
                calls["find"] += 1
                return find(request) if find else httpx.Response(200, json={"results": []})
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)

        def patched_init(self, *args, **kwargs):
            kwargs["transport"] = transport
            orig_init(self, *args, **kwargs)

        monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)
        return calls

    return install


def _gwr_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"results": [_feature(GWR_ATTRS, HOME[1], HOME[0])]})


def _pv_ok(request: httpx.Request) -> httpx.Response:
    assert request.url.params["searchText"] == "408319"
    assert request.url.params["layer"] == bf.PV_LAYER
    return httpx.Response(200, json={"results": [{"attributes": PLANT_ATTRS}]})


def _down(request: httpx.Request) -> httpx.Response:
    return httpx.Response(503, text="down")


# --- decoding --------------------------------------------------------------------------------


def test_energy_codes_decode_to_keys():
    assert bf.energy_key(7520) == "gas"
    assert bf.energy_key("7530") == "oil"
    assert bf.energy_key(7543) == "wood"
    assert bf.energy_key(7581) == "district"
    assert bf.energy_key(7511) == "geothermal"
    # «keine» and a missing code are nothing — never a chip
    assert bf.energy_key(7500) is None
    assert bf.energy_key(None) is None
    # a code newer than our table is still SOMETHING
    assert bf.energy_key(7577) == "other"


def test_period_labels():
    assert bf.period_label(8012) == "1919–1945"
    assert bf.period_label(8011) == "≤1918"
    assert bf.period_label(8023) == "≥2016"
    assert bf.period_label(None) is None
    assert bf.period_label(1234) is None


def test_decode_gwr_reads_what_a_crew_acts_on():
    facts = bf.decode_gwr(GWR_ATTRS)
    assert facts == {
        "egid": "408319",
        "stand": date(2026, 10, 7),
        "floors": 2,
        "flats": 2,
        "year": 1926,
        "period": None,  # the exact year wins
        "heating": ["gas"],  # the second generator is «kein», so it says nothing
        "heating_date": date(2022, 6, 29),
        "hot_water": ["gas"],
        "shelter": None,  # 0 = no Schutzraum: never drawn
        "status": None,  # «bestehend» says nothing
    }


def test_decode_gwr_falls_back_to_the_period_and_keeps_two_sources_once():
    facts = bf.decode_gwr({**GWR_ATTRS, "gbauj": None, "genh2": 7530, "genw2": 7520, "gschutzr": 1, "gstat": 1003})
    assert facts["year"] is None and facts["period"] == "1919–1945"
    assert facts["heating"] == ["gas", "oil"]
    assert facts["hot_water"] == ["gas"]
    assert facts["shelter"] is True
    assert facts["status"] == "under_construction"


def test_decode_plant_and_power():
    plant = bf.decode_plant(PLANT_ATTRS, "fr")
    assert plant == {"kind": "pv", "label": "Photovoltaïque", "power_kw": 35.64, "since": date(2024, 9, 30)}
    assert bf.parse_power_kw("1.2 MW") == 1200.0
    assert bf.parse_power_kw("800 W") == 0.8
    assert bf.parse_power_kw("") is None
    other = bf.decode_plant({"sub_category_de": "Biomasse", "sub_category_en": "Biomass"}, "it")
    assert other["kind"] == "other" and other["label"] == "Biomasse"  # falls back to German


def test_clean_measures():
    assert bf.clean_measures("  Gas zu \r\n\r\n  Abwart   rufen \n") == "Gas zu\nAbwart rufen"
    assert bf.clean_measures(" \n ") is None
    assert bf.clean_measures(None) is None


def test_pick_building_prefers_the_address_then_the_nearest():
    lat, lng = HOME
    neighbour = _feature({**GWR_ATTRS, "egid": "1", "strname_deinr": "Wehrlingasse 4"}, lng, lat)
    ours = _feature(GWR_ATTRS, lng + 0.0002, lat)  # ~15 m off, but it IS the address
    assert bf.pick_building([neighbour, ours], lat, lng, "Hauptstrasse 10, 4104 Oberwil")["egid"] == "408319"
    # no address to go by: the nearest one
    assert bf.pick_building([ours, neighbour], lat, lng, None)["egid"] == "1"
    # nothing within reach: no building rather than somebody else's
    far = _feature({**GWR_ATTRS, "egid": "2", "strname_deinr": "Weit weg 1"}, lng + 0.01, lat)
    assert bf.pick_building([far], lat, lng, None) is None


def test_switzerland_box():
    assert bf.in_switzerland(*HOME)
    assert not bf.in_switzerland(48.137, 11.575)  # München
    assert not bf.in_switzerland(0.0, 0.0)


# --- the registers, each failing on its own ---------------------------------------------------


async def test_registers_answer_gwr_and_pv(registers):
    calls = registers(identify=_gwr_ok, find=_pv_ok)
    ans = await bf.ask_registers(*HOME, "Hauptstrasse 10", "de")
    assert ans.gwr_ok and ans.pv_ok and ans.pv_asked
    assert ans.egid == "408319"
    assert ans.address == "Hauptstrasse 10, 4104 Oberwil"
    assert ans.gwr["heating"] == ["gas"]
    assert ans.plants == [{"kind": "pv", "label": "Photovoltaik", "power_kw": 35.64, "since": date(2024, 9, 30)}]
    assert calls == {"identify": 1, "find": 1}


async def test_a_pv_outage_keeps_the_gwr_facts(registers):
    registers(identify=_gwr_ok, find=_down)
    ans = await bf.ask_registers(*HOME, None)
    assert ans.gwr_ok and ans.gwr["floors"] == 2
    assert ans.pv_asked and not ans.pv_ok and ans.plants == []


async def test_a_gwr_outage_asks_nothing_else(registers):
    calls = registers(identify=_down, find=_pv_ok)
    ans = await bf.ask_registers(*HOME, None)
    assert not ans.gwr_ok and ans.gwr is None
    assert calls["find"] == 0  # no EGID, no join


async def test_no_building_at_the_point_is_not_an_error(registers):
    calls = registers()
    ans = await bf.ask_registers(*HOME, None)
    assert ans.gwr_ok and ans.gwr is None and ans.egid is None and not ans.pv_asked
    assert calls["find"] == 0


async def test_a_clean_answer_is_cached_and_a_failed_one_heals(registers, monkeypatch):
    calls = registers(identify=_gwr_ok, find=_pv_ok)
    await bf.registers_cached(*HOME, "Hauptstrasse 10")
    await bf.registers_cached(*HOME, "Hauptstrasse 10")
    assert calls["identify"] == 1

    bf.clear_cache()
    calls = registers(identify=_gwr_ok, find=_down)
    clock = [1000.0]
    monkeypatch.setattr(bf.time, "monotonic", lambda: clock[0])
    await bf.registers_cached(*HOME, None)
    clock[0] += bf._ERROR_TTL_S - 1
    await bf.registers_cached(*HOME, None)
    assert calls["find"] == 1  # still the cached failure…
    clock[0] += 2
    await bf.registers_cached(*HOME, None)
    assert calls["find"] == 2  # …and asked again two minutes later


# --- the endpoint ----------------------------------------------------------------------------


async def _login(client, user) -> None:
    r = await client.post("/api/auth/login", json={"user_id": str(user.id), "pin": PIN})
    assert r.status_code == 200, r.text


async def _incident(db, **kw) -> Incident:
    base = {"title": "Brand", "source": "manual", "status": "offen", "address": "Hauptstrasse 10, 4104 Oberwil"}
    inc = Incident(**{**base, "lat": HOME[0], "lng": HOME[1], **kw})
    db.add(inc)
    await db.commit()
    return inc


async def _object(db, **kw) -> ObjectSite:
    o = ObjectSite(
        **{"name": "Wohnhaus Hauptstrasse", "address": "Hauptstrasse 10", "lat": HOME[0], "lng": HOME[1], **kw}
    )
    db.add(o)
    await db.commit()
    return o


async def _config(db, doc: dict) -> None:
    db.add(DeploymentConfig(id=1, config_json=doc))
    await db.commit()


async def test_the_card_carries_all_four_halves(client, editor, db_session, registers):
    registers(identify=_gwr_ok, find=_pv_ok)
    await _config(db_session, {"objectVisits": {"enabled": True}})
    inc = await _incident(db_session)
    obj = await _object(
        db_session,
        measures="Gashaupthahn im Keller schliessen",
        remarks="PV-Anlage auf dem Dach",
        measures_source="Modul 1",
    )
    db_session.add_all(
        [
            ObjectVisit(
                id="ov-old",
                object_id=obj.id,
                lifecycle="completed",
                revision=1,
                doc={},
                visited_at=datetime(2025, 5, 1, tzinfo=UTC),
                findings=0,
            ),
            ObjectVisit(
                id="ov-new",
                object_id=obj.id,
                lifecycle="completed",
                revision=1,
                doc={},
                visited_at=datetime(2026, 5, 12, tzinfo=UTC),
                findings=2,
            ),
            # a draft is not a visit that happened
            ObjectVisit(
                id="ov-draft",
                object_id=obj.id,
                lifecycle="draft",
                revision=1,
                doc={},
                visited_at=datetime(2026, 9, 1, tzinfo=UTC),
                findings=5,
            ),
        ]
    )
    await db_session.commit()
    await _login(client, editor)

    r = await client.get(f"/api/incidents/{inc.id}/building")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["registers"] == "on"
    assert body["egid"] == "408319"
    assert body["gwr_status"] == "ok" and body["pv_status"] == "ok"
    assert body["gwr"]["floors"] == 2 and body["gwr"]["heating"] == ["gas"] and body["gwr"]["stand"] == "2026-10-07"
    assert body["plants"][0]["kind"] == "pv" and body["plants"][0]["power_kw"] == 35.64
    assert body["object"]["name"] == "Wohnhaus Hauptstrasse" and body["object"]["address_match"] is True
    assert body["object"]["measures"] == "Gashaupthahn im Keller schliessen"
    assert body["object"]["remarks"] == "PV-Anlage auf dem Dach"
    assert body["object"]["measures_source"] == "Modul 1"
    assert body["visit"]["id"] == "ov-new" and body["visit"]["findings"] == 2


async def test_a_register_outage_still_brings_the_measures(client, editor, db_session, registers):
    registers(identify=_down)
    inc = await _incident(db_session)
    await _object(db_session, measures="Abwart alarmieren")
    await _login(client, editor)

    body = (await client.get(f"/api/incidents/{inc.id}/building")).json()
    assert body["gwr_status"] == "error" and body["gwr"] is None
    assert body["pv_status"] == "skipped"
    assert body["object"]["measures"] == "Abwart alarmieren"
    assert body["visit"] is None  # the Objektbesuche module is off by default


async def test_no_object_and_no_building(client, editor, db_session, registers):
    registers()
    inc = await _incident(db_session)
    await _login(client, editor)

    body = (await client.get(f"/api/incidents/{inc.id}/building")).json()
    assert body["gwr_status"] == "none" and body["egid"] is None
    assert body["object"] is None and body["visit"] is None


async def test_the_registers_switch_off_and_stay_home(client, editor, db_session, registers):
    calls = registers(identify=_gwr_ok, find=_pv_ok)
    await _config(db_session, {"map": {"buildingRegister": False}})
    inc = await _incident(db_session)
    await _login(client, editor)
    body = (await client.get(f"/api/incidents/{inc.id}/building")).json()
    assert body["registers"] == "off" and body["gwr_status"] == "skipped"
    assert calls == {"identify": 0, "find": 0}


async def test_outside_switzerland_and_without_a_location(client, editor, db_session, registers):
    calls = registers(identify=_gwr_ok, find=_pv_ok)
    abroad = await _incident(db_session, lat=48.137, lng=11.575, address="Marienplatz 1, München")
    nowhere = await _incident(db_session, lat=None, lng=None)
    await _login(client, editor)
    assert (await client.get(f"/api/incidents/{abroad.id}/building")).json()["registers"] == "outside_ch"
    assert (await client.get(f"/api/incidents/{nowhere.id}/building")).json()["registers"] == "no_location"
    assert calls["identify"] == 0


async def test_the_operators_pick_wins(client, editor, db_session, registers):
    registers()
    inc = await _incident(db_session)
    await _object(db_session, measures="vom Plan")
    picked = await _object(db_session, name="Anderes", address="Nebenweg 1", measures="gewählt")
    await _login(client, editor)
    body = (await client.get(f"/api/incidents/{inc.id}/building", params={"object": str(picked.id)})).json()
    assert body["object"]["name"] == "Anderes" and body["object"]["measures"] == "gewählt"
    assert body["object"]["address_match"] is False
    # an unknown pick falls back to the plan rail's object
    body = (await client.get(f"/api/incidents/{inc.id}/building", params={"object": str(uuid.uuid4())})).json()
    assert body["object"]["measures"] == "vom Plan"


async def test_unknown_incident_and_no_session(client, editor):
    assert (await client.get(f"/api/incidents/{uuid.uuid4()}/building")).status_code == 401
    await _login(client, editor)
    assert (await client.get(f"/api/incidents/{uuid.uuid4()}/building")).status_code == 404


# --- the object's measures, written by the admin door ------------------------------------------


async def test_upsert_writes_measures_only_when_sent(client, db_session, admin_login):
    await admin_login(client)
    oid = uuid.uuid4()
    r = await client.put(
        f"/api/objects/{oid}",
        json={
            "name": "Werkhof",
            "measures": " Gas zu \n\n Strom aus ",
            "remarks": "Hunde",
            "measures_source": "Modul 1",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["remarks"] == "Hunde"
    assert r.json()["measures"] == "Gas zu\nStrom aus" and r.json()["measures_source"] == "Modul 1"
    # a write that does not name them (an older client, a manifest without the key) keeps them
    r = await client.put(f"/api/objects/{oid}", json={"name": "Werkhof Ost"})
    assert r.json()["measures"] == "Gas zu\nStrom aus"
    # an empty string clears
    r = await client.put(f"/api/objects/{oid}", json={"name": "Werkhof Ost", "measures": "", "measures_source": ""})
    assert r.json()["measures"] is None and r.json()["measures_source"] is None
