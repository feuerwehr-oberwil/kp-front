"""Who decided, and what they decided.

Consent lives on the deployment, not on the device. A firefighter tapping through a tablet
at 3am cannot consent on behalf of the fire station — the station is the data controller,
the person holding the tablet is not, and a per-device checkbox would quietly move a legal
decision onto whoever happens to be on duty. So the switch is in the admin surface (behind
ADMIN_SECRET, the same gate as the config and the capture secret) and it applies to the
whole instance.

The background channel needs that switch. The manual "Problem melden" channel does not: the
operator reads the full payload and presses send, and pressing send IS the consent. What the
admin switch can do to the manual channel is turn it OFF entirely, for a station whose policy
forbids outbound traffic — and even then the mailto:/copy path still works, so an operator is
never left without a way to reach us.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import DeploymentConfig

logger = logging.getLogger("kp.telemetry")

# The only two values the column may hold. 'off' and NULL are the same thing; NULL is what a
# fresh or upgraded install has, which is why "off" is the default without any code running.
CONSENT_OFF = "off"
CONSENT_ERRORS = "errors"
VALID_CONSENT = {CONSENT_OFF, CONSENT_ERRORS}


def env_allows_outbound() -> bool:
    """The deployer's kill switch, which outranks anything an admin clicks.

    ``KP_TELEMETRY_ENABLED=0`` (or an empty DSN) means this process will not talk to an
    ingest, full stop — the consent row can say whatever it likes. That ordering matters for
    a station whose IT policy is set centrally: they can enforce it in the compose file and
    not have to trust that nobody will tick a box later.
    """
    return bool(settings.telemetry_enabled and settings.telemetry_dsn)


async def _row(db: AsyncSession) -> DeploymentConfig | None:
    return (await db.execute(select(DeploymentConfig).where(DeploymentConfig.id == 1))).scalar_one_or_none()


async def get_consent(db: AsyncSession) -> str:
    """Current background-channel consent. Anything unrecognised reads as off (fail-closed)."""
    if not env_allows_outbound():
        return CONSENT_OFF
    row = await _row(db)
    value = (row.telemetry_consent or CONSENT_OFF) if row else CONSENT_OFF
    return value if value in VALID_CONSENT else CONSENT_OFF


async def is_decided(db: AsyncSession) -> bool:
    """Has anyone ever actually answered the question?

    NULL and 'off' behave identically — both send nothing — but they are not the same state
    to a human, and conflating them is how opt-in quietly becomes opt-out-by-neglect. NULL
    means nobody was ever asked, so the admin surface asks, once, with no option preselected.
    A deliberate 'off' is an answer and is never asked about again.
    """
    row = await _row(db)
    return bool(row and row.telemetry_consent in VALID_CONSENT)


async def set_consent(db: AsyncSession, value: str) -> str:
    """Record an admin's decision. Returns what was actually stored.

    Turning it off does not delete what is already queued — the forwarder drops those rows
    instead, so an operator who switches off mid-flight can still see in the outbox what had
    been queued and confirm that it never left.
    """
    if value not in VALID_CONSENT:
        raise ValueError(f"telemetry consent must be one of {sorted(VALID_CONSENT)}")
    row = await _row(db)
    if row is None:
        row = DeploymentConfig(id=1)
        db.add(row)
    row.telemetry_consent = value
    logger.info("telemetry consent set to %s", value)
    return value


async def get_install_id(db: AsyncSession, *, mint: bool = False) -> str | None:
    """The random per-install id, minted lazily on first send.

    Lazily, because an instance that never opts in should not carry an identifier for a
    thing it never did. ``mint=False`` is the read path (admin screen), ``mint=True`` the
    write path (queueing a payload).
    """
    row = await _row(db)
    if row is not None and row.telemetry_install_id:
        return str(row.telemetry_install_id)
    if not mint:
        return None
    if row is None:
        row = DeploymentConfig(id=1)
        db.add(row)
    row.telemetry_install_id = uuid.uuid4()
    logger.info("telemetry install id minted: %s", row.telemetry_install_id)
    return str(row.telemetry_install_id)


async def regenerate_install_id(db: AsyncSession) -> str:
    """Cut the link to everything sent so far.

    This is the self-service half of a deletion request: the old id stays on reports we
    already hold, but nothing the station sends from now on can be joined to them, and we
    have no way to bridge the two. Paired with the mail address in PRIVACY.md for the other
    half (asking us to delete what is already there, by quoting the old id).
    """
    row = await _row(db)
    if row is None:
        row = DeploymentConfig(id=1)
        db.add(row)
    row.telemetry_install_id = uuid.uuid4()
    logger.info("telemetry install id regenerated")
    return str(row.telemetry_install_id)
