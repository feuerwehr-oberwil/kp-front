"""Provider capability registry shared by public config and admin system status.

⚠️ Reads through ``app.credentials`` (env first, admin-set otherwise) rather than off the
boot-time settings object. Synchronous by design — ``api/config._projection`` builds this
inside a response model — so it serves the process-wide snapshot; every caller awaits
``credentials.load(db)`` on the way in, and the scheduler refreshes it every 30 s regardless.
"""

import importlib.util

from . import overpass
from .credentials import get as credential
from .schemas import ConfigIntegrations, ProviderCapability, ProviderRegistration

#: The optional `georef` extra, by top-level module (pyproject `[project.optional-dependencies]`
#: georef). ⚠️ Keep in step with what ``app/georef_suggest.py`` imports — this answers «can the
#: matcher run» WITHOUT paying its ~60 MB import on a public config read, so it is a proxy, and a
#: proxy that drifts lies to the surface it gates.
_GEOREF_MODULES = ("cv2", "numpy", "scipy")


def auto_align_available() -> bool:
    """Can this server answer POST /api/georef/suggest at all?

    Both preconditions the endpoint fails closed on (503): the CV matcher's optional
    dependencies are installed, and an Overpass mirror is configured to fetch the reference
    buildings from. The frontend reads this as ``integrations.autoAlignConfigured`` and HIDES
    «Automatisch ausrichten» when it is false — an image without the extra used to offer the
    button and answer every press with «…ist auf diesem Server nicht eingerichtet».
    """
    if not overpass.mirrors():
        return False
    return all(importlib.util.find_spec(name) is not None for name in _GEOREF_MODULES)


def integrations() -> ConfigIntegrations:
    from .auth.microsoft import enabled as microsoft_login_enabled  # deferred: auth imports the app's models

    divera = bool(credential("divera_access_key"))
    alarm_webhook = bool(credential("alarm_webhook_secret"))
    alarm_provider = "divera" if divera else "webhook" if alarm_webhook else None
    traccar = bool(credential("traccar_url") and credential("traccar_email") and credential("traccar_password"))
    snapshot = bool(credential("roster_snapshot_source"))
    return ConfigIntegrations(
        diveraConfigured=divera,
        traccarConfigured=traccar,
        sttConfigured=bool(credential("stt_base_url")),
        autoAlignConfigured=auto_align_available(),
        cartoBasemapKey=credential("carto_api_key") or None,
        microsoftLoginConfigured=microsoft_login_enabled(),
        personnel=ProviderCapability(
            provider="divera" if divera else None,
            configured=divera,
            capabilities=["pull", "preview", "sync"] if divera else [],
        ),
        alarms=ProviderCapability(
            provider=alarm_provider,
            configured=divera or alarm_webhook,
            capabilities=(
                ["pool", "refresh", "webhook", "take"]
                if divera
                else ["generic-webhook", "auto-open", "lifecycle"]
                if alarm_webhook
                else ["manual"]
            ),
        ),
        vehicles=ProviderCapability(
            provider="traccar" if traccar else None,
            configured=traccar,
            capabilities=["positions", "status"] if traccar else [],
        ),
        providers=[
            ProviderRegistration(
                provider="divera",
                domain="personnel",
                configured=divera,
                active=divera,
                capabilities=["pull", "preview", "sync"],
            ),
            ProviderRegistration(
                provider="divera",
                domain="alarms",
                configured=divera,
                active=divera,
                capabilities=["pool", "refresh", "webhook", "take"],
            ),
            # The shared alarm secret enables every webhook adapter, so it cannot prove that
            # this station actually connected FireHub. Keep the adapter discoverable without
            # claiming a provider-specific setup or an active connection.
            ProviderRegistration(
                provider="firehub",
                domain="alarms",
                configured=False,
                active=False,
                capabilities=["webhook", "auto-open", "lifecycle"],
            ),
            ProviderRegistration(
                provider="traccar",
                domain="vehicles",
                configured=traccar,
                active=traccar,
                capabilities=["positions", "status"],
            ),
            # A roster file the station publishes (docs/CONFIGURATION.md §4c), read by
            # app/roster_snapshot_sync.py once `roster_snapshot_source` is set. Deliberately NOT
            # promoted into `personnel` above: that slot gates the Divera sync controls, and a
            # station running both must keep them.
            ProviderRegistration(
                provider="snapshot",
                domain="personnel",
                configured=snapshot,
                active=snapshot,
                capabilities=["pull", "schedule", "outcome"],
                implemented=True,
            ),
        ],
    )
