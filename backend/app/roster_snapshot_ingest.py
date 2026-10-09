"""Reading a roster snapshot into a station's own roster: the fetch and the reconciliation.

``roster_snapshot.py`` says what a published personnel file looks like. This module says what a
consumer DOES with one, and it is shared for the same reason the contract is: KP Front and KP
Rück each hold a byte-identical copy (pinned by checksum, diffed by kp-rück's
``roster-schema-drift`` job), so one file a station publishes lands the same way in both
products — the same people matched, the same ones created, the same ones held back, the same
outcome report. Neither app imports the other (``docs/RUNNING-BOTH.md``); a copy and a hash
hold them together, the arrangement the telemetry sanitiser already uses.

Everything in here is the part that must not differ between the two products. What may differ
— where the source address is configured, how a person row is written, where the last report
is kept, which button triggers a run — stays in each app's own wrapper, which calls
:func:`read_source` and :func:`reconcile` and then applies the returned plan to its own tables.

Two halves:

* :func:`read_source` fetches the bytes from an ``https://`` URL (optionally with a bearer
  token) or from an absolute local path. Its errors are worded without the address or the
  token, because they end up on an admin status card.
* :func:`reconcile` is pure: snapshot bytes plus the station's current people in, a plan plus
  the outcome report (``roster-snapshot-outcome/1``) out. No session, no clock, no network —
  which is what lets both products test the same rules the same way.

THE SAFETY RULES, AND WHY EACH ONE
----------------------------------
A roster feed that quietly goes wrong corrupts every attendance list and every Trupp picker
built on it, at 3am, invisibly. So the rules are written to fail towards «nothing changed»:

* **A bad file changes nothing.** A fetch that fails, a document that does not validate, a
  document carrying a medical-shaped key (the contract's guard) — the whole run is refused
  and the roster stays exactly as the last good snapshot left it.
* **Never deactivate implausibly many at once.** A complete snapshot that would deactivate more
  than ``max_deactivate_pct`` of the currently active people is HELD: nothing is written and
  the outcome says why. A truncated export or a filter left on in the HR system looks exactly
  like «a third of the brigade resigned», and the cost of guessing wrong is a station with no
  names in its pickers. A held run is released by a human (``force``), never by waiting.
* **Never empty the roster.** Even when forced, a run that would leave no active person is
  refused.
* **Never travel back in time.** A snapshot older than the one already applied is refused — a
  stale mirror or a cached copy must not undo a newer file — and so is one stamped more than
  ``FUTURE_TOLERANCE_MIN`` in the future, which would otherwise make every later file «older».
  ``force`` (an admin, by hand) overrides the «older» check, so a wrong last-good can be cleared.
* **Nobody is taken off while on duty.** A person the app reports busy (checked in to or
  assigned in an open operation) keeps their place; the deactivation is postponed, reported,
  and applied by a later run.
* **Another feed's names are not renamed.** People linked to a provider in ``keep_names_for``
  (Divera, while its sync runs and owns those names) keep the name they have.
* **Deactivate, never delete.** Old Einsätze and Rapporte keep resolving the name.
* **Only people the snapshot owns can be deactivated by absence.** «Absent from a complete
  file» applies only to people carrying THIS provider's identity. Hand-entered people and
  people only Divera knows are never touched by absence.

HOW A PERSON IN THE FILE FINDS A LOCAL PERSON
---------------------------------------------
In this order, and the first rule that decides wins:

1. **The snapshot's own key** — ``(provider, external_id)`` already in
   ``personnel_external_identities``.
2. **Any identity the entry lists** — e.g. ``("divera", "4711")``. This is how a station that
   ran on Divera adopts a snapshot without duplicating anybody: the person the Divera sync
   created is found by their Divera id and gets the snapshot's key attached beside it.
3. **The name**, only when exactly ONE local person carries it and that person is not already
   claimed by another key of the same provider. Two candidates is ``ambiguous_name`` — linking
   the wrong one would be permanent, because the link is what later decides deactivation.

An entry whose identities point at two different local people, or at a person who already holds
a DIFFERENT id at that provider — also when that person was only found by name — is
``conflicting_identity`` and skipped whole; it never becomes a second person of the same name. **An existing
identity link is never overwritten** — not the Divera one, not any other. A person whose id
changed in the source needs a human, and the outcome report names them.

WHAT IS WRITTEN TO A MATCHED PERSON
-----------------------------------
The display name (always), first and last name when the file carries them, the rank when the
file carries a key the station knows (an unknown key is reported and the stored rank left
alone — a sync never wipes a rank), active/inactive, and any identity links the person did not
have yet. Nothing else: there is nothing else in the contract to write.
"""

from __future__ import annotations

import asyncio
import hashlib
import unicodedata
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import httpx

from .roster_snapshot import PersonEntry, RosterOutcome, RosterSnapshot, UnmatchedEntry, parse_snapshot

#: How large a published roster may be. A brigade of 200 is ~60 KB of JSON; this is room for a
#: whole cantonal register and still small enough that a wrong URL pointing at a video file is
#: refused instead of read into memory.
SOURCE_MAX_BYTES = 5_000_000
FETCH_TIMEOUT_SECONDS = 30.0

#: The defaults both products ship. Hourly is «modest»: a roster changes a few times a month,
#: and the on-demand run covers «we just added somebody and need them on the board now».
DEFAULT_INTERVAL_MIN = 60
#: More than this share of the active people deactivated in one run is held for a human.
DEFAULT_MAX_DEACTIVATE_PCT = 20
#: A publisher whose `generated_at` stops moving for this long gets a warning, not a refusal —
#: the file is still the best roster we have, it is just not getting newer.
STALE_AFTER_DAYS = 7
#: How far a publisher's clock may run ahead before its file is refused as «from the future».
FUTURE_TOLERANCE_MIN = 5

#: How many unmatched people a stored status lists by name (the count is always complete).
STATUS_UNMATCHED_MAX = 100
#: The longest `refused` line kept in a report.
_REFUSED_MAX = 600

SourceKind = Literal["url", "file"]


class SnapshotSourceError(ValueError):
    """The snapshot could not be read. The message never carries the address or the token:
    it is shown on an admin status card and written to logs."""


def source_kind(source: str) -> SourceKind | None:
    """`url` for http(s), `file` for an absolute path or ``file://`` URL, None otherwise."""
    s = source.strip()
    if s.startswith(("https://", "http://")):
        return "url"
    if s.startswith("file://") or Path(s).is_absolute():
        return "file"
    return None


def _file_path(source: str) -> Path:
    s = source.strip()
    if s.startswith("file://"):
        s = s[len("file://") :]
    return Path(s)


async def read_source(
    source: str,
    token: str | None = None,
    *,
    fetch_timeout: float = FETCH_TIMEOUT_SECONDS,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    """Read the snapshot's bytes from a URL or an absolute local path.

    A bearer token is only ever sent over https: over plain http it would cross the network in
    the clear, which is the one way to make a read-only personnel feed leak a credential. httpx
    drops the Authorization header on a redirect to another origin, so a publisher that
    redirects to a CDN does not receive it either.
    """
    kind = source_kind(source)
    if kind is None:
        raise SnapshotSourceError("source is neither an http(s):// address nor an absolute file path")
    if kind == "file":
        path = _file_path(source)
        try:
            size = path.stat().st_size
            if size > SOURCE_MAX_BYTES:
                raise SnapshotSourceError(f"file is too large ({size} bytes, at most {SOURCE_MAX_BYTES})")
            # Off the event loop: a slow network mount must not stall every request meanwhile.
            return await asyncio.to_thread(path.read_bytes)
        except FileNotFoundError:
            raise SnapshotSourceError("file not found") from None
        except PermissionError:
            raise SnapshotSourceError("file not readable (permission denied)") from None
        except IsADirectoryError:
            raise SnapshotSourceError("path is a directory, not a file") from None
        except OSError as e:
            raise SnapshotSourceError(f"file not readable ({type(e).__name__})") from None

    url = source.strip()
    headers = {"Accept": "application/json"}
    if token:
        if not url.startswith("https://"):
            raise SnapshotSourceError("a token is only ever sent over https://")
        headers["Authorization"] = f"Bearer {token}"
    try:
        async with (
            httpx.AsyncClient(timeout=fetch_timeout, follow_redirects=True, transport=transport) as client,
            client.stream("GET", url, headers=headers) as response,
        ):
            if response.status_code != 200:
                raise SnapshotSourceError(f"fetch failed: HTTP {response.status_code}")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > SOURCE_MAX_BYTES:
                    raise SnapshotSourceError(f"response is too large (more than {SOURCE_MAX_BYTES} bytes)")
                chunks.append(chunk)
            return b"".join(chunks)
    except httpx.TimeoutException:
        raise SnapshotSourceError("fetch failed: timeout") from None
    except httpx.HTTPError as e:
        # Never str(e): httpx puts the URL into its messages, and the URL may carry a query token.
        raise SnapshotSourceError(f"fetch failed: {type(e).__name__}") from None


def digest(raw: bytes) -> str:
    """The sha256 a run records, so an unchanged file can be recognised without re-reading it."""
    return hashlib.sha256(raw).hexdigest()


# ---------------------------------------------------------------------------------------
# the station's side, as the reconciliation sees it
# ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class LocalPerson:
    """One person as the consuming app holds them — whatever its own table looks like.

    ``id`` is opaque (each app passes its primary key as a string). ``identities`` maps a
    provider to that provider's id for this person. ``active`` is the app's notion of «on the
    roster»; ``rank`` the rank key the app last stored, or None. Pass people OLDEST FIRST — it
    is the order the name rule reads them in.
    """

    id: str
    display_name: str
    first_name: str | None = None
    last_name: str | None = None
    rank: str | None = None
    active: bool = True
    identities: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class LastGood:
    """What the last APPLIED snapshot was. Kept by the app between runs (anywhere it likes);
    losing it costs one idempotent re-apply and the time-travel guard for one run."""

    provider: str
    generated_at: str
    sha256: str
    count: int

    def as_json(self) -> dict[str, Any]:
        return {"provider": self.provider, "generatedAt": self.generated_at, "sha256": self.sha256, "count": self.count}

    @classmethod
    def from_json(cls, doc: Mapping[str, Any] | None) -> LastGood | None:
        if not doc:
            return None
        try:
            return cls(str(doc["provider"]), str(doc["generatedAt"]), str(doc["sha256"]), int(doc["count"]))
        except (KeyError, TypeError, ValueError):
            return None


@dataclass
class PersonWrite:
    """What one entry of the file does to the roster."""

    external_id: str
    #: the local person this writes to; None = a new person
    person_id: str | None
    display_name: str
    #: only the fields that change (all of them for a new person). Keys: display_name,
    #: first_name, last_name, rank
    fields: dict[str, str | None]
    #: back on the roster (an inactive person the file lists as active)
    reactivate: bool = False
    #: identity links to attach, (provider, external_id) — never one the person already has
    links: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Deactivation:
    person_id: str
    display_name: str
    external_id: str | None
    reason: Literal["absent_from_snapshot", "inactive_in_snapshot"]


@dataclass
class Reconciliation:
    """The plan for one run, and the report it produces. ``refused`` / ``held`` / ``unchanged``
    plans carry no writes — apply nothing and record the outcome."""

    outcome: RosterOutcome
    snapshot: RosterSnapshot | None = None
    sha256: str | None = None
    creates: list[PersonWrite] = field(default_factory=list)
    updates: list[PersonWrite] = field(default_factory=list)
    deactivations: list[Deactivation] = field(default_factory=list)
    #: deactivations held back because the person is on duty right now (``busy_ids``) — not
    #: written, not counted against the cap; a later run applies them once the person is free
    postponed: list[Deactivation] = field(default_factory=list)
    #: refused because it would deactivate too many — releasable with ``force``
    held: bool = False
    #: the same bytes as the last applied snapshot; nothing to do
    unchanged: bool = False
    #: the publisher's file has not moved for STALE_AFTER_DAYS
    stale: bool = False
    active_before: int = 0
    deactivation_limit: int | None = None

    @property
    def refused(self) -> str | None:
        return self.outcome.refused

    @property
    def last_good(self) -> LastGood | None:
        """What to remember after APPLYING this plan (None when nothing was applied)."""
        if self.snapshot is None or self.sha256 is None or self.refused is not None:
            return None
        return LastGood(
            provider=self.snapshot.provider,
            generated_at=self.snapshot.generated_at.isoformat(),
            sha256=self.sha256,
            count=self.snapshot.count,
        )


def name_key(name: str) -> str:
    """Lowercase, umlauts and accents folded, whitespace collapsed — «Müller  Hans» = «muller hans»."""
    lowered = " ".join(name.split()).lower()
    decomposed = unicodedata.normalize("NFD", lowered)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")


def _local_names(person: LocalPerson) -> set[str]:
    names = {name_key(person.display_name)}
    first, last = (person.first_name or "").strip(), (person.last_name or "").strip()
    if first and last:
        names |= {name_key(f"{last} {first}"), name_key(f"{first} {last}")}
    return {n for n in names if n}


def _entry_names(entry: PersonEntry) -> set[str]:
    names = {name_key(entry.display_name)}
    first, last = (entry.first_name or "").strip(), (entry.last_name or "").strip()
    if first and last:
        names |= {name_key(f"{last} {first}"), name_key(f"{first} {last}")}
    return {n for n in names if n}


def deactivation_limit(active_before: int, max_pct: int) -> int:
    """How many deactivations one run may apply unheld. 0 % = none, 100 % = no cap. Otherwise
    at least one, so a station of five can still lose one member without a human."""
    if max_pct <= 0:
        return 0
    if max_pct >= 100:
        return active_before
    return max(1, active_before * max_pct // 100)


def _refuse(provider: str, reason: str, *, generated_at: datetime | None = None) -> RosterOutcome:
    return RosterOutcome.model_validate(
        {
            "schema": "roster-snapshot-outcome/1",
            "provider": provider,
            "snapshot_generated_at": generated_at,
            "refused": reason[:_REFUSED_MAX],
        }
    )


def refused_outcome(reason: str, *, last_good: LastGood | None = None) -> RosterOutcome:
    """The report for a run that never got as far as a document (the fetch failed).
    ``provider`` is required by the outcome schema, so the last good one stands in."""
    return _refuse(last_good.provider if last_good else "unknown", reason)


def reconcile(
    raw: bytes | str,
    people: Sequence[LocalPerson],
    *,
    known_ranks: Collection[str] | None,
    max_deactivate_pct: int = DEFAULT_MAX_DEACTIVATE_PCT,
    last_good: LastGood | None = None,
    force: bool = False,
    skip_unchanged: bool = False,
    now: datetime | None = None,
    busy_ids: Collection[str] = (),
    keep_names_for: Collection[str] = (),
) -> Reconciliation:
    """Decide what one snapshot does to ``people``. Pure; see the module docstring for the rules.

    ``known_ranks`` = the rank keys the station defines (None = accept any key). ``force``
    releases a held run (the deactivation cap) and the «older than applied» guard — the human
    answer to a last-good that is wrong — never the other refusals. ``skip_unchanged`` returns
    an ``unchanged`` plan when the bytes equal ``last_good`` — what an unattended poll wants; an
    on-demand run passes False so a changed rank list is picked up. ``now`` (aware) enables the
    stale flag and the «generated in the future» refusal.

    ``busy_ids`` are people the app knows are on duty right now (checked in to, or assigned in,
    an operation that is still open): their deactivation is POSTPONED — listed in ``postponed``
    and applied by a later run once they are free. ``keep_names_for`` names providers whose
    linked people keep the names they have: when another feed owns the name (and may match on
    it), a snapshot must not rename under it.
    """
    raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else raw
    sha = digest(raw_bytes)
    provider_fallback = last_good.provider if last_good else "unknown"
    try:
        snap = parse_snapshot(raw_bytes)
    except ValueError as e:
        return Reconciliation(outcome=_refuse(provider_fallback, str(e)), sha256=sha)

    stale = now is not None and (now - snap.generated_at).days >= STALE_AFTER_DAYS
    if now is not None and snap.generated_at > now + timedelta(minutes=FUTURE_TOLERANCE_MIN):
        # Accepted once, a future stamp would make every later, correct file «older than the one
        # applied» — a feed that blocks itself for as long as the publisher's clock was wrong.
        return Reconciliation(
            outcome=_refuse(
                snap.provider,
                f"generated_at {snap.generated_at.isoformat()} is in the future — check the publisher's clock",
                generated_at=snap.generated_at,
            ),
            snapshot=snap,
            sha256=sha,
        )

    if last_good is not None and last_good.provider == snap.provider:
        try:
            previous = datetime.fromisoformat(last_good.generated_at)
        except ValueError:
            previous = None
        if previous is not None and snap.generated_at < previous and not force:
            return Reconciliation(
                outcome=_refuse(
                    snap.provider,
                    f"older than the snapshot already applied ({snap.generated_at.isoformat()} < "
                    f"{last_good.generated_at}) — a stale copy must not undo a newer file",
                    generated_at=snap.generated_at,
                ),
                snapshot=snap,
                sha256=sha,
                stale=stale,
            )
        if skip_unchanged and last_good.sha256 == sha:
            outcome = RosterOutcome.model_validate(
                {
                    "schema": "roster-snapshot-outcome/1",
                    "provider": snap.provider,
                    "snapshot_generated_at": snap.generated_at,
                }
            )
            return Reconciliation(outcome=outcome, snapshot=snap, sha256=sha, unchanged=True, stale=stale)

    provider = snap.provider
    by_identity: dict[tuple[str, str], LocalPerson] = {}
    for person in people:
        for prov, ext in person.identities.items():
            by_identity.setdefault((prov, ext), person)
    by_name: dict[str, list[LocalPerson]] = {}
    for person in people:
        for key in _local_names(person):
            by_name.setdefault(key, []).append(person)

    known = None if known_ranks is None else set(known_ranks)
    unknown_ranks: list[str] = []
    unmatched: list[UnmatchedEntry] = []
    claimed: dict[str, str] = {}  # person id → external_id of the entry that took them
    placed: dict[str, LocalPerson | None] = {}  # external_id → person (None = create)

    def _pairs(entry: PersonEntry) -> list[tuple[str, str]]:
        pairs = [(provider, entry.external_id)]
        pairs += [(i.provider, i.external_id) for i in entry.identities if (i.provider, i.external_id) not in pairs]
        return pairs

    def _conflicts(entry: PersonEntry, person: LocalPerson) -> bool:
        return any(person.identities.get(p, x) != x for p, x in _pairs(entry))

    def _skip(entry: PersonEntry, reason: Any) -> None:
        unmatched.append(UnmatchedEntry(external_id=entry.external_id, display_name=entry.display_name, reason=reason))

    # Pass 1 — identities. Run over the whole file first, so the name rule below can never hand
    # a person to one entry who is another entry's by key.
    pending: list[PersonEntry] = []
    for entry in snap.people:
        hits = {by_identity[p].id: by_identity[p] for p in _pairs(entry) if p in by_identity}
        if len(hits) > 1:
            _skip(entry, "conflicting_identity")
            continue
        if len(hits) == 1:
            person = next(iter(hits.values()))
            if _conflicts(entry, person) or person.id in claimed:
                _skip(entry, "conflicting_identity")
                continue
            claimed[person.id] = entry.external_id
            placed[entry.external_id] = person
            continue
        pending.append(entry)

    # Pass 2 — names, for what the keys did not place.
    for entry in pending:
        candidates: dict[str, LocalPerson] = {}
        conflicted: set[str] = set()
        for key in _entry_names(entry):
            for person in by_name.get(key, []):
                if provider in person.identities or person.id in claimed:
                    continue
                if _conflicts(entry, person):
                    # Same name, a DIFFERENT id at a provider the entry lists: a namesake, or an
                    # id that changed at the source. A human decides — creating a second
                    # «Muster Hans» is the one answer that is surely wrong.
                    conflicted.add(person.id)
                    continue
                candidates[person.id] = person
        if len(candidates) + len(conflicted) > 1:
            _skip(entry, "ambiguous_name")
            continue
        if conflicted:
            _skip(entry, "conflicting_identity")
            continue
        if len(candidates) == 1:
            person = next(iter(candidates.values()))
            claimed[person.id] = entry.external_id
            placed[entry.external_id] = person
            continue
        if not entry.active:
            _skip(entry, "inactive_in_snapshot")
            continue
        placed[entry.external_id] = None

    creates: list[PersonWrite] = []
    updates: list[PersonWrite] = []
    deactivations: list[Deactivation] = []
    matched = 0
    for entry in snap.people:
        if entry.external_id not in placed:
            continue
        target = placed[entry.external_id]
        rank: str | None = None
        if entry.rank is not None:
            if known is None or entry.rank in known:
                rank = entry.rank
            elif entry.rank not in unknown_ranks:
                unknown_ranks.append(entry.rank)
        if target is None:
            creates.append(
                PersonWrite(
                    external_id=entry.external_id,
                    person_id=None,
                    display_name=entry.display_name,
                    fields={
                        "display_name": entry.display_name,
                        "first_name": entry.first_name,
                        "last_name": entry.last_name,
                        "rank": rank,
                    },
                    links=_pairs(entry),
                )
            )
            continue
        matched += 1
        changes: dict[str, str | None] = {}
        if not any(p in target.identities for p in keep_names_for):
            if entry.display_name != target.display_name:
                changes["display_name"] = entry.display_name
            if entry.first_name is not None and entry.first_name != target.first_name:
                changes["first_name"] = entry.first_name
            if entry.last_name is not None and entry.last_name != target.last_name:
                changes["last_name"] = entry.last_name
        if rank is not None and rank != target.rank:
            changes["rank"] = rank
        links = [(p, x) for p, x in _pairs(entry) if p not in target.identities]
        reactivate = entry.active and not target.active
        if changes or links or reactivate:
            updates.append(
                PersonWrite(
                    external_id=entry.external_id,
                    person_id=target.id,
                    display_name=entry.display_name,
                    fields=changes,
                    reactivate=reactivate,
                    links=links,
                )
            )
        if not entry.active and target.active:
            deactivations.append(
                Deactivation(target.id, target.display_name, entry.external_id, "inactive_in_snapshot")
            )

    if snap.complete:
        listed = {entry.external_id for entry in snap.people}
        for person in people:
            own_id = person.identities.get(provider)
            if own_id is None or own_id in listed or not person.active or person.id in claimed:
                continue
            deactivations.append(Deactivation(person.id, person.display_name, own_id, "absent_from_snapshot"))
            unmatched.append(
                UnmatchedEntry(external_id=own_id, display_name=person.display_name, reason="absent_from_snapshot")
            )

    busy = set(busy_ids)
    postponed = [d for d in deactivations if d.person_id in busy]
    deactivations = [d for d in deactivations if d.person_id not in busy]

    active_before = sum(1 for p in people if p.active)
    limit = deactivation_limit(active_before, max_deactivate_pct)
    active_after = active_before - len(deactivations) + len(creates) + sum(1 for u in updates if u.reactivate)
    base = {
        "schema": "roster-snapshot-outcome/1",
        "provider": provider,
        "snapshot_generated_at": snap.generated_at,
        "unmatched": unmatched,
        "unknown_ranks": unknown_ranks,
    }
    if active_before > 0 and active_after <= 0:
        reason = (
            f"would leave no active person ({len(deactivations)} of {active_before} deactivated) — "
            f"a roster is never emptied by a feed"
        )
        return Reconciliation(
            outcome=RosterOutcome.model_validate({**base, "refused": reason}),
            snapshot=snap,
            sha256=sha,
            stale=stale,
            deactivations=deactivations,
            postponed=postponed,
            active_before=active_before,
            deactivation_limit=limit,
        )
    if len(deactivations) > limit and not force:
        reason = (
            f"held: would deactivate {len(deactivations)} of {active_before} active people "
            f"(limit {limit}, {max_deactivate_pct} %) — nothing written; check the file, then apply it by hand"
        )
        return Reconciliation(
            outcome=RosterOutcome.model_validate({**base, "refused": reason}),
            snapshot=snap,
            sha256=sha,
            held=True,
            stale=stale,
            deactivations=deactivations,
            postponed=postponed,
            active_before=active_before,
            deactivation_limit=limit,
        )

    outcome = RosterOutcome.model_validate(
        {
            **base,
            "matched": matched,
            "created": len(creates),
            "updated": len(updates),
            "deactivated": len(deactivations),
        }
    )
    return Reconciliation(
        outcome=outcome,
        snapshot=snap,
        sha256=sha,
        creates=creates,
        updates=updates,
        deactivations=deactivations,
        postponed=postponed,
        stale=stale,
        active_before=active_before,
        deactivation_limit=limit,
    )


def status_json(
    rec: Reconciliation,
    *,
    trigger: str,
    last_good: LastGood | None,
    applied_at: str | None = None,
) -> dict[str, Any]:
    """The one status document both products keep after a run and show to an admin.

    ``lastGood`` is the snapshot the roster currently reflects — after a refused run it is the
    PREVIOUS one, unchanged, which is the «keep the last good snapshot» rule made visible.
    """
    good = rec.last_good or last_good
    outcome = rec.outcome.model_dump(mode="json", by_alias=True)
    # A status card lists names, not a register: the first ones and the total. The full list is
    # one on-demand run away and the counts above it are always complete.
    outcome["unmatched"] = outcome["unmatched"][:STATUS_UNMATCHED_MAX]
    return {
        "trigger": trigger,
        "outcome": outcome,
        "unmatchedTotal": len(rec.outcome.unmatched),
        "held": rec.held,
        "unchanged": rec.unchanged,
        "stale": rec.stale,
        "activeBefore": rec.active_before,
        "deactivationLimit": rec.deactivation_limit,
        "pendingDeactivations": len(rec.deactivations) if rec.refused else 0,
        "postponed": [{"display_name": d.display_name, "reason": d.reason} for d in rec.postponed],
        "lastGood": good.as_json() if good else None,
        "appliedAt": applied_at,
    }
