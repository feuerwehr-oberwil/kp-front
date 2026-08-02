"""The roster-snapshot contract: what a published personnel file must look like.

`roster.source: "snapshot"` (docs/CONFIGURATION.md §4c) lets a station point this deployment at
a **roster file somebody else publishes** — a personnel system, a canton-level register, a
sibling application, a nightly export written by a script. It is one personnel provider among
several, selectable and disconnectable, and never required: a station that publishes nothing
runs on `"manual"` or `"divera"` exactly as before.

**This module is the contract, not the ingestion.** It defines the document, validates one,
prints its JSON Schema and prints a worked example. It does not fetch, schedule, match or write
anything — a deployment reading a snapshot into `personnel` is a separate piece of work, and
the schema is published first on purpose so the contract is designed rather than left to
emerge from whatever the first importer happened to need. Nothing in the running application
imports this module yet; what reads it today is the CLI below and
``tests/test_roster_snapshot_contract.py``.

Run from ``backend/`` via ``uv run python -m app.roster_snapshot <cmd>``:

    schema                 print the JSON Schema of a snapshot document (the contract)
    outcome-schema         print the JSON Schema of the reconciliation report a consumer emits
    example                print a populated example snapshot you can edit
    validate <file>        parse + validate a snapshot file (no DB, no network)

The committed copies of both schemas live in ``docs/roster-snapshot.schema.json`` and
``docs/roster-snapshot-outcome.schema.json``; ``just roster-schema`` regenerates them and a
test fails when they drift from this module, the same arrangement `docs/openapi.json` has.

WHAT IT CARRIES, AND WHY THAT LIST IS SHORT
-------------------------------------------
A snapshot is the same domain as the `"manual"` CSV — the people, and what the app needs to
show them in a picker: a stable id, a name, a Dienstgrad, whether they are still in. Plus one
thing the CSV does badly: ``identities``, a neutral list of ``(provider, external_id)`` pairs
that lands in ``personnel_external_identities``. There is deliberately no ``divera_id``-shaped
field. Vendor columns are deprecated in this product and in kp-rück; a snapshot that named one
alerting system in its schema would re-introduce the coupling both products spent a migration
removing, and it would be wrong for every station using a different one.

NO MEDICAL FIELDS, EVER — AND THAT IS A TEST, NOT A SENTENCE
------------------------------------------------------------
Personnel files are where Arztuntersuchungs-Dates, Tauglichkeit, Impfungen and absences live in
most fire-service systems, and none of them belong in a snapshot an incident-command app reads
at 3am. "Ever" is a claim about every future edit of this file, so it is held by
:func:`medical_shaped`, which matches a *category* of names rather than a list of three known
ones, and by the contract test that runs it over both schemas, the example and this module's
own fields. :func:`parse_snapshot` runs it over the incoming document too, so a producer that
adds such a key is told why the file was refused instead of having it silently ignored.

What that catches and what it does not is written out in the test's docstring. The short
version: it catches a medically *named* key; it cannot catch medical content wearing a neutral
name. That is why this schema has **no free-form blob and no ``qualifications`` list** — a
string map or a raw qualification list is precisely where "Atemschutz-Tauglichkeit bis 2027"
would arrive under a name no shape test can object to. ``rank`` is the derived, non-medical
projection the app actually uses.
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError, model_validator

#: Contract id carried in every document. Bumped only when the *shape* changes — a producer
#: and a consumer that disagree on this number disagree about everything below it.
SCHEMA_ID = "roster-snapshot/1"
OUTCOME_SCHEMA_ID = "roster-snapshot-outcome/1"
SCHEMA_VERSION = 1

#: `provider` is stored in a 32-char column in both products; the pattern keeps a snapshot from
#: minting a key that cannot be written on either side.
PROVIDER_PATTERN = r"^[a-z][a-z0-9_-]{1,31}$"
RANK_PATTERN = r"^[a-z0-9_-]{1,32}$"

ProviderKey = Annotated[str, Field(pattern=PROVIDER_PATTERN, max_length=32)]


# ---------------------------------------------------------------------------------------
# the medical-shape guard
# ---------------------------------------------------------------------------------------

#: Substrings long enough to be unambiguous. Matched against a normalised key name (lowercased,
#: accents folded, separators removed), so `tauglichBis`, `tauglich_bis` and `Tauglichkeit` all
#: hit `tauglich`. German, English, French and Italian, because this product ships four locales
#: and a contributor names a field in the language they think in.
MEDICAL_SUBSTRINGS: frozenset[str] = frozenset(
    {
        # German
        "untersuch",
        "tauglich",
        "eignung",
        "impf",
        "vakzin",
        "diagnos",
        "medikament",
        "medizin",
        "arztlich",
        "aerztlich",
        "allerg",
        "gesundheit",
        "krankheit",
        "krankschreib",
        "schwanger",
        "attest",
        "therapie",
        "rezept",
        "symptom",
        "psych",
        "behinderung",
        "blutgruppe",
        "koerpergroesse",
        "sehhilfe",
        "hoergeraet",
        "chronisch",
        "gebrechen",
        "befund",
        "anamnese",
        "vorsorge",
        # English
        "medical",
        "health",
        "fitness",
        "fitfor",
        "examination",
        "checkup",
        "vaccin",
        "immuni",
        "diagnosis",
        "medication",
        "allergy",
        "disabilit",
        "handicap",
        "pregnan",
        "illness",
        "disease",
        "physician",
        "prescription",
        "bloodtype",
        "bloodgroup",
        "clinic",
        "hospital",
        "injur",
        "therapy",
        "psychiatr",
        "chronic",
        "screening",
        "epilep",
        "asthma",
        "diabet",
        # French / Italian
        "medecin",
        "medicin",
        "aptitude",
        "sante",
        "maladie",
        "grossesse",
        "handicape",
        "idoneita",
        "sanitar",
        "malattia",
        "salute",
        "visitamedica",
    }
)

#: Short or ambiguous stems, matched as whole tokens only — `fit_for_duty` splits into
#: `fit|for|duty` and fires on `fit`, while `profit` never would. `au` is the abbreviation this
#: estate actually uses for Arztuntersuchung.
MEDICAL_TOKENS: frozenset[str] = frozenset(
    {
        "au",
        "arzt",
        "doctor",
        "blut",
        "blood",
        "krank",
        "sick",
        "fit",
        "unfit",
        "drug",
        "drogen",
        "dose",
        "bmi",
        "puls",
        "pulse",
        "vision",
        "sehkraft",
        "hearing",
        "gehoer",
        "weight",
        "gewicht",
        "height",
        "apte",
    }
)

#: Vendors and neighbouring systems. A published contract that names one is a contract only the
#: station that uses it can implement — unlike the medical set this is unavoidably a list of
#: names, because "is this a product name" has no shape to test for.
VENDOR_SUBSTRINGS: frozenset[str] = frozenset(
    {
        "divera",
        "winfap",
        "schluehue",
        "schluehu",
        "oberwil",
        "traccar",
        "fireboard",
        "firegis",
        "resilio",
        "alamos",
        "blaulicht",
        "onedrive",
        "sharepoint",
    }
)


def _fold(name: str) -> str:
    """Lowercase, fold accents, and normalise umlauts the way a German field name spells them."""
    lowered = name.lower()
    for src, dst in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        lowered = lowered.replace(src, dst)
    decomposed = unicodedata.normalize("NFD", lowered)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")


def _tokens(name: str) -> list[str]:
    """Split a key into words across `_`, `-`, `.`, spaces AND camelCase humps."""
    spaced = "".join(f" {c}" if c.isupper() else c for c in name)
    folded = _fold(spaced)
    return [t for t in "".join(c if c.isalnum() else " " for c in folded).split() if t]


def _matches(name: str, substrings: frozenset[str], tokens: frozenset[str] = frozenset()) -> str | None:
    """The stem that fired, or None. Returned rather than a bool so a failure names itself."""
    parts = _tokens(name)
    joined = "".join(parts)
    for stem in sorted(substrings):
        if stem in joined:
            return stem
    for token in parts:
        if token in tokens:
            return token
    return None


def medical_shaped(name: str) -> str | None:
    """Return the medical stem a field name matches, or None.

    This is the D30 guard in one function: the schema, the example, this module's own model
    fields and every key of an incoming document are run through it. It answers "does this name
    belong to the medical category", not "is this one of three fields we thought of".
    """
    return _matches(name, MEDICAL_SUBSTRINGS, MEDICAL_TOKENS)


def vendor_shaped(name: str) -> str | None:
    """Return the vendor name a field name contains, or None. See :data:`VENDOR_SUBSTRINGS`."""
    return _matches(name, VENDOR_SUBSTRINGS)


# ---------------------------------------------------------------------------------------
# the document
# ---------------------------------------------------------------------------------------


class ExternalIdentity(BaseModel):
    """One `(provider, external_id)` pair, exactly as `personnel_external_identities` stores it.

    This is how a snapshot says "the person the alerting system calls 4711 is the person this
    file calls p-0007" without either product growing a column named after a vendor.
    """

    model_config = ConfigDict(extra="forbid")
    provider: ProviderKey
    external_id: str = Field(min_length=1, max_length=255)


class PersonEntry(BaseModel):
    """One person in a roster snapshot.

    `external_id` is the publisher's own stable key and the only thing a consumer is entitled
    to match on without guessing. Names change (marriage, a corrected spelling, a rank folded
    into the display name); the key must not.
    """

    model_config = ConfigDict(extra="forbid")
    external_id: str = Field(min_length=1, max_length=255)
    display_name: str = Field(min_length=1, max_length=200)
    first_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    #: Rank key referencing the consuming station's own `roster.ranks` list — a key, never a
    #: label, so the publisher does not have to know how the station spells "Wachtmeister". A
    #: key the station does not know is reported (see `RosterOutcome.unknown_ranks`), never a
    #: reason to drop the person.
    rank: str | None = Field(default=None, pattern=RANK_PATTERN)
    #: False = still on file, no longer part of the operational roster. Consumers deactivate,
    #: never delete: old Einsätze and Rapporte keep resolving the name.
    active: bool = True
    identities: list[ExternalIdentity] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def _check(self) -> PersonEntry:
        if not self.external_id.strip():
            raise ValueError("'external_id' must not be blank")
        if not self.display_name.strip():
            raise ValueError(f"person {self.external_id}: 'display_name' must not be blank")
        seen: set[str] = set()
        for identity in self.identities:
            if identity.provider in seen:
                raise ValueError(f"person {self.external_id}: two identities for provider {identity.provider!r}")
            seen.add(identity.provider)
        return self


class RosterSnapshot(BaseModel):
    """A published roster file, whole.

    `complete` is the load-bearing flag. A complete snapshot is a statement about everyone, so
    a local person carrying this provider's identity and absent from the file has left, and a
    consumer may deactivate them. A partial snapshot says nothing about absence and a consumer
    must not act on it. Getting this wrong in the safe direction costs a stale name in a picker;
    getting it wrong in the other direction empties a station's roster from a truncated file.
    """

    model_config = ConfigDict(extra="forbid")

    schema_: Literal["roster-snapshot/1"] = Field(alias="schema")
    schema_version: Literal[1] = 1
    #: When the publisher built this file (RFC 3339, offset required). Consumers surface the age
    #: and warn when it stops moving — a snapshot that silently stopped updating is the failure
    #: mode a pull cannot see from the inside.
    generated_at: AwareDatetime
    #: The key identities from this file are filed under. One station may read two snapshots;
    #: this is what keeps them apart.
    provider: ProviderKey
    complete: bool
    #: Restated by the publisher and checked against `people`. A truncated file is the one
    #: failure that must never read as "most of the brigade left".
    count: int = Field(ge=1)
    people: list[PersonEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self) -> RosterSnapshot:
        if self.count != len(self.people):
            raise ValueError(f"'count' says {self.count} but the file carries {len(self.people)} people")
        seen: set[str] = set()
        for person in self.people:
            if person.external_id in seen:
                raise ValueError(f"duplicate external_id {person.external_id!r}")
            seen.add(person.external_id)
        pairs: set[tuple[str, str]] = set()
        for person in self.people:
            for identity in person.identities:
                pair = (identity.provider, identity.external_id)
                if pair in pairs:
                    raise ValueError(f"two people claim the identity {identity.provider}:{identity.external_id}")
                pairs.add(pair)
        return self


# ---------------------------------------------------------------------------------------
# what a consumer has to be able to say afterwards
# ---------------------------------------------------------------------------------------


UnmatchedReason = Literal[
    "no_identity_match",
    "ambiguous_name",
    "conflicting_identity",
    "absent_from_snapshot",
    "inactive_in_snapshot",
]


class UnmatchedEntry(BaseModel):
    """One person a run could not resolve, with the reason it could not."""

    model_config = ConfigDict(extra="forbid")
    external_id: str | None = None
    display_name: str
    reason: UnmatchedReason


class RosterOutcome(BaseModel):
    """The report one ingestion run must be able to produce.

    Unmapped people are **counted and flagged, never silently dropped** — a roster that quietly
    loses people corrupts every attendance figure derived from it afterwards, and does so
    invisibly. The contract therefore fixes the shape of the answer before anything implements
    the question: whatever a consumer's matching strategy turns out to be, it has to be able to
    fill this in, and `refused` exists so "I changed nothing, and here is why" is a first-class
    result rather than an empty run that looks successful.
    """

    model_config = ConfigDict(extra="forbid")

    schema_: Literal["roster-snapshot-outcome/1"] = Field(alias="schema")
    provider: ProviderKey
    snapshot_generated_at: AwareDatetime | None = None
    #: Set when the whole run was refused (a malformed file, a failed count check, a complete
    #: snapshot that would deactivate implausibly many people). Nothing was written.
    refused: str | None = None
    matched: int = Field(default=0, ge=0)
    created: int = Field(default=0, ge=0)
    updated: int = Field(default=0, ge=0)
    deactivated: int = Field(default=0, ge=0)
    #: People in the file the run could not place, and local people the file does not mention.
    unmatched: list[UnmatchedEntry] = Field(default_factory=list)
    #: Rank keys the file used that this station's `roster.ranks` does not define. The person is
    #: imported without a rank; the key is reported so the config can be fixed.
    unknown_ranks: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------------------


def _walk_keys(node: Any) -> list[str]:
    out: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            out.append(str(key))
            out.extend(_walk_keys(value))
    elif isinstance(node, list):
        for item in node:
            out.extend(_walk_keys(item))
    return out


def parse_snapshot(raw: bytes | str) -> RosterSnapshot:
    """Validate a whole snapshot document, or raise `ValueError` and accept none of it.

    Every check runs before a caller sees a single person, for the same reason
    `plans.parse_index` works that way: a file is a complete statement about a roster, and
    ingesting the good half of a bad one is the failure an operator cannot see.

    The medical-key scan runs over the *raw* document rather than the parsed model, so a key
    the schema would have rejected as unknown is refused with the reason that actually matters.
    """
    try:
        doc = json.loads(raw)
    except (ValueError, TypeError) as e:
        raise ValueError(f"snapshot is not valid JSON: {e}") from e
    if not isinstance(doc, dict):
        raise ValueError("snapshot must be a JSON object")

    for key in _walk_keys(doc):
        stem = medical_shaped(key)
        if stem is not None:
            raise ValueError(
                f"refusing the whole snapshot: key {key!r} looks like medical data (matched {stem!r}). "
                f"Roster snapshots carry no medical fields — see docs/CONFIGURATION.md §4c."
            )

    try:
        return RosterSnapshot.model_validate(doc)
    except ValidationError as e:
        lines = [f"snapshot failed validation ({e.error_count()} issue(s)):"]
        for err in e.errors():
            field = ".".join(str(p) for p in err["loc"]) or "(root)"
            lines.append(f"  {field}: {err['msg']} [{err['type']}]")
        raise ValueError("\n".join(lines)) from e


# ---------------------------------------------------------------------------------------
# the example
# ---------------------------------------------------------------------------------------

#: Invented people in an invented village, in the style the other examples invent places. Never
#: put a real roster in this repository — that is the whole reason station data lives elsewhere.
EXAMPLE_SNAPSHOT: dict[str, Any] = {
    "schema": SCHEMA_ID,
    "schema_version": SCHEMA_VERSION,
    "generated_at": "2026-08-02T04:00:00+00:00",
    "provider": "musterdorf-personalstamm",
    "complete": True,
    "count": 4,
    "people": [
        {
            "external_id": "pers-0001",
            "display_name": "Muster Hans",
            "first_name": "Hans",
            "last_name": "Muster",
            "rank": "maj",
            "active": True,
            "identities": [{"provider": "alarmierung", "external_id": "4711"}],
        },
        {
            "external_id": "pers-0002",
            "display_name": "Beispiel Anna",
            "first_name": "Anna",
            "last_name": "Beispiel",
            "rank": "wm",
            "active": True,
            "identities": [{"provider": "alarmierung", "external_id": "4712"}],
        },
        {
            "external_id": "pers-0003",
            "display_name": "Dorfmatt Peter",
            "first_name": "Peter",
            "last_name": "Dorfmatt",
            "rank": "fw",
            "active": True,
            "identities": [],
        },
        {
            "external_id": "pers-0004",
            "display_name": "Musterhalde Rita",
            "first_name": "Rita",
            "last_name": "Musterhalde",
            "rank": "fw",
            "active": False,
            "identities": [],
        },
    ],
}


# ---------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------


def snapshot_json_schema() -> dict[str, Any]:
    schema = RosterSnapshot.model_json_schema(by_alias=True)
    schema["$id"] = SCHEMA_ID
    return schema


def outcome_json_schema() -> dict[str, Any]:
    schema = RosterOutcome.model_json_schema(by_alias=True)
    schema["$id"] = OUTCOME_SCHEMA_ID
    return schema


def _dump(doc: dict[str, Any]) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.roster_snapshot",
        description="The roster-snapshot contract: print its schema, print an example, validate a file.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("schema", help="print the snapshot JSON Schema (the contract)")
    sub.add_parser("outcome-schema", help="print the JSON Schema of a consumer's reconciliation report")
    sub.add_parser("example", help="print a populated example snapshot")
    p_val = sub.add_parser("validate", help="validate a snapshot file (no DB, no network)")
    p_val.add_argument("file")

    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    if args.cmd == "schema":
        sys.stdout.write(_dump(snapshot_json_schema()))
        return 0
    if args.cmd == "outcome-schema":
        sys.stdout.write(_dump(outcome_json_schema()))
        return 0
    if args.cmd == "example":
        sys.stdout.write(_dump(EXAMPLE_SNAPSHOT))
        return 0

    path = Path(args.file)
    try:
        raw = path.read_bytes()
    except OSError as e:
        print(f"ERROR: cannot read {path}: {e}", file=sys.stderr)
        return 1
    try:
        snapshot = parse_snapshot(raw)
    except ValueError as e:
        print(f"ERROR: {path}: {e}", file=sys.stderr)
        return 1
    active = sum(1 for p in snapshot.people if p.active)
    kind = "complete" if snapshot.complete else "partial"
    print(
        f"OK: {kind} snapshot from {snapshot.provider!r}, {snapshot.count} people "
        f"({active} active), generated {snapshot.generated_at.isoformat()}. Nothing written."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
