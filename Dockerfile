# Single-service image: build the Vite SPA, then run FastAPI serving the SPA + API
# from one origin (SameSite=Lax cookies, zero CORS). One Railway service.

# --- Stage 1: build the SPA ---------------------------------------------------------
FROM node:20-slim AS frontend
WORKDIR /app
# Pin pnpm 10 (matches lockfileVersion 9.0). corepack's bundled default is incompatible
# with this Node, so install explicitly.
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# .git is dockerignored, so the build stamp's sha comes in as a build arg: Railway passes
# RAILWAY_GIT_COMMIT_SHA automatically for declared ARGs; other builders may pass GIT_SHA.
# Falls back to 'dev' in the label — update detection doesn't depend on it (swUpdate.ts).
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA:-$RAILWAY_GIT_COMMIT_SHA}
RUN pnpm build

# --- Stage 2: backend runtime -------------------------------------------------------
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app/backend

# pg_dump for the pre-migration safety dump in start.sh (and manual in-container dumps).
# ffmpeg decodes uploaded voice memos server-side: waveform peaks + the STT re-encode
# (docs/planning/audio-player-markers.md). Missing ffmpeg degrades to a flat seek bar.
# fonts-dejavu-core: the server-side Kroki/plan renderer (app/kroki.py) needs a real
# sans font — PIL labels AND resvg's <text> letters in the tactical-symbol pack; without
# it the symbol letters (F/W/…) silently vanish from the rendered glyphs.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first from the lockfile alone, so editing backend code doesn't
# re-resolve/re-download every dependency (this layer is cached unless deps change).
COPY backend/pyproject.toml backend/uv.lock /app/backend/
RUN uv sync --no-dev --no-install-project

# Then the app code (+ install the project itself into the existing venv).
COPY backend/ /app/backend/
RUN uv sync --no-dev

# SPA build + public assets (plans, leitungskataster, symbols seed source).
COPY --from=frontend /app/dist /app/dist
COPY public /app/public

ENV SPA_DIR=/app/dist
# Railway volume mount for media / snapshots / reference files.
ENV MEDIA_STORAGE_DIR=/mnt/data/storage
ENV SEED_DATABASE=true

# Run as a non-root user. Pre-create both storage roots (compose mounts /data/storage,
# Railway /mnt/data/storage) owned by the app user, so an EMPTY named volume inherits the
# ownership on first mount. If the platform mounts a volume root-owned anyway, /ready flags
# storage as not writable and a gated deploy fails fast instead of losing media silently.
RUN useradd --uid 10001 --create-home app \
    && mkdir -p /data/storage /mnt/data/storage \
    && chown -R app:app /app /data /mnt/data \
    && chmod +x /app/backend/start.sh
USER app
CMD ["/app/backend/start.sh"]
