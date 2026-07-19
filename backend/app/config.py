"""Application configuration (pydantic-settings).

A single standalone backend for kp-front. Same-origin in production (FastAPI serves
the SPA), so there is no CORS config and cookies are SameSite=Lax.
"""

import os
import secrets

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def is_production() -> bool:
    """Production when explicitly flagged, or auto-detected on Railway.

    Self-hosters (docker-compose on a VPS) set ``ENVIRONMENT=production`` (or ``APP_ENV``);
    Railway is still auto-detected via its injected env vars so existing deploys need no
    change. Being production makes SECRET_KEY mandatory (stable PIN/JWT signing), turns on
    Secure cookies, hides /docs, and hands schema ownership to Alembic.
    """
    env = (os.getenv("ENVIRONMENT") or os.getenv("APP_ENV") or "").strip().lower()
    if env in {"production", "prod", "staging"}:
        return True
    if env in {"development", "dev", "local", "test"}:
        return False
    railway_indicators = (
        "RAILWAY_ENVIRONMENT",
        "RAILWAY_PROJECT_ID",
        "RAILWAY_SERVICE_ID",
        "RAILWAY_STATIC_URL",
        "RAILWAY_PUBLIC_DOMAIN",
    )
    return any(os.getenv(k) is not None for k in railway_indicators)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Meta ---
    project_name: str = "kp-front API"
    version: str = "0.1.0"
    api_prefix: str = "/api"

    # --- Uvicorn ---
    host: str = "0.0.0.0"
    port: int = 8000

    # --- Database ---
    database_url: str = "postgresql+asyncpg://kpfront:kpfront@localhost:5434/kpfront"

    @field_validator("database_url", mode="before")
    @classmethod
    def _asyncpg_url(cls, v: str) -> str:
        if v.startswith("postgresql://") and not v.startswith("postgresql+asyncpg://"):
            return v.replace("postgresql://", "postgresql+asyncpg://", 1)
        return v

    # --- Security: SECRET_KEY both signs JWTs and peppers PINs ---
    secret_key: str = ""

    @field_validator("secret_key", mode="before")
    @classmethod
    def _secret(cls, v: str | None) -> str:
        if not v:
            if is_production():
                raise ValueError("SECRET_KEY is required in production (openssl rand -hex 32).")
            generated = secrets.token_hex(32)
            print(f"\U0001f511 Generated development SECRET_KEY: {generated[:8]}…")
            return generated
        if len(v) < 32:
            raise ValueError("SECRET_KEY must be at least 32 characters (openssl rand -hex 32).")
        return v

    algorithm: str = "HS256"
    access_token_expire_minutes: int = 480  # 8h
    refresh_token_expire_days: int = 7

    # PIN policy
    pin_length: int = 6
    pin_bcrypt_rounds: int = 12

    # Cooldown limiter (availability-safe; never permanent)
    pin_free_attempts: int = 5
    pin_cooldown_steps_seconds: list[int] = [5, 10, 30, 60, 120]

    # Capture-surface throttle (per client IP; token bucket, app/auth/capture_limiter.py).
    # Sized so a FAST legit operator (rapid stepper taps ≈ 2–3 req/s in bursts) never
    # trips it: a 120-deep burst plus 2 req/s sustained refill means even continuous
    # 3 req/s tapping lasts ~2 minutes before the first 429 — only scripted abuse of the
    # long-lived poster token gets throttled. Never permanent (refills by itself).
    capture_rate_burst: int = 120
    capture_rate_per_minute: int = 120

    # --- Deployment-admin auth (separate from the incident editor role) ---
    # A shared secret unlocks the /admin UI and the admin-write API/CLI (config,
    # branding, system, user CRUD, geodata/objects). Empty = admin surface is DISABLED
    # (fail-closed): every admin endpoint returns 403 until ADMIN_SECRET is configured.
    # It NEVER falls back to the editor PIN. Generate with `openssl rand -hex 24`.
    admin_secret: str = ""
    admin_session_expire_minutes: int = 240  # 4h admin-session cookie

    @field_validator("admin_secret", mode="before")
    @classmethod
    def _admin_secret(cls, v: str | None) -> str:
        v = (v or "").strip()
        if v and len(v) < 16:
            raise ValueError("ADMIN_SECRET must be at least 16 characters when set (openssl rand -hex 24).")
        return v

    @property
    def cookie_secure(self) -> bool:
        # Secure cookies follow production, but a self-hoster serving over plain HTTP on a
        # trusted LAN (no domain/TLS) can force them off so login still works: COOKIE_SECURE=false.
        override = os.getenv("COOKIE_SECURE")
        if override is not None and override.strip() != "":
            return override.strip().lower() in {"1", "true", "yes", "on"}
        return is_production()

    # --- Seeding ---
    seed_database: bool = True
    seed_users_file: str = "app/seed_users.json"
    # In dev, create tables from models on startup (prod relies on Alembic migrations).
    dev_create_all: bool = True

    # --- SPA serving (single service in prod) ---
    spa_dir: str = "../dist"

    # --- Object storage ---
    media_storage_dir: str = "data/storage"

    # --- Request body size caps (reject early with 413; protect the single instance) ---
    # Must stay above the media endpoint's per-file cap (media.py MAX_UPLOAD_BYTES, 100 MB)
    # plus multipart overhead, or imported voice memos die in the middleware instead.
    max_upload_mb: int = 110     # multipart file uploads (media, plans, reference data)
    max_json_body_mb: int = 8    # JSON bodies (workspace blob, details, etc.)

    # --- Divera (Phase 3) ---
    divera_access_key: str = ""
    # Optional second accesskey used ONLY for the personnel/Mannschaft pull. It must belong to a
    # Divera user whose read scope includes members' Qualifikationen (the alarm accesskey above
    # typically does NOT — its consumer objects return empty `qualifications`). When set, the
    # roster sync derives each member's Dienstgrad from their rank qualifications. Falls back to
    # divera_access_key when empty (→ no rank derivation, names only).
    divera_personnel_access_key: str = ""
    divera_api_url: str = "https://app.divera247.com/api/v2"
    divera_poll_interval_seconds: int = 120
    divera_poll_max_alarms: int = 50
    divera_webhook_secret: str = ""

    # --- Generic alarm intake (POST /api/alarms, non-Divera alerting systems) ---
    # Fail-closed: unset → the endpoint answers 403. Setting the secret IS the opt-in.
    alarm_webhook_secret: str = ""
    # Public origin of this deployment (e.g. https://front.example.org) — used to compose
    # absolute links in outbound webhooks (capture URL on the alarm slip). Empty = links omitted.
    public_url: str = ""
    # Auto-archive sweep cadence for untouched auto-opened incidents (the day threshold
    # itself is deployment config: alarms.autoArchiveDays).
    auto_archive_check_seconds: int = 3600

    # --- Station print relay ---
    # Shared secret for the on-site print agent (`tools/print_agent.py`) that polls
    # /api/print-agent/* and prints queued Einsatzrapport-PDFs on the station printer.
    # Fail-closed: unset → agent endpoints answer 403 and the app never shows the
    # «An Stationsdrucker» button. Generate with `openssl rand -hex 24`.
    print_agent_secret: str = ""

    # --- Traccar (Phase 6) ---
    traccar_url: str = ""
    traccar_email: str = ""
    traccar_password: str = ""
    # Dev/testing: serve injected fake fleet positions instead of a real Traccar server
    # (POST /api/traccar/fake, driven by `python -m app.fake_scenario`). Fail-closed: off
    # by default, and injecting additionally requires ALARM_WEBHOOK_SECRET. Never set in
    # a field deployment — the map would show the fake fleet instead of the real one.
    traccar_fake: bool = False

    @field_validator("traccar_fake", mode="before")
    @classmethod
    def _empty_fake_flag_is_false(cls, v: object) -> object:
        # compose passes TRACCAR_FAKE through as "" when unset — treat blank as off.
        if isinstance(v, str) and v.strip() == "":
            return False
        return v

    # --- Speech-to-text (player drafts) ---
    # One OpenAI-compatible adapter: POST {stt_base_url}/v1/audio/transcriptions covers
    # OpenAI (https://api.openai.com), Groq (https://api.groq.com/openai), and self-hosted
    # faster-whisper servers — base URL WITHOUT the /v1 suffix. Fail-closed: empty base URL
    # → no Transkribieren button, endpoints 503. Audio leaves the instance only when a
    # base URL is configured; the key is optional (self-hosted servers need none).
    stt_base_url: str = ""
    stt_api_key: str = ""
    stt_model: str = "whisper-large-v3-turbo"
    stt_language: str = "de"

    # --- Web Push (killed-app alarms: Atemschutz überfällig + Wiedervorlagen) ---
    # Generate a VAPID pair once per deployment (see .env.example); push is silently
    # disabled while unset — the in-app tone/notification path keeps working regardless.
    vapid_private_key: str = ""
    vapid_public_key: str = ""
    vapid_subject: str = "mailto:kp-front@localhost"
    push_check_seconds: int = 30
    push_renotify_seconds: int = 120

    # --- Weather / wind ---
    # Provider order: "meteoswiss" (nearest SMN station, primary) or "open-meteo"
    # (point-based, fallback). The non-default provider is always tried as fallback.
    weather_provider: str = "meteoswiss"
    weather_cache_ttl_seconds: int = 600  # 10 min — observations refresh ~every 10 min
    # MeteoSwiss OGD (data.geo.admin.ch) — VQHA80 carries all current params per station,
    # joined to the SMN station metadata (which already exposes WGS84 station coords).
    meteoswiss_vqha80_url: str = "https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv"
    meteoswiss_stations_url: str = "https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv"
    # Open-Meteo current-conditions endpoint (no key required).
    open_meteo_url: str = "https://api.open-meteo.com/v1/forecast"

    # --- Geocoder (swisstopo), biased to the brigade's region ---
    # The bias is normally supplied per-deployment via the DeploymentConfig singleton
    # (map.geocoder.defaultLocality / .bboxLv95); these settings are the fallback when no
    # config is present. Empty = unbiased national search (neutral fresh/public build).
    geocoder_url: str = "https://api3.geo.admin.ch/rest/services/api/SearchServer"
    # Appended to bare street addresses (no postal code) so they resolve locally.
    geocoder_default_locality: str = ""
    # LV95 (EPSG:2056) bbox "minE,minN,maxE,maxN" used to rank local results first.
    geocoder_bbox_lv95: str = ""

    # Expose the OpenAPI docs (/docs, /redoc, /openapi.json) in production. Off by default —
    # the API has no public surface beyond the same-origin SPA — but a self-hoster can turn it
    # on for integration work. Dev always exposes them regardless of this flag.
    expose_api_docs: bool = False

    @field_validator("expose_api_docs", mode="before")
    @classmethod
    def _empty_docs_flag_is_false(cls, v: object) -> object:
        # compose passes EXPOSE_API_DOCS through as "" when unset — treat blank as off
        # instead of letting pydantic's bool parsing crash the whole boot.
        if isinstance(v, str) and v.strip() == "":
            return False
        return v

    @property
    def is_production(self) -> bool:
        return is_production()

    @property
    def api_docs_enabled(self) -> bool:
        """Show OpenAPI docs in dev always; in production only when EXPOSE_API_DOCS=true."""
        return (not is_production()) or self.expose_api_docs


settings = Settings()
