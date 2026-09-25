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
pnpm lint    # eslint, with a warning ceiling (--max-warnings) – lower it when you fix some, never raise it
```

**Sourcemaps are hidden** (24.09.2026): `build.sourcemap: 'hidden'` writes a `.map` beside every
chunk. No bundle references it, and the service worker's precache excludes `*.map`.
`scripts/check-sourcemaps.mjs` checks all of this in CI. Never switch to `true`, and never
precache maps. To read a field stack, see [`docs/SOURCEMAPS.md`](docs/SOURCEMAPS.md). A client
crash report is ONE log line (`kpfront.clienterror`, newlines as « ⏎ », each field bounded). The
client sends a repeated signature as a counter (`repeat=×N since=…`) and never drops it
(`src/lib/reportError.ts`).

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
  outboxes and the media upload queue contribute to the shared sync status. Preserve rejected entries for retry/export;
  a failed IndexedDB write must never claim local durability. Hydrate and merge a predecessor's
  queue before a promoted tab writes it. A failed IndexedDB READ is not a miss: every hydrate that
  writes back reads through `idbRead` and never writes over a slot it could not read. Client audit events carry a stable `client_id` through
  retries; a beacon does not acknowledge delivery.
  ⚠️ **An audit event the ROLE can never write is not owed** (24.09.2026, `lib/eventScope`,
  `auditEventStore · refused`). The client mirrors the server's append allowlist
  (`EL_EVENT_PREFIXES`, `atemschutz.*` for an Atemschutz-Link, nothing for a viewer — a test
  pins the prefix list to `api/events.py`) and never queues an op outside it; a 403 for such an
  op is PARKED as `refused` — persisted, exported with «Einträge sichern», never re-sent by
  «Erneut versuchen», and NOT part of the shared sync status (a calm note in the Verlauf, not a
  red lamp). A 403 for an op the role SHOULD be able to write stays `rejected` and red: that
  is a real mismatch. Never drop either kind. (The `el` phone sat red for three hours on
  23.09.2026 over five `atemschutz.alarm` events it could never deliver.)
  ⚠️ **Reconnect is proven by an answer, not by the `online` event** (24.09.2026, after #209).
  A WLAN that routes nowhere, a backend restart, or a reload while offline never fires `online`.
  So the fetch wrapper reports what it saw (`lib/connectivity`). Any FRESH successful answer
  (`serverClock · isFreshSampleSource`, never a service-worker cache hit) turns `useOnline` back
  on. Only the `offline` event turns it off: a failed request never does, so it cannot flap. The
  first answer after a failure to reach the server (status 0 or 502/503/504, or an `offline`
  event) fires `onReachable`, and the workspace and audit outboxes flush on it as on `online`.
  A flush REQUESTED while an outbox attempt is in flight gets one more attempt if that attempt
  failed to reach the server. Workspace and audit do this through the public `flush()`; the
  journal has its own copy. The stores' own timers go through `run()` and request nothing. It is
  one re-run per request and never after an answer (401, refused, exhausted merge), so an offline
  device does not spin (`outboxReconnect.soak.test.ts`).
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
- **Undo/redo – every mutating op should be undoable, scoped to the workspace.** ONE
  chronological timeline for the whole Einsatz (`lib/undoTimeline`), driven by the TopBar's ↶ ↷
  and by Cmd/Ctrl+Z on every surface – so «take back the last thing that happened» never asks
  which surface you are standing on. Three ways to join it, and the choice is decided by what
  the domain already owns:
  - *Delegating* – the domain keeps its own history and the entry calls it: the Karte's document
    (`useUndoableDoc` through `useObjectStore`), a Plan's per-document history (`useBoardDoc`),
    and the synced slices (`useUndoableSlice` – Anwesenheit, Mittel, Checklisten, **Rapport**,
    **Zeitplan**). Always through a **ref**: the entry outlives the render that pushed it.
  - *Closure* – the entry carries its own inverse, for a domain with no stack: the
    Atemschutz-Tafel, the Gebäude one-shots (floor add/remove, building replace, Drehung),
    Rapport-Beilagen, Ansichten (`rememberOneShot`).
  - *Confirm-with-undo toast* – the fast door beside the header pair, for a one-shot that
    destroys something (a Geschoss, a Beilage, an Anwesenheits-Block, a Pendenz's «Erledigt» —
    whose inverse is an APPENDED `reopened` row, since 23.09.2026). It does the inverse
    itself and **drops its timeline entry** (`push` returns the dropper), so an act is never
    undoable twice.
  Two rules that fall out of it: a surface that persists on every **keystroke** classifies its
  writes so a burst of typing is ONE step and a value/row appearing or disappearing is its own
  (`lib/reportUndo`, `UndoableSlice.set`'s `coalesce`); and a remote hydrate drops the whole
  timeline plus every open fold window, because nothing on it describes anything real any more.
  Deliberately NOT undoable: append-only records (Verlauf rows, audit events – corrections are
  new appended rows), device preferences (Ebenen, Einstellungen sheet) and server-side incident
  metadata (`PATCH /incidents`). Add undo for new mutations; don't skip it.
- **Objektpläne is object-first.** Tabs Objekte · Vorschläge (the review wall's staged ✓/✕ +
  Übernehmen, only open proposals) · Übersicht. The object table row itself opens the detail
  (chevron, no «Öffnen» button), which IS the object editor: auto-saving settings rows (explicit
  button only to create), one TABLE row per catalogue module prefixed with its short form («M6»,
  «M5 PV» – never a raw modulN key), ONE primary action per row («Vorbereiten» or the upload) and a
  kebab for the rest – no modal, no nested cards, no captions. Plan order everywhere is
  `src/lib/planOrder.ts` (module number, family before sub-slots; catalogue `order` only breaks ties). Catalogue coverage and locations live
  under Übersicht. Preparation opens a full-screen editor (admin header + Segmented tabs
  Geschosse / Karte ausrichten / Vorschau, the selected floor row expands in place into its
  inspector, one map fit per PDF shown as a per-page setting) with one persistent draft/save action.
  Switching tabs never saves or discards changes; leaving a dirty editor asks before discarding.
  Status belongs to the current PDF byte revision, never an older approved revision.
- **Prepared Gebäude floors belong to their frozen plan binding.** A Modul-6 stack stores
  `pack.bindingId`; changing the selected Einsatzobjekt must not retarget its backdrop or ink.
  Prepared floors cannot be added or deleted in the incident. Floor drawings may connect in
  pairs across PDF pages; resolve those joins in a common frame, never independently centre
  each crop. **A storey may BE several drawings** (`PlanFloor.part`, 16.09.2026 – two wings of one
  1. OG): each drawing is a row with its own region and its own join, all on one page, and the
  storey is still ONE tile, ONE index and one surface for ink, Trupps and symbols. Every join
  shift is keyed by (index, part); a shift per storey can only place one wing. A symbol's Von/Bis range is one object shown and selectable on every covered floor.
  Dragging it one storey moves the whole range (0–2 → 1–3), with one undo step; range controls
  change coverage, and old single-floor values remain readable without inventing assignments.
  Removing a storey never deletes a range that still covers another one: it shrinks to the
  storeys left, and a home on the removed storey moves to the lowest of them.
  A Linie/Fläche dragged or turned WHOLE stays on the storeys it is drawn on and keeps its shape:
  at a tile's edge the translation stops, never each vertex (`whiteboard · floorGeometry.moveRigid`,
  24.09.2026 — the per-vertex clamp flattened a Leitung onto the tile's rim in the field); a vertex
  changes storey only by its own grip.
  **Ink is cut to its storey's visible SECTION** (24.09.2026, `lib/storeyClip`): the tile's
  drawings, laid as `FloorPage` lays them and cut to the footprint box, or the whole tile where
  there is no Geschossplan. Linien, Flächen, Absperrkreise and trails are clipped to it (SVG
  `clipPath`, which also cuts the hit surface: only what shows can be tapped), and a crossing wears
  an EDGE MARK — white disc, ring and arrowhead in the stroke's colour, pointing the way it goes on.
  Tip, tag, markers, label and stair mark stand only on the visible part; a selected cut stroke
  shows its whole path as a faint dashed ghost so its outside grips stay attached. The printed
  stack cuts to the storey's BAND (no plan is printed) with the same mark (`reportPdfDirect ·
  cutToBands`). A Karte hose projected onto the 1. OG used to run on into the EG's plan.
- **A plan PDF may prepare itself (`§` markers).** The plan author writes `§EG` / `§1OG` / `§DG`
  (`§1OG.B` for a second join point, where no one staircase runs through the whole building –
  floors sharing a label join there, and the chain is resolved in one frame), optional region
  corners `§[EG` / `§EG]` and `§GEO <E> <N>` as ordinary text spans on the sheet; SEVERAL corner
  pairs for one storey are its several drawings (16.09.2026), each holding the one join tag that
  places it – a second drawing without its own tag is refused (`part_without_join`), never guessed.
  A corner pair MAY name its drawing's point (`§[1OG.A` … `§1OG.A]`, 16.09.2026) and then pairs and
  places by that name, which beats nearest-corner pairing and containment; named and unnamed pairs
  mix on one storey, and a named pair whose join tag the sheet never states is `corner_stray`.
  **A tag is one TEXT OBJECT and is read back as one** – PDFium's char stream is NOT positionally
  aligned with its text, so never index `get_text_range(0, count)` by char index;
  `app/plan_markers.py` is the one grammar, and the alignment worker turns them into the floor
  pack plus – with two or more `§GEO` – the map fit (`reason`/`reference_source` = `markers`).
  A marked fit is the plan author's own statement, so the worker APPROVES it on import through
  the one shared gate (`app/plan_approval.py`, 16.09.2026) – the admin checks instead of
  approving; without `§GEO` only the floors are pre-filled and the fit stays a proposal. Markers
  never move an approved fit, and never overwrite a pack the admin built by hand. Each row keeps the proposal it was born from
  (`plan_page_floors.marker`), so the next re-export follows the markers where they moved and
  re-applies, by storey index, every name/region/join a human had corrected. `just plan-markers
  <pdf>` is the author's dry run; the tag grammar for humans is `docs/plan-markers/README.md`.
  **A broken export says so on the row** (16.09.2026): every marker run writes
  `plan_alignments.marker_notes` – the faults as a CLOSED code set (`plan_markers.WarningCode`,
  German through `plan_markers.text` for the CLI/log and through
  `admin.alignment.markerWarnings.<code>` for the admin UI) plus
  `storeys_found`/`storeys_written`/`geo_pairs` – so an object left with zero Geschosse reads
  «Marker unvollständig» in Objektpläne and lists what to fix under the editor's header. Add a
  code ⇒ add its sentence in BOTH places.
- **Sync supports task-scoped collaboration.** Multiple editors may work different domains in the
  same incident (e.g. Atemschutz + Lage drawing); this is not shared-cursor co-editing of the same
  object. Cross-domain concurrent edits must merge. Mergeable collections merge three-way **by
  `id`** (`mergeById` in `mergeWorkspace.ts`; delete beats concurrent edit; server-then-local
  order). Same-object conflicts can stay simple for now. To add a synced field: add it to
  `Saved` and give it a row in `MERGE_POLICY` (`mergeWorkspace.ts`) – the map is checked against
  `Saved` at compile time, so a field without a policy fails `tsc` instead of silently merging
  as «this device wins» (23.09.2026). (`Person`/roster is the exception – it carries
  `updatedAt` because it's pulled from Divera, not merged.)
  - ⚠️ **A new slice survives the builds that do not know it yet** (25.09.2026, review of the
    Suche). An older device rebuilds its save from the fields IT knows, and a save replaces the
    blob — so one tablet that had not updated erased a whole new slice for everybody. Three
    guards, one per layer, all generic: `sanitizeWorkspace` keeps every top-level key it does not
    know and the save echoes it back (`workspace · carriedWorkspaceKeys`, IncidentWorkspace ·
    `carriedKeys`); the merge treats such a key three-way as a value, and «absent on my side»
    as «never knew it», never «deleted» (`mergeWorkspace · unknownWorkspaceKeys`); and the server
    carries the stored value over when a save leaves the key out (`api/incidents ·
    CARRIED_WORKSPACE_KEYS` — builds already in the field predate the first two). Adding a synced
    slice therefore means: its `MERGE_POLICY` row, its entry in `CARRIED_WORKSPACE_KEYS`, and a
    client that ALWAYS sends it (even empty — absence cannot say «emptied»).
  - ⚠️ **What every device OBSERVES is recorded under a DERIVED id, once** (24.09.2026). One
    login is routinely open on three devices, and each runs the same engines — the Atemschutz
    alarm clock, the Fahrzeug presence rings. A row or event such an engine writes must carry
    an id every device computes identically from the fact itself, so the server's idempotency
    keeps one: Verlauf rows `azal-`/`azcl-<trupp>-<turnus>` (alarm), `vp-<n>-<zone>-<vehicle>`
    (presence — `n` is the vehicle's transition number in the shared Verlauf, so a device that
    wakes ten minutes later finds the row and writes nothing), and the audit event beside an
    observed row `observedEventId(rowId, actor)` with a payload free of anything device-local.
    Audit ids are ACTOR-scoped (the server binds a `client_id` to its author; two accounts each
    observed it). The server treats a same-id, same-author, same-op, same-payload event with a
    different `occurred_at` as the duplicate (the first observation's time is kept) — a
    different payload under one id stays a 409. A hand-performed act keeps a fresh `newId`.
  - **409 re-merges wait a jittered moment** (`workspaceSync · conflictBackoffMs`: none before
    the first merge, then 125–375 · 250–750 · 500–1500 ms) so three devices do not retry in
    lock-step. ⚠️ An edit saved while a re-merge is in flight is built on the live view, which
    has not seen that merge — the resolver re-bases it onto the merge before merging again
    (`lastMerged`), or the next attempt reads the remote objects it lacks as local deletes
    (the three-device load test lost 7–14 % of edits that way, `workspaceSync.load.test.ts`).
- **A Trupp is `Trupp N` on paper and its Gruppenführer in person** (12.09.,
  [`docs/trupp-naming.md`](docs/trupp-naming.md)). The number comes from ONE counter per Einsatz
  that unlinked «Trupp N» chips draw from too, is never reused, and is a badge beside the leader's
  name – never the primary label. Every Verlauf row about a Trupp is `Trupp N (crew …)` through
  `truppLogName`, and the crew's history is `crew` rows in the Trupp's own log, which is what the
  Rapport prints per cycle. Add a crew-changing action ⇒ it writes a `crew` row.
  - **A Trupp's marker says which STOREY it is on** (18.09.2026): the Gebäude chip — at rest
    (`.team-dot`) and selected (`TwinTeamPill`) — and the Karte marker whose body was baked off
    that chip wear the same signed badge a Leitung's `floorTag` wears (`.team-floor`,
    `symbolRender · floorBadge`). A Trupp placed straight onto the Karte shows none: it is on no
    storey, and a «0» would assert an EG nobody stated. Every row that already names the place a
    Trupp was put or marked names the storey too (« · 2. OG», appended through `floorLabel` — no
    new row kind, no new template key).
  - **A Trupp's «Spur» belongs to the incident, not to its marker** (18.09.2026,
    `lib/truppTrails`). Removing a chip / map marker (or the Trupp, via «Entfernen») moves its
    recorded positions into a synced GHOST TRAIL — read-only, grey, labelled «Trupp N», drawn on
    the storey it was walked on and in the frame it was recorded in (sheet-normalised for a plan,
    geo for the Karte; never projected across). The marker's bar has ONE trash (`deleteLocked` and
    the morphing trash are gone, and so is the short-lived footprint button beside it): with no
    trail it removes the marker outright, and with one it opens the app's `Menu` — «Marker
    entfernen» (the ghost stays) · «Spur löschen» · «Marker und Spur löschen», the last two danger
    rows, each confirming first. The combined row leaves NO ghost: the surface arms the
    reconciliation (`reconcileGhostTrails · dropped`, `IncidentWorkspace · armTrailDrop`) and the
    ghost is born `removedAt`-stamped rather than skipped — a skipped one is ghosted again by the
    next pass — so the marker's own ↶ is still the whole act.
    ⚠️ Ghosting is a RECONCILIATION over the marker set
    (`reconcileGhostTrails`, one effect in `IncidentWorkspace`), NOT a write bolted onto each of
    the four removal paths — that is what keeps the removal's own ↶ ONE step: a marker that comes
    back takes its trail home and its ghost goes with it, and nothing was ever pushed onto the
    timeline for the ghost. Ids are derived (`ght-<markerId>`) so two devices reconciling the same
    removal converge under `mergeById`; deleting a ghost STAMPS `removedAt` (never drops the row),
    or the reconciliation would write a deliberate deletion straight back.
    A tap on a ghost whose Trupp still exists offers the way BACK before the delete («Trupp wieder
    platzieren», 20.09.2026, `truppTrails · ghostRevival`): the marker returns at the trail's end
    under the id the trail was recorded on (`placeTruppOn… · revive`), carrying the points — so
    the same reconciliation takes the ghost home, and nothing is written for the ghost itself.
    Offered for EVERY ghost with points, not only one with a live Trupp: a loose «Trupp N» chip,
    or one whose Trupp was since removed, returns as the loose marker it then is.
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
  The one accepted maintenance exception is whole-incident hard deletion through `/admin`:
  `DELETE /api/incidents/{id}` is deployment-admin-only, and a real Einsatz must already be
  archived (an Übung may be deleted in any state). It deliberately removes the full record and
  its audit chain, so do not widen this to editors, individual production rows, or a mutable
  history shortcut. Revisit external deletion evidence/retention policy before offering managed
  hosting; the current trust boundary is one station operating its own deployment.
- **The Suche is ONE synced slice + append-only rows** (24.09.2026, step 1 — `lib/suche`,
  `components/suche`). `suche = { personen, bereiche }`: a record says who or where, and what
  happened to it is its own `log` — every state (vermisst → gefunden → übergeben / entwarnt; a
  Bereich's offen / in Arbeit + Trupp / abgesucht / nicht zugänglich, «Fund») is FOLDED from it,
  never stored. Each log row carries the Verlauf sentence it wrote, and the Verlauf row carries a
  `suche` link back (Bereich «Suche», a tap opens the record). Rules that fall out of it:
  - It merges by id, and a record both sides changed merges field-wise with its log as a union
    by row id (`mergeWorkspace · mergeSuche`) — two devices booking two things about one person
    keep both; a row one side took back stays gone. A record BOTH sides added under one derived id
    (a storey both seeded) gets an empty ancestor and merges the same way, never «mine wins».
  - A storey's own area is `sbg:<stack>:<index>` — DERIVED from the Gebäude (`stackKeyOf`: the
    pack's binding, else the footprint) and the storey, so every device seeds the same record and a
    REPLACED building starts fresh. The seed on first open (and on the first Trupp sent in on
    «Absuchen») is a machine write, idempotent and no undo step. An unseeded storey renders as a
    virtual «ganzes Geschoss · offen» so read-only devices see the same gaps.
  - A find is ONE row (`gefunden`, with «weiter an» and the area it happened in on it — the area
    wears «Fund» from it); «+ Gefunden» writes no «Vermisst». A person is corrected and withdrawn
    by rows too (`korrigiert`, `irrtuemlich`) — a withdrawn record counts nowhere and is not
    printed in «Personen» (the Einsatzjournal keeps both rows).
  - What a Trupp's save implies is OBSERVED on every editor device and written under ids derived
    from the Trupp, its SORTIE (`entryTime`) and its Ziel (`useSucheActions · observe`,
    `lib/useSucheTrupps`): on the move into the field (or a new Ziel there) its Ziel's area turns
    «in Arbeit · Trupp N» — a new name creating the part, a re-entry marking again; a new Ziel or a
    removed Trupp releases the old area. A Trupp that never went in marks nothing.
  - «Trupp N raus – abgesucht? Ja / Teilweise / Nein» is NOT a dialog: it is derived
    (`pendingAsks` — an area «in Arbeit» whose Trupp is out) and stands on the area's own row, on
    every editor device (the Raus may come from a handed-over board), until somebody answers; an
    unanswered question writes nothing. It is COUNTED where people look — the head chip, the
    phone's peek line, the Bereiche tab — and each one is a Meldeleiste row
    (`components/suche/SucheAskMeldungen`, kind `suche`) that goes by itself once answered.
    «Teilweise» is its own status (`teilweise`, keeps the Trupp), never «offen», and counts as
    not done everywhere.
  - A record that ENDS without a find («Entwarnen», «Irrtümlich erfasst») is never one tap: a
    short form asks why and who said so (both optional, both in the row), «Abbrechen» focused.
    The Abschluss asks about people still missing as its own question after the crews
    (`vermisstAbschlussMessage`), «Zur Suche» focused.
  - Undo is the WRITER's, as patches (`diffSuche` / `applySuchePatch`): a step takes back exactly
    the records, rows and fields it added — never a row the machine or another device wrote since,
    which a whole-slice snapshot (`useUndoableSlice`) did. Its Verlauf row quotes each row it took
    back («Zurückgenommen: …»). The composer's entry that changes a status IS that change's Verlauf
    row (`silent`) and says the change in its text («… · Suche: Tim Muster gefunden»).
  - Every write emits ONE audit event with its patch (`suche.step` / `suche.undo`), and replay
    folds those forward from the snapshot anchor (`lib/replay`) — row by row, like the Karte.
  - EDITOR only in step 1 (`canEditIncident`): the `el` and viewers read; the record slice and the
    Atemschutz-Link routes do not carry `suche`, and «Fund melden» from a link session is not
    offered.
  - Doors: the rail entry with the red count and the head chip «n vermisst» (phone: a row of the
    «Einsatz» chooser, which OPENS it). No toggle in the tool rails — three doors to one thing.
    Tablet: a DOCK beside the Gebäude or the Karte (the stack fits itself into the room left,
    `Whiteboard · dockInset`), storey labels carry «2/4». Phone: `overlays/DetentSheet`, the one
    NON-modal peek · half · full sheet — it stands on the nav bar and never covers it (on the
    keyboard while that is up), the floor chips stand at every detent, and the tool bar steps
    aside while it is up.
  - ⚠️ Step 2 (not built): drawn areas and person markers on the plan/Karte, and the Rettung
    symbol becoming a Person, fill the fields that are typed and empty today (`SuchePerson.point`,
    `SucheBereich.shape`) — no migration. A drawn area is its own kind «Suchbereich», never a line,
    so it can never be offered to a Trupp as its Leitung (the 23.09.2026 failure).
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
  grouped in `.de-group`, and since 18.09.2026 a group boundary is SPACING: a hairline is drawn
  ONLY above a group that opens a NAMED section («Messung», «Verbindungen» — matched on the
  `.de-group-toggle`/`.de-conn-title` it starts with), because four or five rules stacked down a
  340px panel read as a bordered table and said nothing the padding did not. «Spacing» is the
  ROW RHYTHM, not a band of air (20.09.2026): plain groups follow each other as one continuous
  list of options — the 24px the dropped rules left behind read as something missing. The same
  rule reached the app chrome on 22.09.2026, and was then tuned by hand the same day — what
  stands is: the TOP BAR has ONE 8px gap between every neighbour and no groups at all (a wider
  «group gap» was tried and read as holes); the LEFT rail keeps 14px of air around the plan
  tiles; the TOOL rail's tools are ONE undivided list (the `sep` entries left `mapTools` /
  `planTools`) and its one hairline is the FOOT's, above the generic controls (Ebenen · compass ·
  zoom) — a real seam, where «select vs. create» was noise; the map-utility cluster has air; and
  the Einsatz menu draws ONE hairline, above the identity row (the small-caps label heads «App»
  on its own, but the signed-in row is not an action and the rule says «the list ends here»).
  A hairline also survives where it carries a label (`.jr-day-sep`) or guards a destructive row
  in a `Menu`.
  And **no native form
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
    first flip. ⚠️ **The DOC seam converts bearings too** (24.09.2026, Feueralarm-Übung 23.09.):
    a Karte write hands back the GROUND bearing, and `annoAfterMapEdit` once spread it into the
    PAPER's frame for every sheet-anchored object, changed or not — each «Karte write → bake»
    cycle turned the glyph by −`rotationDeg` (a Lüfter reached 66 735°, and turning one turned
    all). Now `sheetBearings` keeps an unchanged bearing verbatim and sends a changed one through
    `turnedToSheet`; `applyDocToObjects` hands an object whose map body did not change back as
    the same record; both conversions answer in [0, 360); and the load gate
    (`sanitizeWorkspace`) brings any stored bearing into [0, 360) by mod alone.
    Pinned by `sheetBearingRoundtrip.test.ts`. A field that cannot be said in both units — a note's width, a label's nudge —
    does not cross at all: it is preserved through the bake instead (`BAKE_PRESERVED`), because a
    number that means two distances is worse in the record than no number.
  - **Last hand-placement owns the truth.** A drag flips the anchor to the surface it happened
    on: dragging a sheet-anchored object on the Karte DROPS its sheet body, dragging a map object
    onto a sheet CREATES one. Both seams (`applyDocToObjects`, `applyBoardToObjects`) therefore
    read a document as a GESTURE rather than as the truth, in four readings each — unchanged is
    nothing, a prop edit writes through to the OTHER body, a positional edit flips the anchor,
    and absence deletes the whole object, because deleting an object deletes the object.
    ⚠️ The flip is between the Karte and PAPER, never between two sheets (24.09.2026): a move of
    the Gebäude's ink on a sheet it is lent to is written back INTO the Gebäude through both fits
    (that sheet's → ground → the stack's), storey and per-vertex storeys intact, and the Gebäude
    keeps it. It used to flip, and a 0.3° ⟳ on Modul 1 took a 1. OG Leitung off its storey (prod
    23.09.2026). Only a HAND drag that leaves the Gebäude's paper (a Brand dragged out onto the
    street), or a stack with no fit to write through, still re-homes it to the sheet it happened on.
  - ⚠️ **A MACHINE write never flips an anchor.** Only a hand places something. The live-GPS pass
    re-routes attached Leitungen several times a minute, and read as a placement it tore
    plan-drawn hoses off their sheet with nobody touching anything; such writers pass
    `gesture: false` and their position crosses through the fit instead. Both store writers take
    it — `setDocRaw` and, since 24.09.2026, `setBoard` (it hard-coded «gesture»): a plan ↶/↷
    restoring a snapshot (`planStepAt`, `useBoardDoc`), the Trupp sweeps that move a marker
    (`settleAtHoseEnd`, `unlinkTruppLine`), a Gebäude amend and a storey removal. A writer that
    rewrites what a sheet OWNS hands the lent annos back untouched (`tacticalObjects ·
    withOwnAnnos`) — the Gebäude amend carried the Karte's projections through the old building
    frame and they came back «moved». So does «Geschoss entfernen» and the ↶ of «Geschoss
    hinzufügen» (24.09.2026, `stackFloors · removeStorey` / `withoutOwnOnStorey`): a Karte object
    SHOWN on a storey is not the storey's, and swept out of the view it was deleted outright. It
    stays on the Karte and simply finds no tile. The removal's confirm asks only about what the
    SAME sweep loses (`removeStorey · lost`, `lib/storeyRemoval`) — «n Markierungen … gelöscht oder
    gekürzt» — and a storey showing only Karte objects goes without asking; the toast still undoes
    it. And the seam honours it per object: a lent anno
    handed back exactly as shown folds to the SAME record (`applyBoardToObjects`), never through
    the bake — which lost a note's text and laid a store step for nothing.
  - ⚠️ **A machine writer is idempotent — writing an unchanged value is a render loop**
    (24.09.2026, post-mortem of the Übung on 23.09.2026). A pass that runs on a feed or an effect
    returns the document it was given (`cur` itself) when nothing changed BY VALUE; a copy with an
    equal-but-new field is a store write, i.e. a render, i.e. another run. The live-GPS pass
    (`lib/useGpsFollow`) rebuilt every guarded/continuous coupling on every run and put every
    device with the vehicle feed into React #185, which then tore the Karte down under a tapped
    Trupp. Two rules keep it closed: `useObjectStore`'s writers keep ONE identity for the life of
    the store (they forward to the latest render through a ref), so they may sit in effect deps;
    and a machine writer runs only where the device may write the tactical document
    (`canEditIncident` — never a viewer, the `el` role, a link or a replay). A layout effect that
    measures after every render sets state only when the measurement changed, compared against a
    ref (`TwinTeamPill · useBarPlacement`) — even a no-op updater is an update React must render.
    `useGpsFollow.load.test.tsx` pins the budget: one write per poll that changed something.
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
    A sheet is never shown its own objects back through the projection, nor a sibling sheet's
    — with ONE exception: the Gebäude stack's ink shows on every other linked sheet, its storey as
    a badge (14.09.2026, `planProjection · projectOntoSheet`), because the building is where a
    Brand is marked and the Übersicht is where it is read. The stack itself never shows another
    sheet's ink, and plan A's work never clutters plan B. What IS lent is only what is not a record
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
    ⚠️ **A reference ARRIVING is a seed, never a correction** (23.09.2026, two phantom rows in
    prod after a remount): the cause is decided PER SHEET KEY (`georefTwins · fitChange`). A key
    this session has never baked a fit for — plans listed late, a `georefKey` resolving to the
    binding's — bakes silently, no row, no step. Only a known key whose `fitSignature` changed is
    a change (its own pairs say `reference` or `measurement`); a key re-linked after «Referenz
    entfernt» is compared with the fit it was left on. `n` counts only GROUND relocations on those
    sheets (`movedOnSheets`) — never objects whose bake differs for another reason (a turn, a
    size, another sheet) — and `rebake` takes the undo step only when that count is > 0.
    A sheet with no fit linked BY HAND gets its ONE row from the act, never the re-bake
    (24.09.2026): the three commit points in `georefMode` (second pair placed, «Übernehmen»,
    «Passung übertragen») call `noteHandLink`, and `georefTwins · handLinkRow` writes «Plan mit
    Karte verknüpft – {plan}[ – n Objekte verortet]» unless the reader already knows that key (a
    re-link after «Referenz entfernt» keeps the re-bake's «Referenz angepasst»); `tacticalLocked`
    devices write nothing.
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
  deps are the **optional `georef` dependency group** (`uv sync --extra georef`) — installed in
  the production image since 11.09.2026 (`Dockerfile`, both `uv sync` lines; without the extra
  the endpoint answers 503 and the app degrades to the point flow, fail-closed). ⚠️ A server that cannot do it **never offers it**: `/api/config` states
  the capability (`integrations.autoAlignConfigured` — extra importable *and* an Overpass mirror
  configured, `app/providers.py`) and the chip then arms the point flow directly instead of
  answering every press with «…ist auf diesem Server nicht eingerichtet» (field report
  09.09.2026). The honesty rules are load-bearing: an accepted fit is stored as exactly
  **two pairs `kind: 'auto'`** (more would fabricate zero-residual evidence); while any auto
  pair is in the fit no surface ever claims a ⌀ — but **whether it is called «ungemessen»
  depends on the APPROVAL** (18.09.2026): an unapproved proposal reads «Automatisch ausgerichtet ·
  ungemessen» in the amber tone, while a fit the admin greenlit on Objektpläne is a plain
  **«verknüpft»** everywhere — chip tone, lamp («Von der Station freigegeben», green), Passung,
  Ebenen row — with the residual simply OMITTED rather than replaced by a word that calls a
  reviewed reference doubtful. The signal is the binding, never a heuristic on the pairs:
  `incidentPlanBindings · incidentBindingApproved` (`source === 'approved'` and no operator
  `override`), threaded into `georefChip` / `georefLamp` / `GeorefQuality` / `georefPlans`; one
  operator-set pair of their own is a correction in progress and brings the proposal wording
  back. Auto anchors are ghosted, badged «A», excluded from every count, and the
  SECOND operator-set pair drops them (`georefMode · settleSlots`); score ≤ 6 = confident,
  under the template ceiling (12 · m1 16) = amber «Deckung nachprüfen», above = «kein
  Vorschlag» — and an **m1 result is never confident**. The proposal review lives on «Deckung
  prüfen» (nothing persists before «Übernehmen», which is confirm-with-undo).
- **Plan alignments are pre-computed server-side and published only by explicit approval**
  (11.09.2026). Every distinct byte version of a Modul-PDF is pinned as an immutable
  `plan_revisions` row (`plans.py · store_plan` — identical bytes are a metadata refresh, old
  blobs are never deleted) and queues one durable `plan_alignments` job the scheduler worker
  prepares (`plan_alignment_worker`, claim/lease/CAS; the CV match from the same `georef`
  extra). An admin reviews and approves on the Objektpläne page (`admin/PlanAlignmentReview`,
  `/api/admin/plan-alignments`); nothing is published by computing, fetching or selecting.
  Approved fits surface at `GET /api/reference/{id}/alignments?v=N`, and an incident FREEZES
  what it opened as an `IncidentPlanBinding` in the workspace blob (`lib/incidentPlanBindings`:
  exact dataset revision + fit; first binding wins, corrections are an `override`, an override
  with empty pairs is a deliberate disconnect — a later replacement or approval never moves a
  running Einsatz's backdrop). ⚠️ The one thing a frozen binding may still GAIN is its `floors`,
  once and only from the SAME dataset revision (`fillBindingFloors`, also inside
  `mergeIncidentPlanBindings`; `useObjectPlans` asks once per session): absent floors are an
  answer not given yet — bound before the pack was published, or by a device with an older
  cached answer — and a stack whose `pack.bindingId` names a floor-less binding reads «Kein
  Geschossplan» on every storey (prod, 20.09.2026). Floors that exist are never replaced. Bound sheets carry `incident:` georef keys, routed by
  `stationPlanScale · georefForPlan`; legacy fits under existing ink are preserved, never
  silently replaced.
- **A plan PDF is downloaded ONCE per revision, and its pages are rendered once per width**
  (18.09.2026). pdf.js is never handed a URL: `lib/pdfBytes` does one plain `GET` and
  `PdfViewport · docEntry` opens the document from `data` (a COPY — pdf.js transfers, i.e.
  detaches, the buffer it is given). The reason is cacheability, not tidiness: pdf.js fetches in
  RANGE requests, and a `206` is cacheable by nothing — not the HTTP cache, not Workbox (`200`
  only) — so every cold open re-downloaded tens of megabytes and offline the sheet was simply
  gone. `?v=N` is immutable by construction, so the backend says so
  (`api/reference · _download_headers`), the fetch may read it straight out of the cache, and a
  dedicated Workbox `reference-plans` CacheFirst route keeps it (purged with the others on an
  explicit denial, `public/sw-media-cache.js`). The unpinned address is always revalidated, so a
  replaced PDF still refreshes. The reader's rasterised pages survive its unmount in a
  byte-bounded LRU (`lib/pdfPageCache`, keyed document + page + CSS width, evicted bitmaps
  CLOSED) — the Plan surface is unmounted on every tab switch, and re-rasterising a multi-page
  A4 is the seconds of white column that read as «it is loading again». `evictPlan` («Erneut
  laden») drops bytes, pages and bitmaps together.
- **A plan sheet is drawn from a server-side TILE PYRAMID; pdf.js is the fallback** (21.09.2026).
  pdf.js walks a page's whole display list on every render, whatever the canvas size: the
  Gymnasium's A1 Modul 6 (357 000 paths) cost 4.5 s a pass on a desktop and 10 s+ on a tablet, and
  its 0.29 mm room stamps need ~600 dpi — a raster no tablet can hold, so the pixel budget
  (`lib/pdfRenderBudget`) capped it to mush. `app/plan_tiles.py` renders every current plan
  revision ONCE with PDFium into lossless-WebP tiles (512 px, top level 600 dpi, ~10 MB for that
  A1): a scheduler tick fills pyramids a few seconds at a time (`fill_once`; the page is loaded
  once per BATCH because loading parses it, each block is encoded before the next is drawn, and
  `malloc_trim` hands PDFium's ~200 MB back), and a cold tile is rendered on demand with its
  block. The fill walks documents of up to 12 pages on its own and EVERY `modul6` (a floor pack is
  one Geschoss per page, however many); a long PV/RWA document renders on demand only. Tiles are DERIVED: own storage root `plan-tiles/`, skipped by `app.backup`, regenerable.
  `GET /api/reference/{id}/tiles?v=N` is the manifest (revalidated — `complete` is live),
  `…/tiles/{v}/{page}/{z}/{x}/{y}` a tile (the revision is in the PATH → immutable), both under
  the same session/link narrowing as the PDF itself (`auth/incident_link`). Client:
  `lib/planTiles` is the pure half (level by the √2 rule, visible tiles, the stitched multi-page
  layout — ⚠️ which must never drift from `PdfViewport · render`, ink is stored in it);
  `PlanTileLayer` (board) and `FloorPage · TiledFloorPage` (Gebäude storeys) mount an always-there
  small UNDERLAY plus the on-screen tiles of the level the zoom asks for, so a device holds about
  two screenfuls of pixels for any sheet at any depth. Tile overlap against seams is half a
  PIXEL, never a constant of the unit square. `lib/planTileRaster · composeTiles` gives the
  Karte backdrop, the auto-align upload and the ink scan their pixels without a bake, and a
  tiled sheet is never pre-baked. `lib/planTilePrefetch` fetches an object's complete pyramids
  through the service worker (`plan-tiles` CacheFirst, `plan-tile-manifests` NetworkFirst — both
  listed BEFORE the reference routes and purged on denial) so a sheet is whole offline. No
  pyramid (unpinned/bundled PDF, >80 pages, PDFium cannot read it, a tile that cannot be had
  offline) ⇒ every caller keeps the pdf.js path unchanged.
  ⚠️ **The zoom ceiling of a tiled sheet follows the PAPER** (`planTiles · paperMaxScale`, 28 CSS
  px per paper mm ≈ 5× life size; `MAX_SCALE` / `MAX_SCALE_STACK` are its floor): a multiple of
  «eingepasst» gave an A1 a sixth of the magnification it gave an A4. It ARRIVES after mount, so
  `useBoardView` clamps through a ref — its wheel listener is bound once.
- **The precache is the field app; `/admin` is online-only** (2026-09-23). Every device used to
  install the AdminApp chunk (~250 KB JS + ~90 KB CSS) and its lazy map/alignment chunks with
  every deploy. `vite.config · adminOutsidePrecache` takes out what is reachable from
  `src/admin/AdminApp.tsx` but not from the field entry (computed from the chunk graph, so a
  chunk both import stays), and `navigateFallbackDenylist` sends an `/admin` navigation to the
  network – a precached old shell would import an AdminApp hash the server no longer has.
  Offline, `/admin` does not open. Both fail the build loudly if the shape they rely on changes.
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
  Three rules the primitives own, so no surface re-answers them (18.09.2026):
  - **One gesture closes one thing.** A dropdown open INSIDE a dialog closes first and alone — the
    first Esc / the first outside tap is the menu's, the second is the sheet's. Every transient
    surface registers while it is open (`overlays/popoverGuard` · `usePopoverGuard`; `Menu`,
    `Popover` and `ComboMenu` already do), and `Sheet`/`Overlay` veto an `outside-press`/
    `escape-key` dismissal while the register is warm. Add a hand-rolled popover ⇒ register it.
  - **A phone bottom sheet is closed by pushing it down.** `overlays/swipeDismiss`, spread on the
    popup by `Sheet` and `Overlay` (`swipeToClose`, on by default) — never a per-surface copy. It
    measures that the popup IS a bottom sheet, leaves a scrolled body its own gesture, never starts
    on a control. ONE grab bar (`overlays/SheetGrab` → `.ui-sheet-grab`, the same 40×5px pill as the
    `.ctx` editors' `.sheet-grip`): `Sheet` draws it by default, a bespoke `Overlay` frame that IS
    a bottom sheet on a phone opts in with `grab` (composer, Verlauf, PlanPicker, audio player, …
    — never a frame that is full-screen or centred there, like the Trupp form on a tablet or the
    handed-over Tafel; on the full app's PHONE board it IS a bottom sheet since 24.09.2026 and
    wears the bar, see the Atemschutz bullet), and the one
    hand-rolled sheet (`Palette`) borrows `SheetGrab` + `useSwipeDismiss` (20.09.2026). The one
    NON-modal bottom sheet is `DetentSheet` (peek · half · full over a live surface, 24.09.2026,
    the Suche): no backdrop, no focus trap, never closed by a swipe — its owner's ✕ closes it. The
    gesture needs the frame FLUSH with the bottom edge — which is why the phone Verlauf is a real
    bottom sheet now and no longer a card floating 8px off it.
  - **One menu row, one wash.** Every row `Menu`/`ContextMenu` renders wears `ui-menu-item`
    (+ `ui-menu-danger`), which carries the hover (`--blue` at 8 %, gated on `hover: hover`), the
    keyboard `[data-highlighted]`, the `--press` wash and the `--r-ctl` row radius
    (13-incident.css · «ONE menu row»). A caller's `itemClassName` skin owns padding, type and
    icons — never what a press looks like. Hand-rolled option lists (`.combo-opt`, `.pickOpt`,
    `.pp-row`, `.tb-uhr-row`, `.ip-ac-row`, `.lrow`) match those values.
- **Coordinates are WGS84 `[lng, lat]` wherever the map renders.** LV95 only at the edges via
  `src/lib/geo.ts` (`wgs84ToLV95` / `lv95ToWgs84` / `fmtLV95`), the `centerLv95` config option,
  and the geocoder bbox. Reference-layer GeoJSON (hydrants, …) must be WGS84.
- **Role gating** – product model is three incident roles: `editor` (FU / can mutate incident
  state), `el` (Einsatzleiter function, 07.09.2026 – reads everything, writes ONLY the record
  domains: Anwesenheit/Zeitplan, Mittel, Checklisten, Rapport + Beilagen, via the
  server-enforced `PUT …/workspace/record` slice (`RECORD_WORKSPACE_KEYS`), journal/event
  appends limited to the record vocabulary (`EL_EVENT_PREFIXES`), media uploads, and — since
  10.09.2026 — the EINSATZDATEN at the head of that record: `PATCH /incidents/{id}` limited to
  the fields «Einsatzdaten bearbeiten» sends (`EL_META_FIELDS`); the full workspace PUT, the
  trupps slice, the incident lifecycle (`status`, `is_archived`, `report_done_at`) and
  everything tactical stay 403 for it), and `viewer`
  (read-only). Frontend: `isEl` behaves like an editor's Führungsansicht (`tacticalLocked`
  on, `readOnly` off) with `canEditRecord` unlocking the four surfaces, `canEditMeta` the
  Einsatzdaten panel, and the sync pushing `slice: 'record'`. The legacy `commander` value has been migrated away: the stored role,
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
  liveness rules live in `backend/app/auth/incident_link.py`. ⚠️ Every link kind may also
  `POST /api/diag/client-error` (24.09.2026), even with a dead session (liveness-exempt). The
  route needs no session and is throttled per source in its own handler. Without it, a crash on
  a responder's phone got a 403 and never reached the log. Its read half, `GET /api/diag/export`,
  stays off every list. A refusal logs its reason server-side (`kpfront.linkscope`) and never
  sends it to the holder. Never widen the full workspace PUT
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
  address, `<img>`, service worker) answer as the link guest otherwise. That «Abmelden» **always
  confirms** (23.09.2026, `lib/logoutConfirm`), in one card that adds the offline and the
  unsent-entries cost when there is one.
- **Per-station config has four layers:** national defaults (code) → per-station deployment
  config (DB/admin) → secrets (env) → per-incident (workspace). One deployment = one station
  (**single-tenant**, no multi-tenancy). See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
  Edit a station's config as code: `cd backend && uv run python -m app.admin_config
  <schema|example|validate|diff|load>`; it's served at `GET /api/config` and applied at boot to
  override `appConfig` defaults.
- **The Lage-Grundgerüst is station doctrine that PLACES, never configures** (24.09.2026,
  post-mortem 23.09.: 65 minutes, no Zufahrt/Absperrung/Wasserbezug on the Karte). A card on the
  Karte lists what the incident's Einsatzart needs (`lib/lageGrundgeruest`,
  `components/LageGrundgeruestCard`); each row is a symbol or a line preset, ticked when one exists
  on the Karte OR any plan, and its only acts are the ordinary ones — arm the place tool, or «hier
  setzen» through the same `placeSymbolAt` a Karte tap uses (one undo step, the usual Verlauf row).
  «auf die Karte übernehmen» for a plan-ANCHORED match is the anchor flip a drag makes
  (`useObjectStore · reanchorToKarte`) — the same record, never a twin. Suggestions come only from
  the incident's OWN location (never the station default centre) and the fresher incident copy.
  Nothing is written until the operator places something; it is never a block. The lists are the
  deployment config `lageGrundgeruest` (a shipped preset from `backend/app/data/lage_grundgeruest/`
  + per-Einsatzart replacements, `/admin › Lage-Grundgerüst`, `admin_config presets|example
  --section`), and the presets are served beside the document (`lageGrundgeruestPresets`,
  response-only). A slot's `symbol` must be in the pack and its `linie` in
  `backend/app/lage_grundgeruest · LINE_PRESETS` — a Vitest pins that list and the category labels
  to their frontend twins. Add a line preset a slot should name ⇒ add its label there too.
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
- **What the Rapport's figure pages carry (18.09.2026).** The **Kroki is the picture**; everything
  else is opt-in or earns its page. Four rules, each from a printed review:
  - **Objektpläne are OFF by default** (`report · defaultReportOptions.annotatedPlans`). A linked
    sheet counts as «annotated» the moment the Karte's objects project onto it, so «on when there
    are any» stapled every linked plan to every rapport. They are reference material the station already owns.
  - **The Gebäude is its own section** (`options.gebaeude`, on), not one of the «Pläne»: it
    carries the Einsatz's own work. Only storeys with content print
    (`reportPdfDirect · usedStackFloors`); an untouched stack prints no page.
  - **A legend line says what the thing IS** – «Art · Bezeichnung · Status»
    (`symbols · symbolLegendText`), for every symbol. ⚠️ Not `symbolCaptionText`: the screen's
    value-only caption is an answer without its question once lifted into a legend. A symbol's own
    `caption: 'off'` is a screen declutter and is not read; only «Beschriftungen aus» silences it.
  - **One figure-page template** (`report_pdf · figure_pages`): heading, then the muted «Einsatz ·
    Stand …» line, picture, legend – for the Kroki, a plan sheet and a Gebäude page alike. A new
    kind of figure page joins that list; it does not get a layout block of its own. Orientation is
    per kind ON PURPOSE: the Kroki is a free crop (the operator's choice), a plan sheet has the
    shape its author gave it (the bitmap decides).
  - **An attached Leitung end is coupled by the SERVER** (`kroki · _snap_attached_ends`, fed by
    `startAt` / `endAt` + the entity `id`; a branch off a Teilstück by `startAtLine` / `endAtLine`
    onto the fork's prong tip – `_snap_line_joints`, one geometry with the glyph: `_fork_dims`). The client has no projection and ends the line on a
    fixed ground footprint; the glyph is sized in pixels, so only the sheet's own view can land the
    end on it. ⚠️ And the fallback fit mirrors the PANEL: the ceiling is
    `report · krokiFitMaxZoom` (20; 21 for a COMPACT Lage under 30 m – one level past the basemap's
    last sharp one, so a single-building cluster is not 15 % of the sheet). That is a MapLibre
    camera zoom, one level tighter than the 256-px projection: `report_pdf · _kroki_fit_max_z` = +1.
    On paper the count badge is a WHITE chip like the storey badge – the numbered legend discs are
    the only dark marks on the sheet.
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
- **A storey is a «Geschoss», the Plan surface an «Arbeitsfläche» – never «Stockwerk» or
  «Whiteboard» in user-facing copy** (2026-09-23: the controls, the Plan stack, the admin and
  OG/UG already said Geschoss while the help and the Verlauf rows said Stockwerk). Already-written
  Verlauf rows keep their wording (append-only); code identifiers (`floor`, `floorTag`,
  `whiteboard.*`, `Whiteboard.tsx`) keep their names.
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
- **A search field's placeholder is «<Thing> suchen …», or bare «Suchen …» where the surface
  already names the thing** (swept 18.09.2026: «Suchen», «Name suchen», «Suchen oder Name
  eingeben …» and three-dot `...` all existed side by side). Always the ellipsis character with a
  space before it, in every locale. A string that serves only as `aria-label`/button text is
  the plain infinitive («Im Verlauf suchen»); a key used for BOTH keeps the placeholder form.
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
  ⚠️ **FKS spread arrows (`spread`) are a drawn convention, never a bearing** (decided 30.08.2026,
  `27f0d92f`; re-confirmed 24.09.2026): ↑/↓ mean upper/lower storeys, ←/→ mean «sideways». They
  are drawn screen-upright outside the glyph's rotated layer on the Karte, on every plan sheet —
  a turned one included — and on paper (`kroki · _spread_dirs`). Turning them through a fit or
  the map bearing was built once (28.08., `spreadRotation`) and made the Feuer's Ausbreitung
  point the wrong way on a turned sheet; do not re-add it.
- **Buttons follow one spec – don't invent a per-surface variant.** Decided 2026-07-28 after a
  sweep found 12 label type combos, 6 disabled opacities and 8 stray radii for one role.
  - *The ✕ that closes a sheet is 36px with an 18px glyph, everywhere* (`.ip-x`, `.journal-x`,
    `.ctx-x` — one rule in 13-incident.css; it was 28/30/32). Beside a 44px search field it is
    44px instead (Palette, Verlauf search), and it is the ordinary grey, never a filled «on».
  - *Radius:* **every** button is `var(--r-sm)`, whatever its size, border or icon-only-ness —
    **except one that sits in a bar's padding** (22.09.2026): its corner is the bar's radius minus
    the padding, so the two curves run concentric (`--r-nested`, stated beside the padding of
    `.topbar` and `.rail` and their phone rules; read by the identity pill, `.tb-act`, the
    Einsatzuhr, the rails' tiles; falls back to `--r-sm` outside a bar). A 10px card inside a
    22px bar read as «way more angled than the container around it». `.toputil` already was
    this arithmetic (16 − 6 = 10). The dark docks' ✕ (Ebenen, Ansichten) are the house 36/18 too.
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
  - *The Karte turns like Google Maps, and in no other way* (24.09.2026, `lib/mapTwist`): two
    fingers pan and pinch freely, but the map only TURNS after a deliberate twist past
    `TWIST_ENGAGE_DEG` (12°) from where the fingers came down — and, fingers close together
    (gloves), past `TWIST_ENGAGE_ARC_PX` of travel along their circle. Once engaged the bearing
    follows the fingers exactly (zoom alongside) until a finger lifts, without jumping by the
    threshold. No snap-back: the old 6° `snapNorth` self-heal is gone, because nothing leaks into
    the bearing any more and a deliberate turn stays; the compass's «Nach Norden» is the way
    back. The gate replaces MapLibre's own rotate handler's `_start`/`_move`/`reset` and is
    FAIL-CLOSED — internals not where MapLibre 4.7 keeps them ⇒ touch rotation off, never
    un-gated (the test pins the shape). ⚠️ MapLibre's own 25 px-of-arc threshold is ~5° with
    the fingers a hand apart, which every two-finger pan crosses: that is what turned the basemap
    and plan overlay «when just scrolling» on an iPad (23.09.2026). Pitch stays off
    (`maxPitch={0}`), mouse right-drag rotation is MapLibre's own. The Plan boards never rotate
    under a gesture at all (`useBoardView` holds scale + pan only); a Gebäude turns only through
    its orientation slider (`components/OrientSlider`), which commits on the input's NATIVE
    `change` — the browser's own release, once per drag or keyboard step — never on `pointerup`;
    a gesture that is CANCELLED (iOS: the touch became a scroll) or left live when the popover
    closes drops its preview, unless a `change` still follows (then the browser did finish it).
- **The phone's two bottom bars hold what 360px holds without scrolling** (18.09.2026) — five wide tiles at most, never a scrolling lane whose only cue is a fade.
  - *Tool bar:* `Auswahl · + Hinzufügen · Messen · Ansichten · Ebenen` (Plan: `… · Einpassen`) —
    five even tiles and NO hairline between the tools and the pinned controls. **«+» is the
    one door to everything that is PUT ON the surface**: Linie · Fläche · Absperrkreis · Notiz ·
    Trupp are the first section of its sheet (`components/Palette` · `tools`, `lib/toolFold`),
    above the symbols and Formen, and search finds them by their word. «+» ALWAYS opens the sheet
    — it never re-arms a remembered tool — and while a tool out of the sheet is armed the tile is
    lit and wears that tool's glyph and word. Auswahl stays: it is the state, the one-tap way out,
    and the door to Mehrfach (a two-member pair flips on the second tap; anything larger gets a
    list, never a cycle). Add a tool that places something ⇒ add its id to `ADD_TOOLS`, in BOTH
    spellings if the Karte and the Plan name it differently.
  - *The compass lives in the BAR, beside Ebenen* (05.08.2026). It floated top-right on the map
    for one day (18.09.) and came back: up there its menu opened half a screen from the thumb that
    asked for it. «Mein Standort» is a row of that menu, not a tile of its own (also tried 18.09.).
  - *«Einpassen» on a Plan is the bar's tile*; the top bar's twin (`TopBar · mapNav`) survives only
    where there is no bar at all (viewer-only Modul, Gebäude pick surface, replay — 20.09.2026).
  - *The FAB follows the THEME, not `--btn-primary`*: white surface by day, the raised `--ink-fill`
    pill at night. That token inverts at night so a form's one action has an edge against its
    sheet; the FAB sits on no sheet, and inverted it was the one pale disc in a dark cab. Its
    hold OPENS a chooser (Sprachnotiz · Foto) that STAYS until one is tapped; the button is its ✕
    and a press elsewhere closes it (`useHoldEntry`, 21.09.2026). It was slide-and-release, which
    «Foto» cannot be on an iPhone: WebKit opens a file picker only for a real TAP, refuses a slid
    touch silently, and `navigator.userActivation.isActive` reads true while it does — two rounds
    of detecting the refusal ended in one chooser with two grammars. Do not bring the slide back.
    A tap on the FAB
    commits the composer with `flushSync` INSIDE the click and the textarea focuses itself as it
    attaches (`JournalComposer · attachText`): React otherwise commits a microtask later, and iOS
    gives a focus made outside the tap a caret and no keys.
  - *ONE page-title size*: `--head-title` is 17px on a phone, set as the TOKEN in `15-mobile.css`
    — never a per-surface `font-size` on the `<h2>`, which is how «Einsatzrapport» came to stand
    19px beside «Anwesenheit» at 17. The Rapport's head carries the title and what is still open;
    the «n Personen · m Positionen» line under it is gone (19.09.2026).
  - *A monogram chip keeps its HEIGHT; the text steps down and the box hugs what is left*
    (`data-mono-len` on the chip; the rail's tiles and the `GroupChooser` rows each restate the
    steps) — the same chip on a phone as on a wide screen. A fixed square was tried and cannot
    work: «RWA» in Sora 800 is 25.5px at 10px, against a 27px inner box (19.09.2026). The
    chooser's glyph column is 44px, the widest chip, so every row's name starts on one line —
    and the EXPANDED rail's column does the same (22.09.2026): the rail stamps its longest
    monogram on itself (`data-mono-max`) and the column is 26 · 28 · 38px for a digit · «PV» ·
    «RWA», one width for every row, so no label steps out of line and no chip is clipped.
  - *The Verlauf's head stays while searching* (22.09.2026): the field sits UNDER title · ⓘ ·
    lens · Replay · ✕, in the row the timeline strip vacates, with its own ✕; the lens is lit and
    closes it. The field used to REPLACE the head, and the drawer then no longer said what it was.
    The funnel beside the lens (23.09.2026, `lib/journalFilter`) filters by the row's ONE Bereich —
    `journalArea`/`journalDisc`'s own words, no taxonomy of its own — as a checkbox `Menu`
    («Art des Eintrags» · «Bereich», with counts); ticks OR, and AND with the search. Lit + dot
    while on, one «Gefiltert: … · Alle zeigen» line under the head, the timeline strip hidden as
    during a search. Per-opening like the search, never stored; it narrows the list only — the
    Wiedergabe always plays the whole picture. The pinned Pendenzen block is part of the list it
    narrows (24.09.2026, `journalFilter · showsPinnedPendenzen`): hidden while a filter is on
    that leaves «Pendenz» unticked, back once «Pendenz» is ticked or the filter is cleared.
  - *The rail's key badges (K · C · A …) show only while ⌘ / Ctrl / Alt is held* (22.09.2026,
    `lib/useModifierHeld` → `data-keys` on the rail): standing on every icon they read as status
    marks in the corner the alarm dot uses, and they are wanted at exactly the moment the
    modifier marks.
  - *A head's icon buttons carry their word on a wide screen* (22.09.2026, `.wordBtn` in
    `Atemschutz.module.css` and `SurfaceControls.module.css`, switched by `useIsPhone`):
    «Reihenfolge · Überwachung abgeben · Alarmton», «In Verwendung · Filtern · Anderes Material».
    The phone keeps the bare square — its row has no room, and the hold-tooltip is its way of
    asking. The bell's word is its honest STATE (Alarmton / Stumm / Ton freigeben).
  - *A checklist item that writes to the Verlauf says so on its row* («⚑ wird im Verlauf
    notiert», `checklists.milestoneTag`, 22.09.2026) — the lone flag's meaning lived in a tooltip
    no tablet shows.
  - *Nav bar:* «Pläne» and «Einsatz» each stand for a group: a tap goes to the last-used member,
    a second tap or a hold opens the ONE list (`components/GroupChooser`), and «Plan wählen» opens
    unasked the first time the tile is used in an Einsatz, once per device (`lib/chooserOffer`).
    Both wear the corner mark (`.nav-grp`; `.vrail-grp` on the two-state Auswahl).
  - Everything stacked above the nav bar keeps ONE 6px channel (`--rail-h + 14px`: the tool bar,
    `.rp-tabs`, the page card in `Surface.module.css`).
  - Tried and thrown out the same day, so nobody rebuilds them: a «Zeichnen» tile with a flyout, the
    same tile opening the GroupChooser behind a last-used first tap, and a «Karte» tile folding
    Ansichten + Ebenen. The vertical rails (tablet/desktop) are unchanged throughout.
- **The Atemschutz phone board of the full app** (`AtemschutzView · phoneMode` = phone and not the
  handed-over Tafel; PR #212 and its follow-up, 24./25.09.2026, Übung 23.09.): sections Drin ·
  Sicherungstrupp · Bereit · Draussen, «Drin» by urgency with the 2 s freeze, «Druck | Kontakt»
  with words, one `PressureSheet`. The tablet grid and the Tafel are NOT this board, except where
  a rule below says «every board». The rules:
  - *The Trupp form is a bottom sheet there, with the due clocks above it* (D1 ⑥): at most two
    due/overdue Trupps, most urgent first, each with a live «Kontakt» that confirms without
    leaving the form. The pinned set holds 2 s after a tap and the row just confirmed reads
    «✓ Bestätigt», disabled — it stays under the finger. The rows sit INSIDE the popup (under the
    scrim they would be outside presses). Grab bar + swipe-to-close, which is «not now».
  - *A kept draft belongs to ONE state of the Trupp* (`draftKeep`, every width): only «Abbrechen»
    and a save the board CONFIRMED drop it (a «Zurück» on any question in front of the save
    returns to a filled form), but an edit / re-entry draft is keyed on the Trupp as the form
    opened it (sortie + every field the form writes, `truppDraftStamp`) — a new sortie, or a
    Leitung linked on the Karte meanwhile, opens a fresh form. «Gleiche / Neue Flasche» is never
    kept. A door that answers a field (`presetAuftrag`: «Bestimmen» → «Sichern») beats a draft.
  - *An edit is a PATCH* (every width, 25.09.2026): only the field groups the form touched
    (`truppFieldGroupsChanged` against the form's own untouched values) are written, onto the
    Trupp as it stands NOW (`truppEditPatch`); a touched group another device changed since the
    form opened is said in one line first, «Zurück zum Formular» focused. A Gast typed into the
    form reaches the Anwesenheit only at the save (`fileGuests`, after every question) — never
    from the picker, and Enter in «Person suchen» only takes a listed person.
  - *Every Kontakt tap is ONE Kontakt*: a repeat on the same Trupp from this device within 3 s
    writes nothing (`contactEcho · recentOwnContact`, in `recordContact`, so every board). The
    first Druck within 3 min of the Eintritt replaces an Eingangsdruck NOBODY SET (the log's
    run-start row carries `measured` when the form's value was dialled, a bottle answered, a low
    value confirmed or a correction made — `entryPressureConfirmed`) and is still a Kontakt:
    clock reset, `contact` row, one Verlauf row that says both; the sheet says so in words.
  - *The Sicherungstrupp has ONE place* (D1 ⑦): between Drin and the rest while anybody is in or
    waiting — a quiet dashed slot while nobody is inside, amber from the first crew in, gone once
    every Trupp is out. «Bestimmen» = a waiting Trupp's Auftrag becomes «Sichern» (an ordinary
    edit) or a new one registered on «Sichern». Its first Eintritt writes «Sicherungstrupp
    eingesetzt». The Abschluss (every width) asks about every Atemschutz-Trupp still angemeldet
    that was never inside (a Reserve after earlier sorties was — read the log, `entryTime` is
    cleared on a re-park): «Zur Tafel» (focused) / «Als «nicht eingesetzt» schliessen». Not while
    a crew is still inside, and the stand-down runs only after the FINAL «Abschliessen», re-checked
    against the Trupps as they stand then — a crew sent in meanwhile never gets an Austritt.
    Crews still INSIDE are the Abschluss's own FIRST question, by name («2 Trupps sind noch drin:
    Trupp 1 (…), Trupp 2 (…).»), «Zur Tafel» focused, closing anyway the quiet answer — and after
    the Abschluss the app stays on the closed Einsatz (App · completeRapport), never opens another.
    A Sicherungstrupp wears «SiTr» on its row and card at every width, sent in or not.
  - *The record is kept whole* (staging walk-through r2, 25.09.2026): the Gäste the form files at
    its save are filed QUIETLY and named once in the crew's «Unter AS: …» row — the crew filing
    knows them (`IncidentWorkspace · fileTruppGuest`) instead of reading a render-old Anwesenheit
    and filing them again. A session that cannot write the record (the Atemschutz-Link) files and
    logs nothing; every device that can OBSERVES the Trupps and files a missing crew under derived
    ids (`lib/crewFiling`) — ONCE per (Trupp, person): the Trupp's `crewFiled` marker (grow-only,
    merged as a union, kept by every undo restore) records who was filed or already there, so a
    person somebody takes OFF the Anwesenheit is never written back by another device (the
    ghost-trail trap). «Entfernen» on a crew INSIDE asks first («Raus melden» focused), and
    every removal raises the confirm-with-undo toast. «Nicht eingesetzt» is a row of the ⋮, never
    the button beside «Im Einsatz», and its log row reads «Nicht eingesetzt», never «Austritt».
    The collapsed phone row carries the «#N» badge; the handed-over phone board opens on the most
    urgent crew inside; the Eintrag FAB is not drawn over the phone Trupps page (a floating button
    over a scrolling list of Kontakt buttons cannot be kept clear by an inset).
  - *A Kontakt another device confirmed < 60 s ago asks* (D1 ⑧a, `lib/contactEcho`) — on EVERY
    board, tablet grid and handed-over Tafel included: it guards the act, not a layout. A
    confirmation this JS realm did not write is «anderes Gerät» — no device names; a stamp more
    than 5 s in the future (a skewed device) is not an echo. «OK» is the filled, focused default;
    it and every dismissal write nothing. «Überwachung abgeben makes the giver read-only» (⑧b)
    was DECIDED AGAINST (25.09.2026) — do not build it.
  - *The Eingangsdruck is guarded, once* (item 2, every width): locked in «Bearbeiten» once the
    Trupp is raus (pointing at the exit's Restdruck); below `doctrine.entryPressureMin` (default
    270, `/admin › Doktrin`) the form asks ONE question with the value on the button and «Ändern»
    focused. No upper bound, no second plausibility rule.
  A question whose «yes» WRITES something a reflex must not (these three) puts the safe answer
  first: `ConfirmSpec · safeAnswer` ('cancel' | 'alt') fills and focuses it, not red.
- **Time-based alerts** (Atemschutz clock, reminders) go through the shared `src/lib/alarm.ts`
  layer, not ad-hoc timers. Delivery: foreground tone/wake-lock + service-worker notification,
  plus – once the deployment sets VAPID keys (`app.gen_vapid`) – server-side Web Push for
  killed apps: `backend/app/push.py` re-derives due-ness from the synced data (no mirror
  API) and also pushes «Neuer Einsatz» when a new Divera alarm lands in the pool. Fail-closed:
  no keys → `/api/push/vapid-key` serves `null` and no sweep runs.
- **The shared clock (`lib/serverClock`) learns only from answers that cannot have come out of a
  cache** (24.09.2026, Feueralarm root cause B). Every Verlauf `at`, every Atemschutz stamp and
  every contact clock counts in `serverNow()`, which is taught by `X-Server-Time` — and a
  service-worker-cached response carries the header of the day it was stored: a three-day-old
  alignments answer stamped «Atemschutz-Alarm beendet» on 20.09. for an act on 23.09. So:
  `api · rawFetch` samples only `isFreshSampleSource` paths (never `/api/reference/…` or
  `/api/media/…`, never a fetch allowed to read the HTTP cache), and the estimator moves the
  clock FORWARD on one answer but BACKWARD only when two answers ≥ 2 s apart agree (a correction
  ≤ 2 s pauses the clock instead of stepping it back; a device clock set back is followed via the
  monotonic clock, so `serverNow()` stays put). A new caching Workbox route under `/api/` ⇒ extend
  `SW_CACHED_API_PREFIXES` (the `serverClock.test` tripwire reads `vite.config.ts`). Live state
  under `/api/reference/` (the plan alignments) is `NetworkOnly` in the SW; its offline copy is
  IndexedDB.

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
- [`docs/AGENT-RUNBOOK.md`](docs/AGENT-RUNBOOK.md) – **start here when the task is operating a
  station rather than changing this code**: standing one up headless and keeping it running,
  as exact commands. It names the four things a terminal cannot do (DNS, the Azure app
  registration, the Divera portal, the Railway volume), the Day-0 sequence, and the `setup`
  block on `GET /api/system` that answers «is this station set up» without scraping `/admin`.
- `mockups/` – historical look-and-feel explorations (not maintained; only `app-lage.html` and
  `nav-concepts.html` are tracked, the rest stays local by `.gitignore`). The former
  `docs/design-concepts/` directory is gone – superseded by the React app itself.
