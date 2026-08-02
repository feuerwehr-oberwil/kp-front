"""The roster-snapshot contract: it must not drift, and it must never grow a medical field.

`app/roster_snapshot.py` defines a document other people's systems produce and this one will
read. Three different things can go wrong with a published contract, and this file holds all
three, because they fail for different reasons and each deserves its own red X.

**1. Drift.** `docs/roster-snapshot.schema.json` and `docs/roster-snapshot-outcome.schema.json`
are what a producer validates against — nobody runs this Python to find out what the shape is.
A committed artifact that no longer matches the code advertises a contract that is not the one
in force, the same failure `docs/openapi.json` had when it went 31 endpoints out of date.
Regenerate with `just roster-schema` in the same change that touches the models.

**2. Cross-repo drift.** kp-rück holds byte-identical copies of both schema files, pinned by
the same checksums. Neither repository may import the other (`docs/RUNNING-BOTH.md`), so the
copies stay copies and a hash holds them together — exactly the arrangement
`test_alarm_keywords.py` and `test_telemetry_vendored.py` already use. **What this cannot
catch, stated plainly:** editing the schema here and updating only this repository's hash
leaves both suites green while the two copies diverge. Only a job that checks out both
repositories actually compares them, and **this pair is in no such job yet** — kp-rück's
`alarm-keyword-drift` and `telemetry-drift` are the two that exist, and adding a third for a
contract nothing implements was left out of the change that published it. Until then, "copy it
across and update both hashes in one change" is a habit, not a guarantee.

**3. A medical field.** D30 of the estate architecture says the exclusion is a property of the
payload, "enforced by a schema test that fails on any medical-shaped key, not by doctrine:
'ever' is a claim about every future edit, and only a test can hold it." That test is below.

WHAT THE MEDICAL TEST ACTUALLY CATCHES
--------------------------------------
It matches a *category of names*, not three field names someone thought of. Every property
name, `$defs` name, `required` entry and enum value in both schemas, every key of the example
file, and every model field name in the module is folded (lowercased, umlauts expanded, accents
stripped, `snake_case`/`camelCase`/`kebab-case` split into words) and tested against ~70
substrings and ~24 whole-token stems covering German, English, French and Italian — the four
languages this product ships copy in, because a contributor names a field in the language they
think in. `tauglichBis`, `arzt_termin`, `impfstatus`, `fitnessForDuty`, `medical_notes`,
`blutgruppe`, `aptitude_medicale` and `idoneita` all fail it. So does `au_datum`, the
abbreviation this estate actually uses.

It also runs at *runtime*: `parse_snapshot` scans every key of an incoming document, so a
producer that adds one is refused with the reason, rather than having the field silently
ignored by a lenient parser.

Two structural tests back it up, because a name test is only worth as much as the surface it
covers. `test_no_free_form_object_in_the_schema` fails if any object in either schema allows
additional properties or declares no properties at all — a string map is a hole through which
medical data arrives under no schema name at all, and the contract deliberately has none, which
is also why it carries no `metadata` blob and no `qualifications` list.

WHAT WOULD SLIP PAST IT — read this before trusting it
------------------------------------------------------
* **Medical content under a neutral name.** `note`, `status`, `valid_until`, `restriction`,
  `bemerkung`, `qualifications` — none of these are medical-shaped, and a list of qualification
  strings is exactly where "Atemschutz-Tauglichkeit bis 2027" would arrive. The contract's
  answer is to carry none of them; if a later version adds one, this test will not save it.
* **Medical content in a field that legitimately holds free text.** Nothing stops a producer
  writing `"display_name": "Meier Anna (AU abgelaufen)"`. No schema test can.
* **Prose.** Only *names* are scanned, never `description` or `title`, so a docstring may
  discuss Arztuntersuchungen — as this module's does.
* **A language none of the stems cover**, or a coinage that shares no stem with any of them.
* **Anything a consumer derives and stores locally.** This governs the payload, not the
  database that reads it.

The vendor test is weaker still and honestly so: "is this a product name" has no shape, so
`VENDOR_SUBSTRINGS` is a list of names and only catches the ones on it. It is scoped to the
roster-snapshot artifacts on purpose — `winfapAlias` is a legitimate, deliberate key elsewhere
in this product's station config, and this test says nothing about it.
"""

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from app import providers, roster_snapshot
from app.roster_snapshot import EXAMPLE_SNAPSHOT, medical_shaped, parse_snapshot, vendor_shaped
from app.schemas import RosterConfig

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
SNAPSHOT_SCHEMA = ROOT / "docs" / "roster-snapshot.schema.json"
OUTCOME_SCHEMA = ROOT / "docs" / "roster-snapshot-outcome.schema.json"
EXAMPLE_FILE = BACKEND / "roster.snapshot.example.json"

#: sha256 of each file that is ALSO vendored into feuerwehr-oberwil/kp-rueck. Regenerate with:
#:   just roster-schema && shasum -a 256 docs/roster-snapshot*.schema.json
VENDORED = {
    "roster-snapshot.schema.json": "85c9cfab43c64f096a6b260f4892240fe0b7890acc7741b8be544698ef102cc0",
    "roster-snapshot-outcome.schema.json": "131cedd7246ccac71f9e1017af8e61bebe998dc09f04cc47df8d5d9bac9e78a9",
}

repo_only = pytest.mark.skipif(not SNAPSHOT_SCHEMA.exists(), reason="repo root not available (running from the image)")


# --- 1. drift against the code ----------------------------------------------------------


@repo_only
def test_committed_snapshot_schema_matches_the_models():
    committed = json.loads(SNAPSHOT_SCHEMA.read_text(encoding="utf-8"))
    assert committed == roster_snapshot.snapshot_json_schema(), (
        "docs/roster-snapshot.schema.json is out of date — regenerate with `just roster-schema` "
        "and commit it in the same change. Producers validate against that file, not this code."
    )


@repo_only
def test_committed_outcome_schema_matches_the_models():
    committed = json.loads(OUTCOME_SCHEMA.read_text(encoding="utf-8"))
    assert committed == roster_snapshot.outcome_json_schema(), (
        "docs/roster-snapshot-outcome.schema.json is out of date — regenerate with `just roster-schema` and commit it."
    )


@repo_only
def test_committed_example_matches_the_module():
    committed = json.loads(EXAMPLE_FILE.read_text(encoding="utf-8"))
    assert committed == EXAMPLE_SNAPSHOT, (
        "backend/roster.snapshot.example.json drifted from EXAMPLE_SNAPSHOT — regenerate with "
        "`just roster-schema`. An example that no longer validates is worse than no example."
    )


def test_the_example_validates_against_its_own_contract():
    # The one test that proves the published example is a conforming document, which is the
    # only thing a station copying it actually cares about.
    snapshot = parse_snapshot(json.dumps(EXAMPLE_SNAPSHOT))
    assert snapshot.count == len(snapshot.people) == 4
    assert snapshot.provider == "musterdorf-personalstamm"
    assert sum(1 for p in snapshot.people if not p.active) == 1, (
        "keep one inactive person in the example — 'active: false' is the field a producer is "
        "most likely to get wrong, and an example that never shows it does not teach it"
    )


# --- 2. cross-repo pin ------------------------------------------------------------------


@repo_only
@pytest.mark.parametrize("name", sorted(VENDORED))
def test_vendored_schema_matches_the_recorded_hash(name: str):
    path = ROOT / "docs" / name
    assert path.exists(), f"{name} is missing — the vendored copy must not be deleted"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == VENDORED[name], (
        f"docs/{name} no longer matches the hash recorded here.\n"
        f"Copy the file across to kp-rueck, run BOTH test suites, and update the hash in BOTH "
        f"repositories in the same change. Do NOT just update the hash — see this module's "
        f"docstring for why that is not enough on its own."
    )


@repo_only
def test_both_schemas_are_pinned():
    # A guard on the guard: pinning the document but not the outcome report would leave half
    # the contract free to move.
    assert set(VENDORED) == {"roster-snapshot.schema.json", "roster-snapshot-outcome.schema.json"}


# --- 3. the medical exclusion -----------------------------------------------------------


def _schema_names(node: Any, *, in_defs: bool = False) -> list[str]:
    """Every NAME a schema introduces: property names, $defs names, required entries, enum
    values. Deliberately not `description`/`title` — those are prose, and this module's own
    docstrings discuss the very words being banned."""
    out: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("properties", "$defs", "patternProperties"):
                out.extend(str(k) for k in value)
                for sub in value.values():
                    out.extend(_schema_names(sub))
            elif key in ("required", "enum"):
                out.extend(str(v) for v in value if isinstance(v, str))
            elif key in ("description", "title", "$id", "pattern", "const", "default"):
                continue
            else:
                out.extend(_schema_names(value))
    elif isinstance(node, list):
        for item in node:
            out.extend(_schema_names(item))
    return out


def _document_keys(node: Any) -> list[str]:
    out: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            out.append(str(key))
            out.extend(_document_keys(value))
    elif isinstance(node, list):
        for item in node:
            out.extend(_document_keys(item))
    return out


def _model_field_names() -> list[str]:
    names: list[str] = []
    for obj in vars(roster_snapshot).values():
        if isinstance(obj, type) and issubclass(obj, BaseModel) and obj is not BaseModel:
            for field_name, field in obj.model_fields.items():
                names.append(field_name)
                if field.alias:
                    names.append(field.alias)
    return names


def _every_name() -> list[str]:
    names = _model_field_names()
    names += _schema_names(roster_snapshot.snapshot_json_schema())
    names += _schema_names(roster_snapshot.outcome_json_schema())
    names += _document_keys(EXAMPLE_SNAPSHOT)
    if SNAPSHOT_SCHEMA.exists():
        names += _schema_names(json.loads(SNAPSHOT_SCHEMA.read_text(encoding="utf-8")))
        names += _schema_names(json.loads(OUTCOME_SCHEMA.read_text(encoding="utf-8")))
    return names


def test_no_medical_shaped_name_anywhere_in_the_contract():
    """THE test D30 asks for. If this ever fails, the answer is to remove the field."""
    offenders = sorted({f"{n} (matched {stem!r})" for n in _every_name() if (stem := medical_shaped(n))})
    assert not offenders, (
        "the roster-snapshot contract grew a medical-shaped field: "
        + ", ".join(offenders)
        + ".\nRoster snapshots carry no medical data, ever — not the date of an Arztuntersuchung, "
        "not a Tauglichkeit, not an Impfung. This is not a naming problem to work around by "
        "renaming the field; remove it. See docs/CONFIGURATION.md §4c."
    )


def test_no_vendor_named_key_anywhere_in_the_contract():
    """A published contract that names a vendor is a contract only one station can implement.

    Scoped to the roster snapshot: `winfapAlias` in the fleet/groups config is deliberate and
    documented, and this test has nothing to say about it.
    """
    offenders = sorted({f"{n} (matched {stem!r})" for n in _every_name() if (stem := vendor_shaped(n))})
    assert not offenders, (
        "the roster-snapshot contract names a vendor: "
        + ", ".join(offenders)
        + ".\nExternal ids travel in `identities` as (provider, external_id) pairs — that is what "
        "`personnel_external_identities` is for, and why the vendor columns are deprecated."
    )


@pytest.mark.parametrize(
    "name",
    [
        # German — what a contributor to THIS estate would plausibly add
        "untersuchung",
        "letzteUntersuchung",
        "arztuntersuchung_faellig",
        "au_datum",
        "tauglichBis",
        "atemschutztauglichkeit",
        "dienstuntauglich",
        "impfstatus",
        "impfungen",
        "diagnose",
        "medikamente",
        "allergien",
        "eignung",
        "gesundheitszustand",
        "krank_bis",
        "blutgruppe",
        "arzt_kontakt",
        "attest_url",
        "schwangerschaft",
        "psychologische_betreuung",
        "behinderungsgrad",
        # English
        "medical",
        "medicalNotes",
        "health_status",
        "fitness",
        "fit_for_duty",
        "lastExamination",
        "vaccination_date",
        "immunisation",
        "diagnosis",
        "medication",
        "allergyList",
        "disability",
        "pregnant",
        "bloodType",
        "physicianPhone",
        "injuryHistory",
        "sick_leave_days",
        "bmi",
        "weight_kg",
        "hearing_test",
        # French / Italian — this product ships fr-CH and it-CH copy
        "aptitude_medicale",
        "medecin_traitant",
        "etat_de_sante",
        "idoneita",
        "certificato_sanitario",
        "malattia",
    ],
)
def test_the_medical_guard_fires_on_a_plausible_future_field(name: str):
    """Proves the guard above can fail. A test that only ever passes proves nothing."""
    assert medical_shaped(name) is not None, (
        f"{name!r} slipped past the medical guard — add the stem it should have matched to "
        f"MEDICAL_SUBSTRINGS or MEDICAL_TOKENS in app/roster_snapshot.py."
    )


@pytest.mark.parametrize(
    "name",
    [
        # The contract's own vocabulary
        "external_id",
        "display_name",
        "first_name",
        "last_name",
        "rank",
        "active",
        "identities",
        "provider",
        "generated_at",
        "complete",
        "count",
        "people",
        "schema",
        "schema_version",
        "unmatched",
        "unknown_ranks",
        "deactivated",
        # Fire-service words that must NOT trip it, including near misses
        "funkkanal",
        "default_funkkanal",
        "einheit",
        "funktion",
        "zug",
        "atemschutz",
        "einsatzbereitschaft",
        "unfallmeldung",
        "profit",
        "example",
        "weightless_note",
        "benefit",
        "outfit",
    ],
)
def test_the_medical_guard_leaves_the_domain_vocabulary_alone(name: str):
    """A guard that fires on ordinary field names would be turned off within a week."""
    assert medical_shaped(name) is None, (
        f"{name!r} wrongly matched {medical_shaped(name)!r} — an over-broad stem makes this "
        f"guard unusable, which is worse than not having it."
    )


@pytest.mark.parametrize(
    ("name", "expected"),
    [("divera_id", "divera"), ("winfapAlias", "winfap"), ("traccarDeviceName", "traccar")],
)
def test_the_vendor_guard_fires_on_a_vendor_name(name: str, expected: str):
    assert vendor_shaped(name) == expected


# --- the guard at runtime, not only at edit time ----------------------------------------


def _example_with(mutate) -> str:
    doc = json.loads(json.dumps(EXAMPLE_SNAPSHOT))
    mutate(doc)
    return json.dumps(doc)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda d: d.update({"tauglichkeit_geprueft": True}), id="top-level"),
        pytest.param(lambda d: d["people"][0].update({"impfstatus": "ok"}), id="person"),
        pytest.param(lambda d: d["people"][0]["identities"][0].update({"blutgruppe": "A"}), id="identity"),
    ],
)
def test_a_medical_key_refuses_the_whole_document(mutate):
    """Refused as a whole, with the reason — not quietly dropped by a lenient parser.

    A file is a complete statement about a roster; ingesting the acceptable half of one that
    carries medical data is how the data ends up in the database anyway.
    """
    with pytest.raises(ValueError, match="looks like medical data"):
        parse_snapshot(_example_with(mutate))


@repo_only
def test_no_free_form_object_in_the_schema():
    """No string map, anywhere. That is what makes the name guard worth anything.

    A `metadata` blob or an untyped object would let medical data in under no schema name at
    all, so the contract carries neither — and this fails the moment one is added.
    """
    offenders: list[str] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                if node.get("additionalProperties") is not False:
                    offenders.append(f"{path}: allows additional properties")
                if not node.get("properties"):
                    offenders.append(f"{path}: declares no properties (a free-form map)")
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, f"{path}[{i}]")

    for name in sorted(VENDORED):
        walk(json.loads((ROOT / "docs" / name).read_text(encoding="utf-8")), name)
    assert not offenders, (
        "the roster-snapshot contract grew a free-form object: "
        + "; ".join(offenders)
        + ".\nA string map is a hole in the medical exclusion — the keys inside it are data, so "
        "no schema test can see them. If a later version genuinely needs one, it has to run "
        "roster_snapshot.medical_shaped over its keys at parse time and this test has to change "
        "deliberately."
    )


# --- the contract's own invariants ------------------------------------------------------


def test_the_version_is_stated_in_three_places_and_they_agree():
    # A producer reads `schema`, a consumer switches on `schema_version`, and the code has a
    # constant. Two of the three disagreeing is how a v2 file gets parsed as a v1.
    assert f"roster-snapshot/{roster_snapshot.SCHEMA_VERSION}" == roster_snapshot.SCHEMA_ID
    assert EXAMPLE_SNAPSHOT["schema"] == roster_snapshot.SCHEMA_ID
    assert EXAMPLE_SNAPSHOT["schema_version"] == roster_snapshot.SCHEMA_VERSION
    assert roster_snapshot.snapshot_json_schema()["$id"] == roster_snapshot.SCHEMA_ID


def test_a_document_from_another_contract_version_is_refused():
    assert parse_snapshot(json.dumps(EXAMPLE_SNAPSHOT)).schema_version == 1
    with pytest.raises(ValueError):
        parse_snapshot(_example_with(lambda d: d.update({"schema": "roster-snapshot/2"})))
    with pytest.raises(ValueError):
        parse_snapshot(_example_with(lambda d: d.update({"schema_version": 2})))


@pytest.mark.parametrize(
    ("mutate", "why"),
    [
        pytest.param(lambda d: d.update({"count": 99}), "a truncated file must not read as a departure", id="count"),
        pytest.param(lambda d: d.update({"people": [], "count": 0}), "an empty roster is a broken publish", id="empty"),
        pytest.param(
            lambda d: d["people"].append(dict(d["people"][0])) or d.update({"count": 5}),
            "the same person twice",
            id="dupe-id",
        ),
        pytest.param(
            lambda d: d["people"][2].update({"identities": [{"provider": "alarmierung", "external_id": "4711"}]}),
            "two people cannot be the same external person",
            id="dupe-identity",
        ),
        pytest.param(lambda d: d.update({"provider": "Musterdorf Personalstamm"}), "not a key", id="provider-shape"),
        pytest.param(lambda d: d.update({"generated_at": "2026-08-02T04:00:00"}), "no offset", id="naive-time"),
        pytest.param(lambda d: d["people"][0].update({"external_id": ""}), "blank key", id="blank-id"),
    ],
)
def test_the_document_refuses_what_it_says_it_refuses(mutate, why: str):
    with pytest.raises(ValueError):
        parse_snapshot(_example_with(mutate))
    assert why  # documented in the parameter id, kept visible in the failure output


def test_partial_and_complete_are_both_expressible():
    # The flag a consumer gates deactivation on. Both values must round-trip.
    assert parse_snapshot(_example_with(lambda d: d.update({"complete": False}))).complete is False
    assert parse_snapshot(json.dumps(EXAMPLE_SNAPSHOT)).complete is True


# --- the selector and the registry ------------------------------------------------------


def test_roster_source_accepts_snapshot_beside_manual_and_divera():
    # D65: a third `roster.source` value, not a replacement for either existing one.
    for value in ("manual", "divera", "snapshot", None):
        assert RosterConfig(source=value).source == value


def test_the_registry_lists_the_provider_and_admits_it_is_not_built():
    entry = next(p for p in providers.integrations().providers if p.provider == "snapshot")
    assert entry.domain == "personnel"
    assert entry.implemented is False, (
        "flip this to True only in the change that actually implements snapshot ingestion — "
        "a registry that claims a working provider is worse than one that omits it"
    )
    assert entry.configured is False and entry.active is False
    # …and it must not have displaced the providers that do work.
    assert {p.provider for p in providers.integrations().providers} >= {"divera", "traccar", "snapshot"}
