# AGENTS.md

Guidance for agents and humans working in this repo. Keep it current: when a convention or
decision changes, update this file in the same change.

This file holds the conventions and concepts. A rule about ONE module lives in a comment at the
top of that module (or above the function it concerns); a rule that spans modules lives in the
matching page under [`docs/`](docs/) – see the map at the end. Read the module's header before
you change it.

## What this is

KP Front is an **Einsatzführungs-app for frontline fire-service command** – a tablet-first
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
can't be undone.** In practice that means –

- Undo/redo (or confirm-with-undo) on every mutable surface.
- In-context empty states that teach what a surface is for.
- Consistent controls/gestures across surfaces – Lage ↔ Plan parity is a review criterion.
- Place-don't-configure: lean on presets and sensible defaults.
- Touch targets ≥44px (primary actions ~48–56px), interactive text ≥12.5px.
- For any generated calculation, show source, timestamp, and editable assumptions, and label
  estimates as *Planungshilfe / Schätzung*.

## Stack & commands

- **Frontend:** React 19 + TypeScript, Vite 8, MapLibre GL, Workbox/PWA, Vitest. Use **pnpm**.
- **Backend:** FastAPI + PostgreSQL, Alembic; one service serving the frontend same-origin (no
  CORS), on Railway or self-hosted via docker-compose. Manage Python with **uv** – see
  [`backend/README.md`](backend/README.md).

```bash
pnpm install
pnpm dev     # Vite dev server on http://localhost:5188 (http origin required, not file://)
pnpm build   # tsc --noEmit + vite build
pnpm test    # vitest
pnpm lint    # eslint + a per-rule warning ratchet (scripts/eslint-baseline.json); `pnpm lint:update` lowers it
```

`just` (no argument) lists the recipes: `just dev` for the full local stack, `just bench` /
`just fat-perf` for large incidents ([`docs/testing/fat-incident.md`](docs/testing/fat-incident.md)),
`just perf` for the performance journeys, `just staging-refresh`, `just release …`.

## Working in this repo

- **Committing straight to `main` is fine (no PR ceremony).** But only commit+push
  *immediately* when the user needs the change on production to test it right now; otherwise
  **batch related changes and commit once the chunk of work is done** (a coherent unit), rather
  than after every small edit. The user tests on production, so a needed-for-testing change
  still ships promptly – just don't pepper `main` with partial commits.
- **Sign off every commit (DCO):** `git commit -s`. The «DCO (sign-off)» check fails a pull
  request with a commit that has no `Signed-off-by` line; why and how to fix one:
  [`CONTRIBUTING.md`](CONTRIBUTING.md). Commit subjects are Conventional Commits (`feat(scope):
  …`, `fix: …`, `docs: …`) – git-cliff drafts the CHANGELOG from them.
- **An idea that should not reach the station yet goes to staging, not `main`.** Push it to the
  `staging` branch; it deploys to the Railway `staging` environment
  (`https://kp-front-staging.up.railway.app`, a separate PWA on prod's data, with push and
  webhooks cut). `just staging-refresh` re-copies prod into it and overwrites whatever was tested
  there. Pass `--environment` explicitly to every `railway` command: the checkout is linked to
  `production`. See `docs/DEPLOYMENT.md` §3a.
- **The user keeps uncommitted WIP and commits in parallel.** Never `git add -A` / `git commit
  -a`; stage only the specific files you changed, and don't assume the tree is clean.
- **Verification before prod (the CI gate).** Prod deploys from `main`, so a red `main` reaches
  the field. The standing flow for any non-urgent change: develop on a branch, push, let
  `ci.yml` go **fully green**, *then* merge – never merge a red branch. `ci.yml` runs three gate
  jobs: *Frontend (tsc + build)* – eslint + `tsc --noEmit` + vitest + `vite build`; *Backend
  (ruff + alembic + pytest)*; *Image (hadolint + build + smoke)* – builds & boots the real
  production container and drives the Playwright e2e against it: the white-screen smoke
  (`e2e/smoke.spec.ts`) and the field scenario of the Übung on 23.09.2026
  (`e2e/field-scenario.spec.ts`: a parked vehicle sending GPS, a coupled Leitung, a tapped Trupp,
  and then three devices on one login). ⚠️ **Every e2e test fails when the app reports a client
  error or a render storm** (`e2e/guard.ts`, 24.09.2026). A spec imports `test` from
  `e2e/helpers`, never from `@playwright/test` (eslint enforces it). A report a test provokes on
  purpose is listed with `expectedClientErrors`; nothing turns the guard off (`e2e/README.md`).
  An **urgent prod hotfix** may still go straight to `main` (see the commit bullets / the 3am
  tenet) – but run `pnpm lint && pnpm test` (and ideally `pnpm build`) locally first. For
  interactive changes a unit test can't cover, use `/code-review` on the diff and `/verify` to
  drive the real app. Keep the house rule: every new mutating feature ships with a `src/lib` test.
- **The gate is server-enforced.** Branch protection on `main` requires these checks to pass
  before a merge: *Frontend (tsc + build)*, *Backend (ruff + alembic + pytest)*, *Image
  (hadolint + build + smoke)*, *Secrets (gitleaks)*, *Visual (screenshots vs baseline)* and
  *Shared files match KP Rück*. `enforce_admins` is **off** on purpose,
  so a 3am hotfix can still bypass it – that is the only intended bypass, not a routine one.
- **Performance is gated too.** CI's «Performance» job walks real user journeys on the busiest
  Einsatz on record and fails on regressions against `e2e/perf/baseline.json`; a red check
  blocks the merge like a failing test, and a baseline is never accepted (nor a tolerance
  loosened) to turn it green. The rules for an agent are in
  [`docs/testing/perf-journeys.md`](docs/testing/perf-journeys.md) · «The gate is part of
  «done»». Read [`docs/testing/perf-journeys.md`](docs/testing/perf-journeys.md) before adding
  or changing a journey.
- **Releases are for other stations, not for us.** Prod + demo deploy continuously from `main`;
  a `v*` tag exists so a self-hoster can pull a known image. The number answers *what does this
  update cost the operator* – PATCH = fixes, MINOR = features + automatic migrations, MAJOR =
  operator action required (table at the top of `CHANGELOG.md`). Cutting one:
  `just changelog` (git-cliff draft) → curate into `[Unreleased]` → `just release X.Y.Z` (bumps
  `package.json`, `backend/pyproject.toml`, `backend/app/config.py`, opens the CHANGELOG section;
  a pytest fails if those three ever drift) → `just release-tag X.Y.Z` → `git push --follow-tags`,
  which runs the CI gate and publishes `ghcr.io/feuerwehr-oberwil/kp-front:{X.Y.Z,X.Y,latest}`
  plus a GitHub Release whose body is the committed CHANGELOG section. `docker-compose.yml`
  **pulls** that image by default (`KP_FRONT_TAG`); building from source is the commented path.
- Replace files in place – no `_v2` / `-new` / `-fixed` variants.
- **A file in [`shared/MANIFEST.json`](shared/MANIFEST.json) is shared with KP Rück by copy**
  (telemetry sanitiser, alarm vocabulary, roster contract + reader, alarm intake corpus, snail).
  Change it in both repositories on equally named branches – [`shared/README.md`](shared/README.md).
- Scratch scripts are named `.x-*` (git ignores them anywhere; never leave one in `site/`, which
  is published). New work starts in a worktree off `origin/main`; `just doctor` warns when a
  checkout is far behind it, `just wt-prune [--apply]` clears finished worktrees (CONTRIBUTING.md).
- Match the surrounding code's style, naming, and comment density.
- When writing docs, convert relative dates to absolute.
- **A new rule goes where the next editor meets it**: a comment at the top of the module (or
  above the function) it is about, or the `docs/` page of its topic when it spans modules. Add
  a line here only for a convention every change has to know.

## Testing

**Tests** are Vitest (node env), colocated as `*.test.ts`, focused on pure `src/lib` logic
(plus a few components); the backend uses pytest. The backend has a ruff pre-commit hook; the
frontend has none – so run `pnpm lint && pnpm test` before pushing, since changes go straight
to prod. `just ci` runs every gate of CI's Frontend and Backend jobs locally (incl. coverage
floor, bundle budget, audits, licenses and `just schema-check`: a throwaway Postgres migrated to
head, then `alembic check` against the models); image, secrets, e2e, visual and perf stay CI's.

- **Ratchets only go down.** The eslint warnings per rule (`scripts/eslint-baseline.json`; `pnpm
  lint` fails when a rule's count goes up, or down without `pnpm lint:update`), the style-debt
  baseline (`src/styles/styleDebt.baseline.json`, below) and the vitest coverage floor are lowered
  (the floor raised) when you fix something and never moved the other way to pass. The gzipped
  entry, App, maplibre, pdf-worker and CSS chunks have a +5 % budget against
  `scripts/bundle-baseline.json` (`scripts/check-bundle-size.mjs`, CI); a deliberate growth is an
  `--update` in its own commit, with the reason.
- **`jsdom` is held on 30.0.x** (`~30.0.1`, Dependabot ignores 30.1): 30.1's blob URLs cannot
  read the Node `Blob` Vitest supplies, so maplibre-gl 4.7 fails at import and MapView, mapTwist
  and the IncidentWorkspace harness stop loading. Lift it with a jsdom past 30.1 or MapLibre 6
  (#193) – never by mocking MapLibre away in those tests.
- **CLI subprocess tests run outside `backend/`**: pydantic reads `.env` from the cwd, so a
  station's `backend/.env` would leak into them (`tests/test_admin_cli_output.py` · `_run`).
- **e2e** runs on the production image in CI (`e2e/README.md`); every spec takes `test` from
  `e2e/helpers`, which fails on a client error or a render storm.
- **The look is gated too.** CI's «Visual» job shoots nine frozen states and compares them with
  `e2e/visual/baseline/` (`maxDiffPixels: 20`). A changed pixel you did not mean is a regression;
  a look you changed on purpose gets new baselines from CI (`just visual-accept <run-id>`) in its
  own commit, saying why – never to turn the check green, never shot on a laptop
  ([`docs/testing/visual-regression.md`](docs/testing/visual-regression.md)).
- **Large / long incidents and performance** are measured, not guessed:
  [`docs/testing/fat-incident.md`](docs/testing/fat-incident.md),
  [`docs/testing/perf-journeys.md`](docs/testing/perf-journeys.md).
- **Field crash reports** are one `kpfront.clienterror` log line; hidden sourcemaps turn their
  stacks back into source ([`docs/SOURCEMAPS.md`](docs/SOURCEMAPS.md)).

## Conventions

### Copy and language

- **Domain language is German** (Atemschutz, Trupp, Einsatz, Verlauf, …); keep terms
  accurate. **All user-facing strings live in `appConfig.copy.*`** – never hard-code UI text in
  a component; add a key and reference it.
- **Prose language split: technical English, user-facing German.** Everything technical –
  `docs/`, READMEs, `CHANGELOG.md`, code comments, commit messages – is written in English;
  German appears there only as domain terms and as «quoted» UI copy. User-facing text is German
  with i18n overlays (above). The gitignored internal station documents under `docs/` are the
  exception and may stay German.
- **i18n / multilingual copy lives in `src/config/copy/`.** German (`de.ts`, assembled from one
  module per surface in `de/<surface>.ts`) is the canonical base and the source of the `Copy`
  type; `en.ts` (full) / `fr.ts` / `it.ts` (each split the same way) are
  `Localizable<Copy>` partial overlays **deep-merged over German**, so any missing key falls
  back to the German string – a half-translated locale is always complete. `appConfig.copy` is
  a **getter** returning the active locale's catalogue (`copy/getCopy()`); read sites are
  unchanged (`appConfig.copy.x.y`). Locale is a **per-deployment** setting (one brigade = one
  language), resolved **once at boot** (`/api/config` `identity.locale` → `de-CH`) by
  `applyLocale()` in `main.tsx`. It's set in deployment config (CLI/config file first; admin UI
  can inspect/basic-edit Station › Identität › Sprache), NOT per device. **Add a new string to
  `de/<surface>.ts` first** (it defines
  the shape); translate in the other locales as desired. Two caveats: (1) module-level captures
  like `const C = appConfig.copy.x` freeze the language at import – read inside the
  component/function instead; (2) a few copy values are structural DATA keys, not labels
  (`contextPanel.unField`/`stoffField` match the non-localized preset fields, intake
  `kategorien`/`kategorieGuess` mirror the backend) – leave these untranslated (German fallback).
- Which word a screen uses – «Karte» vs «Kroki», «Geschoss», «Verlauf» / «Eintrag»,
  «Entfernen» vs «gelöscht», failure sentences, «leeren», search placeholders – is settled in
  [`docs/copy-and-wording.md`](docs/copy-and-wording.md). Help text is per device
  (`lib/helpDevice`).

### Look and feel

- **Theming:** use tokens / `color-mix(in srgb, var(--accent) N%, ...)`, **never** a frozen
  `rgba()` of the accent – that breaks day/night and per-station accent theming.
- **CSS:** design tokens, the day/night flip (`[data-theme="night"]`), and shared chrome live
  in **`src/styles/NN-*.css`** – one numbered file per block (tokens, base, map, chrome, one per
  surface), listed in order by `src/app.css`, which is now a manifest of `@import`s and holds no
  rules of its own. **The numbering is the cascade**: source order decides ties, so put a new
  block where it belongs and renumber, rather than appending for tidiness – `20-touch-floors.css`
  is last precisely because its `(pointer: coarse)` targets have to beat every surface above it.
  Component-specific layout still goes in `*.module.css` files that reference `var(--token)`;
  the admin UI uses `src/admin/admin.css`. Form controls take the page's family from ONE reset
  in 02-base (`button, input, select, textarea { font-family: inherit }`, 07.10.2026): never add
  a per-control `font-family: inherit`. The reset is the family only; sizes stay per rule.
- **New CSS picks from the scales** (07.10.2026, UI sweep C1–C5; `01-tokens.css` · «THE SCALES»,
  «THE TINTS»): type `--fs-1…7` (12.5 · 14 · 16 · 19 · 24 · 32 · 40, each with its `--lh-*`) and
  `--fs-micro` (11, read-only captions, never a tappable label); weight `--fw-regular/medium/
  bold/heavy` (400/500/700/800 – 600 is not a step); space `--sp-1…8` (4/8/12/16/24/32/48/64;
  1–2px optical nudges stay literal); elevation `--e1…e5` (with night values; `--shadow-sm` and
  `--shadow` are `--e3`/`--e4`); tints `--{blue,red,amber,green,ink}-{5,8,12,16,22,28,45,62}`
  (= that hue at that % over transparent). The old literals move onto them surface by surface
  (staged; the owner sees pairs for anything visible), so do not mass-convert a file on the side.
  **The pile only shrinks**: `src/styles/styleDebt.test.ts` counts per stylesheet the literal
  font sizes, off-step weights, off-grid spacings and literal-colour shadows against
  `styleDebt.baseline.json` and fails when one goes up – or when one went down and the baseline
  was not lowered (`STYLE_DEBT_UPDATE=1 pnpm vitest run src/styles/styleDebt.test.ts`, which
  only ever lowers it). Like the lint ceiling: never raise it to pass.
- **One corner, one button family.** Every rectangle wears `var(--r-sm)` (12px); a floating bar
  that hugs controls wears `--r-bar` (19px), things under ~32px `--r-xs`, and map furniture stays
  round. New buttons are `<Button>` / `<IconButton>` / `<Chip>` (the `.ip-btn` family), never a
  new `.foo-btn` rule. Breakpoints come from `src/lib/breakpoints.ts` only. The whole spec –
  type, colour, selected, primary, delete, close, messages, the floating family – is
  [`docs/ui-conventions.md`](docs/ui-conventions.md); phone layout is
  [`docs/phone-layout.md`](docs/phone-layout.md).
- **Overlays go through `src/lib/overlays/`** (`Sheet`/`SheetClose`, `Overlay`, `ConfirmCard`,
  `Menu`, `Popover`/`PopoverClose`) – thin wrappers over **Base UI** (`@base-ui/react`, headless)
  that supply focus trap/restore, scroll-lock, Esc, backdrop/outside-click dismissal, and ARIA,
  painted with the existing `.ip-*`/token CSS. That package is imported **only** inside
  `src/lib/overlays/` – every surface uses the wrappers, so behaviour/theming/a11y live in one
  place. Base UI portals Backdrop+Popup as siblings, so scrim = `.ui-backdrop` and centering =
  `.ip-sheet.ui-dialog` (see app.css). **Modal surfaces only** – the non-modal map tool-docks
  (`MapViewsMenu` views popover, the `.ctx` tool editors, the incident `ip-menu`) stay
  hand-rolled: a focus-trapping/scroll-locking primitive would break map interaction. The
  tap-open picker (`ComboMenu`, worn by `Combo` and the Atemschutz `PersonField`) and the
  tap-toggle `DockInfo`/`InfoTip` also stay bespoke (free-type + in-menu toggle / a tablet tap
  model don't map cleanly to Base UI Select/Tooltip); the admin `Select` stays hand-rolled too,
  keyboard-driven and unportalled. What a surface IS on a phone (slide-up sheet, centred
  dialog, anchored popover), one gesture closing one thing, and the sheet footer:
  [`docs/ui-conventions.md`](docs/ui-conventions.md) · «Overlays».
- **Editor sheets have one control per kind of question** – a yes/no is the `OnOff` pair, a
  number the `Stepper`, and no native form control (`Menu`, not `<select>`):
  [`docs/ui-conventions.md`](docs/ui-conventions.md) · «Editor sheets».
- **Touch: one beat, one buzz, one wash.** Holds that reveal share the 350 ms beat, `buzz()`
  fires 12 ms on arm and only on arm, a press is the `--press` wash and nothing moves, `:hover`
  is mouse-only. The vocabulary is in [`docs/ui-conventions.md`](docs/ui-conventions.md) ·
  «Touch vocabulary».
- **Lage and Plan should stay as close as possible in every regard** – same tools, controls,
  and behavior. Only the implementation that *must* differ because of the drawing surface /
  relative coordinate system may diverge. Shared logic lives in `ToolDock`, `DrawEditor`,
  `SelectionBar` and `src/lib/lineStyle.ts` / `src/lib/selectionTransform.ts`; the renderers stay
  separate only for that surface-specific part. How one tactical object lives on both surfaces:
  [`docs/tactical-objects.md`](docs/tactical-objects.md).
- **Tactical symbols are our own pack.** `public/tactical-symbols.json` is KP-Front-authored
  artwork following the FKS Faltkarte conventions, generated by `tools/gen_symbols.py` – edit
  the generator, never the JSON, and re-run `python3 tools/gen_symbols.py emit` (a `review`
  mode renders a sign-off grid). Names/categories are compatibility keys referenced across
  appConfig/copy/backend config; keep them stable.

### Undo

- **Undo/redo – every mutating op should be undoable, scoped to the workspace.** ONE
  chronological timeline for the whole Einsatz (`lib/undoTimeline`), driven by the TopBar's ↶ ↷
  and by Cmd/Ctrl+Z on every surface – so «take back the last thing that happened» never asks
  which surface you are standing on. Three ways to join it – delegating, closure and the
  confirm-with-undo toast – and the choice is decided by what the domain already owns
  ([`docs/undo.md`](docs/undo.md), with what a remote merge does to the timeline).
  Deliberately NOT undoable: append-only records (Verlauf rows, audit events – corrections are
  new appended rows), device preferences (Ebenen, Einstellungen sheet) and server-side incident
  metadata (`PATCH /incidents`). Add undo for new mutations; don't skip it.

### Offline, sync and the record

- **Operational browser state lives in IndexedDB, not localStorage.** `src/lib/idb.ts` is the
  storage layer (localStorage only as its degradation fallback), `src/lib/storageMigration.ts`
  moved legacy operational keys over once. IndexedDB holds incident workspaces, pending sync,
  media queue metadata, reference/checklist/object metadata, and readiness; localStorage holds
  only tiny device flags (update banners, install prompts, once-per-device hints) and migration
  flags. UI copy/locale/defaults/storage keys live in
  `src/config/appConfig.ts`; the neutral fallback incident is `src/data/demoIncident.ts`.
- **Saved means every operational queue is acknowledged.** Workspace, journal and client audit
  outboxes and the media upload queue contribute to the shared sync status. Preserve rejected entries for retry/export;
  a failed IndexedDB write must never claim local durability. Hydrate and merge a predecessor's
  queue before a promoted tab writes it. A failed IndexedDB READ is not a miss: every hydrate that
  writes back reads through `idbRead` and never writes over a slot it could not read. Client audit events carry a stable `client_id` through
  retries; a beacon does not acknowledge delivery.
- **Sync supports task-scoped collaboration.** Multiple editors may work different domains in the
  same incident (e.g. Atemschutz + Lage drawing); this is not shared-cursor co-editing of the same
  object. Cross-domain concurrent edits must merge. Mergeable collections merge three-way **by
  `id`** (`mergeById` in `mergeWorkspace.ts`; delete beats concurrent edit; server-then-local
  order). Same-object conflicts can stay simple for now. To add a synced field: add it to
  `Saved` and give it a row in `MERGE_POLICY` (`mergeWorkspace.ts`) – the map is checked against
  `Saved` at compile time, so a field without a policy fails `tsc` instead of silently merging
  as «this device wins» (23.09.2026). (`Person`/roster is the exception – it carries
  `updatedAt` because it's pulled from Divera, not merged.)
- **IDs are prefixed timestamps, not UUIDs** – `newId(prefix)` from `src/lib/ids.ts`
  (`<prefix><ms>-<seq><rand>`) for EVERY record the app mints and syncs — Verlauf rows
  included (`newRowId(tag?)`), Mittel events, patch rows, Gäste, Pendenzen. A per-device
  counter is not enough: one login on three tablets (Übung 23.09.2026) had each counter at
  0, and the journal's idempotency-by-id silently dropped the second device's row. Ids
  already stored keep their old shape (never rewrite them); a reader that needs to know
  what wrote a row reads the tag (`isPlayerRowId`), never a parsed timestamp. Deliberately
  DERIVED ids (`ght-<markerId>`, `vp-…`, `azal-`/`azcl-`) stay deterministic — two devices
  must mint the same one. Offline-friendly, no DB roundtrip; don't reach for
  `crypto.randomUUID()`.
- **Incident records are append-only where it matters.** Verlauf is the human operational journal
  plus selected meaningful system events; audit/events record committed domain actions. Don't add
  mutate/delete shortcuts for production records; lifecycle changes (reminders, media transcripts,
  corrections) are *new appended events* with state derived from them. **A row carries what was
  said, not a pointer to it** (reversed 11.08.): a Notiz, a Fläche's name, a Druckmeldung print
  their actual text/value, because the Rapport is read on paper where nothing can be clicked. The
  row is also the ONE string the Verlauf, the Rapport and the hash chain all read – so a re-shown
  reminder carries its bare text alongside (`reminder.text`) rather than the row being re-parsed.
  What reaches the Verlauf: [`docs/verlauf-coverage.md`](docs/verlauf-coverage.md).
- **The server observes; devices never write observations** – a fact about the outside world
  (vehicle presence, weather, Divera alarms) is recorded once by the scheduler
  ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). The closed Einsatz, derived ids for what
  every device observes, and the review regression contracts:
  [`docs/sync-and-offline.md`](docs/sync-and-offline.md).
- ⚠️ **A Divera answer is never presence** (X1, 08.10.2026). The Anwesenheit's «Anrückend»
  block lists who answered «komme» / «komme nicht» — yes / no and names only, nothing else
  stored; a person is anwesend only after the explicit «da» tap. «kommt nicht» is its own muted
  group with ✕ + the word, never colour alone. The answers are an editor-only read that never
  enters the workspace, an export or a link:
  [`docs/divera-connector.md`](docs/divera-connector.md) › Rückmeldungen.
- **Time-based alerts** (Atemschutz clock, reminders) go through the shared `src/lib/alarm.ts`
  layer, not ad-hoc timers. Delivery: foreground tone/wake-lock + service-worker notification,
  plus – once the deployment sets VAPID keys (`app.gen_vapid`) – server-side Web Push for
  killed apps: `backend/app/push.py` re-derives due-ness from the synced data (no mirror
  API) and also pushes «Neuer Einsatz» when a new Divera alarm lands in the pool. Fail-closed:
  no keys → `/api/push/vapid-key` serves `null` and no sweep runs. Every stamp counts in
  `serverNow()` (`lib/serverClock`).

### Configuration, station data and roles

- **A setting lives in one of three places – pick by who owns it, not by what is easiest to
  reach.** (1) *Device preference* – theme, symbol scale, rail words, offline radius, screen
  wake: cookie via `src/lib/prefs.ts`, surfaced in the **Einstellungen sheet**
  (`src/components/panels/SettingsSheet.tsx`), which since 28.08. carries device prefs plus
  per-device utilities and **nothing else**. (2) *Station doctrine* – Funkkontakt-Intervall,
  Nachfrist, Funkkanal, Auftragsfarben: deployment config `doctrine.*`, edited **only** in
  `/admin › Doktrin` (`DoctrineSection` in `src/admin/ConfigSections.tsx`) and read **only**
  through `atemschutzDoctrine()` in `src/lib/deploymentConfig.ts`, never off
  `appConfig.atemschutz`. These left the sheet on purpose (99c4348): station configuration
  belongs where whoever set it up changes it, not under the finger of an unknowing operator at
  3am – do not re-add a doctrine editor to any in-app surface. (3) *Synced per-incident state* –
  the workspace blob (`IncidentSettings` in `src/lib/workspace.ts`). Overrides already written
  there keep applying as the layer above doctrine, but no surface offers new ones; add here only
  when the value must genuinely differ *per Einsatz* and be identical on every device.
- **Per-station config has four layers:** national defaults (code) → per-station deployment
  config (DB/admin) → secrets (env) → per-incident (workspace). One deployment = one station
  (**single-tenant**, no multi-tenancy). See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
  Edit a station's config as code: `cd backend && uv run python -m app.admin_config
  <schema|example|validate|diff|load>`; it's served at `GET /api/config` and applied at boot to
  override `appConfig` defaults. Integration credentials are read through
  `app.credentials.get(name)`, never off `settings` (`backend/app/credentials.py`).
- **Reference geodata, object plans, and checklists are station data, never bundled.**
  Hydrants/Leitungskataster/canton-WMS layers, Modul PDFs, and the FU/EL checklist templates +
  playbook diagrams don't live in this repo – they're loaded into a deployment from a *private data
  repo* via `admin_geodata` / `admin_objects` / `admin_checklists` (each a
  `schema|example|validate|load|push|show` CLI keyed off `KP_ADMIN_SECRET`; they share their
  flags, refusals and push session with `admin_config`/`admin_branding` via `app/admin_cli.py`).
  The frontend turns
  config geodata into map layers (`referenceLayersFromConfig` → `deriveInitial`); missing object
  plans fall back only to OSM outlines + `Tafel`, never bundled `/public` PDFs; checklist templates
  are fetched from the `checklists:<id>` reference datasets (`loadTemplates` in
  `src/lib/checklists.ts`, offline-cached), falling back to one neutral bundled example
  (`src/data/checklists/generic-action.json`) – never a station's real lists. GeoJSON must be WGS84
  `[lng,lat]` (LV95 is rejected).
- **Coordinates are WGS84 `[lng, lat]` wherever the map renders.** LV95 only at the edges via
  `src/lib/geo.ts` (`wgs84ToLV95` / `lv95ToWgs84` / `fmtLV95`), the `centerLv95` config option,
  and the geocoder bbox. Reference-layer GeoJSON (hydrants, …) must be WGS84.
- **Roles:** three incident roles – `editor` (FU), `el` (Einsatzleiter: reads everything,
  writes only the record) and `viewer` – plus the Atemschutz-Link; deployment administration is
  separate, behind `ADMIN_SECRET`, and fail-closed. A door the role cannot go through is not
  drawn. The full model, the link rules and the allowlists:
  [`docs/roles-and-access.md`](docs/roles-and-access.md).
- **Objektbesuche live beside the Einsatz, never inside it** – the module's contract and the
  rules that are easy to break are [`docs/object-visits.md`](docs/object-visits.md).

## Documentation map

- [`docs/`](docs/) – concept, configuration, deployment, and architecture docs, indexed
  with status in [`docs/README.md`](docs/README.md).
- [`docs/AGENT-RUNBOOK.md`](docs/AGENT-RUNBOOK.md) – **start here when the task is operating a
  station rather than changing this code**: standing one up headless and keeping it running,
  as exact commands. It names the four things a terminal cannot do (DNS, the Azure app
  registration, the Divera portal, the Railway volume), the Day-0 sequence, and the `setup`
  block on `GET /api/system` that answers «is this station set up» without scraping `/admin`.
- Cross-module rules, by topic (each page says which modules carry the rest in their headers):
  - [`docs/sync-and-offline.md`](docs/sync-and-offline.md) – the review regression contracts,
    the closed Einsatz and reopening, derived ids for observed facts.
  - [`docs/undo.md`](docs/undo.md) – how an act joins the undo timeline; what a merge does to it.
  - [`docs/tactical-objects.md`](docs/tactical-objects.md) – one object, two surfaces: anchors,
    projection, machine writes, references, replay.
  - [`docs/plans-and-buildings.md`](docs/plans-and-buildings.md) – prepared Gebäude floors,
    «Automatisch ausrichten», approved alignments, plan PDFs and the tile pyramid.
  - [`docs/ui-conventions.md`](docs/ui-conventions.md) – editor sheets, overlays, the button
    spec, the touch vocabulary.
  - [`docs/phone-layout.md`](docs/phone-layout.md) – the two bottom bars, page heads, pages.
  - [`docs/atemschutz-board.md`](docs/atemschutz-board.md) – the Trupps board, the Trupp form,
    the Sicherungstrupp, the Atemschutznotfall and the Abschluss.
  - [`docs/copy-and-wording.md`](docs/copy-and-wording.md) – which word a screen uses.
  - [`docs/rapport.md`](docs/rapport.md) – what the Rapport's figure pages carry.
  - [`docs/roles-and-access.md`](docs/roles-and-access.md) – roles, the deployment admin, links.
  - [`docs/trupp-naming.md`](docs/trupp-naming.md), [`docs/verlauf-coverage.md`](docs/verlauf-coverage.md),
    [`docs/object-visits.md`](docs/object-visits.md) – Trupp identity, what reaches the Verlauf,
    Objektbesuche.
- `mockups/` – historical look-and-feel explorations (not maintained; only `app-lage.html` and
  `nav-concepts.html` are tracked, the rest stays local by `.gitignore`). The former
  `docs/design-concepts/` directory is gone – superseded by the React app itself.
