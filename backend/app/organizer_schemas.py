"""Objektbesuche — the response models of the organizer API, ``/api/integrations`` (docs/object-visits.md).

The answers are built as dicts in ``app.object_visits``, ``app.visit_programmes`` and the router;
these models name every key of them, so ``docs/openapi.json`` carries the wire types an outside
organizer (fwo-admin, fwo-stats) can generate a client from. Shapes the field API answers too
(a visit, the catalogue, an object ref, a prior completion) come from ``object_visit_schemas``.

⚠️ The routes answer with ``response_model_exclude_unset=True``, as the field API does: a key the
producer left out stays out, a default here is never sent. A field without a default is always
there. A key the model does not name is DROPPED without an error — name every key.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from .object_visit_schemas import (
    Lifecycle,
    ObjectVisitCatalogueOut,
    ObjectVisitDeliveryOut,
    ObjectVisitLocationOut,
    ObjectVisitPersonOut,
    ObjectVisitPriorDoneOut,
    ObjectVisitRefOut,
    TargetKind,
)

# --- visit programmes --------------------------------------------------------------------------


class VisitProgrammeRouteOut(BaseModel):
    """A reusable route: its ordered stops by the organizer's ids. Retired routes stay listed."""

    code: str
    title: str
    objects: list[ObjectVisitRefOut]
    retired: bool


class VisitProgrammeOut(BaseModel):
    """``GET``/``PUT …/visit-programmes/{ref}…``: the routes and the years published from them.

    An unknown ref reads as revision 0 with no routes; ``revision`` guards the next write."""

    revision: int
    routes: list[VisitProgrammeRouteOut]
    years: list[int]


# --- reads -------------------------------------------------------------------------------------


class OrganizerCatalogueOut(ObjectVisitCatalogueOut):
    """``GET /object-visits/catalogue``: the field catalogue (``canCapture`` false) plus the map key."""

    #: CARTO's public browser key; null when the station has none
    cartoBasemapKey: str | None


class OrganizerFeedItemOut(BaseModel):
    """One visit at its latest state in the change feed (docs/object-visits.md «FeedItem»)."""

    seq: int
    id: str
    #: null for a visit at a place
    objectId: str | None
    #: live ``{source, id}`` rows from ``object_refs``; for a visit whose object is gone, the
    #: document's snapshot as the device wrote it (validate_doc does not check it)
    objectRefs: list[Any]
    objectName: str | None
    workRef: str | None
    revision: int
    lifecycle: Lifecycle
    ready: bool
    #: required on every accepted document (validate_doc)
    visitedAt: str
    updatedAt: str | None
    by: ObjectVisitPersonOut
    #: «Von»: the people typed on the visit
    with_: list[str] = Field(alias="with")
    findings: int
    #: the document's correction proposals as the device wrote them
    proposals: list[dict[str, Any]]
    deliveries: list[ObjectVisitDeliveryOut]
    url: str
    target_kind: TargetKind
    location: ObjectVisitLocationOut | None


class OrganizerFeedOut(BaseModel):
    """``GET /object-visits/changes``: poll again with ``after=nextAfter``."""

    items: list[OrganizerFeedItemOut]
    #: the last item's ``seq``, or ``after`` when there is none
    nextAfter: int


class OrganizerObjectOut(BaseModel):
    """``GET /objects/by-ref/{source}/{externalId}``: the station object behind the organizer's id."""

    objectId: str
    name: str
    address: str | None
    lat: float | None
    lng: float | None
    folder: str
    refs: list[ObjectVisitRefOut]
    hasPlans: bool


class OrganizerPlanOut(BaseModel):
    """One row of ``GET /objects/{id}/plans``: the current plan of one Modul-Slot."""

    module: str
    title: str | None
    #: the current version — send it back as ``?revision=`` for exactly these bytes
    revision: int
    contentType: str
    size: int | None


# --- writes ------------------------------------------------------------------------------------


class OrganizerObjectPutOut(BaseModel):
    """``PUT /objects/{source}/{externalId}``: the object the id resolved to, or was created as."""

    objectId: str
    created: bool


class OrganizerObjectDeleteOut(BaseModel):
    """``DELETE /objects/{source}/{externalId}``: what went (idempotent)."""

    removed: Literal["ref", "object", "none"]


class OrganizerVisitListPutOut(BaseModel):
    """``PUT /visit-lists/{ref}``: the stops resolved now, the refs nothing knows yet."""

    ref: str
    objectIds: list[str]
    unresolved: list[ObjectVisitRefOut]
    #: object id → the organizer's prior completion (resolved stops only)
    done: dict[str, ObjectVisitPriorDoneOut]


class OrganizerVisitListDeleteOut(BaseModel):
    """``DELETE /visit-lists/{ref}``: whether a list was there (idempotent)."""

    ref: str
    deleted: bool
