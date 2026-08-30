"""Provider capability registry shared by public config and admin system status.

⚠️ Reads through ``app.credentials`` (env first, admin-set otherwise) rather than off the
boot-time settings object. Synchronous by design — ``api/config._projection`` builds this
inside a response model — so it serves the process-wide snapshot; every caller awaits
``credentials.load(db)`` on the way in, and the scheduler refreshes it every 30 s regardless.
"""

from .credentials import get as credential
from .schemas import ConfigIntegrations, ProviderCapability, ProviderRegistration


def integrations() -> ConfigIntegrations:
    divera = bool(credential("divera_access_key"))
    alarm_webhook = bool(credential("alarm_webhook_secret"))
    alarm_provider = "divera" if divera else "webhook" if alarm_webhook else None
    traccar = bool(credential("traccar_url") and credential("traccar_email") and credential("traccar_password"))
    return ConfigIntegrations(
        diveraConfigured=divera,
        traccarConfigured=traccar,
        sttConfigured=bool(credential("stt_base_url")),
        cartoBasemapKey=credential("carto_api_key") or None,
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
