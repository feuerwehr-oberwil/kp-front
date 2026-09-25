"""The Lage-Grundgerüst: shipped presets, a station's own Einsatzarten, and the refusals.

Three things held down here:

1. **The shipped presets are valid** by the SAME rule a station's lists pass — every symbol is in
   the pack, every line is a preset — so a preset can never place a symbol that does not exist.
2. **A wrong name is refused at the door, and the refusal says what was meant.** A slot naming a
   symbol the pack does not carry is a row on the Karte that places nothing; the likeliest cause
   is an umlaut the symbol names do not use, so the did-you-mean is part of the contract.
3. **The block round-trips through `/api/config`**, with the presets served beside it, and a
   stored row a newer rule refuses degrades (drops the slot) instead of emptying the station.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from app import lage_grundgeruest as gg
from app.config_guard import ignored_keys
from app.divera import CATEGORY_LABELS
from app.schemas import DeploymentConfigIn, LageGrundgeruestConfig, LageSlot, load_stored_config

BACKEND = Path(__file__).resolve().parents[1]


def _refusal(doc: dict) -> str:
    with pytest.raises(ValidationError) as e:
        DeploymentConfigIn.model_validate({"lageGrundgeruest": doc})
    return str(e.value)


# --- 1. What ships -------------------------------------------------------------------------


def test_the_two_presets_ship_and_fks_standard_is_the_default():
    assert set(gg.PRESETS) == {"fks-standard", "minimal"}
    assert gg.DEFAULT_PRESET == "fks-standard"
    assert DeploymentConfigIn().lageGrundgeruest.preset == "fks-standard"
    assert DeploymentConfigIn().lageGrundgeruest.kategorien == {}


@pytest.mark.parametrize("name", sorted(gg.PRESETS))
def test_every_shipped_slot_passes_the_rule_a_station_list_passes(name):
    assert gg.symbol_names(), "the symbol pack must be found in a repo checkout"
    kategorien = gg.PRESETS[name]["kategorien"]
    LageGrundgeruestConfig.model_validate({"preset": name, "kategorien": kategorien})
    assert set(kategorien) <= set(CATEGORY_LABELS)


def test_fks_standard_carries_the_lists_of_the_design():
    k = gg.PRESETS["fks-standard"]["kategorien"]

    def row(cat: str) -> list[str]:
        return [s.get("symbol") or f"linie:{s['linie']}" for s in k[cat]]

    assert row("brandbekaempfung") == [
        "VKF KP Front", "linie:Zufahrt", "SI Wasserbezugsort", "FW Sammelplatz", "FW Absperrung", "FW Warteraum",
    ]  # fmt: skip
    assert row("bma_unechte_alarme") == ["VKF KP Front", "GB Schluesseldepot", "GB Brandmeldezentrale", "linie:Zufahrt"]
    assert row("strassenrettung")[-1] == "VKF Helilandeplatz" and k["strassenrettung"][-1]["optional"] is True
    assert k["chemiewehr"] == k["oelwehr"]
    assert row("elementarereignis") == ["VKF KP Front", "VKF Bereich Materialdepot", "FW Absperrung", "FW Warteraum"]
    # the suggestions the card makes out of data it already has
    brand = {s["id"]: s.get("vorschlag") for s in k["brandbekaempfung"]}
    assert brand["wasser"] == {"naechster": "hydrant"}
    assert brand["kp"] == {"wind": "auf", "m": 40} and brand["bereit"] == {"wind": "auf", "m": 80}


def test_minimal_is_kp_zufahrt_sammelplatz_for_every_einsatzart():
    k = gg.PRESETS["minimal"]["kategorien"]
    assert set(k) == set(CATEGORY_LABELS)
    assert all([s["id"] for s in slots] == ["kp", "zufahrt", "sammel"] for slots in k.values())


def test_line_presets_are_the_frontend_labels():
    # the Vitest half reads LINE_PRESETS out of lage_grundgeruest.py; this half keeps the
    # neutral Freihand out of it — a slot that places a plain line would tick on every scribble
    assert "Zufahrt" in gg.LINE_PRESETS and "Rettungsachse" in gg.LINE_PRESETS
    assert "Freihand" not in gg.LINE_PRESETS


# --- 2. Refusals, each with what was meant ------------------------------------------------


def test_preset_alone_is_a_whole_answer():
    doc = DeploymentConfigIn.model_validate({"lageGrundgeruest": {"preset": "minimal"}})
    assert doc.lageGrundgeruest.preset == "minimal" and doc.lageGrundgeruest.kategorien == {}


def test_an_unknown_preset_is_refused_with_a_suggestion():
    msg = _refusal({"preset": "fks-standart"})
    assert "fks-standart" in msg and "did you mean 'fks-standard'?" in msg


def test_an_unknown_symbol_is_refused_with_a_suggestion():
    msg = _refusal(
        {"kategorien": {"bma_unechte_alarme": [{"id": "s", "label": "Schlüsseldepot", "symbol": "GB Schlüsseldepot"}]}}
    )
    assert "not in the symbol pack" in msg
    assert "did you mean 'GB Schluesseldepot'?" in msg


def test_an_unknown_line_preset_is_refused_with_a_suggestion():
    msg = _refusal({"kategorien": {"brandbekaempfung": [{"id": "z", "label": "Zufahrt", "linie": "Zufart"}]}})
    assert "is not a line preset" in msg and "did you mean 'Zufahrt'?" in msg


def test_an_unknown_einsatzart_is_refused_with_a_suggestion():
    msg = _refusal({"kategorien": {"bma": []}})
    assert "not an Einsatzart" in msg and "did you mean 'bma_unechte_alarme'?" in msg
    msg = _refusal({"kategorien": {"brandbekämpfung": []}})
    assert "did you mean 'brandbekaempfung'?" in msg


def test_a_misspelled_target_key_is_named():
    msg = _refusal({"kategorien": {"brandbekaempfung": [{"id": "s", "label": "S", "symbl": "FW Sammelplatz"}]}})
    assert "unknown key 'symbl' — did you mean 'symbol'?" in msg


def test_a_slot_names_exactly_one_target():
    assert "exactly one of «symbol»" in _refusal(
        {
            "kategorien": {
                "brandbekaempfung": [{"id": "x", "label": "X", "symbol": "FW Sammelplatz", "linie": "Zufahrt"}]
            }
        }
    )


def test_suggestions_are_checked():
    def slot(vorschlag: dict, **kw) -> dict:
        return {
            "kategorien": {
                "brandbekaempfung": [{"id": "k", "label": "K", "symbol": "VKF KP Front", "vorschlag": vorschlag, **kw}]
            }
        }

    assert "needs «m»" in _refusal(slot({"wind": "auf"}))
    assert "exactly one of «naechster»" in _refusal(slot({"wind": "auf", "m": 40, "naechster": "hydrant"}))
    assert "exactly one of «naechster»" in _refusal(slot({}))
    _refusal(slot({"naechster": "tanklöschfahrzeug"}))
    _refusal(slot({"wind": "auf", "m": 1}))  # below 5 m is a typo, not a suggestion
    # a line is drawn, never set at a point
    line = {
        "kategorien": {
            "brandbekaempfung": [{"id": "z", "label": "Z", "linie": "Zufahrt", "vorschlag": {"naechster": "hydrant"}}]
        }
    }
    assert "takes no suggestion" in _refusal(line)
    # the hydrant suggestion carries no distance — dropped, not refused
    ok = LageSlot.model_validate(
        {"id": "w", "label": "W", "symbol": "SI Wasserbezugsort", "vorschlag": {"naechster": "hydrant", "m": 30}}
    )
    assert ok.vorschlag is not None and ok.vorschlag.m is None


def test_duplicate_slot_ids_are_refused():
    two = [
        {"id": "kp", "label": "KP", "symbol": "VKF KP Front"},
        {"id": "kp", "label": "KP 2", "symbol": "VKF KP Front"},
    ]
    assert "used twice: kp" in _refusal({"kategorien": {"brandbekaempfung": two}})


def test_misspelled_slot_keys_come_back_as_warnings():
    raw = {
        "lageGrundgeruest": {
            "prest": "minimal",
            "kategorien": {
                "brandbekaempfung": [
                    {"id": "w", "label": "W", "symbol": "SI Wasserbezugsort", "vorschlg": {"naechster": "hydrant"}},
                    {
                        "id": "k",
                        "label": "K",
                        "symbol": "VKF KP Front",
                        "vorschlag": {"wind": "auf", "m": 40, "meter": 5},
                    },
                ]
            },
        }
    }
    lines = ignored_keys(raw)
    assert "lageGrundgeruest.prest — did you mean lageGrundgeruest.preset?" in lines
    assert "lageGrundgeruest.kategorien.brandbekaempfung[0].vorschlg — did you mean vorschlag?" in lines
    assert any(line.startswith("lageGrundgeruest.kategorien.brandbekaempfung[1].vorschlag.meter") for line in lines)


def test_a_stored_row_drops_what_it_cannot_read_instead_of_failing():
    stored = {
        "doctrine": {"contactIntervalMin": 7},
        "lageGrundgeruest": {
            "preset": "retired-preset",
            "kategorien": {
                "brandbekaempfung": [
                    {"id": "kp", "label": "KP", "symbol": "VKF KP Front"},
                    {"id": "alt", "label": "Alt", "symbol": "A symbol a newer pack renamed"},
                ],
                "no-such-category": [],
            },
        },
    }
    doc = load_stored_config(stored)
    assert doc.doctrine.contactIntervalMin == 7  # the station config survived
    assert doc.lageGrundgeruest.preset == "fks-standard"
    assert [s.id for s in doc.lageGrundgeruest.kategorien["brandbekaempfung"]] == ["kp"]
    assert "no-such-category" not in doc.lageGrundgeruest.kategorien


def test_effective_slots_prefers_the_station_list_and_honours_an_empty_one():
    own = {"bma_unechte_alarme": [{"id": "kp", "label": "KP", "symbol": "VKF KP Front"}], "strassenrettung": []}
    assert [s["id"] for s in gg.effective_slots("fks-standard", own, "bma_unechte_alarme")] == ["kp"]
    assert gg.effective_slots("fks-standard", own, "strassenrettung") == []
    assert len(gg.effective_slots("fks-standard", own, "brandbekaempfung")) == 6
    assert gg.effective_slots("fks-standard", own, "gerettete_tiere") == []


def test_did_you_mean_is_strict():
    assert gg.did_you_mean("FW Sammelplatz ", {"FW Sammelplatz", "VKF Sammelstelle"}) == "FW Sammelplatz"
    assert gg.did_you_mean("xyz", {"FW Sammelplatz"}) is None
    # ambiguous containment is no suggestion
    assert gg.did_you_mean("sammel", {"FW Sammelplatz", "VKF Sammelstelle"}) is None


# --- 3. API + CLI --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_config_serves_the_block_and_the_presets(client):
    body = (await client.get("/api/config")).json()
    assert body["lageGrundgeruest"] == {"preset": "fks-standard", "kategorien": {}}
    presets = body["lageGrundgeruestPresets"]
    assert set(presets) == {"fks-standard", "minimal"}
    assert presets["fks-standard"]["kategorien"]["brandbekaempfung"][0]["symbol"] == "VKF KP Front"


@pytest.mark.asyncio
async def test_put_config_round_trips_a_station_list(client, admin_login, put_config):
    await admin_login(client)
    own = [{"id": "kp", "label": "KP", "symbol": "VKF KP Front", "vorschlag": {"wind": "auf", "m": 30}}]
    r = await put_config(client, {"lageGrundgeruest": {"preset": "minimal", "kategorien": {"chemiewehr": own}}})
    assert r.status_code == 200, r.text
    got = (await client.get("/api/config")).json()["lageGrundgeruest"]
    assert got["preset"] == "minimal"
    assert got["kategorien"]["chemiewehr"][0]["vorschlag"] == {"naechster": None, "wind": "auf", "m": 30}
    # the served presets are response-only: handing the whole GET back is no «ignored» warning
    echo = (await client.get("/api/config")).json()
    r = await put_config(client, echo)
    assert r.status_code == 200, r.text
    assert not [w for w in r.json()["warnings"] if "lageGrundgeruestPresets" in w]


@pytest.mark.asyncio
async def test_put_config_refuses_an_unknown_symbol(client, admin_login, put_config):
    await admin_login(client)
    bad = {"kategorien": {"brandbekaempfung": [{"id": "s", "label": "S", "symbol": "FW Sammelplaz"}]}}
    r = await put_config(client, {"lageGrundgeruest": bad})
    assert r.status_code == 422
    assert "did you mean 'FW Sammelplatz'?" in r.text


def _cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 -- this repo's own CLI, fixed arguments
        [sys.executable, "-m", "app.admin_config", *args], cwd=BACKEND, capture_output=True, text=True, check=False
    )


def test_cli_lists_the_presets_with_their_einsatzarten():
    out = _cli("presets", "lageGrundgeruest")
    assert out.returncode == 0, out.stderr
    assert "fks-standard" in out.stdout and "minimal" in out.stdout
    assert "Brandbekämpfung: KP · Einsatzleitung · Zufahrt · Wasserbezug" in out.stdout
    assert "Helilandeplatz (optional)" in out.stdout


def test_cli_example_spells_a_preset_out_and_validates(tmp_path):
    out = _cli("example", "--section", "lageGrundgeruest", "--preset", "fks-standard")
    assert out.returncode == 0, out.stderr
    doc = json.loads(out.stdout)
    assert doc["lageGrundgeruest"]["kategorien"] == gg.PRESETS["fks-standard"]["kategorien"]
    path = tmp_path / "gg.json"
    path.write_text(out.stdout, encoding="utf-8")
    check = _cli("validate", str(path))
    assert check.returncode == 0, check.stderr
    # spelled out identically, nothing is «replaced»
    assert "Lage-Grundgerüst: preset «fks-standard», no Einsatzart replaced" in check.stdout


def test_cli_validate_names_the_bad_symbol(tmp_path):
    path = tmp_path / "bad.json"
    bad = {
        "lageGrundgeruest": {"kategorien": {"brandbekaempfung": [{"id": "k", "label": "K", "symbol": "VKF KP Frnot"}]}}
    }
    path.write_text(json.dumps(bad), encoding="utf-8")
    out = _cli("validate", str(path))
    assert out.returncode == 1
    assert "lageGrundgeruest.kategorien.brandbekaempfung.0" in out.stderr
    assert "did you mean 'VKF KP Front'?" in out.stderr


def test_cli_refuses_an_unknown_preset_name():
    out = _cli("example", "--section", "lageGrundgeruest", "--preset", "fks")
    assert out.returncode == 1
    assert "did you mean 'fks-standard'?" in out.stderr


# --- resetting the last adapted Einsatzart is not «emptying» ------------------------------


def test_an_empty_kategorien_is_a_value_not_a_loss():
    from app.config_history import emptied_sections

    old = {"lageGrundgeruest": {"preset": "fks-standard", "kategorien": {"chemiewehr": [{"id": "kp"}]}}}
    new = {"lageGrundgeruest": {"preset": "fks-standard", "kategorien": {}}}
    assert emptied_sections(old, new) == []
    # the neighbour rule still stands: the same shape elsewhere IS a loss
    assert emptied_sections({"report": {"links": [{"title": "x"}]}}, {"report": {"links": []}}) == ["report.links"]


@pytest.mark.asyncio
async def test_resetting_the_only_adapted_einsatzart_is_accepted(client, admin_login, put_config):
    """/admin › «Auf Preset zurücksetzen» on the last adapted Einsatzart writes `kategorien: {}`.
    It answered 409 would_empty_sections and stalled every Station page's autosave."""
    await admin_login(client)
    own = [{"id": "kp", "label": "KP", "symbol": "VKF KP Front"}]
    r = await put_config(client, {"lageGrundgeruest": {"preset": "fks-standard", "kategorien": {"chemiewehr": own}}})
    assert r.status_code == 200, r.text
    r = await put_config(client, {"lageGrundgeruest": {"preset": "fks-standard", "kategorien": {}}})
    assert r.status_code == 200, r.text
    assert (await client.get("/api/config")).json()["lageGrundgeruest"]["kategorien"] == {}


@pytest.mark.asyncio
async def test_a_label_past_80_characters_is_refused_with_its_path(client, admin_login, put_config):
    """The admin page keeps such a row out of the document (LageGrundgeruestSection · problem); the
    server's refusal names the row's path, which /admin turns into «Element 1 (Brand)»."""
    await admin_login(client)
    long = [{"id": "kp", "label": "K" * 81, "symbol": "VKF KP Front"}]
    r = await put_config(client, {"lageGrundgeruest": {"kategorien": {"brandbekaempfung": long}}})
    assert r.status_code == 422
    assert "lageGrundgeruest" in r.text and "label" in r.text
