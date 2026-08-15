"""Pydantic request/response schemas (grows per phase)."""

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# --- Auth ---------------------------------------------------------------------------
class RosterUser(BaseModel):
    """A login tile — never includes anything secret."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    display_name: str
    role: str
    color: str | None = None


class LoginRequest(BaseModel):
    user_id: uuid.UUID
    pin: str = Field(min_length=4, max_length=12)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    username: str
    display_name: str
    role: str
    color: str | None = None
    last_login: datetime | None = None
    # frontend default for the Einsatzleiter view (see models.User.el_view_default)
    el_view_default: bool = False
    # Present only on an incident-link session (auth/incident_link.py). The client reads
    # these to hide every control that would 403, so a link holder never meets a dead
    # button — a real account has neither attribute and both fall back to the defaults.
    link_scoped: bool = False
    link_incident_id: uuid.UUID | None = None


# --- User administration (Slice 2 — Members & access) -------------------------------
# Editor-only management of the login users. NEVER exposes pin_hash. The PIN policy
# (exactly `settings.pin_length` digits) is mirrored from auth.security.hash_pin; the
# router re-hashes through hash_pin so a malformed PIN is rejected consistently.


class UserAdminOut(BaseModel):
    """Full admin view of a login user (incl. inactive). No secrets — never pin_hash."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    username: str
    display_name: str
    role: str
    color: str | None = None
    is_active: bool
    created_at: datetime
    last_login: datetime | None = None
    el_view_default: bool = False


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1)
    role: Literal["editor", "viewer"]
    color: str | None = None
    el_view_default: bool = False
    pin: str = Field(min_length=4, max_length=12)  # exact digit policy enforced via hash_pin


class UserUpdate(BaseModel):
    """All optional — rename / recolor / role-change / (de)activate."""

    display_name: str | None = Field(default=None, min_length=1)
    color: str | None = None
    role: Literal["editor", "viewer"] | None = None
    is_active: bool | None = None
    el_view_default: bool | None = None


class PinReset(BaseModel):
    pin: str = Field(min_length=4, max_length=12)  # exact digit policy enforced via hash_pin


# --- Incidents ----------------------------------------------------------------------
class IncidentCreate(BaseModel):
    title: str = Field(min_length=1)
    type: str | None = None
    priority: str | None = None  # 'HIGH' | 'LOW'
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    started_at: datetime | None = None
    is_exercise: bool = False
    details_json: dict[str, Any] | None = None


class IncidentPatch(BaseModel):
    title: str | None = None
    type: str | None = None
    priority: str | None = None
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    # Alarmierungszeit — correctable in the Einsatzdaten panel (e.g. Divera time was off)
    started_at: datetime | None = None
    status: str | None = None
    is_archived: bool | None = None
    is_exercise: bool | None = None
    report_done_at: datetime | None = None


class IncidentMeta(BaseModel):
    """List/metadata view — never carries the workspace blob."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    divera_id: int | None = None
    title: str
    type: str | None = None
    priority: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    status: str
    source: str
    source_ref: str | None = None
    auto_opened: bool = False
    started_at: datetime
    closed_at: datetime | None = None
    is_archived: bool
    is_exercise: bool = False
    report_done_at: datetime | None = None
    # Cross-visibility: latch of the first editor open (QR side shows «KP-Tablet aktiv»),
    # and capture write count/last-write (tablet side shows «QR: N Einträge · zuletzt HH:MM»).
    editor_opened_at: datetime | None = None
    capture_writes: int = 0
    capture_last_at: datetime | None = None
    workspace_rev: int
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class IncidentFull(IncidentMeta):
    text: str | None = None
    details_json: dict[str, Any] | None = None
    map_workspace_json: dict[str, Any] | None = None


class WorkspaceOut(BaseModel):
    workspace: dict[str, Any] | None = None
    workspace_rev: int


class WorkspacePut(BaseModel):
    workspace: dict[str, Any]
    base_rev: int


class DetailsPatch(BaseModel):
    details_json: dict[str, Any]


# --- People / notes -----------------------------------------------------------------
class PersonIn(BaseModel):
    role: str | None = None
    name: str | None = None
    contact: str | None = None
    note: str | None = None
    position: int = 0


class PersonOut(PersonIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID


class NoteIn(BaseModel):
    text: str
    occurred_at: datetime | None = None


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    author_id: uuid.UUID | None = None
    occurred_at: datetime
    text: str | None = None


# --- Audit events -------------------------------------------------------------------
class EventIn(BaseModel):
    op_type: str
    payload: dict[str, Any] | None = None
    occurred_at: datetime | None = None


class EventBatchIn(BaseModel):
    events: list[EventIn]


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    seq: int
    occurred_at: datetime
    recorded_at: datetime
    source: str
    user_id: uuid.UUID | None = None
    op_type: str
    payload_json: dict[str, Any] | None = None
    prev_hash: str | None = None
    hash: str


# --- Journal (Verlauf) store ----------------------------------------------------------
class JournalAppendIn(BaseModel):
    """Batch of Verlauf rows (frontend TimelineEvent dicts, stored verbatim). The row's
    own `id` is the idempotency key; a 32 KB per-row cap keeps a bad client from turning
    the journal into blob storage (photos/audio go through /media, never in rows)."""

    entries: list[dict[str, Any]]

    @model_validator(mode="after")
    def _validate_rows(self) -> "JournalAppendIn":
        import json as _json

        for e in self.entries:
            rid = e.get("id")
            if not isinstance(rid, str) or not rid.strip():
                raise ValueError("Jede Journalzeile braucht eine nichtleere String-id")
            if len(_json.dumps(e)) > 32_768:
                raise ValueError(f"Journalzeile {rid!r} zu gross (max. 32 KB)")
        return self


class JournalEntryOut(BaseModel):
    seq: int
    row: dict[str, Any]


class JournalPage(BaseModel):
    entries: list[JournalEntryOut]
    latest_seq: int


# --- Replay (audit-trail sub-phase B) -----------------------------------------------
class SnapshotOut(BaseModel):
    """The nearest workspace snapshot <= a requested instant — the fold anchor."""

    found: bool
    occurred_at: datetime | None = None
    seq_at: int | None = None
    workspace: dict[str, Any] | None = None


class VehicleSampleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    device_id: int
    ts: datetime
    lat: float
    lng: float
    course: float | None = None
    speed: float | None = None


# --- Divera ------------------------------------------------------------------------
class DiveraWebhookPayload(BaseModel):
    id: int
    number: str | None = None
    title: str = ""
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    ts_create: int | None = None
    ts_update: int | None = None

    @field_validator("lat", "lng")
    @classmethod
    def _zero_is_no_coordinate(cls, v: float | None) -> float | None:
        # Divera sends lat/lng 0/0 for alarms without a location ("Einrücken ins Magazin").
        # Stored verbatim, 0/0 became a real coordinate downstream — the map centred on Null
        # Island and the weather picked the nearest Swiss station to the Gulf of Guinea
        # (Grosser St. Bernhard). Zero means absent; NULL lets the address geocoder run.
        return None if v is not None and abs(v) < 1e-6 else v


class DiveraEmergencyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    divera_id: int
    divera_number: str | None = None
    title: str
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    received_at: datetime
    is_taken: bool
    taken_incident_id: uuid.UUID | None = None


class DiveraTakeBody(BaseModel):
    """Optional EL corrections applied when taking a pool alarm into an incident.

    All fields optional: an empty body takes the alarm verbatim (backwards-compatible),
    any field present overrides the mirrored Divera value. The wizard sends the reviewed
    fields so a wrong address/keyword/pin is fixed before the incident is born.
    """

    title: str | None = None
    type: str | None = None
    priority: str | None = None
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None


# --- Generic alarm intake -------------------------------------------------------------
# Slugs a generic sender may not claim. This is the UNION of what KP Front and KP Rück each
# use internally, not just Front's own three ("manual", "migrated", "divera") — a station
# running both feeds one dispatch system into both apps, and a slug accepted here but
# rejected there would be a trap that only shows up on the second integration. Reserving a
# name Front doesn't use costs nothing; it was never a valid external sender name anyway.
# Keep in sync with kp-rueck's app/schemas/alarms.py. See docs/RUNNING-BOTH.md.
RESERVED_ALARM_SOURCES = {"divera", "intake", "manual", "migrated", "operator", "training"}


class AlarmIn(BaseModel):
    """Generic alarm-intake payload (`POST /api/alarms`) for non-Divera alerting systems.

    `source` names the sender (a short slug, one per upstream system); `source_id` is the
    sender's alarm id — together they dedupe, so a retried webhook returns the existing
    incident instead of duplicating it. `type`/`priority` fall back to the same keyword
    inference the Divera path uses.
    """

    source: str = Field(default="webhook", min_length=1, max_length=16, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    # OPTIONAL, deliberately — it was required here and optional in KP Rück, so the same
    # relay could not feed both apps: one answered 422 where the other accepted the alarm.
    # Without it there is nothing to dedupe on, so a redelivery creates a second incident;
    # that is the sender's trade to make, and it is the same trade KP Rück offers.
    source_id: str | None = Field(default=None, min_length=1, max_length=128)
    title: str = Field(min_length=1)
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    type: str | None = None
    priority: Literal["HIGH", "LOW"] | None = None
    started_at: datetime | None = None
    # Accepted so one payload validates against both apps. KP Rück shows this in its alarm
    # pool ("E-123"); an Einsatz here has no such field, so it is ACCEPTED AND IGNORED rather
    # than rejected. Said out loud because a silently dropped field is worse than a 422.
    number: str | None = Field(default=None, max_length=50)


class AlarmOut(BaseModel):
    incident_id: uuid.UUID
    created: bool


class MilestoneGroup(BaseModel):
    """One alarmed group: id matches `alarms.groups[].id` in the deployment config."""

    id: str = Field(min_length=1, max_length=32)
    alarmedAt: datetime


class MilestoneVehicle(BaseModel):
    """Per-vehicle timeline milestones: id matches `fleet.vehicles[].id` (Traccar name)."""

    id: str = Field(min_length=1, max_length=32)
    ausgerueckt: datetime | None = None
    vorOrt: datetime | None = None
    zurueck: datetime | None = None


class MilestonesIn(BaseModel):
    """`POST /api/alarms/milestones` — alarm/vehicle timeline enrichment from the alarm
    pipeline (e.g. fwo-divera's Traccar state machine). Targets an existing incident by
    `divera_id` OR by the generic-intake `(source, source_id)` pair; 404 while it doesn't
    exist yet (senders retry). Idempotent per-key upsert; operator-edited entries
    (`manual: true` in the workspace) are never overwritten."""

    divera_id: int | None = None
    source: str | None = Field(default=None, min_length=1, max_length=16)
    source_id: str | None = Field(default=None, min_length=1, max_length=128)
    groups: list[MilestoneGroup] = Field(default_factory=list)
    vehicles: list[MilestoneVehicle] = Field(default_factory=list)
    #: Where the alarm came IN from, as the alerting system knew it — a slug like
    #: ``"alarmzentrale"``, never a phone number. Recorded write-once on the incident
    #: (``Incident.alarm_origin``); omitting it is normal and means «unknown», not «no».
    #: Same charset rule as ``AlarmIn.source``: a short lowercase identifier.
    origin: str | None = Field(default=None, min_length=1, max_length=32, pattern=r"^[a-z0-9][a-z0-9_-]*$")


class MilestonesOut(BaseModel):
    incident_id: uuid.UUID
    applied: int  # how many values were actually new/changed (0 = pure replay)


# --- Geocoder ----------------------------------------------------------------------
class GeoHit(BaseModel):
    label: str
    lat: float
    lng: float


# --- Objects + reference data -------------------------------------------------------
class ObjectIn(BaseModel):
    name: str
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    source_note: str | None = None


class ObjectOut(ObjectIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    updated_at: datetime


class ReferenceDatasetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    object_id: uuid.UUID | None = None
    module: str | None = None
    kind: str
    title: str | None = None
    source_type: str
    source_note: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    feature_count: int | None = None
    current_version: int
    fetch_url: str | None = None
    updated_at: datetime


class ObjectWithPlans(ObjectOut):
    plans: list[ReferenceDatasetOut] = []
    distance_m: float | None = None


# --- Personnel (Mannschaft) ---------------------------------------------------------
class PersonnelExternalIdentityOut(BaseModel):
    provider: str
    external_id: str
    synced_at: datetime


class PersonnelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    divera_id: int | None = None
    external_identities: list[PersonnelExternalIdentityOut] = Field(default_factory=list)
    display_name: str
    first_name: str | None = None
    last_name: str | None = None
    rank: str | None = None
    is_active: bool
    updated_at: datetime


class PersonnelCreate(BaseModel):
    """Manually add a crew member. ``divera_id`` is normally null (hand entry); a bare
    name is enough."""

    display_name: str = Field(min_length=1)
    divera_id: int | None = None
    rank: str | None = None


class PersonnelUpdate(BaseModel):
    """All optional — rename / (de)activate / set rank."""

    display_name: str | None = Field(default=None, min_length=1)
    first_name: str | None = None
    last_name: str | None = None
    rank: str | None = None
    is_active: bool | None = None


class PersonnelSyncPreview(BaseModel):
    """Read-only diff of Divera members vs the personnel table (no writes applied)."""

    new: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []
    unchanged: list[dict[str, Any]] = []
    stale: list[dict[str, Any]] = []


class PersonnelSyncExecuteBody(BaseModel):
    # default false: stale members stay active (and assignable) until explicitly confirmed
    deactivate_stale: bool = False


class PersonnelSyncResult(BaseModel):
    created: int
    updated: int
    reactivated: int
    unchanged: int
    deactivated: int
    stale: int


# --- Deployment config (Phase 1.A — per-station settings) ---------------------------
# Mirrors docs/CONFIGURATION.md §1. EVERY field is optional with a sensible default so
# an empty `{}` validates and the app runs as a generic empty station. camelCase field
# names match the frontend contract (appConfig.ts / types.ts); we keep them verbatim
# rather than aliasing because the document round-trips as-is to the client.


class IdentityAssets(BaseModel):
    model_config = ConfigDict(extra="ignore")
    logo: str | None = None
    #: Letterhead of the printed Einsatzrapport; falls back to `logo` when unset.
    #: ⚠️ A slot missing HERE is silently dropped — `extra="ignore"` means the upload succeeds,
    #: the blob is stored, and the URL vanishes on the way back out through this projection.
    reportLogo: str | None = None
    iconPng192: str | None = None
    iconPng512: str | None = None
    favicon: str | None = None


class IdentityConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    appName: str | None = None
    locale: str | None = None
    accentColor: str | None = None
    assets: IdentityAssets = Field(default_factory=IdentityAssets)
    helpIntro: str | None = None
    # Station Kommandant (display name) — pre-fills the Kommandant signature line on the
    # Einsatzrapport; purely informational, grants no role/permission.
    kommandant: str | None = None
    # Demo deployments: render a persistent "DEMO" ribbon everywhere and an optional note
    # (e.g. login credentials / reset cadence). Off/empty for real stations.
    demoMode: bool | None = None
    demoNote: str | None = None


class MapDefaultView(BaseModel):
    model_config = ConfigDict(extra="ignore")
    center: list[float] | None = None  # [lon, lat] WGS84
    centerLv95: list[float] | None = None  # [easting, northing] EPSG:2056
    zoom: float | None = None

    @model_validator(mode="after")
    def _one_crs(self) -> "MapDefaultView":
        # Invalid CRS pair: exactly one origin form may be set, never both.
        if self.center is not None and self.centerLv95 is not None:
            raise ValueError("map.defaultView: set either 'center' (WGS84) or 'centerLv95' (LV95), not both")
        return self


class MapGeocoder(BaseModel):
    model_config = ConfigDict(extra="ignore")
    defaultLocality: str | None = None
    bboxLv95: str | None = None


class MapExternalLink(BaseModel):
    # A station-supplied deep link to an external map portal, built per-incident. The
    # urlTemplate may use {E}/{N} (LV95 easting/northing) and {lng}/{lat} (WGS84).
    model_config = ConfigDict(extra="ignore")
    label: str | None = None
    urlTemplate: str | None = None


class MapConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    defaultView: MapDefaultView = Field(default_factory=MapDefaultView)
    geocoder: MapGeocoder = Field(default_factory=MapGeocoder)
    externalLinks: list[MapExternalLink] = Field(default_factory=list)


class ReferenceLayerConfig(BaseModel):
    """A station-supplied reference layer (raster WMS/WMTS or vector GeoJSON).

    Permissive (extra=ignore) but enforces the kind→payload invariant: raster layers
    must carry `tiles`, geojson layers must carry `geojson`. Malformed entries reject.
    """

    model_config = ConfigDict(extra="ignore")
    id: str | None = None
    group: str | None = None
    label: str | None = None
    icon: str | None = None
    kind: Literal["wms", "wmts", "geojson"] | None = None
    tiles: list[str] | None = None
    geojson: str | None = None
    vectorKind: str | None = None
    symbol: str | None = None
    color: str | None = None
    nightColor: str | None = None
    opacity: float | None = None
    maxzoom: float | None = None
    attribution: str | None = None
    # Einsatz categories (German `kategorien` values, e.g. "Brandbekämpfung") that switch
    # this layer visible when an incident of that category is created / re-categorized.
    autoActivate: list[str] | None = None

    @model_validator(mode="after")
    def _kind_payload(self) -> "ReferenceLayerConfig":
        if self.kind in ("wms", "wmts") and not self.tiles:
            raise ValueError(f"referenceLayer {self.id!r}: raster layer ({self.kind}) requires 'tiles'")
        if self.kind == "geojson" and not self.geojson:
            raise ValueError(f"referenceLayer {self.id!r}: geojson layer requires 'geojson'")
        return self


class FleetPartner(BaseModel):
    model_config = ConfigDict(extra="ignore")
    feuerwehr: list[str] = Field(default_factory=list)
    sanitaet: list[str] = Field(default_factory=list)
    polizei: list[str] = Field(default_factory=list)
    chemiewehr: list[str] = Field(default_factory=list)
    zivilschutz: list[str] = Field(default_factory=list)


class FleetAttributeList(BaseModel):
    """A data-driven suggestion list for one symbol field (``field == 'title'`` targets the
    title input; any other key targets that detail row). Replaces the fixed vehicle/Lüfter/…
    lists below so a deployment can attach a list to any symbol field."""

    model_config = ConfigDict(extra="ignore")
    symbol: str
    field: str
    options: list[str] = Field(default_factory=list)


class FleetVehicle(BaseModel):
    """One station vehicle for the Alarmierungs-/Ausrückzeiten grid (rapport form, paper
    Erfassungsblatt, milestone webhook matching, stats export). `id` should equal the
    sender's device name (Traccar convention, e.g. 'tlf') — matching is a plain string
    compare. Empty `fleet.vehicles` (default) hides every vehicle-times surface."""

    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    winfapAlias: str | None = None


class FleetConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    vehicles: list[FleetVehicle] = Field(default_factory=list)
    attributeLists: list[FleetAttributeList] = Field(default_factory=list)
    # Legacy fixed lists — still accepted/echoed so existing stored configs round-trip; the
    # admin editor migrates them into attributeLists on first edit.
    vehicleTypes: list[str] = Field(default_factory=list)
    luefterTypes: list[str] = Field(default_factory=list)
    kleinloeschTypes: list[str] = Field(default_factory=list)
    partner: FleetPartner = Field(default_factory=FleetPartner)


class DoctrineConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    defaultFunkkanal: int | None = None
    funkkanalMin: int | None = None
    funkkanalMax: int | None = None
    alarmBar: int | None = None
    contactIntervalMin: int | None = None
    contactGraceSec: int | None = None
    defaultPressureBar: int | None = None
    pressureStep: int | None = None
    pressureMax: int | None = None
    #: The two numbers behind the Atemschutz air estimate («noch ≈ 246 bar»): the cylinder's
    #: volume in litres and the litres/min a working AdF is reckoned to breathe. The frontend has
    #: read these from the deployment config all along — but ``extra="ignore"`` meant the backend
    #: silently DROPPED them on save, so the estimate looked like a station setting and was in
    #: fact the shipped 7 L / 50 L·min⁻¹ everywhere. A 9-litre cylinder is an ordinary thing for a
    #: Wehr to own, and the estimate is what an Überwacher plans a relief against.
    cylinderLiters: float | None = Field(default=None, gt=0, le=30)
    estConsumptionLPerMin: float | None = Field(default=None, gt=0, le=200)
    # Station colour per Atemschutz-Auftrag (auftrag id → CSS colour), e.g. {"loeschen": "#e8392b"}.
    # The colour a Trupp with that order STARTS in; it stays overridable per Trupp. Absent/empty
    # keeps the automatic behaviour (every Trupp a different colour from the palette).
    auftragColors: dict[str, str] | None = None


class AlarmGroup(BaseModel):
    """One station alarm group for the Alarmierungs-/Ausrückzeiten grid. `id` must match
    what the milestone sender uses; `tagespikett` marks the day-duty group."""

    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    color: str | None = None  # display hint on paper/form ('Rot', 'Grün', …)
    winfapAlias: str | None = None
    tagespikett: bool = False


class AlarmsConfig(BaseModel):
    """Alarm handling: auto-open incidents from incoming alarms + auto-archive of untouched
    auto-opened ones."""

    model_config = ConfigDict(extra="ignore")
    # DEPRECATED 2026-08-02, accepted and ignored. Auto-open is no longer a setting: every
    # alarm opens its Einsatz on arrival, on every path. The flag defaulted to off, so any
    # station that had not opted in left every Einsatz-Link holder on «Einsatz nicht (mehr)
    # verfügbar» until an editor took the alarm on a tablet — a config default is the wrong
    # place for that decision. What the filters bought (test alarms, Nachbarhilfe and BMA
    # runs not becoming counted Einsätze) is now bought by `Incident.editor_opened_at`
    # instead, which measures whether anyone ATTENDED rather than guessing from the keyword.
    # Kept in the schema so existing config files and the admin round-trip keep validating;
    # they will be dropped in the next MAJOR.
    autoOpen: bool = False
    autoOpenPriorities: list[Literal["HIGH", "LOW"]] | None = None
    autoOpenKeywords: list[str] | None = None
    autoArchiveDays: int = Field(default=7, ge=0)  # 0 = sweep off
    # …and the OTHER way an Einsatz stays open forever: one that WAS worked on and then simply
    # never closed. Archiving is a deliberate act nobody performs unless they know they have to,
    # so the open list grows by one row per Einsatz until somebody tidies up. Its own, much
    # longer clock — this one sweeps real work, so it must sit far past any chance of the Einsatz
    # still being in use. Archived WITHOUT stamping report_done_at: the Rapport was never
    # finished and the record must not claim it was. Reversible like every archive. 0 = off.
    staleIncidentDays: int = Field(default=30, ge=0)
    # How long after an incident opened the station capture link (Erfassungs-Poster QR)
    # may still reach it once its Rapport is done. Incidents WITHOUT a completed Rapport
    # (and not archived) stay reachable regardless of age — the poster shows the open
    # backlog (decided 2026-07-11); the window only ages out finished ones.
    captureWindowHours: int = Field(default=12, ge=1, le=168)
    # Outbound webhooks: every URL gets a POST when an incident is created (any path —
    # manual, Divera take, auto-open, generic intake). Fail-open: delivery is retried,
    # logged, and NEVER blocks intake. Example receiver: a kp-rueck QR-slip adapter.
    webhooks: list[str] = Field(default_factory=list)
    # Station alarm groups for the Alarmierungs-/Ausrückzeiten grid (rapport form, paper
    # Erfassungsblatt, milestone webhook, stats export). Empty (default) hides the grid
    # everywhere — a vanilla deployment is unchanged.
    groups: list[AlarmGroup] = Field(default_factory=list)


class AlarmKeywordGroup(BaseModel):
    """One reader-facing grouping of high-priority keywords. `group`/`note` are documentation
    — priority inference is an any-match, so the grouping carries no meaning at runtime."""

    model_config = ConfigDict(extra="ignore")
    group: str | None = None
    note: str | None = None
    keywords: list[str] = Field(default_factory=list)


class AlarmHighPriorityKeywords(BaseModel):
    model_config = ConfigDict(extra="ignore")
    groups: list[AlarmKeywordGroup] = Field(default_factory=list)


class AlarmKeywordCategories(BaseModel):
    """`pairs` is ordered: the first keyword found in an uppercased title wins."""

    model_config = ConfigDict(extra="ignore")
    pairs: list[tuple[str, str]] = Field(default_factory=list)


class AlarmMatcherDivergence(BaseModel):
    """Documentation of the kp-front/kp-rueck matcher difference; carried so a station can copy
    the shipped file verbatim. kp-front's matcher does not read it."""

    model_config = ConfigDict(extra="ignore")
    kp_rueck_word_bounded: list[str] = Field(default_factory=list)


class AlarmKeywordsConfig(BaseModel):
    """A station's own alarm vocabulary — it REPLACES the shipped one wholesale.

    The shape is `backend/app/data/alarm_keywords.json` verbatim, so a station starts by
    copying that file (the documented way to add a single keyword) and pastes it under
    `alarmKeywords`. Hence the snake_case field names in here, unlike the rest of this
    document: they are the file's key names, not new ones. `_readme` and `schema` are accepted
    and dropped — they document the shipped file, not this deployment's row.

    Validity is decided ONCE, by `alarm_keywords.parse()`, the same rule the shipped file
    passes at import. There is no second schema to keep in step. On top of it, one kp-front
    rule the shared file cannot state: every category must be one this app has a German label
    for, because a vocabulary routing to an unknown category would file those alarms under
    «Diverse Einsätze» and never say why.
    """

    model_config = ConfigDict(extra="ignore")
    schema_version: int
    keyword_to_category: AlarmKeywordCategories
    fallback_category: str
    high_priority_keywords: AlarmHighPriorityKeywords = Field(default_factory=AlarmHighPriorityKeywords)
    known_matcher_divergence: AlarmMatcherDivergence = Field(default_factory=AlarmMatcherDivergence)

    @model_validator(mode="after")
    def _must_parse_and_stay_labelled(self) -> "AlarmKeywordsConfig":
        # Imported here, not at module scope: both modules import this one.
        from .alarm_keywords import InvalidVocabularyError, parse

        try:
            vocab = parse(self.model_dump(mode="json"))
        except InvalidVocabularyError as e:
            raise ValueError(str(e)) from e

        from .divera import CATEGORY_LABELS

        unknown = sorted(vocab.category_keys - set(CATEGORY_LABELS))
        if unknown:
            raise ValueError(
                f"routes to categories this app has no label for: {unknown}. "
                f"Known categories: {sorted(CATEGORY_LABELS)}"
            )
        return self


class AlarmVocabularyStatus(BaseModel):
    """Which vocabulary is running, on the public GET — so «what classifies our alarms» is
    answerable with one request instead of a database session."""

    model_config = ConfigDict(extra="ignore")
    source: Literal["shipped", "deployment"] = "shipped"
    schemaVersion: int = 1
    titleKeywords: int = 0
    highPriorityKeywords: int = 0
    fallbackCategory: str = ""


class JournalConfig(BaseModel):
    """Journal composer configuration: the station's Textbausteine (quick phrases) —
    tappable chips that pre-fill the entry text. Empty = the app's national defaults."""

    model_config = ConfigDict(extra="ignore")
    quickPhrases: list[str] = Field(default_factory=list)


class ReportConfig(BaseModel):
    """Einsatzrapport form presets. `partnerOrgs` feeds the Partnerorganisationen
    checkbox row (paper Erfassungsblatt + rapport form quick-pick); free-text entries
    remain possible everywhere. Empty = no preset row."""

    model_config = ConfigDict(extra="ignore")
    partnerOrgs: list[str] = Field(default_factory=list)
    #: Send the Rapport to the STATION PRINTER with its pages in reverse order.
    #:
    #: A printer that ejects face-up delivers a stack that is back-to-front, so the rapport has
    #: to be re-sorted by hand every time — which is exactly the moment nobody has. Reversing the
    #: document fixes the stack. Only the relay path is affected; a downloaded PDF is always in
    #: reading order, because that one is read on a screen.
    #:
    #: Default on: the relay is deliberately configured per station (PRINT_AGENT_SECRET), so
    #: whoever switches the printer on can switch this off if theirs ejects face-down.
    reversePrintOrder: bool = True
    #: How the SECOND Einsatzstunden figure on the rapport is rounded (the one in brackets).
    #:
    #: The first figure is the raw sum — what actually happened, never rounded. The second is
    #: each person's time rounded UP to the next ``stepMin`` block, but only once ``graceMin``
    #: past the previous one, then summed. With the default 30 / 5: 0:05 counts as 0:00, 0:06 as
    #: 0:30, 0:35 as 0:30, 0:36 as 1:00. The grace is what stops a crew that stayed three minutes
    #: over the half hour from being counted a whole block for it.
    #:
    #: Rounding is per PERSON and then summed — rounding the total instead would give the same
    #: Einsatz a different answer depending on how many people came. Set ``stepMin: 60`` for a
    #: station that counts whole hours. See ``docs/CONFIGURATION.md`` §1b.
    hoursRounding: "HoursRoundingConfig" = Field(default_factory=lambda: HoursRoundingConfig())
    #: How short a break between two recorded presence blocks still counts as ONE stretch on
    #: the Personalblatt, in minutes.
    #:
    #: Somebody ticked «gegangen» and «wieder anwesend» a minute later did not go home —
    #: that is a corrected mis-tap, or the QR poster and the tablet recording the same arrival
    #: from two sides. Printed as recorded it came out as two lines under one name
    #: («22:11 – 22:58» over «22:59 – 23:20»), which reads as a break that never happened.
    #:
    #: The record keeps both blocks either way; only the Rapport merges them, and the
    #: Einsatzstunden follow the same merge so the two halves of the sheet agree. ``0`` prints
    #: every block exactly as recorded. A station number, not a per-incident one: whether a
    #: ten-minute gap is «a break» or «two deployments» has to mean the same on every sheet
    #: the Wehr files. See ``docs/CONFIGURATION.md`` §1b.
    attendanceMergeGapMin: int = Field(default=15, ge=0, le=240)
    #: The station's OWN paperwork, as links on the Rapport ("Formulare & Links").
    #:
    #: Every Wehr has forms that live outside this app and still have to be filled in after an
    #: Einsatz — a Getränke-Abrechnung for the Gemeinde, a Schadenmeldung for the Versicherung,
    #: an internal Google-Form. They are station-specific by nature, so they are configuration:
    #: a deployment that sets none has no such section on its Rapport at all. Ticking one off
    #: is per-incident and lives in the workspace blob, not here. See
    #: ``docs/CONFIGURATION.md`` §1d and the frontend's ``src/lib/reportLinks.ts``.
    #:
    #: ⚠️ NOT optional. Verwaltung PUTs the whole document, so accepting ``None`` here would be
    #: the difference between "this station has no forms" and a 422 that wedges every later
    #: config edit in that tab. An empty list is how "none" is said.
    links: list["ReportLinkConfig"] = Field(default_factory=list, max_length=30)


class ReportLinkConfig(BaseModel):
    """One row of ``ReportConfig.links``.

    ``url`` may carry ``{platzhalter}`` tokens (``{stichwort}``, ``{ort}``, ``{datum}``,
    ``{alarmzeit}``, ``{einsatzende}``, ``{einsatzleiter}``, ``{kontaktperson}``,
    ``{kurzbericht}``, ``{wehr}``), which the app substitutes URL-encoded when the link is
    opened. That is how a Google Form arrives with Anlass and Datum already in it — see
    "Link zum Vorausfüllen abrufen" in Google Forms, which yields ``?usp=pp_url&entry.<id>=…``.

    The backend does not resolve or fetch these; it stores them.

    ⚠️ ``url`` is constrained to http(s) HERE as well, not only in the app. The frontend gate
    (``deploymentConfig · reportLinks``) protects the one consumer that exists today; a
    ``javascript:`` URL accepted into the stored document would be waiting for the next one.
    """

    model_config = ConfigDict(extra="ignore")
    #: stable id — an incident's tick state is filed under it
    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2048)
    #: when this has to be filled in ("nur bei Gebäudeschaden, innert 48 h")
    note: str | None = Field(default=None, max_length=200)

    @field_validator("id", "title", "url")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        """⚠️ Stripped, and blank-after-stripping is empty. ``min_length=1`` alone accepts a
        single space, while the app drops the row on ``.trim()`` — which is the worst of both:
        stored, shown as configured in Verwaltung, and absent from every Rapport."""
        if not v.strip():
            raise ValueError("must not be blank")
        return v.strip()

    @field_validator("url")
    @classmethod
    def _http_only(cls, v: str) -> str:
        """Reject anything the app would refuse to open anyway — with an explanation, rather
        than storing a row that silently never appears on a Rapport."""
        if not re.match(r"^https?://", v, re.IGNORECASE):
            raise ValueError("url must start with http:// or https://")
        return v


class HoursRoundingConfig(BaseModel):
    """The Sold convention this station counts Einsatzstunden by — see ``ReportConfig``."""

    model_config = ConfigDict(extra="ignore")
    #: block size in minutes (30 = half hours, 60 = whole hours)
    stepMin: int = Field(default=30, ge=1, le=480)
    #: minutes past a block that still count as that block, not the next one
    graceMin: int = Field(default=5, ge=0, le=479)


class RankConfig(BaseModel):
    """One Dienstgrad in the station's ordered rank list. Position in ``roster.ranks`` is
    the seniority order (most senior first). ``tier`` drives the "nur Offiziere" picker
    filter and the Anwesenheit grouping; ``abbr`` is the short badge shown in lists."""

    model_config = ConfigDict(extra="ignore")
    key: str
    label: str
    abbr: str | None = None
    tier: Literal["officer", "nco", "crew"] = "crew"


class RosterConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    # "snapshot" = a roster file somebody else publishes, to the contract in
    # docs/CONFIGURATION.md §4c (schema: docs/roster-snapshot.schema.json). The value is
    # accepted and served; the ingestion that reads such a file is NOT built yet, so today a
    # station on "snapshot" behaves exactly like "manual" — CSV and hand entry, nothing synced.
    source: Literal["manual", "divera", "snapshot"] | None = None
    # Ordered rank list (most senior first). Empty → the frontend falls back to its in-code
    # Swiss default (see src/lib/rank.ts). Ranks reference these keys.
    ranks: list[RankConfig] = Field(default_factory=list)
    # How a crew member's name reads, station-wide: "Müller Hans" (default — what Divera
    # delivers and how a Feuerwehr calls people) or "Hans Müller". One order for the whole
    # deployment, applied when a name is SERVED, not when it is stored: a station can flip
    # this and every list, Trupp card and Rapport changes with the next request.
    nameOrder: Literal["last-first", "first-last"] = "last-first"


class MittelStockEntry(BaseModel):
    """How many of a material are normally carried at one source (the standard load-out)."""

    model_config = ConfigDict(extra="ignore")
    source: str  # matches a MittelSource.id
    qty: int


class MittelItem(BaseModel):
    """One station-catalogue material: id + label + default unit (Stk/l/Sack/m/Flasche …),
    an optional grouping `category`, and an optional per-source `stock` (nominal load-out +
    where it lives → drives the used/available readout and the Bestand overview)."""

    model_config = ConfigDict(extra="ignore")
    id: str
    label: str
    unit: str | None = None
    category: str | None = None
    stock: list[MittelStockEntry] = Field(default_factory=list)
    # tactical-symbol pack name → placing that symbol offers logging this material
    symbol: str | None = None
    # …and WHICH variant of that symbol, keyed on the symbol's own fields: {"Typ": "Exhauster"}.
    # One symbol is routinely several materials (Lüfter / Grosslüfter / Exhauster share one pack
    # name and are told apart by the Typ a station already configures in fleet.attributeLists).
    # A LIST of clauses is an OR — "Typ = Exhauster ODER Luftrichtung = saugen", because a Lüfter
    # switched to saugen is an Exhauster whether or not anybody also set its Typ. The pseudo-field
    # "Luftrichtung" reads the airflow flag.
    # ⚠️ `extra="ignore"` above means an unknown key is dropped SILENTLY on load, so this field
    # has to exist here or the whole mapping vanishes between the file and the app — the same way
    # the demo's doctrine block did.
    when: dict[str, str] | list[dict[str, str]] | None = None
    # consumable (Nachschub list) vs. equipment (Retablierung status zurück/vor Ort/defekt)
    verbrauchbar: bool = False


class MittelSource(BaseModel):
    """One source a material can be drawn from (vehicle / depot / …)."""

    model_config = ConfigDict(extra="ignore")
    id: str
    label: str


class MittelConfig(BaseModel):
    """Station-wide material-use config: the Mittel catalogue, the optional source list, and
    common unit suggestions for custom («Anderes Mittel») entries. All optional → the app falls
    back to its national defaults (empty catalogue, free-typed materials)."""

    model_config = ConfigDict(extra="ignore")
    catalogue: list[MittelItem] = Field(default_factory=list)
    sources: list[MittelSource] = Field(default_factory=list)
    units: list[str] = Field(default_factory=list)


class ModuleConfig(BaseModel):
    """One Objektplan module — drives BOTH the app's plan tile and the import parsing, so a
    station configures its module set / labels / parsing in one place.

    Display: ``code`` is the short tile label ('M1', '2/3', 'Wasser'), plus title/subtitle/
    orientation/order/icon. Parsing: ``match`` is a regex tested (case-insensitive) against a
    source PDF's filename stem — the first module whose ``match`` hits claims the file.
    ``combinedWith`` marks a combined sheet that also fills other slots (modul2-3 → modul2 +
    modul3). ``family`` marks a generative module whose ``match`` has a capture group for a
    sub-slot — "Modul 5 - Wasser" → ``modul5-wasser`` labelled "Wasser".
    """

    model_config = ConfigDict(extra="ignore")
    id: str
    code: str | None = None
    title: str | None = None
    subtitle: str | None = None
    orientation: Literal["portrait", "landscape"] = "landscape"
    order: int = 0
    icon: str | None = None
    match: str | None = None  # filename regex for the importer; None = display-only / data-driven
    combinedWith: list[str] | None = None
    family: bool = False
    viewer: bool = False  # render as a plain PDF viewer (no drawing); on a family applies to all sub-slots


class DeploymentConfigIn(BaseModel):
    """The full config document an admin PUTs. All sections optional → `{}` is valid.

    The input `integrations` block (ON/OFF intent) is accepted but IGNORED for the GET
    projection: integration availability is derived from env-configured secrets, not the
    document (see ConfigIntegrations / config_projection in the router).
    """

    model_config = ConfigDict(extra="ignore")
    identity: IdentityConfig = Field(default_factory=IdentityConfig)
    map: MapConfig = Field(default_factory=MapConfig)
    referenceLayers: list[ReferenceLayerConfig] = Field(default_factory=list)
    modules: list[ModuleConfig] = Field(default_factory=list)
    fleet: FleetConfig = Field(default_factory=FleetConfig)
    doctrine: DoctrineConfig = Field(default_factory=DoctrineConfig)
    roster: RosterConfig = Field(default_factory=RosterConfig)
    mittel: MittelConfig = Field(default_factory=MittelConfig)
    journal: JournalConfig = Field(default_factory=lambda: JournalConfig())
    alarms: AlarmsConfig = Field(default_factory=AlarmsConfig)
    # Unset (the normal case) = the vocabulary shipped in app/data/alarm_keywords.json. Set =
    # that file replaced wholesale for this deployment; there is no merging (§1 of
    # docs/CONFIGURATION.md says why, and says to copy the shipped file to add one keyword).
    alarmKeywords: AlarmKeywordsConfig | None = None
    report: ReportConfig = Field(default_factory=ReportConfig)
    # Accepted on input but not authoritative (kept loose; not echoed from the document).
    # Future asset-upload slice: validate that identity.assets.* reference existing entries in
    # asset storage. Skipped while assets are still provisioned outside this document.


class ProviderCapability(BaseModel):
    provider: str | None = None
    configured: bool = False
    capabilities: list[str] = Field(default_factory=list)


class ProviderRegistration(BaseModel):
    """One provider this build knows about, whether or not this station uses it.

    The list is what makes personnel/alarms/vehicles a *choice* rather than a vendor: a
    station reads it to see what it could point at. ``implemented`` is false for a provider
    whose contract is published but whose ingestion is not built yet — an entry that is
    discoverable and honest about being inert, rather than a registry that quietly implies
    everything listed works.
    """

    provider: str
    domain: Literal["personnel", "alarms", "vehicles"]
    configured: bool
    active: bool
    capabilities: list[str] = Field(default_factory=list)
    implemented: bool = True


class ConfigIntegrations(BaseModel):
    """Env-derived integration availability (the GET projection's `integrations`).

    These are FACTS about the deployment's secrets, NOT the document's on/off intent —
    hence the `*Configured` naming. The frontend should read these to decide whether to
    surface Divera/Traccar features. (docs/CONFIGURATION.md §1 names the document's intent
    fields `diveraEnabled`/`traccarEnabled`; the GET output deliberately uses
    `diveraConfigured`/`traccarConfigured` to signal env-derived truth.)
    """

    diveraConfigured: bool = False
    traccarConfigured: bool = False
    # STT engine reachable (env stt_base_url set) — gates the player's Transkribieren button
    sttConfigured: bool = False
    personnel: ProviderCapability = Field(default_factory=ProviderCapability)
    alarms: ProviderCapability = Field(default_factory=ProviderCapability)
    vehicles: ProviderCapability = Field(default_factory=ProviderCapability)
    providers: list[ProviderRegistration] = Field(default_factory=list)


class ConfigHistoryEntry(BaseModel):
    """One kept previous configuration, for the «Letzte Änderungen» list in Verwaltung.

    Deliberately NOT the document itself: the list is read to answer «what happened to our
    config», and shipping a full config per row would make that a scroll through hundreds of
    lines of JSON. What identifies the damage is `emptied` — sections that had content before
    this write and none after — which is the shape every one of these incidents has taken.
    """

    model_config = ConfigDict(extra="ignore")
    id: int
    replacedAt: datetime
    #: which path did the replacing — `api` (Verwaltung/HTTP), `cli`, `branding`, `geodata`
    source: str | None = None
    #: the admin behind it, resolved to a display name. NULL for a CLI push — and «api, nobody»
    #: is itself the signature of an unattended writer, which is worth being able to see.
    replacedBy: str | None = None
    #: top-level sections that had content in this kept document
    sections: list[str] = Field(default_factory=list)
    #: what the write that replaced it left EMPTY (config_history · emptied_sections)
    emptied: list[str] = Field(default_factory=list)


class DeploymentConfigOut(DeploymentConfigIn):
    """GET/PUT response projection: the validated document PLUS env-derived integration
    flags. NEVER includes updated_by, raw secrets, or API keys.
    """

    integrations: ConfigIntegrations = Field(default_factory=ConfigIntegrations)
    # Derived from the document, not stored: a one-glance answer to "shipped or ours?" that
    # does not require reading (or understanding) the whole `alarmKeywords` block above.
    alarmVocabulary: AlarmVocabularyStatus = Field(default_factory=AlarmVocabularyStatus)
    # Opaque version token of the stored document — hand it back on the next PUT and a write
    # against a document somebody else has since changed is refused (409) instead of silently
    # winning. See app/api/config · put_config. NOT part of the document; `DeploymentConfigIn`
    # ignores extras, so echoing this response straight back as a body is harmless.
    version: str | None = None
