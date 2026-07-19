# Contributing to KP Front

KP Front is an **Einsatzführungs-app for frontline fire-service command** — a tablet-first
situation map, plan whiteboard, live documentation, and offline-capable record. Thanks for
considering a contribution.

The project is licensed under the **GNU Affero General Public License v3.0 or later**
(`AGPL-3.0-or-later`, see [`LICENSE`](LICENSE)). By contributing, you agree that your
contributions are licensed under AGPL-3.0-or-later. Please also read our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Dev setup

The fastest path uses the [`just`](https://github.com/casey/just) task runner (`just` with no
argument lists every recipe):

```bash
just setup          # install frontend + backend deps
just db             # dev Postgres (Docker, localhost:5434)
just api            # backend  → http://localhost:8000 (migrates first)
just dev            # frontend → http://localhost:5188 (use http://, not file://)
just lint && just test   # both stacks — run before pushing
```

Or drive the tools directly:

**Frontend** (React 18 + TypeScript, Vite 5, MapLibre GL, Workbox/PWA, Vitest) — uses
[pnpm](https://pnpm.io/):

```bash
pnpm install
pnpm dev     # Vite dev server on http://localhost:5188 (use an http:// origin, not file://)
pnpm build   # tsc --noEmit + vite build
pnpm test    # vitest
pnpm lint    # eslint
```

**Backend** (FastAPI + PostgreSQL, Alembic) — Python managed with [uv](https://docs.astral.sh/uv/).
See [`backend/README.md`](backend/README.md) for setup, migrations, and the admin CLIs, and
[`docs/API.md`](docs/API.md) for the HTTP API.

For self-hosting (Postgres + the backend serving the SPA same-origin), use the bundled
docker-compose stack — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## The 3am tenet (the design bar)

Every feature is judged against one rule: the operator is an **infrequent expert, under
stress, possibly in the dark and offline, who must use this correctly at 3am after six months
without practice.** So: **recognition over recall, right defaults over configuration, nothing
that can't be undone.** Concretely:

- Undo/redo (or confirm-with-undo) on every mutable surface — add undo for new mutations.
- In-context empty states that teach what a surface is for.
- Consistent controls/gestures across surfaces — Lage ↔ Plan parity is a review criterion.
- Place-don't-configure: lean on presets and sensible defaults.
- Touch targets ≥44px (primary actions ~48–56px), interactive text ≥12.5px.
- For any generated calculation, show source, timestamp, and editable assumptions, and label
  estimates as *Planungshilfe / Schätzung*.

See [`CLAUDE.md`](CLAUDE.md) for the full conventions; it is the source of truth and should be
kept current when a convention changes.

## Conventions

- **Replace files in place** — no `_v2` / `-new` / `-fixed` variants.
- **Match the surrounding code's style**, naming, and comment density.
- **Domain language is German** (Lage, Atemschutz, Trupp, Einsatz, Verlauf, …) — keep terms
  accurate. All user-facing strings live in `appConfig.copy.*`; never hard-code UI text in a
  component — add a key and reference it.
- **Theming:** use tokens / `color-mix(in srgb, var(--accent) N%, …)`, never a frozen `rgba()`
  of the accent — that breaks day/night and per-station accent theming.
- The backend has a ruff pre-commit hook; the frontend has none — so **run
  `pnpm lint && pnpm test` before pushing**.

## Pull requests

- Keep PRs **small and focused** — one coherent change.
- Describe **what** changed and **why**; include screenshots for UI changes.
- Run `pnpm lint && pnpm test` (and the backend's `pytest` if you touched it) first.
- There is **no per-file license-header requirement**, but new files must be compatible with
  AGPL-3.0-or-later.

## Never commit private / station data

Per-station deployment data is **not** part of this repo and must never be committed:

- Station config files live in `backend/private/` (gitignored) and are loaded via the
  `admin_config` CLI.
- Reference geodata (hydrants, Leitungskataster, canton WMS) lives in a **private data repo**
  and is loaded via `admin_geodata` — never bundled here.
- Secrets (`SECRET_KEY`, `DATABASE_URL`, Divera/Traccar credentials) live in environment
  variables only — never in the repo.

Keep deployment data, rosters, and any personal/operational data out of the repository.
