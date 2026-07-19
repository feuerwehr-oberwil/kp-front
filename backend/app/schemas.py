"""Pydantic request/response schemas (grows per phase)."""

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
RESERVED_ALARM_SOURCES = {"manual", "migrated", "divera"}


class AlarmIn(BaseModel):
    """Generic alarm-intake payload (`POST /api/alarms`) for non-Divera alerting systems.

    `source` names the sender (a short slug, one per upstream system); `source_id` is the
    sender's alarm id — together they dedupe, so a retried webhook returns the existing
    incident instead of duplicating it. `type`/`priority` fall back to the same keyword
    inference the Divera path uses.
    """

    source: str = Field(default="webhook", min_length=1, max_length=16, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    source_id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1)
    text: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    type: str | None = None
    priority: Literal["HIGH", "LOW"] | None = None
    started_at: datetime | None = None


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
    mindestBar: int | None = None
    contactIntervalMin: int | None = None
    contactGraceSec: int | None = None
    defaultPressureBar: int | None = None
    pressureStep: int | None = None
    pressureMax: int | None = None


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
    auto-opened ones. `autoOpen` gates the Divera pool path (the generic `/api/alarms`
    intake always creates — configuring its secret is the opt-in). Filters are None =
    accept all; keywords match as case-insensitive substrings of title+text."""

    model_config = ConfigDict(extra="ignore")
    autoOpen: bool = False
    autoOpenPriorities: list[Literal["HIGH", "LOW"]] | None = None
    autoOpenKeywords: list[str] | None = None
    autoArchiveDays: int = Field(default=7, ge=0)  # 0 = sweep off
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
    source: Literal["manual", "divera"] | None = None
    # Ordered rank list (most senior first). Empty → the frontend falls back to its in-code
    # Swiss default (see src/lib/rank.ts). Ranks reference these keys.
    ranks: list[RankConfig] = Field(default_factory=list)


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
    report: ReportConfig = Field(default_factory=ReportConfig)
    # Accepted on input but not authoritative (kept loose; not echoed from the document).
    # Future asset-upload slice: validate that identity.assets.* reference existing entries in
    # asset storage. Skipped while assets are still provisioned outside this document.


class ProviderCapability(BaseModel):
    provider: str | None = None
    configured: bool = False
    capabilities: list[str] = Field(default_factory=list)


class ProviderRegistration(BaseModel):
    provider: str
    domain: Literal["personnel", "alarms", "vehicles"]
    configured: bool
    active: bool
    capabilities: list[str] = Field(default_factory=list)


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


class DeploymentConfigOut(DeploymentConfigIn):
    """GET/PUT response projection: the validated document PLUS env-derived integration
    flags. NEVER includes updated_by, raw secrets, or API keys.
    """

    integrations: ConfigIntegrations = Field(default_factory=ConfigIntegrations)
