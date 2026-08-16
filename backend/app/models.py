"""SQLAlchemy ORM models for the whole kp-front backend.

All tables for Phases 1–7 plus the audit-trail capture substrate (sub-phase A) are
defined here so migrations stay coherent as features land. Roles are exactly two:
``editor`` (edit) and ``viewer`` (read-only).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


#: ``Incident.status`` values that mean the Einsatz is RUNNING. See `Incident.is_open`.
#:
#: Two, not one. "offen" is the column default every intake writes; "in_arbeit" is what an
#: editor sets once somebody is working it (PATCH /incidents/{id}, and the app labels it «In
#: Arbeit» in the Einsatz list). Both are live. Treating only "offen" as running quietly
#: revoked the Einsatz-Link — and hid Standort teilen — the moment an Einsatz was marked as
#: being worked on, which is the one moment it is most obviously not over.
INCIDENT_ACTIVE_STATUSES = ("offen", "in_arbeit")

#: The column default, for the intake paths that stamp it.
INCIDENT_OPEN_STATUS = "offen"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    pin_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="viewer")
    display_name: Mapped[str] = mapped_column(Text, nullable=False, default="")
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # start this login in the Einsatzleiter view (tactical editing locked, journal + detail
    # viewing stay live). A frontend DEFAULT the device toggle can override — not a role:
    # the user remains a full editor at the API.
    el_view_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (CheckConstraint("role in ('editor','viewer')", name="ck_users_role"),)


class RevokedToken(Base):
    """Persisted JWT blocklist: a logged-out / rotated token's ``jti`` stays revoked
    across restarts and instances until its own ``expires_at`` passes (then it's pruned).

    Generic column types only (no JSONB/postgres UUID) so the auth hot path's table is
    portable — it also stands up on SQLite for the test suite.
    """

    __tablename__ = "revoked_tokens"

    jti: Mapped[str] = mapped_column(String(64), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    revoked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# Provenance of ``Incident.started_at``. Part VIII of the estate architecture asks for
# marking at FIELD level rather than row level: the incident is real either way, but the
# alarm-time column is only externally sourced on some of them.
#   "alarm"  — the alerting system stamped it (Divera ``ts_create``, generic intake payload)
#   "manual" — a human typed or confirmed it (Einsatz-Wizard, Einsatzdaten correction)
#   NULL     — nobody supplied one; ``started_at`` is the row's insert time (record opened)
ALARM_TIME_SOURCES = ("alarm", "manual")


class Incident(Base):
    __tablename__ = "incidents"

    id: Mapped[uuid.UUID] = _uuid_pk()
    divera_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[str | None] = mapped_column(String(8), nullable=True)  # 'HIGH' | 'LOW'
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    lat: Mapped[float | None] = mapped_column(Numeric(10, 7), nullable=True)
    lng: Mapped[float | None] = mapped_column(Numeric(10, 7), nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="offen")
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # 'divera' | 'manual' | 'migrated' | intake slug
    # Foreign alarm id for generic (non-Divera) intake sources; dedupe key per source.
    source_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Created by an alarm without a human (auto-open / generic intake) — only such incidents
    # are eligible for the untouched-auto-archive sweep.
    # NB: plain-string server_default — `text` here is the Text column above, not sqlalchemy.text
    auto_opened: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default="false")
    # Alarmierungszeit — the moment the alarm went out, NOT the moment somebody opened the
    # record. Every surface (Rapport-PDF, Einsatzdaten-Panel, Statistik-Export) reads it as
    # the alarm time, so an intake path that leaves the server default standing is silently
    # publishing «when the tablet was picked up» under that name.
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Where started_at came from — see ALARM_TIME_SOURCES. NULL means nothing supplied an
    # alarm time and the server default stands, i.e. the value is the record-open time and
    # must NOT be read as an Alarmierungszeit. Honest null beats a plausible guess: a
    # downstream join keying on a fabricated alarm time is worse than one that skips the row.
    started_at_source: Mapped[str | None] = mapped_column(String(8), nullable=True)
    # Where the alarm came IN from, as the alerting system knew it — e.g. "alarmzentrale"
    # for a dispatch versus a member sending an SMS by hand. Both are legitimate alarms and
    # both look identical here otherwise, which is why the distinction is worth recording:
    # it is what lets a downstream consumer decide whether an Einsatz may reach a public
    # surface. A slug, never a phone number.
    #
    # WRITE-ONCE. Set on the first milestone that carries it and never overwritten, for the
    # same reason `editor_opened_at` is a latch: provenance is not an editable field, and a
    # late edit from an alerting system must not be able to rewrite where an alarm came from.
    #
    # NULL is an ordinary answer, not a missing one. An unlabelled allowlist entry, an alarm
    # the fallback relay handled during an outage (it cannot reach this app at all), and any
    # deployment whose alerting system does not send origins all produce NULL — and none of
    # them mean "not a real alarm". A consumer that treats NULL as suspicious is wrong.
    alarm_origin: Mapped[str | None] = mapped_column(String(32), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Übung — orthogonal to the VKF `type` (an exercise still has a category). Exercises are
    # excluded from the stats export by default and are the ONLY incidents that may be hard-
    # deleted; real Einsätze stay append-only.
    is_exercise: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default="false")
    # When the Abschluss-Assistent last marked the Rapport complete. Purely a bookmark:
    # «geändert nach Abschluss» is DERIVED (updated_at advanced past it), never stored.
    report_done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Cross-visibility (QR capture ↔ KP tablet). editor_opened_at is a LATCH: stamped once on
    # the first authenticated-editor workspace read/write («the KP tablet has this incident»),
    # never advanced — no last-active tracking. capture_writes/capture_last_at count successful
    # capture-surface writes (workspace PUT / journal append) for the tablet's «QR: N Einträge».
    editor_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    capture_writes: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default="0")
    capture_last_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    details_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    map_workspace_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    workspace_rev: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (Index("ix_incidents_archived_started", "is_archived", "started_at"),)

    @property
    def is_open(self) -> bool:
        """Still running — the one definition of it.

        Several features hang off this: the Einsatz-Link is revoked, self-reported crew
        positions are dropped, a phone may no longer report into it. They were hand-written
        copies of the same condition, which is the kind of drift that ends with a link
        outliving its Einsatz.

        ``is_archived`` is the state; ``closed_at`` is deliberately NOT consulted. That column
        is a TIMESTAMP — the first Einsatzende — kept across a reopen precisely so later
        journal rows can be rendered as Nachträge (see api/incidents.patch_incident, and
        lib/reminders + lib/report on the client, which read it as a moment in time). Reading
        it as a liveness flag meant a REACTIVATED Einsatz — an operator explicitly saying «this
        is running again» — stayed dead: its links refused, Standort teilen silently absent.
        Verified against production 2026-08-05. Archiving it, or moving `status` off an active
        one, still ends it immediately.
        """
        return not self.is_archived and self.status in INCIDENT_ACTIVE_STATUSES


# Partial-unique: only one incident per Divera alarm, but many manual incidents have
# NULL divera_id. Defined outside the class so `text` is the SQL helper, not the column.
Index(
    "ix_incidents_divera_id_unique",
    Incident.divera_id,
    unique=True,
    postgresql_where=text("divera_id IS NOT NULL"),
)

# Same idea for generic intake sources: one incident per (source, source_ref) so a retried
# webhook can't duplicate an Einsatz; manual incidents have NULL source_ref.
Index(
    "ix_incidents_source_ref_unique",
    Incident.source,
    Incident.source_ref,
    unique=True,
    postgresql_where=text("source_ref IS NOT NULL"),
)


class IncidentPerson(Base):
    __tablename__ = "incident_people"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str | None] = mapped_column(Text, nullable=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    contact: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class IncidentNote(Base):
    __tablename__ = "incident_notes"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    text: Mapped[str | None] = mapped_column(Text, nullable=True)


class DiveraEmergency(Base):
    __tablename__ = "divera_emergencies"

    id: Mapped[uuid.UUID] = _uuid_pk()
    divera_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False, index=True)
    divera_number: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    lat: Mapped[float | None] = mapped_column(Numeric(10, 7), nullable=True)
    lng: Mapped[float | None] = mapped_column(Numeric(10, 7), nullable=True)
    raw_payload_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Divera's own creation stamp for the alarm (unix seconds) — the ALARM time, as opposed
    # to ``received_at`` (when we heard about it) and ``ts_update`` (last edit upstream).
    # It is what an incident opened from this alarm inherits as its Alarmierungszeit.
    ts_create: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    ts_update: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    is_taken: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    taken_incident_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("incidents.id", ondelete="SET NULL"), nullable=True
    )
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)


class Personnel(Base):
    """Brigade crew member (Mannschaft), synced from Divera — the predefined people who
    get marked present and assigned into Atemschutz-Trupps. Distinct from ``User`` (the
    handful of operators who log into KP Front). ``divera_id`` is the stable key; the
    display name is a snapshot that may change when Divera names are edited.
    """

    __tablename__ = "personnel"

    id: Mapped[uuid.UUID] = _uuid_pk()
    divera_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    first_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Rank key referencing the per-station roster.ranks config list (e.g. "hptm"); NULL = no
    # rank. Imported from Divera/CSV, never hard-coded — labels/order/tier live in config.
    rank: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# Partial-unique: one row per Divera member, but manually-added crew carry NULL divera_id.
Index(
    "ix_personnel_divera_id_unique",
    Personnel.divera_id,
    unique=True,
    postgresql_where=text("divera_id IS NOT NULL"),
)


class PersonnelExternalIdentity(Base):
    """Opaque provider identity attached to a canonical local personnel record."""

    __tablename__ = "personnel_external_identities"
    __table_args__ = (
        UniqueConstraint("provider", "external_id", name="uq_personnel_external_provider_id"),
        UniqueConstraint("personnel_id", "provider", name="uq_personnel_external_person_provider"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    personnel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("personnel.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    external_id: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Media(Base):
    __tablename__ = "media"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # 'photo' | 'audio'
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SttJob(Base):
    """Speech-to-text job for one audio recording.

    ``segments`` are DRAFTS — working data, not record: each carries a per-segment
    ``status`` ('open' | 'confirmed' | 'dismissed'); confirming appends an ordinary journal
    row client-side and stamps the created row id back onto the segment. One job per media
    (a re-run replaces the previous result)."""

    __tablename__ = "stt_jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    media_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("media.id", ondelete="CASCADE"), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")  # queued|running|done|failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    segments: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # [{start,end,text,status,rowId?}]
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PrintJob(Base):
    """Queued Einsatzrapport-PDF for the station print relay.

    The backend composes the PDF at enqueue time; the on-site agent polls, claims the
    oldest ``queued`` row, prints it, and reports back. Rows are transient — the paper is
    the artefact — and are swept after ``PRINT_JOB_RETENTION_DAYS`` (scheduler.py)."""

    __tablename__ = "print_jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # 'report' | 'capture_report'
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    pdf: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # True only when the document renders the (coloured) Kroki — everything else prints
    # monochrome at the agent (toner/ink discipline; decided 2026-07-18)
    color: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="queued"
    )  # queued|printing|done|failed|cancelled
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ObjectSite(Base):
    """Einsatzobjekt — a pre-planned site carrying its own module plans."""

    __tablename__ = "objects"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    lat: Mapped[float | None] = mapped_column(Numeric(10, 7), nullable=True)
    lng: Mapped[float | None] = mapped_column(Numeric(10, 7), nullable=True)
    #: The station's own stable key for this object — whatever its pipeline calls the thing
    #: (a folder name, an Objekt-Nr, a row id). Optional and opaque: this app never parses it.
    #:
    #: It exists so an external producer can say "this plan belongs to that object" WITHOUT
    #: either side re-deriving the other's UUID. Before it, the scheduled plan pull compared
    #: the publisher's own object UUID against ours; the two id spaces overlap by zero, so it
    #: skipped every plan as unknown and fetched nothing — silently, because skipping is the
    #: safe branch. A station whose importer sets this gets a pull that matches; one that
    #: does not keeps uploading by hand, unaffected.
    source_key: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True, index=True)
    source_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ReferenceDataset(Base):
    __tablename__ = "reference_datasets"

    id: Mapped[str] = mapped_column(Text, primary_key=True)  # 'symbols:tactical', 'geo:hydrant', 'plan:<obj>:modul1'
    object_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("objects.id", ondelete="CASCADE"), nullable=True)
    module: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 'modul1'…'modul6'
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # 'pdf' | 'geojson' | 'symbols'
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_type: Mapped[str] = mapped_column(String(16), nullable=False, default="uploaded")
    source_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    feature_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    current_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    fetch_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    fetch_interval: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Checksum the SOURCE declared for the bytes currently stored here (sha256 hex, lowercase).
    # Set by the snapshot pull (app/plans.py) so a scheduled run can tell "unchanged" from
    # "changed" without downloading anything. NULL for hand-uploaded datasets — the upload path
    # has no upstream checksum to record, and NULL simply means "compare nothing, fetch it".
    source_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)


# --- Multi-station deployment config (Phase 1.A) ------------------------------------


class DeploymentConfig(Base):
    """Singleton row (id=1) holding the per-station deployment config document.

    ``config_json`` is the admin-edited JSON described in docs/CONFIGURATION.md §1
    (identity/map/referenceLayers/fleet/symbols/doctrine/roster). It is validated
    through the Pydantic schema in schemas.py before persistence.

    ⚠️ NO SECRET EVER GOES IN ``config_json``. ``GET /api/config`` is public and the Sicherung
    export/import round-trip replaces the whole document, so a secret in there would be both a
    leak and one bad import away from deletion. The station-level ones are columns below;
    integration credentials (Divera, Traccar, VAPID, STT, the webhooks, the monitor) live in
    ``integration_credentials``, encrypted — see app/credentials.py.
    """

    __tablename__ = "deployment_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    config_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Editor-authored (NOT admin) station plan-scale calibration: {default, byPlan}. Kept OUT of
    # config_json so an admin config push never wipes it and it isn't schema-validated as config.
    # Persists a once-off plan calibration across incidents/devices — see docs/CONFIGURATION.md.
    plan_scales_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Station-level capture secret (the Erfassungs-Poster QR). NOT part of config_json —
    # GET /api/config is public and must never leak it. NULL = capture disabled (fail-closed);
    # rotating replaces it, invalidating every printed poster at once.
    capture_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Statistics-export token (read-only GET /api/stats/*, consumer e.g. fwo-stats).
    # Same rules as capture_secret: never in config_json, NULL = disabled (fail-closed).
    stats_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Minting key for incident view links (app/auth/incident_link.py): the alerting system
    # holds a copy and signs the link token it puts into an alert, offline. Deliberately NOT
    # settings.SECRET_KEY — that one peppers PINs and mints admin sessions, so anyone holding
    # it could issue themselves deployment-admin access. Same rules as the two above: never in
    # config_json, NULL = disabled (fail-closed); rotating invalidates every link already sent.
    incident_link_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    # --- Telemetry (opt-in, see app/telemetry/) --------------------------------------
    # Consent for the BACKGROUND channel only: 'off' (or NULL) | 'errors'. NULL is the
    # column default and the value every existing and every fresh install starts at, which
    # is what makes "off unless switched on" a property of the schema rather than of some
    # code path remembering to check. Out of config_json deliberately: an admin config push
    # from the CLI must not be able to turn telemetry on as a side effect of editing the
    # roster, and a consent decision should not be something you can accidentally `load`.
    telemetry_consent: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Random per-install id, minted on first use of either channel — NOT at boot, so an
    # instance that never opts in never even generates one. Not derived from the hostname,
    # the config or the DB: it identifies reports as same-origin and nothing else, and
    # regenerating it (admin UI) is how a station makes its past reports unlinkable.
    telemetry_install_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class DeploymentConfigHistory(Base):
    """The config document AS IT WAS, kept before each write that replaced it.

    ⚠️ Every writer of ``deployment_config.config_json`` replaces the WHOLE document, so one
    writer holding an outdated copy costs a station its Dienstgrade, its Atemschutz-Doktrin, its
    Partnerorganisationen and its Fahrzeuge in a single silent write. The demo lost its config
    three times in four days, each time through a different path, each time diagnosed only
    because somebody happened to look.

    The guards in front of those paths stay (a browser must send the version it read; the CLI
    refuses to empty a populated section without ``--force``) — but each of them protects a route
    somebody thought of, and the record here is that enumerating them keeps coming up short. This
    table protects nothing and covers everything: it is what makes a bad write UNDOABLE, whatever
    wrote it. A station has no seed file to rebuild from — the demo's reset is the only reason
    those three occurrences were recoverable at all — so for a real Wehr this is the whole safety
    net. See ``admin_config history|restore``.
    """

    __tablename__ = "deployment_config_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    #: the document as it stood BEFORE the write, not a diff — a diff needs an intact base to
    #: mean anything, and the case this exists for is exactly the one where there isn't one
    config_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    replaced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    #: which path did the replacing — `api` (Verwaltung / HTTP), `cli` (admin_config load),
    #: `branding` (a logo upload), `geodata` (a reference-layer push). The one question that was
    #: unanswerable after the fact: nobody could say whether it had been a browser or a terminal.
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: the admin driving the UI; NULL for a CLI push, which has no user behind it
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)


# --- Audit-trail capture substrate (sub-phase A) ------------------------------------


class IncidentEvent(Base):
    """Append-only, hash-chained operational event for an incident."""

    __tablename__ = "incident_events"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)  # monotonic per incident
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # client|status|divera|units|gps
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    op_type: Mapped[str] = mapped_column(String(32), nullable=False)
    payload_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    prev_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    hash: Mapped[str] = mapped_column(Text, nullable=False)

    __table_args__ = (UniqueConstraint("incident_id", "seq", name="uq_incident_events_seq"),)


class PushSubscription(Base):
    """One browser's Web-Push endpoint (killed-app alarm delivery). Endpoint is the natural
    key — re-subscribing upserts; a 404/410 from the push service deletes the row."""

    __tablename__ = "push_subscriptions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    endpoint: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JournalEntry(Base):
    """One Verlauf row as a first-class append-only record.

    The Verlauf used to ride inside the workspace blob, making the one unbounded domain
    re-sync wholesale on every edit. Rows are now appended here once and never rewritten:
    the client-generated row id (`'t'+Date.now()`…) is the idempotency key, `seq` is the
    per-incident monotonic read cursor, and `row_json` carries the TimelineEvent verbatim
    (the frontend owns its shape). Distinct from IncidentEvent: that is the hash-chained
    AUDIT record of committed domain actions; this is the operational journal store.
    """

    __tablename__ = "journal_entries"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    row_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("incident_id", "client_id", name="uq_journal_client_id"),
        UniqueConstraint("incident_id", "seq", name="uq_journal_seq"),
    )


class WorkspaceSnapshot(Base):
    """Versioned blob = fold checkpoint for replay."""

    __tablename__ = "workspace_snapshots"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class VehicleSample(Base):
    """GPS history sample tied to an incident window (outside the hash chain)."""

    __tablename__ = "vehicle_samples"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False)
    device_id: Mapped[int] = mapped_column(Integer, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lat: Mapped[float] = mapped_column(Numeric(10, 7), nullable=False)
    lng: Mapped[float] = mapped_column(Numeric(10, 7), nullable=False)
    course: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    speed: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)

    __table_args__ = (Index("ix_vehicle_samples_incident_device_ts", "incident_id", "device_id", "ts"),)


class PersonPosition(Base):
    """Where one person currently is, self-reported from their own phone.

    Deliberately NOT a history table — unlike ``VehicleSample`` above there is one row per
    person per incident, overwritten on every update. The feature answers "where is the crew
    working right now" (someone on a Wassertransport is kilometres away *on purpose*, and the
    FU wants to see that), not "where has this person been", and a track of a named human's
    movements is a record this app has no reason to keep.

    Everything about the row is ephemeral: it is deleted when the Einsatz is closed, swept
    when it goes untouched, and cascades with the incident. It is outside the hash chain, does
    not appear in Verlauf, and never reaches the Rapport.

    ``person_id`` is a *claim*: the sharer picked their own name out of the roster on their
    phone. ``device_id`` is what makes that claim traceable to one device, so a second phone
    claiming the same person is detectable rather than silently overwriting.
    """

    __tablename__ = "person_positions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("personnel.id", ondelete="CASCADE"), nullable=False)
    #: Opaque random id generated on the sharing device (never a fingerprint of it).
    device_id: Mapped[str] = mapped_column(Text, nullable=False)
    #: Name snapshot, same reasoning as AttendanceEntry.displayNameSnapshot — the map keeps
    #: reading right after a roster rename mid-Einsatz.
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    lat: Mapped[float] = mapped_column(Numeric(10, 7), nullable=False)
    lng: Mapped[float] = mapped_column(Numeric(10, 7), nullable=False)
    accuracy_m: Mapped[float | None] = mapped_column(Numeric(8, 1), nullable=True)
    #: The device's own fix time — what the operator reads as "vor 3 min".
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("incident_id", "person_id", name="uq_person_positions_incident_person"),)


# --- Telemetry outbox -----------------------------------------------------------------


class TelemetryOutbox(Base):
    """One already-sanitised payload waiting to go upstream.

    A queue rather than a direct POST, for three reasons that all come from where this app
    runs: the instance may be offline for a day, the ingest may be down, and — the one that
    actually decides it — the operator has to be able to SEE what is queued before and after
    it goes. A fire-and-forget POST is unauditable by construction; a table is `SELECT`able
    by the deployer with psql, which is the strongest transparency claim available.

    ``payload_json`` is the finished event, post-scrub. Nothing is sanitised on the way OUT
    of this table, so what a deployer reads here is byte-for-byte what left the building.
    """

    __tablename__ = "telemetry_outbox"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # 'error' (background, needs consent) | 'report' (manual, the send button is the consent)
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # NULL = still queued. Set once the ingest has 200'd; rows are swept after a few days.
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    # Why the last attempt failed, for the admin screen. Never the response body — an error
    # from someone else's server is not something we want to store verbatim.
    last_error: Mapped[str | None] = mapped_column(String(200), nullable=True)

    __table_args__ = (Index("ix_telemetry_outbox_pending", "sent_at", "created_at"),)


# --- Integration credentials (browser-settable, encrypted at rest) ---------------------


class IntegrationCredential(Base):
    """One integration credential a station set from the browser, encrypted at rest.

    ⚠️ Its own table rather than a field of ``deployment_config.config_json``, and that is
    the load-bearing part. ``GET /api/config`` is PUBLIC — the login screen brands itself
    before anybody logs in — and the Sicherung export/import round-trip replaces that whole
    document. A credential inside it would make the export a leak and the import a
    credential-deletion button. The three station secrets that came before this
    (``capture_secret``, ``stats_secret``, ``incident_link_key``) are columns for exactly
    that reason; there are sixteen of these and they each carry their own «changed when, by
    whom», so they get a table instead.

    ``value_encrypted`` is ``version ‖ nonce ‖ AES-256-GCM(value, aad=name)`` under a key
    HKDF-derived from ``SECRET_KEY``, which stays in ``.env`` (see app/credentials.py). So a
    database dump on its own — the nightly backup, the pre-migration safety dump, a laptop
    with a restore on it — carries no usable credential.

    ⚠️ Which also means rotating ``SECRET_KEY`` makes every row here unreadable, the same way
    it invalidates every PIN. That is reported as «unlesbar, bitte neu setzen», never as «nicht
    konfiguriert» — an operator who is told a credential is missing goes and looks for a
    setting they already made.
    """

    __tablename__ = "integration_credentials"

    #: The ``Settings`` attribute name (``divera_access_key``, …). One string is the DB key,
    #: the env-variable name (upper-cased) and the settings attribute, so they cannot drift.
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    value_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    #: The admin who set it, where a person was behind it; NULL for a CLI/automated write.
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class IntegrationCredentialAudit(Base):
    """That a credential changed, when, and by whom — never the value, not even encrypted.

    Config writes keep the previous document so a bad one is undoable. A credential must NOT
    work that way: keeping old values would mean a leaked ``SECRET_KEY`` exposes every
    credential this station has ever held, not just its current ones. So this table records
    the event and nothing else, and «undo» is «set it again», which for a credential is the
    only honest undo anyway — the far end has to be told either way.
    """

    __tablename__ = "integration_credential_audit"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    #: 'set' (first time) | 'rotated' (replaced an existing value) | 'cleared'
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    #: which path did it — 'api' (Verwaltung) today; kept for the same reason
    #: ``deployment_config_history.source`` exists: «browser or terminal» was unanswerable.
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
