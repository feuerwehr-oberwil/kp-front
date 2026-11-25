"""Objektbesuche — the response models of ``/api/object-visits`` and ``/api/admin/object-visits``.

The answers are built as dicts in ``app.object_visits`` and the two routers; these models name
every key of them, so ``docs/openapi.json`` (and the client's generated ``schema.d.ts``) carries
the wire types and a key renamed on the server fails ``tsc`` in the client.

⚠️ Every route that uses one of these answers with ``response_model_exclude_unset=True``: a key
the producer left out stays out, a default here is never sent. So a field with a default is one
the answer may LACK — an ``error`` that only a failing delivery has, a key an older server wrote
into a stored PUT answer that a replay sends back as it was. A field without a default is always
there.

A visit's own document (``schema``, ``object``, ``answers``, …) is the client's: the device
writes it and ``validate_doc`` checks it. The visit models name only what the server adds and
pass the document's keys through (``extra="allow"``).
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import ObjectVisitProposalField

Lifecycle = Literal["draft", "completed", "discarded"]
TargetKind = Literal["object", "location"]
DeliveryState = Literal["pending", "delivered", "failed", "paused"]


class ObjectVisitPersonOut(BaseModel):
    """Who did it: an account's id and display name; both null for the admin session or an organizer."""

    id: str | None
    name: str | None


class ObjectVisitLocationOut(BaseModel):
    """Where a visit was (contract C2): the place of a location visit, the object for an object visit."""

    label: str | None
    address: str | None
    lat: float | None
    lng: float | None


class ObjectVisitDeliveryOut(BaseModel):
    """One destination's state for one visit, as the visit itself reports it."""

    destination: str
    state: DeliveryState
    revision: int
    at: str | None
    #: only while the delivery is ``failed`` or ``pending`` with an error
    error: str | None = None


class ObjectVisitOut(BaseModel):
    """``GET /{id}``: the document plus the server's fields (docs/object-visits.md «Server-added on read»).

    Only ``revision``/``ready``/``missing`` are required: the same model reads the visit inside a
    replayed PUT answer, stored by whichever server version accepted the revision."""

    model_config = ConfigDict(extra="allow")

    revision: int
    ready: bool
    #: photo ids the document names whose bytes the server does not hold yet
    missing: list[str]
    createdBy: ObjectVisitPersonOut | None = None
    createdAt: str | None = None
    updatedAt: str | None = None
    updatedBy: ObjectVisitPersonOut | None = None
    findings: int = 0
    url: str | None = None
    deliveries: list[ObjectVisitDeliveryOut] = Field(default_factory=list)
    #: absent: an object visit
    target_kind: TargetKind = "object"
    location: ObjectVisitLocationOut | None = None
    #: when it was finished: the first revision that said ``completed``
    completedAt: str | None = None
    #: from when corrections are refused; null where no lock applies
    lockedAt: str | None = None


class ObjectVisitPutOut(BaseModel):
    """``PUT /{id}`` accepted (200) — also the replay of a known ``opId``."""

    revision: int
    ready: bool
    missing: list[str]
    visit: ObjectVisitOut


class ObjectVisitAttachmentOut(BaseModel):
    """``PUT /{id}/attachments/{attId}``: the photo the server now holds (201 new · 200 already there)."""

    id: str
    sha256: str
    size: int


class ObjectVisitChecklistRefOut(BaseModel):
    """The checklist a visit was made with; ``title`` null when the snapshot has none."""

    id: str
    title: str | None


class ObjectVisitSummaryOut(BaseModel):
    """One row of ``GET /api/object-visits`` (newest first)."""

    id: str
    #: null for a visit at a place
    objectId: str | None
    objectName: str | None
    target_kind: TargetKind
    location: ObjectVisitLocationOut | None
    workRef: str | None
    lifecycle: Lifecycle
    revision: int
    ready: bool
    #: required on every accepted document (validate_doc)
    visitedAt: str
    updatedAt: str | None
    by: ObjectVisitPersonOut
    #: «Von»: the people typed on the visit
    with_: list[str] = Field(alias="with")
    findings: int
    #: null: «Ohne Checkliste»
    checklist: ObjectVisitChecklistRefOut | None


class ObjectVisitFilingOut(BaseModel):
    """One destination's filing of a visit, as the admin list reports it."""

    destination: str
    state: DeliveryState
    revision: int
    at: str | None
    #: the folder path below the library, once the first delivery made it
    folder: str | None
    #: only while the filing is ``failed`` or ``pending`` with an error
    error: str | None = None


class ObjectVisitAdminSummaryOut(ObjectVisitSummaryOut):
    """One row of ``GET /api/admin/object-visits``: the summary plus where the visit was filed."""

    deliveries: list[ObjectVisitFilingOut]


class ObjectVisitRevisionOut(BaseModel):
    """One row of ``GET /{id}/revisions``."""

    revision: int
    lifecycle: Lifecycle
    acceptedAt: str
    acceptedBy: ObjectVisitPersonOut
    ready: bool


class ObjectVisitRevisionDocOut(BaseModel):
    """``GET /{id}/revisions/{n}``: that revision's document plus when and by whom it was accepted."""

    model_config = ConfigDict(extra="allow")

    revision: int
    ready: bool
    acceptedAt: str
    acceptedBy: ObjectVisitPersonOut


# --- the catalogue -----------------------------------------------------------------------------


class ObjectVisitRefOut(BaseModel):
    """An object's id in another system (the organizer's ``source`` + its own ``id``)."""

    source: str
    id: str


class ObjectVisitLastVisitOut(BaseModel):
    """The latest visit to a catalogue object that was not discarded."""

    id: str
    #: required on every accepted document (validate_doc)
    visitedAt: str
    lifecycle: Lifecycle


class ObjectVisitCatalogueObjectOut(BaseModel):
    """One station object as the field app caches it."""

    id: str
    name: str
    address: str | None
    lat: float | None
    lng: float | None
    folder: str
    refs: list[ObjectVisitRefOut]
    hasPlans: bool
    lastVisit: ObjectVisitLastVisitOut | None


class ObjectVisitPriorDoneOut(BaseModel):
    """A completion the organizer already holds for a stop (``at`` YYYY-MM-DD); never a visit."""

    at: str
    by: str | None = None
    source: str | None = None
    note: str | None = None


class ObjectVisitListOut(BaseModel):
    """A work list (visit programme): its stops resolved to object ids, the refs nothing knows yet."""

    ref: str
    title: str
    note: str | None
    closesAt: str | None
    #: YYYY-MM-DD
    scheduledOn: str | None
    archived: bool
    objectIds: list[str]
    unresolved: list[ObjectVisitRefOut]
    #: object id → the organizer's prior completion
    done: dict[str, ObjectVisitPriorDoneOut]


class ObjectVisitCatalogueOut(BaseModel):
    """``GET /catalogue``: everything the field app caches for offline use."""

    generatedAt: str
    canCapture: bool
    objects: list[ObjectVisitCatalogueObjectOut]
    #: the ``visit`` checklist templates as uploaded (app/checklist_templates validates them)
    templates: list[dict[str, Any]]
    lists: list[ObjectVisitListOut]
    proposalFields: list[ObjectVisitProposalField]


# --- admin -------------------------------------------------------------------------------------


class ObjectVisitNotifyAccountOut(BaseModel):
    """One active account: whether it gets «Neuer Objektbesuch», and how many browsers can receive it."""

    id: str
    name: str
    username: str
    role: str
    notify: bool
    devices: int


class ObjectVisitNotifyOut(BaseModel):
    """``GET``/``PUT /notify``: who is told about a new visit."""

    pushEnabled: bool
    accounts: list[ObjectVisitNotifyAccountOut]


class ObjectVisitDeliveryRowOut(BaseModel):
    """One row of the delivery outbox (``GET /deliveries``)."""

    destination: str
    visitId: str
    objectName: str | None
    wantedRevision: int
    deliveredRevision: int
    state: DeliveryState
    attempts: int
    nextAttemptAt: str | None
    lastError: str | None
    updatedAt: str | None


class ObjectVisitRetryOut(BaseModel):
    """``POST /deliveries/retry``: how many deliveries went back to ``pending``."""

    retried: int


class ObjectVisitDestinationTestOut(BaseModel):
    """``POST /destinations/{id}/test``: Graph's answer to the test upload, or why none was tried."""

    ok: bool
    status: int | None
    detail: str
    #: the test file's SharePoint link, on success only
    webUrl: str | None = None
