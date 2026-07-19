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
                provider="divera", domain="personnel", configured=divera, active=divera,
                capabilities=["pull", "preview", "sync"],
            ),
            ProviderRegistration(
                provider="divera", domain="alarms", configured=divera, active=divera,
                capabilities=["pool", "refresh", "webhook", "take"],
            ),
            ProviderRegistration(
                provider="traccar", domain="vehicles", configured=traccar, active=traccar,
                capabilities=["positions", "status"],
            ),
        ],
    )
