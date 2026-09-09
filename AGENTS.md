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

- **Frontend:** React 19 + TypeScript, Vite 8, MapLibre GL, Workbox/PWA, Vitest. Use **pnpm**.
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

- **Operational browser state lives in IndexedDB, not localStorage.** `src/lib/idb.ts` is the
  storage layer (localStorage only as its degradation fallback), `src/lib/storageMigration.ts`
  moved legacy operational keys over once. IndexedDB holds incident workspaces, pending sync,
  media queue metadata, reference/checklist/object metadata, and readiness; localStorage holds
  only tiny device flags (update banners, install prompts, once-per-device hints) and migration
  flags. UI copy/locale/defaults/storage keys live in
  `src/config/appConfig.ts`; the neutral fallback incident is `src/data/demoIncident.ts`.
- **Saved means every operational queue is acknowledged.** Workspace, journal and client audit
  outboxes contribute to the shared sync status. Preserve rejected entries for retry/export;
  a failed IndexedDB write must never claim local durability. Hydrate and merge a predecessor's
  queue before a promoted tab writes it. Client audit events carry a stable `client_id` through
  retries; a beacon does not acknowledge delivery.
  A disposed journal store must never publish a late snapshot over its replacement.
  A Web Lock request rejected before a grant must not immediately requeue: an inactive
  document can reject forever and prevent navigation. Requeue only after a held lock is lost,
  and ignore grants that arrive after the owner stopped.
- **Backup originals are immutable.** Publish original blobs under fresh/content-addressed
  keys before committing their SQL reference; delete obsolete files through `storage.delete`
  (including transaction callbacks). The online backup guard retains deleted originals until
  `app.backup` pins them; never bypass it with direct unlink or overwrite original keys in place.
  Derived thumbnails/waveforms may be regenerated. Keep `.kp-backup` coordination files private
  and never unlink its lock files. Corrupt deletion markers retain their pins for inspection;
  they must not prevent other cleanup or backups. Incompatible schema rollback is an explicit restore with
  `scripts/restore.sh --no-start`, followed by selecting the matching image; never auto-downgrade.
- **PDFium calls share one process-wide lock.** Hold `app/pdfium_lock.py`'s lock through object
  creation, rendering and explicit closure, including print-page reversal. Run this synchronous
  work off the request event loop; separate PDF documents are not thread-safe either.
- **Alarm validation must preserve unchanged legacy data.** Full workspace saves validate at
  `apply_workspace_put` against the stored incident, retaining exact existing malformed rows
  while rejecting new, edited or duplicated invalid rows. Never silently drop operational
  records or skip validation because a revision differs; return the normal conflict instead.
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
- **IDs are prefixed timestamps, not UUIDs** – `newId(prefix)` from `src/lib/ids.ts`
  (`<prefix><ms>-<seq><rand>`) for records the app mints and syncs; plain
  `'p'+Date.now()` survives in older call sites. Offline-friendly, no DB roundtrip;
  don't reach for `crypto.randomUUID()`.
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
- **One object, two surfaces — there are no twins any more** (10.09.2026,
  `tmp/design-unified-objects.md`). A tactical object is ONE record in one collection
  (`src/lib/tacticalObjects.ts`), carrying up to two bodies of the same thing: `entity` XOR
  `drawing` is what the Karte draws, `sheet {planId, anno}` is what one plan sheet draws. The
  three legacy collections (`entities` / `drawings` / `board`) survive only as VIEWS of it, and
  the blob still carries them so an older client can read a newer incident.
  - **The sheet body's PRESENCE is the anchor.** An object hand-placed on a sheet carries
    `sheet`: the sheet coordinates are its truth, and its map body is BAKED through the plan's
    georeference (`bakeGeoBody`) and re-baked when that fit changes. An object hand-placed on the
    Karte carries no `sheet` at all: geo is its truth, and a linked sheet draws it by PROJECTING
    it through the same fit (`src/lib/planProjection.ts`). Both derivations are pure, and they
    are **inverse in geometry AND in absence** — a projected anno handed back off a sheet becomes
    the stored sheet body verbatim, so an asymmetry between them would rotate, resize or displace
    the object a little on every flip, and an absent field materialising as `0` or `''` would
    invent one. Where one converts (the sheet's own turn into and out of the paper's frame, for
    BOTH bearings; metres into sheet fractions and back, at the same default an unsized object is
    drawn at) the other undoes it, and the comment at each says so. ⚠️ The absence half is
    normalised on the way BACK, not on the way out: an object with no bearing genuinely IS turned
    by `rotationDeg` in the paper's frame, so the projection has to state that — and «points
    north» is the same fact as «has no bearing», so the bake returns the shorter one
    (`turnedToGround`). Without it every ordinary unturned Fahrzeug acquired `rotation: 0` on its
    first flip. A field that cannot be said in both units — a note's width, a label's nudge —
    does not cross at all: it is preserved through the bake instead (`BAKE_PRESERVED`), because a
    number that means two distances is worse in the record than no number.
  - **Last hand-placement owns the truth.** A drag flips the anchor to the surface it happened
    on: dragging a sheet-anchored object on the Karte DROPS its sheet body, dragging a map object
    onto a sheet CREATES one. Both seams (`applyDocToObjects`, `applyBoardToObjects`) therefore
    read a document as a GESTURE rather than as the truth, in four readings each — unchanged is
    nothing, a prop edit writes through to the OTHER body, a positional edit flips the anchor,
    and absence deletes the whole object, because deleting an object deletes the object.
  - ⚠️ **A MACHINE write never flips an anchor.** Only a hand places something. The live-GPS pass
    re-routes attached Leitungen several times a minute, and read as a placement it tore
    plan-drawn hoses off their sheet with nobody touching anything; such writers pass
    `gesture: false` and their position crosses through the fit instead.
  - ⚠️ **Ownership decides the undo stack.** A surface's own objects belong to that surface's
    history — the Karte's `commit`, a plan's per-document `planHistory` / `useBoardDoc`. An edit
    that touches an object the surface does NOT own is a store-level act, and checkpoints on the
    store's stack: a per-sheet snapshot of annotations cannot express «this object was
    geo-anchored», so it could not undo an anchor flip at all. One gesture stays one step: a plan
    step opens a TOKEN (`useObjectStore · beginSheetStep`) whose first cross-ownership fold takes
    the step and whose remaining samples fold into it, and the token closes when the finger lifts
    — a plan step is a pointer gesture. With none open, every write is its own step, which is what
    the writers that are not gestures (the Trupp sweeps, a plan ↶, a Gebäude amend) need.
  - **Presentation stays equivalent, and nothing is lent that is owned.** Each surface draws the
    other's objects with its OWN native chrome and sizing (map `symPx`, board `symBase`) — no
    projection tone, no reduced opacity, no twin-only band — and every capability the surface has
    applies: selection, the `SelectionBar`, the marquee, the magnet, the fat-finger fan, Delete.
    A sheet is never shown its own objects back through the projection, and never a SIBLING
    sheet's: plan A's work has never cluttered plan B. What IS lent is only what is not a record
    — the live vehicle and responder feed (`planProjection · liveOverlay`, `PlanLiveLayer`),
    read-only but for the one gesture it always had: dropping a Fahrzeug writes the same
    held-in-place override the Karte writes.
  - **Reference change or delete loses nothing.** Correcting a fit re-bakes every sheet-anchored
    object's map body — that correction is the whole point of correcting a fit — as ONE undo step
    with one Verlauf row («Referenz angepasst – n Objekte neu verortet»). A DELETED reference
    leaves both bodies standing: the sheet keeps its annos, the Karte keeps the ground positions
    the last fit baked, and neither is marked stale — last known truth, like a vehicle that
    stopped reporting. Nothing moves, so the re-bake honestly reports 0, and the row is therefore
    its own («Referenz entfernt – n Objekte behalten ihre letzte Position»): without it the
    Verlauf would say nothing whatever about an act somebody performed on purpose. ⚠️ It is
    derived from SHEET KEYS still on the rail (`georefTwins · referenceDelta`) — every
    Einsatzobjekt has a «Modul 2», so counting plan ids would read every object switch as a
    deletion. Re-linking later re-links both directions and re-bakes.
  - ⚠️ **The aspect the fit is solved in is its own stored fact** (`measuredArByPlan`), NOT
    `PlanScale.ar`. `ar` is half of a pair — a sheet's ground width is `ar · mPerU` — so
    correcting it in place silently rescales every measured distance on that plan. The measured
    aspect says only «this sheet is this shape»; correcting it re-solves the fit from the SAME
    pairs (a pair is an aspect-independent statement), so `fitSignature` changes and the ordinary
    journalled re-bake does the rest. The surface holding the bitmap writes it, once per sheet per
    session, past the same 2 % drift calibration staleness uses. It matters because a replaced
    Modul PDF leaves a stale `ar` that staleness CANNOT catch (it is measured against the very
    aspect being looked for, and the pairs were fitted at the same wrong one), and a wrong aspect
    is now a wrong position in the record rather than a tilted picture.
  - **The station document is version-guarded.** `PUT /api/plan-scales` is a whole-document
    replace and now carries `If-Match` — the same content-hash token and 409 as `PUT /api/config`
    — because a lost update no longer costs a re-measurable calibration but MOVES objects. The
    client recovers by re-reading and re-applying its per-plan change on top, once. A PUT without
    the header is still accepted for one release (there is no CLI writer here, and an old build
    must not lose the ability to save a Georeferenz in the field).
  - ⚠️ Known limitation, ACCEPTED and not to be re-opened without a decision: the flip is a FIELD
    REMOVAL, and `mergeWorkspace` merges an object field-wise last-writer-wins — a concurrent edit
    still carrying the dropped sheet body brings it back. Absence cannot say «deliberately
    dropped»; a tombstone or an explicit anchor enum could, and that is a schema change nobody has
    asked for. Replay is unaffected: it folds VIEWS, so a sheet there shows only what was recorded
    on it.
  - ⚠️ **An attachment may name an object in the other document, and that is now the common
    case.** A Leitung end docked onto an object stores the object's id; both live surfaces resolve
    it, because it is the same id on both. The server-side print/export adapters cannot — they see
    one document at a time — and neither can a reader after the far side deleted it. Both land on
    the SAME safe answer every unresolvable attachment gets: the stored coordinate, which is
    exactly where the endpoint was dropped (`lineAttachments · resolveLinePoints`). Do not «fix»
    that by resolving across documents in an adapter; the fallback is the contract.
  - ⚠️ **Replay stays VIEW-based, deliberately** (`lib/replay`). A `Saved` blob carries the three
    legacy collections even though they are derived, so a recorded incident replays through
    anything that ever spoke those shapes — and a view is *what was on the screen*, whereas an
    object would have to be projected through a fit, and the only fit a replay has is TODAY's.
    The price is that the event stream has to be COHERENT across both views, so the seams pay it:
    an anchor flip emits the PAIR (the store reports the flip — `tacticalObjects · anchorChanges`
    — because neither surface can see the other's half), `board.move` is folded, and the georef
    re-bake deliberately emits NOTHING (n `entity.move` rows would claim n placements nobody made;
    the snapshot the ensuing save writes is what carries it). Full ledger:
    `docs/verlauf-coverage.md`.
  - The word «twin» survives where renaming it would cost something real: `twin:` is a persisted
    Ebenen-preference prefix (`lib/prefs`) and would reset every device's rows, and
    `TWIN_CLIP_MARGIN` is the one clip both derivations quote. Elsewhere it is only a name that
    has outlived its concept — the file `lib/georefTwins.ts`, `components/TwinTeamPill`, the copy
    keys `twinFromMap` / `twinUnnamed`, the `LayerPanel` `twins` prop — and any of those may be
    renamed by whoever is next in that file anyway. Nothing in the app is a twin.
- **«Automatisch ausrichten» PROPOSES a georeference; it never asserts one** (08.09.2026). An
  unlinked module sheet's «Karte verknüpfen» chip offers the CV suggestion beside the point
  flow: `POST /api/georef/suggest` (matcher in `app/georef_suggest.py`, evaluation + provenance
  in the gitignored `docs/planning/auto-alignment/`) segments the client-rendered sheet
  (`PdfViewport · planMatcherImage` reuses the resident bake), matches it against OSM building
  rings via the Overpass proxy, and streams NDJSON progress for the step card. The heavy CV
  deps are the **optional `georef` dependency group** (`uv sync --extra georef`) — not in the
  production image yet; without them the endpoint answers 503 and the app degrades to the point
  flow (fail-closed). ⚠️ A server that cannot do it **never offers it**: `/api/config` states
  the capability (`integrations.autoAlignConfigured` — extra importable *and* an Overpass mirror
  configured, `app/providers.py`) and the chip then arms the point flow directly instead of
  answering every press with «…ist auf diesem Server nicht eingerichtet» (field report
  09.09.2026). The honesty rules are load-bearing: an accepted fit is stored as exactly
  **two pairs `kind: 'auto'`** (more would fabricate zero-residual evidence); while any auto
  pair is in the fit no surface claims a ⌀ (chip/lamp/Passung read «Automatisch ausgerichtet ·
  ungemessen»); auto anchors are ghosted, badged «A», excluded from every count, and the
  SECOND operator-set pair drops them (`georefMode · settleSlots`); score ≤ 6 = confident,
  under the template ceiling (12 · m1 16) = amber «Deckung nachprüfen», above = «kein
  Vorschlag» — and an **m1 result is never confident**. The proposal review lives on «Deckung
  prüfen» (nothing persists before «Übernehmen», which is confirm-with-undo).
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
  hand-rolled: a focus-trapping/scroll-locking primitive would break map interaction. The
  tap-open picker (`ComboMenu`, worn by `Combo` and the Atemschutz `PersonField`) and the
  tap-toggle `DockInfo`/`InfoTip` also stay bespoke (free-type + in-menu toggle / a tablet tap
  model don't map cleanly to Base UI Select/Tooltip); the admin `Select` stays hand-rolled too,
  keyboard-driven and unportalled.
- **Coordinates are WGS84 `[lng, lat]` wherever the map renders.** LV95 only at the edges via
  `src/lib/geo.ts` (`wgs84ToLV95` / `lv95ToWgs84` / `fmtLV95`), the `centerLv95` config option,
  and the geocoder bbox. Reference-layer GeoJSON (hydrants, …) must be WGS84.
- **Role gating** – product model is three incident roles: `editor` (FU / can mutate incident
  state), `el` (Einsatzleiter function, 07.09.2026 – reads everything, writes ONLY the record
  domains: Anwesenheit/Zeitplan, Mittel, Checklisten, Rapport + Beilagen, via the
  server-enforced `PUT …/workspace/record` slice (`RECORD_WORKSPACE_KEYS`), journal/event
  appends limited to the record vocabulary (`EL_EVENT_PREFIXES`), and media uploads; the full
  workspace PUT, the trupps slice and everything tactical stay 403 for it), and `viewer`
  (read-only). Frontend: `isEl` behaves like an editor's Führungsansicht (`tacticalLocked`
  on, `readOnly` off) with `canEditRecord` unlocking the four surfaces and the sync pushing
  `slice: 'record'`. The legacy `commander` value has been migrated away: the stored role,
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
  to a link session. **A link is the literal page and touches nothing on the device** (02.09.):
  its cookie has to be site-wide (an `<img>` carries no header), so the PAGE says which session
  it is asking with — `X-Incident-Link: off` from the app and `/admin`, `use` from the
  handed-over Atemschutz board, nothing from a subresource or an alarm/view link page
  (`src/lib/linkMode.ts` ↔ `LINK_MODE_HEADER`). Consequences to keep true: the bare site after a
  link visit is whoever it was before, an Atemschutz link no longer signs the phone out to win
  precedence, `logout` is off the allowlist, and **no link surface offers «Abmelden»** — leaving
  a link is closing the page, and coming back is the link URL. Two rules that fall out of the
  same model and are easy to break: a page sending `use` with no live link session is **401, never
  the device's login** (falling through would turn a lapsed board into the phone owner's account),
  and the device's own «Abmelden» **does** clear the link cookie — headerless requests (typed
  address, `<img>`, service worker) answer as the link guest otherwise.
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
  `schema|example|validate|load|push|show` CLI keyed off `KP_ADMIN_SECRET`; they share their
  flags, refusals and push session with `admin_config`/`admin_branding` via `app/admin_cli.py`).
  The frontend turns
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
