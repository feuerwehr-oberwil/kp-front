# CLAUDE.md

Guidance for agents and humans working in this repo. Keep it current: when a convention or
decision changes, update this file in the same change.

## What this is

KP Front is an **Einsatzführungs-app for frontline fire-service command** — a tablet-first
situation map (Lage), plan whiteboard (Plan), live documentation, and offline-capable record
that replaces the physical Lagekarte/command-table at the Einsatzort. It is standalone: it
owns its own incident, map, timeline, offline cache, and exports.

Read [`README.md`](README.md) for the overview and the "why", and
[`docs/README.md`](docs/README.md) for the full documentation index. The system architecture
and its key decisions live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## The 3am tenet (overriding UX rule)

Every feature is judged against this: the operator is an **infrequent expert, under stress,
possibly in the dark and offline, who must use this correctly at 3am after six months without
practice.** So: **recognition over recall, right defaults over configuration, nothing that
can't be undone.** In practice that means —

- Undo/redo (or confirm-with-undo) on every mutable surface.
- In-context empty states that teach what a surface is for.
- Consistent controls/gestures across surfaces — Lage ↔ Plan parity is a review criterion.
- Place-don't-configure: lean on presets and sensible defaults.
- Touch targets ≥44px (primary actions ~48–56px), interactive text ≥12.5px.
- For any generated calculation, show source, timestamp, and editable assumptions, and label
  estimates as *Planungshilfe / Schätzung*.

## Stack & commands

- **Frontend:** React 18 + TypeScript, Vite 5, MapLibre GL, Workbox/PWA, Vitest. Use **pnpm**.
- **Backend:** FastAPI + PostgreSQL, Alembic; one service serving the frontend same-origin (no
  CORS), on Railway or self-hosted via docker-compose. Manage Python with **uv** — see
  [`backend/README.md`](backend/README.md).

```bash
pnpm install
pnpm dev     # Vite dev server on http://localhost:5188 (http origin required, not file://)
pnpm build   # tsc --noEmit + vite build
pnpm test    # vitest
pnpm lint    # eslint
```

**Tests** are Vitest (node env), colocated as `*.test.ts`, focused on pure `src/lib` logic
(plus a few components); the backend uses pytest. The backend has a ruff pre-commit hook; the
frontend has none — so run `pnpm lint && pnpm test` before pushing, since changes go straight
to prod.

## Architecture & conventions

- **Operational browser state should live in IndexedDB, not localStorage.** Current code still has
  localStorage workspace paths, but the target is: IndexedDB for incident workspaces, pending sync,
  media queue metadata, reference/checklist/object metadata, and readiness; localStorage only for
  tiny preferences and migration flags. UI copy/locale/defaults/storage keys live in
  `src/config/appConfig.ts`; the neutral fallback incident is `src/data/demoIncident.ts`.
- **Undo/redo — every mutating op should be undoable, scoped to the workspace.** The standing
  rule: Lage map has document-level undo (`useUndoableDoc`), Plan has per-plan-document undo
  (`useBoardDoc`), and one-shot ops (Gebäude floor add/remove, building replace) use
  confirm-with-undo toasts. Add undo for new mutations; don't skip it.
- **Sync supports task-scoped collaboration.** Multiple editors may work different domains in the
  same incident (e.g. Atemschutz + Lage drawing); this is not shared-cursor co-editing of the same
  object. Cross-domain concurrent edits must merge. Mergeable collections merge three-way **by
  `id`** (`mergeById` in `mergeWorkspace.ts`; delete beats concurrent edit; server-then-local
  order). Same-object conflicts can stay simple for now. To add a synced collection: extend
  `HasId` and register it in `WsShape`. (`Person`/roster is the exception — it carries
  `updatedAt` because it's pulled from Divera, not merged.)
- **IDs are prefixed timestamps, not UUIDs** — `'p'+Date.now()`, `'sh'+Date.now()`,
  `'e'+Date.now()+'-'+i`. Offline-friendly, no DB roundtrip; don't reach for
  `crypto.randomUUID()`.
- **Incident records are append-only where it matters.** Verlauf is the human operational journal
  plus selected meaningful system events; audit/events record committed domain actions. Don't add
  mutate/delete shortcuts for production records; lifecycle changes (reminders, media transcripts,
  corrections) are *new appended events* with state derived from them.
- **Two kinds of settings:** per-device preferences (cookie/Preferences) vs. synced
  per-incident state (workspace blob). Both live in the Einstellungen sheet — pick the right
  one for a new setting.
- **Lage and Plan should stay as close as possible in every regard** — same tools, controls,
  and behavior. Only the implementation that *must* differ because of the drawing surface /
  relative coordinate system may diverge. Shared logic lives in `ToolDock`, `DrawEditor`, and
  `src/lib/lineStyle.ts`; the renderers stay separate only for that surface-specific part.
- **Theming:** use tokens / `color-mix(in srgb, var(--accent) N%, ...)`, **never** a frozen
  `rgba()` of the accent — that breaks day/night and per-station accent theming.
- **CSS:** design tokens, the day/night flip (`[data-theme="night"]`), and shared chrome live
  in `src/app.css`; component-specific layout goes in `*.module.css` files that reference
  `var(--token)`; the admin UI uses `src/admin/admin.css`.
- **Overlays go through `src/lib/overlays/`** (`Sheet`/`SheetClose`, `Overlay`, `ConfirmCard`,
  `Menu`, `Popover`/`PopoverClose`) — thin wrappers over **Base UI** (`@base-ui/react`, headless)
  that supply focus trap/restore, scroll-lock, Esc, backdrop/outside-click dismissal, and ARIA,
  painted with the existing `.ip-*`/token CSS. That package is imported **only** inside
  `src/lib/overlays/` — every surface uses the wrappers, so behaviour/theming/a11y live in one
  place. Base UI portals Backdrop+Popup as siblings, so scrim = `.ui-backdrop` and centering =
  `.ip-sheet.ui-dialog` (see app.css). **Modal surfaces only** — the non-modal map tool-docks
  (`MapViewsMenu` views popover, the `.ctx` tool editors, the incident `ip-menu`) stay
  hand-rolled: a focus-trapping/scroll-locking primitive would break map interaction. `Combo`
  and the tap-toggle `DockInfo`/`InfoTip` also stay bespoke (free-type + in-menu toggle / a
  tablet tap model don't map cleanly to Base UI Select/Tooltip).
- **Coordinates are WGS84 `[lng, lat]` wherever the map renders.** LV95 only at the edges via
  `src/lib/geo.ts` (`wgs84ToLV95` / `lv95ToWgs84` / `fmtLV95`), the `centerLv95` config option,
  and the geocoder bbox. Reference-layer GeoJSON (hydrants, …) must be WGS84.
- **Role gating** — product model is two incident roles: `editor` (FU / can mutate incident state)
  and `viewer` (read-only). The legacy `commander` value has been migrated away: the stored role,
  the `Literal`/type unions, the `CurrentEditor` dependency, and `user?.role === 'editor'` checks
  all use `editor` now. Do not reintroduce `commander`, and do not add deployment-admin power to the
  incident role model. Deployment administration is **separated** behind the `ADMIN_SECRET` env var:
  the `/admin` UI and admin-write API (config, branding, system, user CRUD, geodata/objects) gate on
  `get_current_admin` / `CurrentAdmin` (a secret-backed admin-session cookie via `/api/admin/login`),
  not the editor role; the `admin_geodata`/`admin_objects` `push` CLI uses `KP_ADMIN_SECRET`. It's
  **fail-closed** — unset `ADMIN_SECRET` → admin endpoints 403, never the editor PIN. Incident
  endpoints stay on `CurrentEditor`.
- **Per-station config has four layers:** national defaults (code) → per-station deployment
  config (DB/admin) → secrets (env) → per-incident (workspace). One deployment = one station
  (**single-tenant**, no multi-tenancy). See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
  Edit a station's config as code: `cd backend && uv run python -m app.admin_config
  <schema|example|validate|diff|load>`; it's served at `GET /api/config` and applied at boot to
  override `appConfig` defaults.
- **Reference geodata, object plans, and checklists are station data, never bundled.**
  Hydrants/Leitungskataster/canton-WMS layers, Modul PDFs, and the FU/EL checklist templates +
  playbook diagrams don't live in this repo — they're loaded into a deployment from a *private data
  repo* via `admin_geodata` / `admin_objects` / `admin_checklists` (each a
  `schema|example|validate|load|push|show` CLI keyed off `KP_ADMIN_SECRET`). The frontend turns
  config geodata into map layers (`referenceLayersFromConfig` → `deriveInitial`); missing object
  plans fall back only to OSM outlines + `Tafel`, never bundled `/public` PDFs; checklist templates
  are fetched from the `checklists:<id>` reference datasets (`loadTemplates` in
  `src/lib/checklists.ts`, offline-cached), falling back to one neutral bundled example
  (`src/data/checklists/generic-action.json`) — never a station's real lists. GeoJSON must be WGS84
  `[lng,lat]` (LV95 is rejected).
- **Domain language is German** (Lage, Atemschutz, Trupp, Einsatz, Verlauf, …); keep terms
  accurate. **All user-facing strings live in `appConfig.copy.*`** — never hard-code UI text in
  a component; add a key and reference it.
- **i18n / multilingual copy lives in `src/config/copy/`.** German (`de.ts`) is the canonical
  base and the source of the `Copy` type; `en.ts` (full) / `fr.ts` / `it.ts` are
  `Localizable<Copy>` partial overlays **deep-merged over German**, so any missing key falls
  back to the German string — a half-translated locale is always complete. `appConfig.copy` is
  a **getter** returning the active locale's catalogue (`copy/getCopy()`); read sites are
  unchanged (`appConfig.copy.x.y`). Locale is a **per-deployment** setting (one brigade = one
  language), resolved **once at boot** (`/api/config` `identity.locale` → `de-CH`) by
  `applyLocale()` in `main.tsx`. It's set in deployment config (CLI/config file first; admin UI
  can inspect/basic-edit Station › Identität › Sprache), NOT per device. **Add a new string to
  `de.ts` first** (it defines
  the shape); translate in the other locales as desired. Two caveats: (1) module-level captures
  like `const C = appConfig.copy.x` freeze the language at import — read inside the
  component/function instead; (2) a few copy values are structural DATA keys, not labels
  (`contextPanel.unField`/`stoffField` match the non-localized preset fields, intake
  `kategorien`/`kategorieGuess` mirror the backend) — leave these untranslated (German fallback).
- **Tactical symbols are our own pack.** `public/tactical-symbols.json` is KP-Front-authored
  artwork following the FKS Faltkarte conventions, generated by `tools/gen_symbols.py` — edit
  the generator, never the JSON, and re-run `python3 tools/gen_symbols.py emit` (a `review`
  mode renders a sign-off grid). Names/categories are compatibility keys referenced across
  appConfig/copy/backend config; keep them stable.
- **Time-based alerts** (Atemschutz clock, reminders) go through the shared `src/lib/alarm.ts`
  layer, not ad-hoc timers. Delivery: foreground tone/wake-lock + service-worker notification,
  plus — once the deployment sets VAPID keys (`app.gen_vapid`) — server-side Web Push for
  killed apps: `backend/app/push.py` re-derives due-ness from the synced data (no mirror
  API) and also pushes «Neuer Einsatz» when a new Divera alarm lands in the pool. Fail-closed:
  no keys → `/api/push/vapid-key` serves `null` and no sweep runs.

## Working in this repo

- **Committing straight to `main` is fine (no PR ceremony).** But only commit+push
  *immediately* when the user needs the change on production to test it right now; otherwise
  **batch related changes and commit once the chunk of work is done** (a coherent unit), rather
  than after every small edit. The user tests on production, so a needed-for-testing change
  still ships promptly — just don't pepper `main` with partial commits.
- **The user keeps uncommitted WIP and commits in parallel.** Never `git add -A` / `git commit
  -a`; stage only the specific files you changed, and don't assume the tree is clean.
- **Verification before prod (the CI gate).** Prod deploys from `main`, so a red `main` reaches
  the field. The standing flow for any non-urgent change: develop on a branch, push, let
  `ci.yml` go **fully green**, *then* merge — never merge a red branch. `ci.yml` runs three gate
  jobs: *Frontend (tsc + build)* — eslint + `tsc --noEmit` + vitest + `vite build`; *Backend
  (ruff + alembic + pytest)*; *Image (hadolint + build + smoke)* — builds & boots the real
  production container and drives the Playwright white-screen smoke (`e2e/smoke.spec.ts`) against
  it. An **urgent prod hotfix** may still go straight to `main` (see the commit bullets / the 3am
  tenet) — but run `pnpm lint && pnpm test` (and ideally `pnpm build`) locally first. For
  interactive changes a unit test can't cover, use `/code-review` on the diff and `/verify` to
  drive the real app. Keep the house rule: every new mutating feature ships with a `src/lib` test.
- **Server-side enforcement of the gate is NOT yet active.** GitHub gates branch protection /
  rulesets behind a paid plan for *private* repos (a `PUT …/branches/main/protection` returns
  403 here), so "required status checks" can't be configured while the repo is private + free.
  Enable it the moment the repo goes **public** (OSS Phase E — protection is free for public
  repos) or upgrades to **Pro**: require the three CI jobs above, with `enforce_admins: false` so
  a 3am hotfix can still bypass. Until then the gate is **by convention**, not machine-enforced.
- Replace files in place — no `_v2` / `-new` / `-fixed` variants.
- Match the surrounding code's style, naming, and comment density.
- When writing docs, convert relative dates to absolute.

## Documentation map

- [`docs/`](docs/) — concept, configuration, deployment, and architecture docs, indexed
  with status in [`docs/README.md`](docs/README.md).
- `docs/design-concepts/`, `mockups/` — historical look-and-feel explorations (not maintained).
