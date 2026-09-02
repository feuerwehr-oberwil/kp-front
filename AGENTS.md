# AGENTS.md

Guidance for agents and humans working in this repo. Keep it current: when a convention or
decision changes, update this file in the same change.

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

- **Frontend:** React 18 + TypeScript, Vite 5, MapLibre GL, Workbox/PWA, Vitest. Use **pnpm**.
- **Backend:** FastAPI + PostgreSQL, Alembic; one service serving the frontend same-origin (no
  CORS), on Railway or self-hosted via docker-compose. Manage Python with **uv** – see
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
frontend has none – so run `pnpm lint && pnpm test` before pushing, since changes go straight
to prod.

## Architecture & conventions

- **Operational browser state should live in IndexedDB, not localStorage.** Current code still has
  localStorage workspace paths, but the target is: IndexedDB for incident workspaces, pending sync,
  media queue metadata, reference/checklist/object metadata, and readiness; localStorage only for
  tiny preferences and migration flags. UI copy/locale/defaults/storage keys live in
  `src/config/appConfig.ts`; the neutral fallback incident is `src/data/demoIncident.ts`.
- **Undo/redo – every mutating op should be undoable, scoped to the workspace.** The standing
  rule: Lage map has document-level undo (`useUndoableDoc`), Plan has per-plan-document undo
  (`useBoardDoc`), and one-shot ops (Gebäude floor add/remove, building replace) use
  confirm-with-undo toasts. Add undo for new mutations; don't skip it.
- **Sync supports task-scoped collaboration.** Multiple editors may work different domains in the
  same incident (e.g. Atemschutz + Lage drawing); this is not shared-cursor co-editing of the same
  object. Cross-domain concurrent edits must merge. Mergeable collections merge three-way **by
  `id`** (`mergeById` in `mergeWorkspace.ts`; delete beats concurrent edit; server-then-local
  order). Same-object conflicts can stay simple for now. To add a synced collection: extend
  `HasId` and register it in `WsShape`. (`Person`/roster is the exception – it carries
  `updatedAt` because it's pulled from Divera, not merged.)
- **IDs are prefixed timestamps, not UUIDs** – `'p'+Date.now()`, `'sh'+Date.now()`,
  `'e'+Date.now()+'-'+i`. Offline-friendly, no DB roundtrip; don't reach for
  `crypto.randomUUID()`.
- **Incident records are append-only where it matters.** Verlauf is the human operational journal
  plus selected meaningful system events; audit/events record committed domain actions. Don't add
  mutate/delete shortcuts for production records; lifecycle changes (reminders, media transcripts,
  corrections) are *new appended events* with state derived from them. **A row carries what was
  said, not a pointer to it** (reversed 11.08.): a Notiz, a Fläche's name, a Druckmeldung print
  their actual text/value, because the Rapport is read on paper where nothing can be clicked. The
  row is also the ONE string the Verlauf, the Rapport and the hash chain all read – so a re-shown
  reminder carries its bare text alongside (`reminder.text`) rather than the row being re-parsed.
  The one accepted maintenance exception is whole-incident hard deletion through `/admin`:
  `DELETE /api/incidents/{id}` is deployment-admin-only, and a real Einsatz must already be
  archived (an Übung may be deleted in any state). It deliberately removes the full record and
  its audit chain, so do not widen this to editors, individual production rows, or a mutable
  history shortcut. Revisit external deletion evidence/retention policy before offering managed
  hosting; the current trust boundary is one station operating its own deployment.
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
- **Lage and Plan should stay as close as possible in every regard** – same tools, controls,
  and behavior. Only the implementation that *must* differ because of the drawing surface /
  relative coordinate system may diverge. Shared logic lives in `ToolDock`, `DrawEditor`,
  `SelectionBar` and `src/lib/lineStyle.ts` / `src/lib/selectionTransform.ts`; the renderers stay
  separate only for that surface-specific part.
- **One selection bar, one edit-chrome vocabulary** (decided 01.09.). Moving, turning and
  deleting a selection – a single Linie/Fläche/Absperrkreis, a Form, or a Mehrfach group – happen
  on the fixed `SelectionBar` at the bottom of each surface, never on floating chrome grown at the
  object's own centre. **✥ and ⟳ answer two gestures** (02.09.): a *drag on the grip* moves /
  dials straight away, for the small adjustment; a *tap* arms that grip as a surface **mode**
  (`lib/useArmedTransform`), and while it is on, a drag anywhere on the Karte or the Kroki moves
  the selection by the drag delta or turns it about its centre, following the pointer's bearing.
  The mode exists because of where the bar sits: pinned bottom-centre, pulling ✥ *downward* runs
  the finger off the screen within ~28px. Only one of the two is ever armed; tapping it again,
  Esc, a selection change and a tool change all disarm, and while armed the surface answers no
  taps at all – a press that never travels is nothing, so nothing can be placed, selected or
  deselected under the finger. **The bar has three slots and no fourth: ✥ · ⟳ · Fertig.** The
  turn's degrees are read *on the surface*, beside the pivot and the radius the finger is
  swinging (`components/SelectionTurn`), never off a button at the far edge of a tablet – so the
  two grips are icon-only and never re-flow mid-gesture. «Fertig» ends the editing state
  (disarm + clear the selection + close its sheets); **«Löschen» is not on the bar** – an object
  is deleted from its own editor sheet and with the Delete key, which on both surfaces reaches a
  Mehrfach group and a mirrored selection too. On the object itself only **geometry** grips live:
  vertex, «+» midpoint, Verlängern, Verbindung lösen, the radius ring, and a shape's own
  resize grips (its rotate knob left on 02.09.: the bar's ⟳ is the one way to turn a Form;
  directional symbols and composites keep their rotor because they are not on the bar) – and all of them step aside for the length of a transform
  (`lib/transformChrome`, a body class), because they answer «where exactly» and a whole-object
  drag is asking «where to».
  Colour is one family: a geometry point is white-filled with a `--blue` ring, an action grip that
  transforms the whole object is solid `--blue`, `--amber` means the SECOND axis and nothing else,
  `--red` means delete, and `--accent` stays alarm/relationship – never «selected». Node dots are
  24px on both surfaces. Every grip whose press-and-hold is its own gesture carries
  `data-holdaction`, or the app-wide hold-tooltip eats its release.
- **The editor sheets have one control per kind of question** (decided 01.09., same sweep). A
  yes/no property is the `OnOff` Segmented pair (`components/Segmented`) – never a single chip
  whose text or glyph flips, which said «An» on one row and showed a state on the next. A number
  is the shared `Stepper`; where the two surfaces cannot agree on a unit (a Form's size is metres
  on the Karte and a share of the sheet on a Plan) it is `ScaleStepper`, the same chrome handing
  the caller a ×-factor. A one-press action is a `.de-action` row, in the grammar «Verbindung
  lösen» already had – it is not given toggle chrome, because it has no state to be in. Rows are
  grouped in `.de-group`, so the hairline falls where the subject changes. And **no native form
  control** on these surfaces: the app's own `Menu` instead of a `<select>`, the `Stepper`
  instead of a number field, `components/Slider` instead of `<input type="range">`.
- **A georef twin is the object itself, seen from the other side.** Once a plan carries a
  georeference, annotations mirror between the surfaces (`src/lib/georefTwins.ts`,
  `GeorefTwins*` / `GeorefContent*`). A twin is **interaction- AND presentation-equivalent** to
  its original: the same capabilities through the same functions (rename, Trupp-Join, Farbe,
  Position markieren, trail eye, the locked trash), the surface's **native** sizing (map `symPx`
  band, board `symBase` – never a twin-only band), the original's own chrome and markup (the hit
  button carries only hit-shell classes, the chip sits in an inner span with its native class),
  and the source's own spread arrows, bars and labels – never re-aimed through the fit. **No
  «projection tone»** – no reduced opacity, no dimmed grips or lines; it paints exactly like the
  native object beside it. The ONE permitted difference is which surface persists it: a twin is a
  projection, never stored, logged, printed or clocked, and an edit writes the ONE source object.
  A mechanical exception must be real and documented (an anchored endpoint reshapes instead of
  translating, on both surfaces); «not built on that surface yet» is not one. The third real one
  is the **sheet's edge**: a twin's source lives on a BOUNDED document (plan x/y are fractions of
  the paper), so a drag on the Karte that crosses the projected edge pins that coordinate and
  goes on following the finger with the other — the object slides along the edge rather than
  stopping dead. Right, and invisible on a surface that draws no paper, so for the length of any
  twin drag the Karte draws the sheet: a dashed outline in the link tone plus the edge that is
  actually holding, solid, and one `buzz()` the first time it is met (`MapView · twinBound`).
  ⚠️ **The drawn rectangle and the enforced bound are ONE definition** — `georefTwins ·
  SHEET_DOMAIN`, projected through the very fit the drag's write-through inverts. Every writer
  (the direct drag, the whole-path drag, the bar's own twin move) measures against it through
  `sheetShift`, and no surface may derive that rectangle from anywhere else: a footprint, a
  preview's extent or a second-hand aspect turns the outline into a promise the drag does not
  keep. The Plan needs no such chrome — there the bound IS the sheet under the finger. It follows that a
  twin is also inside every SELECTION mechanism of the surface it stands on: the fixed
  `SelectionBar` (for the kinds a native gets it for – ink and a Form), the marquee/group, the
  fat-finger pile's fan, and the magnet. The magnet carries the second real mechanical exception:
  an endpoint docked on a twin stores an attachment naming an object in the OTHER document, which
  both live surfaces resolve but the print/export adapters cannot – there, and after a far-side
  delete, it falls back to the stored coordinate the way every unresolvable attachment does
  (`resolveLinePoints`).
- **Theming:** use tokens / `color-mix(in srgb, var(--accent) N%, ...)`, **never** a frozen
  `rgba()` of the accent – that breaks day/night and per-station accent theming.
- **CSS:** design tokens, the day/night flip (`[data-theme="night"]`), and shared chrome live
  in **`src/styles/NN-*.css`** – one numbered file per block (tokens, base, map, chrome, one per
  surface), listed in order by `src/app.css`, which is now a manifest of `@import`s and holds no
  rules of its own. **The numbering is the cascade**: source order decides ties, so put a new
  block where it belongs and renumber, rather than appending for tidiness – `20-touch-floors.css`
  is last precisely because its `(pointer: coarse)` targets have to beat every surface above it.
  Component-specific layout still goes in `*.module.css` files that reference `var(--token)`;
  the admin UI uses `src/admin/admin.css`.
- **Overlays go through `src/lib/overlays/`** (`Sheet`/`SheetClose`, `Overlay`, `ConfirmCard`,
  `Menu`, `Popover`/`PopoverClose`) – thin wrappers over **Base UI** (`@base-ui/react`, headless)
  that supply focus trap/restore, scroll-lock, Esc, backdrop/outside-click dismissal, and ARIA,
  painted with the existing `.ip-*`/token CSS. That package is imported **only** inside
  `src/lib/overlays/` – every surface uses the wrappers, so behaviour/theming/a11y live in one
  place. Base UI portals Backdrop+Popup as siblings, so scrim = `.ui-backdrop` and centering =
  `.ip-sheet.ui-dialog` (see app.css). **Modal surfaces only** – the non-modal map tool-docks
  (`MapViewsMenu` views popover, the `.ctx` tool editors, the incident `ip-menu`) stay
  hand-rolled: a focus-trapping/scroll-locking primitive would break map interaction. `Combo`
  and the tap-toggle `DockInfo`/`InfoTip` also stay bespoke (free-type + in-menu toggle / a
  tablet tap model don't map cleanly to Base UI Select/Tooltip).
- **Coordinates are WGS84 `[lng, lat]` wherever the map renders.** LV95 only at the edges via
  `src/lib/geo.ts` (`wgs84ToLV95` / `lv95ToWgs84` / `fmtLV95`), the `centerLv95` config option,
  and the geocoder bbox. Reference-layer GeoJSON (hydrants, …) must be WGS84.
- **Role gating** – product model is two incident roles: `editor` (FU / can mutate incident state)
  and `viewer` (read-only). The legacy `commander` value has been migrated away: the stored role,
  the `Literal`/type unions, the `CurrentEditor` dependency, and `user?.role === 'editor'` checks
  all use `editor` now. Do not reintroduce `commander`, and do not add deployment-admin power to the
  incident role model. Deployment administration is **separated** behind the `ADMIN_SECRET` env var:
  the `/admin` UI and admin-write API (config, branding, system, user CRUD, geodata/objects) gate on
  `get_current_admin` / `CurrentAdmin` (a secret-backed admin-session cookie via `/api/admin/login`),
  not the editor role; the `admin_geodata`/`admin_objects` `push` CLI uses `KP_ADMIN_SECRET`. It's
  **fail-closed** – unset `ADMIN_SECRET` → admin endpoints 403, never the editor PIN. Incident
  endpoints stay on `CurrentEditor`, with ONE exception: the Atemschutz-Link (a QR minted from a
  running Einsatz that lets a non-FU operate only the Atemschutzüberwachung) writes through
  `CurrentAtemschutzWriter` on exactly three routes – `PUT …/workspace/trupps`, `POST …/journal`
  (`kind: 'team'` rows only) and `POST …/events` (`atemschutz.*` only); the allowlist and the
  liveness rules live in `backend/app/auth/incident_link.py`. Never widen the full workspace PUT
  to a link session.
- **Per-station config has four layers:** national defaults (code) → per-station deployment
  config (DB/admin) → secrets (env) → per-incident (workspace). One deployment = one station
  (**single-tenant**, no multi-tenancy). See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
  Edit a station's config as code: `cd backend && uv run python -m app.admin_config
  <schema|example|validate|diff|load>`; it's served at `GET /api/config` and applied at boot to
  override `appConfig` defaults.
- **Integration credentials are settable from `/admin`, encrypted, and read through an
  accessor — never off `settings`.** Divera / Traccar / VAPID / STT / CARTO / the two webhook secrets /
  the print-agent secret / `HEALTHCHECK_PING_URL` live in `integration_credentials`
  (AES-256-GCM under an HKDF key derived from `SECRET_KEY`, which stays in `.env`), and every
  consumer reads `app.credentials.get(name)` after `await load(db)`. **`.env` still wins where
  it is set**, so no existing deployment changes. Two rules for anything added here: a
  scheduler job whose credential is runtime-settable is **registered unconditionally and
  no-ops when unset** (gating registration at boot is what made this impossible before), and
  a secret is **write-only over the API** — settable, never readable. The CARTO basemap key is
  the explicit client-credential exception: CARTO requires it in browser tile URLs, so it is
  readable at runtime and must be restricted to deployment domains at the provider. ⚠️ Readable
  is not public — `/api/config` serves it only to a caller holding a session, and «session»
  includes an incident LINK (`LinkApp` mounts the whole app, and a link carries no
  `access_token`, so `actor is not None` is the wrong test). Server-side renders (Rapport/Kroki)
  use `app/carto.py` and the deployment's own credential, never the client's copy. `SECRET_KEY`,
  `ADMIN_SECRET`, `KP_TELEMETRY_*` and `REQUIRE_PLAN_DIGEST` stay env-only on purpose: each
  would defeat itself in the database it gates.
- **Reference geodata, object plans, and checklists are station data, never bundled.**
  Hydrants/Leitungskataster/canton-WMS layers, Modul PDFs, and the FU/EL checklist templates +
  playbook diagrams don't live in this repo – they're loaded into a deployment from a *private data
  repo* via `admin_geodata` / `admin_objects` / `admin_checklists` (each a
  `schema|example|validate|load|push|show` CLI keyed off `KP_ADMIN_SECRET`). The frontend turns
  config geodata into map layers (`referenceLayersFromConfig` → `deriveInitial`); missing object
  plans fall back only to OSM outlines + `Tafel`, never bundled `/public` PDFs; checklist templates
  are fetched from the `checklists:<id>` reference datasets (`loadTemplates` in
  `src/lib/checklists.ts`, offline-cached), falling back to one neutral bundled example
  (`src/data/checklists/generic-action.json`) – never a station's real lists. GeoJSON must be WGS84
  `[lng,lat]` (LV95 is rejected).
- **Domain language is German** (Atemschutz, Trupp, Einsatz, Verlauf, …); keep terms
  accurate. **All user-facing strings live in `appConfig.copy.*`** – never hard-code UI text in
  a component; add a key and reference it.
- **The map surface is «Karte», the printed picture is «Kroki» – user-facing copy no longer says
  «Lage»** (2026-09-01). The word meant three things at once (the surface you draw on, the
  tactical picture that gets printed, and the doctrinal *Lage* of an Einsatz), so a row could
  read «auf der Lage platziert» while the tab beside it said «Karte» and the Rapport column said
  «Kroki». The rule now: the surface and everything about placing things on it is **Karte**; the
  rendered/printed snapshot is **Kroki** (the Rapport's `areaLage` value has said so since
  10.08.); real doctrine compounds – *Lage- und Einsatzführung*, *Lagebeurteilung*, *Lagerapport*
  – keep their word, because they are the fire service's terms and not ours. ⚠️ Code identifiers
  are NOT part of this: `mode 'map'`, `surface: 'map'`, `areaLage`, `placeLage`, `lagePickSub`
  and friends keep their names, and so does `alarmText.ts`'s `LINK_PREFIX = 'Lage & Pläne:'`,
  which is a **wire literal** matching what the external alerting gateway (fwo-divera ·
  `src/api/sms.py`) emits – renaming it would break link extraction on every real alarm.
- **Failure copy has two shapes, and they are not interchangeable** (settled 2026-08-27 after a
  sweep found 35 of one and 20+ of the other with no rule between them):
  - *«X fehlgeschlagen»* – the action the operator just triggered failed, on a surface that
    already says which one it was (the toast right after the button). It is a **fragment**.
  - *«X konnte nicht … werden»* – the failure is about a **named thing** the operator did not
    just act on, or the sentence has to carry *which* object failed («Plan konnte nicht
    hochgeladen werden»). Losing the object name to shorten it is the wrong trade.
  - **Punctuation follows the last segment, not the string.** A string ends with a period only
    when its final segment is a full clause (subject + finite verb): «… – Änderungen sind lokal
    gespeichert.» keeps it, «… – nochmals versuchen» and «Löschen fehlgeschlagen» do not.
    Headings and titles never take one, even when they are full clauses («Ein Fehler ist
    aufgetreten»). The rule is per locale – French «La suppression a échoué.» is a clause where
    German «Löschen fehlgeschlagen» is a fragment, and both are right.
- **Prose language split: technical English, user-facing German.** Everything technical –
  `docs/`, READMEs, `CHANGELOG.md`, code comments, commit messages – is written in English;
  German appears there only as domain terms and as «quoted» UI copy. User-facing text is German
  with i18n overlays (above). The gitignored internal station documents under `docs/` are the
  exception and may stay German.
- **i18n / multilingual copy lives in `src/config/copy/`.** German (`de.ts`) is the canonical
  base and the source of the `Copy` type; `en.ts` (full) / `fr.ts` / `it.ts` are
  `Localizable<Copy>` partial overlays **deep-merged over German**, so any missing key falls
  back to the German string – a half-translated locale is always complete. `appConfig.copy` is
  a **getter** returning the active locale's catalogue (`copy/getCopy()`); read sites are
  unchanged (`appConfig.copy.x.y`). Locale is a **per-deployment** setting (one brigade = one
  language), resolved **once at boot** (`/api/config` `identity.locale` → `de-CH`) by
  `applyLocale()` in `main.tsx`. It's set in deployment config (CLI/config file first; admin UI
  can inspect/basic-edit Station › Identität › Sprache), NOT per device. **Add a new string to
  `de.ts` first** (it defines
  the shape); translate in the other locales as desired. Two caveats: (1) module-level captures
  like `const C = appConfig.copy.x` freeze the language at import – read inside the
  component/function instead; (2) a few copy values are structural DATA keys, not labels
  (`contextPanel.unField`/`stoffField` match the non-localized preset fields, intake
  `kategorien`/`kategorieGuess` mirror the backend) – leave these untranslated (German fallback).
- **Tactical symbols are our own pack.** `public/tactical-symbols.json` is KP-Front-authored
  artwork following the FKS Faltkarte conventions, generated by `tools/gen_symbols.py` – edit
  the generator, never the JSON, and re-run `python3 tools/gen_symbols.py emit` (a `review`
  mode renders a sign-off grid). Names/categories are compatibility keys referenced across
  appConfig/copy/backend config; keep them stable.
- **Buttons follow one spec – don't invent a per-surface variant.** Decided 2026-07-28 after a
  sweep found 12 label type combos, 6 disabled opacities and 8 stray radii for one role.
  - *Radius:* **every** button is `var(--r-sm)`, whatever its size, border or icon-only-ness.
    Rows, list items, option cells, tiles and field triggers are **not** buttons and keep
    `--r-ctl`; on-canvas furniture (handles, vertices, pins, trail marks, colour swatches, the
    badges attached to a map object), dots, legends and avatars stay round – roundness is what
    tells map furniture apart from chrome.
  - *Type:* two sizes, two weights. `12.5px/700` compact (toolbars, docks, dense rows, chips),
    `14px/700` standard (sheet footers, form + page actions), and `800` **only** on the single
    action of a surface (Kontakt, Speichern, Senden). Nothing else.
  - *Height is a separate axis* – `--tap` (44px) by default, 48–50px for a card's main action.
    The 12 type combos happened because people enlarged the *label* when they wanted a bigger
    *target*; raise the height, not the font.
  - *Colour:* the primary fill is `var(--btn-primary)` (+ `--btn-primary-hover` /
    `--on-btn-primary`), never `--ink-fill`/`--blue`/`--accent` directly. **Red never fills an
    action** – it means danger/delete only. Amber = warning but not critical; red = danger,
    broken, act now; blue/grey = normal status and in-progress.
  - *Disabled:* `opacity: var(--disabled)` + `cursor: default`. Never inline the number.
- **Touch vocabulary – one beat, one buzz, one wash.** The primary devices are gloved tablets;
  a new gesture reuses these or it teaches a second language. Any new touch interaction must:
  - *Hold on the 350 ms beat* when the hold **reveals or offers** – the icon-only hold-tooltip
    (`src/lib/holdTooltip.ts` · `HOLD_MS`) and the Eintrag hold (`src/lib/useHoldEntry.ts` ·
    `HOLD_MS`) share it, so every still hold answers alike. The holds that are not «reveal» keep
    their own documented numbers: `useHoldToDrag` arms a drag at 180 ms, `nodeHold.ts` arms at
    250 ms and fires destructively at 825 ms. Reuse a constant; don't invent a third window.
  - *Buzz on arm, and only on arm* – `buzz()` from `src/lib/haptics.ts`, always 12 ms, at the
    moment a held gesture becomes something (tooltip appears, drag latches, chooser opens, magnet
    dwell engages). Never on taps, successes or errors; never a pattern or a second duration
    (`navigator.vibrate` is Android-only, so anything expressive is inaudible to half the fleet).
    Older inline `navigator.vibrate?.(12)` sites (MapView/Whiteboard magnets, `nodeHold`) are the
    same 12 ms – new call sites go through `buzz()`.
  - *One hold ring, around the icon* – `HoldChargeRing` (`src/components/HoldTargets.tsx`, also
    `NodeDeleteChip`), fed by `useTimedProgress` off the **same clock as the timer**. Never a CSS
    keyframe: it drifts against the latch and, under `prefers-reduced-motion`, paints full on the
    first frame while the timer still runs. The ring haloes the glyph – never strokes across a
    label, and nothing may reflow under the finger mid-hold.
  - *Pressed state is the `--press` wash* – `background-image: linear-gradient(var(--press),
    var(--press))` on `:active:not(:disabled)`, so it composes over any background colour.
    **Nothing moves**: no scale, no translate – motion on press reads as lag under a glove.
  - *Hover is mouse-only* – every `:hover` rule sits inside `@media (hover: hover)` (app-wide
    since 28.08.). A tap leaves `:hover` stuck on what it hit, which reads as a selection state
    the surface does not have. `@media (pointer: coarse)` in `20-touch-floors.css` is the other
    instrument: it grows a target, it does not style one.
  - *A control whose press-and-hold IS its own gesture spreads `data-holdaction`* (the shared
    hooks already do), so the global hold-tooltip never claims it and asking «what is this»
    can never also do it.
- **Time-based alerts** (Atemschutz clock, reminders) go through the shared `src/lib/alarm.ts`
  layer, not ad-hoc timers. Delivery: foreground tone/wake-lock + service-worker notification,
  plus – once the deployment sets VAPID keys (`app.gen_vapid`) – server-side Web Push for
  killed apps: `backend/app/push.py` re-derives due-ness from the synced data (no mirror
  API) and also pushes «Neuer Einsatz» when a new Divera alarm lands in the pool. Fail-closed:
  no keys → `/api/push/vapid-key` serves `null` and no sweep runs.

## Working in this repo

- **Committing straight to `main` is fine (no PR ceremony).** But only commit+push
  *immediately* when the user needs the change on production to test it right now; otherwise
  **batch related changes and commit once the chunk of work is done** (a coherent unit), rather
  than after every small edit. The user tests on production, so a needed-for-testing change
  still ships promptly – just don't pepper `main` with partial commits.
- **The user keeps uncommitted WIP and commits in parallel.** Never `git add -A` / `git commit
  -a`; stage only the specific files you changed, and don't assume the tree is clean.
- **Verification before prod (the CI gate).** Prod deploys from `main`, so a red `main` reaches
  the field. The standing flow for any non-urgent change: develop on a branch, push, let
  `ci.yml` go **fully green**, *then* merge – never merge a red branch. `ci.yml` runs three gate
  jobs: *Frontend (tsc + build)* – eslint + `tsc --noEmit` + vitest + `vite build`; *Backend
  (ruff + alembic + pytest)*; *Image (hadolint + build + smoke)* – builds & boots the real
  production container and drives the Playwright white-screen smoke (`e2e/smoke.spec.ts`) against
  it. An **urgent prod hotfix** may still go straight to `main` (see the commit bullets / the 3am
  tenet) – but run `pnpm lint && pnpm test` (and ideally `pnpm build`) locally first. For
  interactive changes a unit test can't cover, use `/code-review` on the diff and `/verify` to
  drive the real app. Keep the house rule: every new mutating feature ships with a `src/lib` test.
- **The gate is server-enforced.** Branch protection on `main` requires four checks to pass
  before a merge: *Frontend (tsc + build)*, *Backend (ruff + alembic + pytest)*, *Image
  (hadolint + build + smoke)*, and *Secrets (gitleaks)*. `enforce_admins` is **off** on purpose,
  so a 3am hotfix can still bypass it – that is the only intended bypass, not a routine one.
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
- Match the surrounding code's style, naming, and comment density.
- When writing docs, convert relative dates to absolute.

## Documentation map

- [`docs/`](docs/) – concept, configuration, deployment, and architecture docs, indexed
  with status in [`docs/README.md`](docs/README.md).
- `mockups/` – historical look-and-feel explorations (not maintained; only `app-lage.html` and
  `nav-concepts.html` are tracked, the rest stays local by `.gitignore`). The former
  `docs/design-concepts/` directory is gone – superseded by the React app itself.
