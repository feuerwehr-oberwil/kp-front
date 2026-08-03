# Single-service image: build the Vite SPA, then run FastAPI serving the SPA + API
# from one origin (SameSite=Lax cookies, zero CORS). One Railway service.

# --- Stage 1: build the SPA ---------------------------------------------------------
# Pinned to the BUILD platform, not the target: the output is plain JS/CSS and works on any
# architecture, so pinning keeps the Vite build native even when the final image is arm64 —
# otherwise a multi-arch build runs pnpm under QEMU and takes an order of magnitude longer.
# Node 24 = Active LTS (security support to 2028-04-30). Node 20 went end-of-life on
# 2026-04-30 and this stage sat on it for three months. Keep in step with node-version in
# .github/workflows/ci.yml and the engines field in package.json; dependabot's docker
# ecosystem now proposes the bumps so it cannot drift silently again.
FROM --platform=$BUILDPLATFORM node:25-slim AS frontend
WORKDIR /app
# Pin pnpm 10 (matches lockfileVersion 9.0). corepack's bundled default is incompatible
# with the Node line above, so install explicitly.
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
# It comes from PGDG, not from Debian: bookworm ships client 15, and pg_dump refuses to dump
# a server NEWER than itself. So every migration logged «pre-migration dump failed —
# continuing, but fix your backups» and then migrated with no backup at all — on CI and on
# every self-hosted box following SETUP.md.
#
# ⚠️ This must be >= the HIGHEST server major this image will ever be pointed at, not just
# the one in docker-compose.yml. Pinning it to the compose image (16) is what broke it the
# second time: compose runs postgres:16, but Railway production runs 18.x, so a client that
# matched compose still could not dump production — and start.sh's guard skipped the dump
# silently on every deploy. A newer client dumps an older server fine, never the reverse,
# so one pin at the highest server covers every deployment target:
#     Railway production 18.x  ─┐
#     docker-compose  16       ─┴─> postgresql-client-18
# Verify with `SHOW server_version` against each target before lowering this.
#
# The key is fetched by the builder itself (no curl/gnupg in the image); apt reads an
# ASCII-armored keyring directly as long as it is named .asc.
ARG PG_CLIENT_MAJOR=18
ADD --chmod=644 https://www.postgresql.org/media/keys/ACCC4CF8.asc /etc/apt/keyrings/pgdg.asc
# ffmpeg decodes uploaded voice memos server-side: waveform peaks + the STT re-encode
# (docs/planning/audio-player-markers.md). Missing ffmpeg degrades to a flat seek bar.
# fonts-dejavu-core: the server-side Kroki/plan renderer (app/kroki.py) needs a real
# sans font — PIL labels AND resvg's <text> letters in the tactical-symbol pack; without
# it the symbol letters (F/W/…) silently vanish from the rendered glyphs.
RUN echo "deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" ffmpeg fonts-dejavu-core \
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
# Synthetic demo dataset (Musterdorf) — small (~276K). Needed in-image so the demo deployment's
# in-process auto-reset (DEMO_RESET_SECONDS) can read examples/demo-data/incident.workspace.json.
COPY examples /app/examples

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
