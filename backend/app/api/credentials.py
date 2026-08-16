"""Integration credentials: admin-only, write-only for anything secret.

The contract, and the reason for each half of it:

* **An admin session may SET or CLEAR a credential and may not READ one back.** A stolen
  tablet with `/admin` unlocked, or a leaked `ADMIN_SECRET`, must not be a way to walk off
  with the station's Divera key. Rotating from a phone at 3am beats SSH; exfiltrating from a
  phone at 3am does not, so only one of the two is possible here.
* **Six fields are readable, and each one earns it individually** (see the `secret` flag in
  app/credentials · FIELDS): a Traccar hostname, the STT server/model/language, the VAPID
  public key (already handed to every logged-in browser by `/api/push/vapid-key`) and the
  VAPID contact address. Everything else — including `TRACCAR_EMAIL`, which is half of a
  credential pair, and `HEALTHCHECK_PING_URL`, whose only misuse is pinging it to keep a
  monitor believing a dead station is alive — answers with `configured: true` and nothing
  more.
* **`.env` wins where it is set**, so an existing deployment is untouched. A field the
  environment supplies is reported with `source: "env"` and refuses writes (409) rather than
  storing a value that would then be shadowed — «I typed the key in and nothing happened» is
  precisely the failure this whole surface was built to end.
* **A credential that will not decrypt is reported as `unreadable`**, never as unset. That
  state means `SECRET_KEY` was rotated (docs/DEPLOYMENT.md: don't), and the operator needs to
  be told «set it again», not sent looking for a setting they already made.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import credentials as creds
from ..auth.dependencies import CurrentAdmin, OptionalUser
from ..database import get_db
from ..models import IntegrationCredentialAudit, User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/integrations", tags=["integrations"])


class CredentialState(BaseModel):
    """One credential's state. ``value`` is present ONLY for the non-secret fields."""

    name: str
    group: str
    label: str
    secret: bool
    #: env | stored | unset | unreadable
    source: str
    configured: bool
    #: The env variable a deployer would set instead — named so the page can say where a
    #: server-set value comes from without the operator having to guess.
    env: str
    value: str | None = None
    updatedAt: str | None = None  # noqa: N815 — camelCase mirrors the frontend contract
    updatedByName: str | None = None  # noqa: N815


class CredentialIn(BaseModel):
    value: str = Field(min_length=1, max_length=2048)


class CredentialAuditEntry(BaseModel):
    id: int
    name: str
    label: str
    action: str
    source: str | None
    at: str
    by: str | None


def _state(name: str, *, updated_by_name: str | None = None) -> CredentialState:
    f = creds.BY_NAME[name]
    r = creds.resolved(name)
    return CredentialState(
        name=f.name,
        group=f.group,
        label=f.label,
        secret=f.secret,
        source=r.source,
        # `unreadable` is NOT configured: every consumer treats it as missing, and saying
        # otherwise here would put a green tick next to a dead integration.
        configured=r.source in ("env", "stored"),
        env=f.env,
        # ⚠️ The one place a value may leave this process, and it is gated on the field's own
        # `secret` flag rather than on anything about the caller. There is no admin level at
        # which a Divera key becomes readable.
        value=None if f.secret else (r.value or None),
        updatedAt=r.updated_at.isoformat() if r.updated_at else None,
        updatedByName=updated_by_name,
    )


async def _names(db: AsyncSession) -> dict[object, str]:
    """Resolve the acting admins' display names for the whole snapshot in one query."""
    ids = {r.updated_by for r in (await creds.load(db)).values() if r.updated_by}
    if not ids:
        return {}
    return {u.id: u.display_name for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars()}


@router.get("/credentials", response_model=list[CredentialState])
async def list_credentials(_admin: CurrentAdmin, db: AsyncSession = Depends(get_db)) -> list[CredentialState]:
    """Every settable credential and where it currently comes from. Never a secret value."""
    await creds.load(db, force=True)
    names = await _names(db)
    out: list[CredentialState] = []
    for f in creds.FIELDS:
        r = creds.resolved(f.name)
        out.append(_state(f.name, updated_by_name=names.get(r.updated_by) if r.updated_by else None))
    return out


@router.put("/credentials/{name}", response_model=CredentialState)
async def put_credential(
    name: str,
    body: CredentialIn,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    db: AsyncSession = Depends(get_db),
) -> CredentialState:
    """Set or replace one credential. The response says THAT it is set, never what it is."""
    if name not in creds.BY_NAME:
        raise HTTPException(status_code=404, detail=f"Unbekannter Zugang «{name}».")
    await creds.load(db, force=True)
    if creds.resolved(name).source == "env":
        raise HTTPException(status_code=409, detail=_env_message(name))
    try:
        await creds.set_value(db, name, body.value, actor_id=actor.id if actor else None)
    except creds.CredentialRefusedError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    # ⚠️ Commit here rather than at dependency teardown: the page re-reads the list straight
    # after saving (that is what turns «gesetzt» from a hope into a fact), and against the
    # teardown commit that refetch races and loses — the row would come back «nicht gesetzt»
    # until a reload, which on a credential form reads as «the save did not take».
    await db.commit()
    return _state(name)


@router.delete("/credentials/{name}", response_model=CredentialState)
async def delete_credential(
    name: str,
    _admin: CurrentAdmin,
    actor: OptionalUser,
    db: AsyncSession = Depends(get_db),
) -> CredentialState:
    """Remove a stored credential — the integration falls back to off (fail-closed)."""
    if name not in creds.BY_NAME:
        raise HTTPException(status_code=404, detail=f"Unbekannter Zugang «{name}».")
    await creds.load(db, force=True)
    if creds.resolved(name).source == "env":
        raise HTTPException(status_code=409, detail=_env_message(name))
    try:
        await creds.clear(db, name, actor_id=actor.id if actor else None)
    except creds.CredentialRefusedError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    await db.commit()
    return _state(name)


@router.get("/credentials-audit", response_model=list[CredentialAuditEntry])
async def list_credential_audit(
    _admin: CurrentAdmin,
    db: AsyncSession = Depends(get_db),
    limit: int = 30,
) -> list[CredentialAuditEntry]:
    """Which credentials changed, when and by whom — the record, never the values.

    The point of the record is the question nobody could answer after the fact about the
    config document: was that a person or an unattended writer, and which one. A row with no
    name is not a gap, it is «nobody was signed in behind it».
    """
    rows = (
        (
            await db.execute(
                select(IntegrationCredentialAudit)
                .order_by(IntegrationCredentialAudit.at.desc())
                .limit(max(1, min(limit, 200)))
            )
        )
        .scalars()
        .all()
    )
    ids = {r.actor_id for r in rows if r.actor_id}
    names: dict[object, str] = {}
    if ids:
        names = {u.id: u.display_name for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars()}
    return [
        CredentialAuditEntry(
            id=r.id,
            name=r.name,
            label=creds.BY_NAME[r.name].label if r.name in creds.BY_NAME else r.name,
            action=r.action,
            source=r.source,
            at=r.at.isoformat(),
            by=names.get(r.actor_id) if r.actor_id else None,
        )
        for r in rows
    ]


def _env_message(name: str) -> str:
    f = creds.BY_NAME[name]
    return (
        f"«{f.label}» wird von der Server-Umgebung vorgegeben ({f.env} in .env) und lässt sich "
        "hier nicht ändern. Entferne den Eintrag aus .env und starte neu, um ihn hier zu setzen."
    )
