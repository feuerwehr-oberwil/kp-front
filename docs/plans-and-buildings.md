# Plans, the Gebäude stack and alignments

Rules for prepared floors, plan alignment and how plan sheets are fetched and drawn. The
module-level rules live in `lib/storeyClip`, `lib/footprintPick`, `components/PlanCompass`,
`app/plan_markers.py`, `app/reference_buildings.py`, `lib/pdfBytes` and `lib/planTiles`; the data
flow is in [`objektplaene-architecture.md`](objektplaene-architecture.md). Moved here from
AGENTS.md on 2026-10-08, wording unchanged.

## Prepared Gebäude floors

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
  - *A storey's acts live in its LABEL* (29.09.2026). The label shows the word only («4. OG»,
    «EG», a custom name); the signed chip comes back only when a custom name hides the order. A
    tap opens a Menu «Ausblenden · Geschoss entfernen» — Ausblenden is a way of looking
    (device-local, on read-only surfaces too, the folded strip is the way back), «Geschoss
    entfernen» is the danger row and stays the owner's confirm-with-undo (IncidentWorkspace ·
    onRemoveFloor). No eye and no bin on the canvas: delete is the rarest act on this surface.

## «Automatisch ausrichten» and approved alignments

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

## Plan PDFs and the tile pyramid

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
