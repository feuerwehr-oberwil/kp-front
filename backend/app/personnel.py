"""Divera247 Mannschaft (crew) sync service.

Fetches member names from the Divera *pull* API and reconciles them with the
``personnel`` table. The Divera member id is the stable key; display names are
snapshots. Stale members (a divera_id no longer returned by Divera) are deactivated
on request, never hard-deleted — old incidents/reports keep referencing them.

The diff (:func:`diff_members`) is pure so it can be unit-tested without a database.
"""

import logging
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import DeploymentConfig, Personnel, PersonnelExternalIdentity

logger = logging.getLogger(__name__)

# The member pull lives on a different host than the alarm API (settings.divera_api_url).
DIVERA_PULL_BASE_URL = "https://www.divera247.com/api/v2"

# Rank (Dienstgrad) source, verified 2026-07-01 against the real /pull/all: Divera has NO rank
# field. It DOES expose per-member Qualifikationen — but ONLY for a user whose read scope includes
# them (the alarm accesskey returns empty `qualifications`; the winfap/personnel key returns the
# real list). Each consumer's `qualifications` is a list of qualification IDs referencing
# `cluster.qualification` (id → {name, shortname}). We map those names against the station rank
# list and take the most senior match as the member's rank (see :func:`derive_rank_from_quals`).
# So rank is derived from Divera when the personnel key can see qualifications; otherwise it stays
# whatever it was (CSV import remains a fallback).


class _ExistingPerson(Protocol):
    id: object
    divera_id: int | None
    display_name: str
    rank: str | None
    is_active: bool


@dataclass
class ProviderPerson:
    """Canonical person plus the provider identity used by one adapter sync."""

    id: object
    divera_id: int | None
    display_name: str
    rank: str | None
    is_active: bool


async def provider_people(db: AsyncSession, provider: str) -> list[ProviderPerson]:
    """Load personnel through generic external identities.

    The deprecated column is a fallback only for databases in the migration window.
    """
    people = list((await db.execute(select(Personnel))).scalars())
    identities = list(
        (await db.execute(
            select(PersonnelExternalIdentity).where(PersonnelExternalIdentity.provider == provider)
        )).scalars()
    )
    external_by_person = {identity.personnel_id: identity.external_id for identity in identities}
    out: list[ProviderPerson] = []
    for person in people:
        raw = external_by_person.get(person.id)
        legacy = person.divera_id if provider == "divera" else None
        try:
            provider_id = int(raw) if raw is not None else legacy
        except (TypeError, ValueError):
            provider_id = None
        out.append(ProviderPerson(person.id, provider_id, person.display_name, person.rank, person.is_active))
    return out


async def attach_external_identity(
    db: AsyncSession, *, person: Personnel, provider: str, external_id: str, metadata: dict | None = None
) -> PersonnelExternalIdentity:
    identity = (
        await db.execute(
            select(PersonnelExternalIdentity).where(
                PersonnelExternalIdentity.provider == provider,
                PersonnelExternalIdentity.external_id == external_id,
            )
        )
    ).scalar_one_or_none()
    if identity is None:
        identity = PersonnelExternalIdentity(
            personnel_id=person.id, provider=provider, external_id=external_id, metadata_json=metadata
        )
        db.add(identity)
    else:
        identity.personnel_id = person.id
        identity.metadata_json = metadata
        identity.synced_at = datetime.now(UTC)
    return identity


def normalize_name(name: str) -> str:
    """Lowercase, strip accents, collapse whitespace — for name-based comparison."""
    name = " ".join(name.split()).strip().lower()
    name = unicodedata.normalize("NFD", name)
    return "".join(c for c in name if unicodedata.category(c) != "Mn")


def format_name(stdformat_name: str, firstname: str, lastname: str) -> str | None:
    """Build the full display name as ``"Lastname Firstname"`` (so the list sorts/searches by
    surname). ``stdformat_name`` arrives from Divera as ``"Lastname, Firstname"``. The map's
    Trupp chip abbreviates this client-side; everywhere else uses the full name.
    """
    last, first = "", ""
    if stdformat_name:
        parts = stdformat_name.split(",", 1)
        if len(parts) == 2:
            last, first = parts[0].strip(), parts[1].strip()
        else:
            last = stdformat_name.strip()
    last = last or lastname.strip()
    first = first or firstname.strip()
    if not last and not first:
        return None
    if last and first:
        return f"{last} {first}"
    return last or first or None


def match_rank(text: str, ranks: list[dict]) -> str | None:
    """Map a free-text CSV rank cell onto a config rank ``key``.

    Matches (accent/case/space-insensitively) against each rank's ``key``, ``label`` or
    ``abbr``. Returns the key, or ``None`` when blank/unmatched. Pure — the caller supplies
    the active rank list (see :func:`load_roster_ranks`)."""
    needle = normalize_name(text or "")
    if not needle:
        return None
    for r in ranks:
        candidates = (r.get("key"), r.get("label"), r.get("abbr"))
        if any(normalize_name(c) == needle for c in candidates if c):
            return r.get("key")
    return None


def derive_rank_from_quals(qual_names: list[str], ranks: list[dict]) -> str | None:
    """Pick a member's Dienstgrad from their Divera qualification names.

    Each qualification name is matched against the station rank list (:func:`match_rank`); the
    MOST SENIOR match wins (rank list is ordered senior-first, so lowest index). Members whose
    qualifications include no rank fall back to the base rank — the most junior entry in the
    list (e.g. Feuerwehrmann) — so the whole roster is ranked; returns ``None`` only when the
    list is empty. Pure."""
    if not ranks:
        return None
    best_idx = None
    for name in qual_names:
        key = match_rank(name, ranks)
        if key is None:
            continue
        idx = next((i for i, r in enumerate(ranks) if r.get("key") == key), None)
        if idx is not None and (best_idx is None or idx < best_idx):
            best_idx = idx
    if best_idx is not None:
        return ranks[best_idx]["key"]
    return ranks[-1]["key"]  # base rank — everyone is at least this


async def load_roster_ranks(db: AsyncSession) -> list[dict]:
    """The active station rank list (stored config → in-code default), for import mapping.

    Reads the singleton deployment-config row; falls back to the shipped Swiss default when a
    station hasn't configured ``roster.ranks`` (mirrors the frontend fallback in rank.ts)."""
    from .admin_config import EXAMPLE_CONFIG  # local import avoids an import cycle

    row = (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()
    ranks = ((row.config_json or {}).get("roster", {}) or {}).get("ranks") if row else None
    if ranks:
        return ranks
    return EXAMPLE_CONFIG["roster"]["ranks"]


async def fetch_divera_members() -> list[dict]:
    """Fetch crew members from the Divera pull API.

    Uses ``divera_personnel_access_key`` when set (it can see Qualifikationen), else the alarm
    ``divera_access_key``. Returns dicts with ``divera_id``, ``name``, ``first_name``,
    ``last_name`` and ``qualifications`` (the member's qualification NAMES, resolved via the
    cluster catalogue — empty list when the key can't see them). Rank is derived from these at
    sync time.
    """
    access_key = settings.divera_personnel_access_key or settings.divera_access_key
    if not access_key:
        raise ValueError("Divera access key not configured")

    url = f"{DIVERA_PULL_BASE_URL}/pull/all"
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, params={"accesskey": access_key})
        response.raise_for_status()
        data = response.json()

    if not data.get("success"):
        raise ValueError("Divera API returned success=false")

    cluster = data.get("data", {}).get("cluster", {})
    # qualification catalogue: id → name (ints keyed by string ids)
    qual_names: dict[int, str] = {}
    for qid_str, q in (cluster.get("qualification") or {}).items():
        try:
            qual_names[int(qid_str)] = (q or {}).get("name") or ""
        except (ValueError, TypeError):
            continue

    consumer = cluster.get("consumer", {})
    members: list[dict] = []
    for member_id_str, info in consumer.items():
        if not isinstance(info, dict):
            continue
        try:
            divera_id = int(member_id_str)
        except (ValueError, TypeError):
            continue
        firstname = (info.get("firstname") or "").strip()
        lastname = (info.get("lastname") or "").strip()
        name = format_name((info.get("stdformat_name") or "").strip(), firstname, lastname)
        if not name:
            continue
        # `qualifications` is a list of ids (or {id,…} objects) → resolve to catalogue names
        quals: list[str] = []
        for q in info.get("qualifications") or []:
            qid = q.get("id") if isinstance(q, dict) else q
            try:
                nm = qual_names.get(int(qid))
            except (ValueError, TypeError):
                nm = None
            if nm:
                quals.append(nm)
        members.append(
            {
                "divera_id": divera_id,
                "name": name,
                "first_name": firstname or None,
                "last_name": lastname or None,
                "qualifications": quals,
            }
        )

    logger.info("Fetched %d members from Divera", len(members))
    return members


def diff_members(members: list[dict], existing: list[_ExistingPerson]) -> dict:
    """Reconcile freshly-fetched Divera members against existing personnel by divera_id.

    Returns serializable categories: ``new`` (insert), ``updated`` (name/rank changed or
    currently inactive → reactivate), ``unchanged``, and ``stale`` (an active row whose
    divera_id is gone from Divera). Manually-added crew (divera_id is None) are never stale.

    Rank is compared ONLY for members carrying a ``"rank"`` key (set upstream when the feed
    could see qualifications). When the key is absent (restricted access → no qualifications),
    rank is left out of the diff entirely, so a sync never wipes a CSV/admin-set rank.
    """
    by_divera: dict[int, _ExistingPerson] = {p.divera_id: p for p in existing if p.divera_id is not None}
    seen_divera: set[int] = set()
    new, updated, unchanged = [], [], []

    for m in members:
        did = m["divera_id"]
        seen_divera.add(did)
        rank_known = "rank" in m
        rank = m.get("rank")
        person = by_divera.get(did)
        if person is None:
            new.append({"divera_id": did, "name": m["name"], **({"rank": rank} if rank_known else {})})
        elif (
            person.display_name != m["name"]
            or not person.is_active
            or (rank_known and getattr(person, "rank", None) != rank)
        ):
            updated.append(
                {
                    "id": str(person.id),
                    "divera_id": did,
                    "name": m["name"],
                    "was_inactive": not person.is_active,
                    **({"rank": rank} if rank_known else {}),
                }
            )
        else:
            unchanged.append({"id": str(person.id), "divera_id": did, "name": m["name"]})

    stale = [
        {"id": str(p.id), "name": p.display_name}
        for p in existing
        if p.divera_id is not None and p.divera_id not in seen_divera and p.is_active
    ]
    return {"new": new, "updated": updated, "unchanged": unchanged, "stale": stale}


async def _resolve_ranks(members: list[dict], db: AsyncSession) -> None:
    """In place: derive each member's rank from their qualifications, IF the feed carried any.

    A key that can't see qualifications returns them empty for everyone — in that case we leave
    ``rank`` unset on the member dicts so the sync doesn't touch existing ranks."""
    if not any(m.get("qualifications") for m in members):
        return
    ranks = await load_roster_ranks(db)
    for m in members:
        m["rank"] = derive_rank_from_quals(m.get("qualifications") or [], ranks)


async def build_sync_preview(db: AsyncSession) -> dict:
    """Fetch from Divera and diff against the DB — read-only, no writes."""
    members = await fetch_divera_members()
    await _resolve_ranks(members, db)
    existing = await provider_people(db, "divera")
    return diff_members(members, existing)


async def execute_sync(db: AsyncSession, *, deactivate_stale: bool) -> dict:
    """Fetch, diff, and apply in one transaction. Returns applied counts.

    Rank is derived from Divera qualifications when the personnel key can see them (authoritative
    then); if it can't, existing ranks are preserved untouched.
    """
    members = await fetch_divera_members()
    await _resolve_ranks(members, db)
    by_member = {m["divera_id"]: m for m in members}
    existing = await provider_people(db, "divera")
    diff = diff_members(members, existing)
    canonical = list((await db.execute(select(Personnel))).scalars())
    by_id = {str(p.id): p for p in canonical}

    for item in diff["new"]:
        m = by_member[item["divera_id"]]
        person = Personnel(
            display_name=m["name"], first_name=m["first_name"], last_name=m["last_name"],
            rank=m.get("rank"), is_active=True,
        )
        db.add(person)
        await db.flush()
        await attach_external_identity(
            db, person=person, provider="divera", external_id=str(m["divera_id"]),
            metadata={"first_name": m["first_name"], "last_name": m["last_name"]},
        )
    reactivated = 0
    for item in diff["updated"]:
        person = by_id[item["id"]]
        m = by_member[item["divera_id"]]
        person.display_name = m["name"]
        person.first_name = m["first_name"]
        person.last_name = m["last_name"]
        if "rank" in m:
            person.rank = m["rank"]
        if not person.is_active:
            person.is_active = True
            reactivated += 1
        await attach_external_identity(
            db, person=person, provider="divera", external_id=str(m["divera_id"]),
            metadata={"first_name": m["first_name"], "last_name": m["last_name"]},
        )
    deactivated = 0
    if deactivate_stale:
        for item in diff["stale"]:
            by_id[item["id"]].is_active = False
            deactivated += 1

    return {
        "created": len(diff["new"]),
        "updated": len(diff["updated"]),
        "reactivated": reactivated,
        "unchanged": len(diff["unchanged"]),
        "deactivated": deactivated,
        "stale": len(diff["stale"]),
    }
