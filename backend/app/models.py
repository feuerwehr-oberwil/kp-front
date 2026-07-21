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
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
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
    media_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("media.id", ondelete="CASCADE"), nullable=False, unique=True
    )
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
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)


# --- Multi-station deployment config (Phase 1.A) ------------------------------------


class DeploymentConfig(Base):
    """Singleton row (id=1) holding the per-station deployment config document.

    ``config_json`` is the admin-edited JSON described in docs/CONFIGURATION.md §1
    (identity/map/referenceLayers/fleet/symbols/doctrine/roster). It is validated
    through the Pydantic schema in schemas.py before persistence; secrets stay in env.
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
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)


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
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False
    )
    device_id: Mapped[int] = mapped_column(Integer, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lat: Mapped[float] = mapped_column(Numeric(10, 7), nullable=False)
    lng: Mapped[float] = mapped_column(Numeric(10, 7), nullable=False)
    course: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    speed: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)

    __table_args__ = (Index("ix_vehicle_samples_incident_device_ts", "incident_id", "device_id", "ts"),)
