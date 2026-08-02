"""Provider capability registry shared by public config and admin system status."""

from .config import settings
from .schemas import ConfigIntegrations, ProviderCapability, ProviderRegistration


def integrations() -> ConfigIntegrations:
    divera = bool(settings.divera_access_key)
    traccar = bool(settings.traccar_url and settings.traccar_email and settings.traccar_password)
    return ConfigIntegrations(
        diveraConfigured=divera,
        traccarConfigured=traccar,
        sttConfigured=bool(settings.stt_base_url),
        personnel=ProviderCapability(
            provider="divera" if divera else None,
            configured=divera,
            capabilities=["pull", "preview", "sync"] if divera else [],
        ),
        alarms=ProviderCapability(
            provider="divera" if divera else None,
            configured=divera,
            capabilities=["pool", "refresh", "webhook", "take"] if divera else ["manual", "generic-webhook"],
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
            ProviderRegistration(
                provider="traccar",
                domain="vehicles",
                configured=traccar,
                active=traccar,
                capabilities=["positions", "status"],
            ),
            # Published contract, no ingestion yet — `implemented=False` says so out loud
            # rather than letting a registry entry imply a working feature. A station
            # selects it with `roster.source: "snapshot"`; the file it would read is
            # specified in docs/CONFIGURATION.md §4c and docs/roster-snapshot.schema.json.
            ProviderRegistration(
                provider="snapshot",
                domain="personnel",
                configured=False,
                active=False,
                capabilities=["contract"],
                implemented=False,
            ),
        ],
    )
