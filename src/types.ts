export type LngLat = [number, number]

export type LayerId = string

export interface LayerDef {
  id: LayerId
  group: string
  label: string
  /** compact name for the Basiskarte tile row, where a full name has ~70px to live in
   *  («OpenStreetMap» → «OSM»). Falls back to `label`. */
  shortLabel?: string
  icon: string          // sprite id in the inline UI icon set
  locked?: boolean
  base?: boolean        // part of the radio base-layer group
  visible: boolean
  opacity?: number      // 0..100, only for overlay layers (plan)
  tiles?: string[]      // raster tile template(s) for base layers
  nightTiles?: string[] // optional dark-theme raster to swap to in night mode (e.g. Dark Matter)
  dark?: boolean        // base is already dark (skip the night dim)
  maxzoom?: number
  attribution?: string
  geojson?: string              // URL to a GeoJSON FeatureCollection (vector overlay)
  vectorKind?: 'line' | 'point' // how to render a geojson overlay (default 'line')
  color?: string                // stroke/fill colour for a geojson overlay
  nightColor?: string           // brighter stroke/fill for night mode (dark colours vanish on the dark base)
  symbol?: string               // FireGIS symbol name to use as the icon for a point overlay
  autoActivate?: string[]       // Einsatz categories (kategorien values) that auto-show this layer
}

/** `person` = a crew member's self-reported live position (Standort teilen). Always `live`,
 *  never placed by an operator and never persisted — see lib/usePersonPositions. */
export type EntityKind = 'symbol' | 'vehicle' | 'note' | 'photo' | 'shape' | 'team' | 'person'

/** editable generic shapes (not tactical symbols) — placed, then reshaped via
 *  colour / size / rotation. e.g. an arrow for direction, a cloud for smoke. */
export type ShapeKind = 'arrow' | 'cloud' | 'square'

/** The built-in steppers in the symbol editor that change how the glyph reads on
 *  the surface: `rotation` (orientation), `count` (quantity badge), `floor` (storey
 *  badge — map only) and `floorRange` (a von/bis storey span, e.g. stairs/lift —
 *  rendered as a combined `-1/+3` badge on BOTH surfaces). Each symbol declares,
 *  via its preset, which are meaningful for it; the editor shows only those
 *  (see symbolControls). */
export type SymbolControl = 'rotation' | 'rotation2' | 'count' | 'floor' | 'floorRange' | 'spread' | 'airflow'

/** FKS Entwicklung (spread) on a damage symbol — Feuer/Wasser/Gefahrstoffe.
 *  Rendered as arrows in the symbol's own colour (red/blue/orange): horizontal
 *  arrows left/right, and/or vertical up/down arrows (which pair with the symbol's
 *  Geschoss number). Each direction carries its own Entwicklungsgrenze bar at the
 *  arrow tip (→|). Absent / all-empty = no spread.
 *
 *  All four directions are INDEPENDENT, and so is every bar: a fire running both
 *  ways along a Fassade, stopped at a Brandmauer on one side only, is one symbol
 *  and not two. ⚠️ `left`/`right` used to be one exclusive `h: 'E' | 'W'` field
 *  with a single `hBounded`, and `up`/`down` shared one `vBounded` — incidents
 *  written before this still carry that shape, so nothing reads these fields raw.
 *  Everything goes through `normalizeSpread` (lib/spread.ts), and the Kroki
 *  renderer has the same normalisation in Python (`_spread_dirs` in kroki.py). */
export interface Spread {
  left?: boolean
  right?: boolean
  up?: boolean
  down?: boolean
  /** per-direction Entwicklungsgrenze — the bar at that arrow's tip */
  leftBounded?: boolean
  rightBounded?: boolean
  upBounded?: boolean
  downBounded?: boolean
}

/** The pre-2026-08 shape, still present in stored incidents. Read-only: nothing writes it. */
export interface LegacySpread {
  h?: 'E' | 'W'
  hBounded?: boolean
  up?: boolean
  down?: boolean
  vBounded?: boolean
}

/** Attributes shared by a placed tactical symbol on EITHER surface (Lage map
 *  `Entity` or Plan whiteboard `BoardAnno`). Both interfaces extend this, so a
 *  symbol carries — and is edited with — the SAME attribute set everywhere; a
 *  new attribute added here lights up on both surfaces. NOTE: `floor` is NOT
 *  here on purpose — it means different things per surface (a signed badge value
 *  on the map vs. a floor-stack tile index on the plan), so each keeps its own. */
export interface SymbolProps {
  /** name of the FireGIS symbol to render (key into the symbol library) */
  symbol?: string
  /** title (German operational name); shown in the symbol editor */
  label?: string
  /** type line under the title (e.g. the symbol category) — auto-set on placement */
  subtitle?: string
  /** structured key/value details shown + edited in the symbol editor. Seeded from
   *  a per-symbol template on placement; rows are freely added/edited/removed. */
  fields?: Record<string, string>
  /** free-text general notes (one multi-line field, separate from the key/value details) */
  notes?: string
  /** quantity this object represents — shown as a badge at the icon's bottom-right.
   *  Positive only; absent or 1 = no badge (the default). */
  count?: number
  /** rotation in degrees — applied to the glyph on both surfaces (and to shapes) */
  rotation?: number
  /** secondary rotation (deg) — only the composite Grosslüfter uses it: `rotation`
   *  aims the vehicle body, `rotation2` aims the overlaid fan / airflow direction. */
  rotation2?: number
  /** lower / upper storey of a vertical span (stairs, lift) — rendered together as
   *  a `-1/+3` badge on the glyph. Surface-agnostic (unlike the map-only `floor`),
   *  so it shows on the Plan where building elements actually live. */
  floorFrom?: number
  floorTo?: number
  /** FKS Entwicklung (spread) arrows — see Spread. Shown on Feuer/Wasser/Gefahrstoffe. */
  spread?: Spread
  /** airflow direction of a Lüfter: absent/false = Einblasen (arrow blows away from the fan,
   *  Überdruck), true = Absaugen (arrow reversed to point INTO the fan — the fan is positioned in
   *  the space but draws air out). Only meaningful for the mobile Lüfter (`controls: ['airflow']`);
   *  the renderer swaps in the reversed-arrow glyph. */
  extract?: boolean
  /** symbol/shape accent colour */
  color?: string
  /** on-canvas caption mode for this one symbol — overrides the global device default
   *  (`appConfig.symbols.captionDefault`). Absent = follow the global default. 'off' hides
   *  it, 'auto' shows the one discriminating value (e.g. a Kleinlöscher's Typ), 'all' shows
   *  every filled detail. Value-only — the glyph already conveys the key. See lib/symbols. */
  caption?: CaptionMode
  // --- free-text note styling (Lage `Entity` kind 'note' / Plan `BoardAnno` kind 'text') ---
  // A note grows from a one-line pill into a wrapping text box; these describe how it LOOKS,
  // while the box WIDTH lives per-surface (Entity.noteW in screen px, BoardAnno.wN as a
  // fraction of the plan width) because the two surfaces scale differently. Absent
  // everywhere = the original one-line pill, so stored incidents render unchanged.
  /** relative text size: 's' ×0.8, 'm' ×1 (absent = 'm'), 'l' ×1.45. */
  noteSize?: NoteSize
  /** the box width follows the typed text (see lib/notes · autoNoteWPx / autoNoteWN) instead of
   *  sitting at the surface default. Set on a freshly placed note and cleared the moment the
   *  width is dragged by hand — a width the operator chose is never recomputed. The width itself
   *  is always stored as a number, so the PDF/print renderers need to know nothing about this. */
  noteAutoW?: boolean
  /** drop the yellow Zettel background + border and render bare text (a heading on a blank
   *  sheet). The renderers add a `--note-halo` outline so bare text stays legible over an
   *  aerial / a dark plan — never a background-less plain colour. */
  notePlain?: boolean
}

/** Relative note text size. Absent = 'm'; see `NOTE_SIZE_SCALE` in lib/notes. */
export type NoteSize = 's' | 'm' | 'l'

/** How much of a symbol's metadata is printed under its glyph on the map / plan:
 *  'off' none, 'auto' the single discriminating value, 'all' every filled detail. */
export type CaptionMode = 'off' | 'auto' | 'all'

export interface Entity extends SymbolProps {
  id: string
  kind: EntityKind
  layer: LayerId
  coord: LngLat
  /** inline SVG markup to render instead of a library symbol — used for live
   *  vehicles, whose name + orientation are baked into the glyph */
  symbolSvg?: string
  /** storey where the represented event is happening — shown as a signed badge
   *  (e.g. +2, -1) at the icon's top-right in the symbol's own colour. 0 = EG,
   *  +1 = OG1, -1 = UG1. Absent = no floor badge. (Map-only meaning; see SymbolProps.) */
  floor?: number
  badge?: string        // short text shown in the context panel avatar
  photoUrl?: string     // for kind 'photo'
  /** kind 'note': box width in SCREEN px — map notes are pinned to a constant screen size
   *  (they don't scale with zoom, see symPx), so a ground-metre width would be wrong here.
   *  The Plan analogue is `BoardAnno.wN`. ABSENT = the legacy auto-width pill (capped by CSS
   *  at 180px, no wrapping); its presence is what makes a note a text box. */
  noteW?: number
  /** externally sourced (e.g. live GPS) — read-only: not draggable, editable or persisted */
  live?: boolean
  /** live vehicles only: the glyph shows a heading arrow (the vehicle has moved at some point).
   *  False for one that has never moved, whose body is drawn neutral. Carried on the entity so a
   *  renderer can REBUILD the glyph (e.g. to compensate the map bearing) without inventing a
   *  direction the vehicle never reported — see lib/useVehiclePositions · vehicleSymbolSvg. */
  directed?: boolean
  // --- kind 'shape' ---
  shape?: ShapeKind
  sizeM?: number        // shape size on the ground, in metres
  /** aerial-appliance boom reach in metres (Hubretter) — the ground distance from the truck
   *  (`coord`) to the rescue cage; the cage is the draggable tip and `rotation2` its bearing.
   *  Metre-scaled like `sizeM` so the cage stays over its ground spot as the map zooms. The Plan
   *  mirror is `BoardAnno.reachN`. Absent = the seeded default. */
  reachM?: number
  // --- kind 'team' (Atemschutz-Trupp tracked on the Lage map — the geo mirror of the
  // plan board's 'resource' chip; a Trupp is placed on exactly ONE surface at a time) ---
  /** linked Atemschutz Trupp (this marker represents that team) */
  truppId?: string
  /** recorded position breadcrumbs (markPosition) — part of the incident record */
  trail?: GeoTrailPoint[]
  /** HH:MM of the last move / position mark (mirrors BoardAnno.t) */
  t?: string
}

/** One breadcrumb of a team marker's movement trail on the Lage map (WGS84). */
export interface GeoTrailPoint { coord: LngLat; t: string }

/** One vehicle position as returned by kp-rueck's GET /api/traccar/positions
 *  (see backend/app/api/traccar.py · VehiclePositionResponse). */
export interface VehiclePosition {
  device_id: number
  device_name: string
  unique_id: string
  status: string          // 'online' | 'offline' | 'unknown'
  latitude: number
  longitude: number
  speed?: number | null   // km/h
  course?: number | null  // heading in degrees
  last_update: string     // ISO timestamp
  address?: string | null
}

/** Current weather near a coordinate (see GET /api/weather). Mirrors the backend
 *  WeatherData model; wind_dir_deg is the meteorological FROM bearing (0=N, 90=E). */
export interface WeatherData {
  wind_dir_deg: number | null
  wind_speed_kmh: number | null
  wind_gust_kmh: number | null
  temp_c: number | null
  precip_mm: number | null
  /** WMO present-weather code (0=clear, 2=partly, 3=overcast, 45=fog, 6x=rain, 7x=snow, 95=storm…). */
  weather_code: number | null
  observed_at: string | null
  source: string
  station: string | null
}

export type DrawKind = 'line' | 'area' | 'circle'
export type LineEndpoint = 'start' | 'end'
export type LineRoutingMode = 'direct' | 'trace'
export type GpsFollowState = 'guarded' | 'continuous' | 'paused'

/** Persisted relationship intent for one magnetic line endpoint. The coordinate stored in
 *  `coords`/`pts` remains its fail-safe fallback and is materialised before detaching. */
export interface LineAttachment {
  target: { kind: 'object'; id: string; live?: boolean } | { kind: 'line'; id: string; endpoint: LineEndpoint }
  routing: LineRoutingMode
  /** Assigned 0..2 when the target is the three-port end of an FKS Teilstück (-E). */
  port?: number
  gps?: {
    state: GpsFollowState
    /** Target position at the last operator confirmation (WGS84 on Lage). */
    confirmedAt: LngLat
    /** Last safely resolved endpoint; used while GPS following is paused/missing. */
    lastSafe: LngLat
  }
}
export interface Drawing {
  id: string
  kind: DrawKind
  coords: LngLat[]
  color?: string
  width?: number
  /** circle radius in metres (circle kind only — coords holds a single [center]).
   *  Backs the Gefahrenradius / Absperrkreis; rendered via circlePolygon(). */
  radiusM?: number
  /** fill opacity 0..1 for closed shapes (circle / area). Absent = the default fill. */
  fillOpacity?: number
  /** render the line dashed instead of solid (lines only). Absent = solid. */
  dashed?: boolean
  // --- annotated-polyline fields (lines only). A tool "preset" just seeds these on
  //     creation; every one stays editable in the DrawEditor afterwards. ---
  /** draw an arrowhead at the LAST coord, pointing along the final segment. */
  arrow?: boolean
  /** the Entwicklungsgrenze bar across the arrowhead — «bis hier, und dort gestoppt», the same
   *  statement the fire's bounded spread arrow makes (lines with `arrow` only). */
  arrowStop?: boolean
  /** a single letter (e.g. "R") repeated inline along the line (—R— look). */
  marker?: string
  /** show an auto geodesic-length label at the polyline midpoint. */
  showDistance?: boolean
  /** free-text label shown at the polyline midpoint. */
  label?: string
  /** screen-space px offset of the distance/text label from the polyline midpoint, so it
   *  can be nudged off overlapping drawings. Absent / 0 = pinned at the midpoint.
   *  DEPRECATED on the Lage map (drifted on zoom) — superseded by the georeferenced
   *  `labelAt`; still used by the Plan whiteboard, where it is a board-relative offset. */
  labelDx?: number
  labelDy?: number
  /** georeferenced anchor (WGS84 [lng,lat]) the distance/text label was dragged to, so it
   *  stays pinned to the ground at every zoom + map bearing. Absent = the polyline midpoint. */
  labelAt?: LngLat
  // --- FKS hose-line annotations (lines only) ---
  /** Teilstück coupling at the line end: a forward "E"-fork instead of an arrowhead. */
  teilstueck?: boolean
  /** FKS device/content letter at the line end: S=Schaumrohr, W=Wasserwerfer,
   *  H=Hydroschild, P=Pulverpistole. Wasser = plain line (unset). */
  content?: 'S' | 'W' | 'H' | 'P'
  /** Druckleitung number shown in a small box on the line (e.g. 1. Druckleitung). ALSO the
   *  identity of the Leitung for the Atemschutz link: the same number on the Lage and on a Plan
   *  is one hose drawn twice, and both carry the Trupp tag (see lib/truppLines). Unique per
   *  surface. */
  lineNo?: number
  /** Atemschutz link ANCHOR — the Trupp this line was explicitly picked for (mirrors
   *  `Trupp.lineId`, the way a team chip's `truppId` mirrors `Trupp.annoId`). Display resolves by
   *  anchor OR number, so neither an undo of the stamped number nor a merge that drops the anchor
   *  can blank the tag. Never read by the contact clock: the drawing decorates the Atemschutz
   *  record, it never feeds it. */
  truppId?: string
  /** storey the line works on, shown as a signed badge (+2 / 0 / -1) by the number box. */
  floorTag?: number
  /** screen-space px offset of the FKS end-tag from its default spot (just before the line end),
   *  so it can be dragged clear of other symbols. Absent / 0 = the default position.
   *  DEPRECATED on the Lage map — superseded by the georeferenced `endLabelAt`. */
  endDx?: number
  endDy?: number
  /** georeferenced anchor (WGS84 [lng,lat]) the FKS end-tag was dragged to. Absent = the
   *  default spot just before the line end. Keeps the tag pinned at every zoom + bearing. */
  endLabelAt?: LngLat
  /** locked: the shape ignores click-select / drag so it can't be moved by accident or
   *  swallow clicks meant for objects over it (e.g. a big Absperrkreis under other work).
   *  A lock chip at its centre unlocks it. Absent = editable. */
  locked?: boolean
  /** Magnetic relationship intent at the first/last vertex (lines only). */
  startAttachment?: LineAttachment
  endAttachment?: LineAttachment
}

/** Which surface an event originated on. Drives the Verlauf row's chip + the
 *  jump-back target (map fly-to vs. plan recenter). */
export type Surface = 'map' | 'plan'

/** A single line in the unified, append-only journal (Verlauf). Events are never
 *  edited or removed — undo/redo on either surface append their own rows — so the
 *  log is a faithful incident record that could later back a standalone screen. */
export interface TimelineEvent {
  id: string
  t: string             // HH:MM
  /** absolute timestamp for reports/exports. Older saved rows may only have `t`. */
  at?: string
  icon: string
  text: string
  kind?: 'audio' | 'symbol' | 'vehicle' | 'layer' | 'note' | 'photo' | 'snapshot' | 'journal' | 'team' | 'history' | 'reminder'
  /** Pendenz / Wiedervorlage lifecycle. The journal is append-only (see kp-front-journal), so an
   *  open item is never a row with a mutated status: the `created` row carries op (+ `dueAt` if it
   *  is a timed Erinnerung), and `done`/`snoozed`/`note` are their OWN later rows referencing the
   *  same `id`. The open set is DERIVED from these events (see lib/reminders.ts), never edited in
   *  place.
   *
   *  Two ways in, one lifecycle:
   *   - the ○ switch on an ordinary entry → `created` WITHOUT `dueAt` (a Pendenz: open until done,
   *     never alarms — there are no check-ins on a Schadenplatz, so a due time would be a fiction)
   *   - the Erinnerung mode → `created` WITH `dueAt` (alarms, snoozes, the banner)
   *  ⚠️ The `created` event rides on the ENTRY'S OWN row — «Auftrag · Trupp 2 entraucht …» is both
   *  the record and the Pendenz. Tracking hangs off this event, never off `entryType: 'auftrag'`:
   *  keying it to the tag would turn every Auftrag row already written into an eternally open
   *  Pendenz, in live and archived incidents alike.
   *  ⚠️ `note` is forward-compatible by construction: the reducer treats everything that is not
   *  `done` as still open, so an older client meeting one fails in the safe direction. */
  reminder?: {
    /** ⚠️ `dueAt` on a `note` is a MOVED Wiedervorlage, not a second reminder: a Meldung that
     *  reports «Werkhof meldet 20 Minuten» is exactly the moment the item's own clock shifts. It
     *  rides on the note rather than on a `snoozed` row of its own, because the sentence has to
     *  stay in the item's thread (lib/reminders · the note branch reads the dueAt and leaves the
     *  open/closed state alone). */
    op: 'created' | 'done' | 'snoozed' | 'note'; id: string; dueAt?: string
    /** Pendenz only: sorts to the top of the list and prints a marker.
     *  ⚠️ Written by `created` alone. The composer offered it on a Meldung for a while, as a
     *  «normal / dringend» switch — but a Meldung reports on an item, and a control sitting on one
     *  of them silently re-ranked the whole Pendenz. The reducer still takes it from whatever
     *  event carries it (order-independent, and an older or later client may), so re-ranking could
     *  be offered again as its own action; nothing writes it after the fact today. */
    urgent?: boolean
    /** «Wer», for the Rapport column — the first vocabulary name in the entry's text
     *  (lib/journalLinks · linkParts). NOT a field anybody fills in: whoever writes «Trupp 2
     *  entraucht Treppenhaus» has said who it is for, and a Trupp is titled by its Gruppenführer,
     *  who is in the vocabulary already. Absent when the sentence names nobody. */
    assignee?: string
    /** ⚠️ The BARE Wiedervorlage, as typed — «Pizza bestellen», not the row's own `text`
     *  («Erinnerung gesetzt für 12:06: Pizza bestellen»). The two are not the same string: the
     *  row is the record and has to say what was decided and for when, while every place that
     *  RE-shows the reminder (the pinned block, the fällig banner, the erledigt/snooze rows)
     *  already prints the Fälligkeit beside it and only wants the thing to do. Reading the row
     *  text there stuttered the time and the word «Erinnerung» twice per line.
     *  Optional: rows written before this existed fall back to the stripped `text`. */
    text?: string
  }
  /** enrichment patch: this row carries later-arriving fields (transcript, uploaded media
   *  URL) for the row with id `patchOf`. The journal store folds patches onto their target
   *  at display time and hides the patch row itself — rows are never edited in place
   *  (append-only record; same pattern as the reminder lifecycle above). */
  patchOf?: string
  /** patch payload only: corrected text for the target row. Patch rows carry a filler
   *  `text: ''`, so a text correction needs its own field — the store folds it onto the
   *  target's `text` at display time (append-only correction, same as transcript). */
  textEdit?: string
  /** patch payload only: ONE transcript section for the target audio row — offset in seconds
   *  into the recording plus the words heard there. Written by the player's transcript
   *  composer (voice memos) and by confirmed STT segments; the store folds them into
   *  `transcriptSections`. Append-only, like every other enrichment. */
  transcriptSection?: { at: number; text: string }
  /** patch payload only: replace one section's words (`id` = the section's creating patch row).
   *  Empty text removes the section. NOT a «Korrektur» that marks the row — the recording is
   *  the original and stays; its transcription may simply be fixed. */
  transcriptSectionEdit?: { id: string; text: string }
  /** DERIVED by journalStore's fold: every transcriptSection patch (id = its patch row, so an
   *  edit can address it), sorted by offset. The Verlauf lists them as subtitle lines under
   *  the row; the row's own text stays «Audionotiz (8s)» so the recording remains
   *  recognisable as one. */
  transcriptSections?: { id: string; at: number; text: string }[]
  /** DERIVED, never written to a row: when a `textEdit` patch folded onto this row (the patch's
   *  own `at`). The Verlauf marks the line «korrigiert HH:MM» from it — a corrected line that
   *  looked untouched would be the one thing an append-only record must not do: quietly show
   *  something other than what was said at the time. The original text and the correction both
   *  stay in the record and in the hash chain; this is only how the fold is shown.
   *  ⚠️ Set by journalStore's fold, so it exists on displayed rows and on nothing that is sent. */
  correctedAt?: string
  /** DERIVED, like `correctedAt`: the row's FIRST wording, kept through any number of
   *  corrections. The printed rapport shows it beside the latest text («korrigiert HH:MM ·
   *  ursprünglich: …») — intermediate revisions stay in the record but are not printed. */
  textOriginal?: string
  /** retraction (append-only "delete"): a later patch sets this and the row folds out of
   *  display/report — both the original and the retraction stay in the record. Only
   *  player-created Nachdokumentation rows offer this; incident log lines never do. */
  retracted?: boolean
  audioUrl?: string
  /** structured audio metadata — the stable time origin later waveform markers and
   *  transcript offsets hang off */
  audioMeta?: {
    source: 'recorded' | 'imported'
    startedAt: string      // ISO — confirmed recording start
    durationSec?: number
    originalName?: string
  }
  transcript?: string
  photoUrl?: string      // attached photo (journal entry) — session-only blob, stripped on save
  /** SEVERAL photos on one row — one damage is rarely one picture, and attaching a second used
   *  to REPLACE the first. `photoUrl` above is the single-photo shape every row written before
   *  2026-08-06 carries; readers take both (see lib/verlauf · rowPhotos). */
  photoUrls?: string[]
  /** which screen the event happened on — shown as a chip, drives the jump target */
  surface?: Surface
  // --- map jump target ---
  entityId?: string      // related map entity — select + fly to it on Lage
  coord?: LngLat         // free map point (journal pin) — fly to it on Lage
  // --- plan jump target ---
  planId?: string        // plan document the event belongs to
  px?: number            // plan-space x (0..1) to recenter on
  py?: number            // plan-space y (0..1)
  floor?: number         // floor-stack storey (0 = EG), if applicable
  annoId?: string        // related board annotation (e.g. a team) to select
  /** user-dropped pin (vs. an automatic entity/team link) — shown with a pin glyph */
  pinned?: boolean
  /**
   * What kind of statement this was — Führungsrhythmus (BGV Behelf Schadenplatz): an ordinary
   * observation, an order given, or an immediate measure. Absent = ordinary, the vast majority.
   *
   * ⚠️ ALSO written into `text` at compose time, and `text` stays the record: the Verlauf, the
   * Rapport and the audit chain all read that one string, and a row whose meaning lived in a
   * side field would say something different in the app than on the paper. This exists so the
   * journal can later be FILTERED by it, not so a second copy of the sentence can drift.
   *
   * There is deliberately no «who said it» field: the sentence answers that, and the names in
   * it are linked (lib/journalLinks). A second field asking the same thing was dropped 09.08.
   */
  entryType?: JournalEntryType
}

/** `'info'` · `'auftrag'` (Befehlsgebung) · `'sofort'` (Sofortmassnahme). See TimelineEvent. */
export type JournalEntryType = 'info' | 'auftrag' | 'sofort'

export interface Incident {
  type: string
  title: string
  address: string
  center: LngLat
  startedAt: string
  durationSec: number
  offline: boolean
  cachedTiles: number
  recording: boolean
  recDurationSec: number
}

export interface PlanDocument {
  id: string
  /** Stable key for station-level data that belongs to THIS object's sheet. `id` is only the
   *  module slot (`modul1`, `modul2`, …) and is reused by every Einsatzobjekt, so using it for
   *  a georeference makes the last opened building overwrite every other one. Absent on generic
   *  surfaces and legacy/bundled documents, where callers fall back to `id`. */
  georefKey?: string
  code: string           // short label, e.g. "Module 1"
  title: string          // descriptive title, e.g. "Übersicht"
  subtitle: string       // one-line description
  imageUrl: string       // image asset under public/ — empty string = blank sheet
  orientation: 'portrait' | 'landscape'
  icon?: string          // sidebar icon (defaults to 'doc')
  /** when set, the board background is live OSM building outlines for this area
   *  (a square bbox of ±radiusM around center) instead of a PDF/blank sheet */
  osm?: { center: LngLat; radiusM: number }
  /** the generated "Gebäude" document: a vertical stack of floor sheets traced
   *  from a selected OSM footprint (see BuildingDoc) — a stand-in for Modul 6 */
  floorStack?: boolean
  /** viewer-only: render the PDF as a plain viewer (pan/zoom) with NO drawing tools or
   *  annotation surface — e.g. PV / documentation sheets that are read, not marked up */
  viewer?: boolean
}

/** A selected building (or group of connected buildings) promoted into the
 *  floor-stack ("pseudo Modul 6"). `floors` are the storey indices present
 *  (0 = EG, +1 = OG1, −1 = UG1).
 *
 *  `rings` (when present) holds one or more footprints, each re-normalized 0..1 to
 *  the COMBINED bounding box of all selected footprints, so their relative
 *  positions and sizes are preserved when several houses are transferred together.
 *  `ring` mirrors `rings[0]` and `ringAspect` = combined height/width — both kept
 *  for backward compatibility with single-building workspaces saved before
 *  multi-select existed. Renderers prefer `rings`, falling back to `[ring]`. */
/** Where a building's isotropic `src` box sits on the ground: the WGS84 position of its (0,0)
 *  corner — north-west, since `src` y runs down/south — and the ground length of one `src` unit.
 *
 *  This is what makes a saved footprint PLACEABLE. Without it a `BuildingDoc` is a rectangle with
 *  no address: the picker cannot show you which outlines you already have, and
 *  `lib/buildingTransfer` has nothing to anchor the old tile frame to when the building changes. */
export interface SrcGeoref {
  /** WGS84 [lng, lat] of the src box's (0,0) corner */
  origin: LngLat
  /** ground metres spanned by one src unit */
  spanM: number
}

export interface BuildingDoc {
  ring: [number, number][]
  ringAspect: number
  floors: number[]
  rings?: [number, number][][]
  /** the footprint(s) in ISOTROPIC 0..1 board space (true proportions) — the source the
   *  Gebäudeview rotates. Present on buildings picked since auto-orientation shipped;
   *  absent on older docs (which then render north-up only). See lib/footprint. */
  src?: [number, number][][]
  /** auto-computed rotation (deg) that puts the longest axis horizontal; 0 = north-up
   *  / square. Constant for the building — the toggle flips the active view, not this. */
  orientDeg?: number
  /** active view: true = "Norden oben" (unrotated), false/absent = oriented (default).
   *  `rings`/`ring`/`ringAspect` always mirror the ACTIVE view for back-compat renderers. */
  northUp?: boolean
  /** where this footprint sits on the ground, recorded at pick time from the picker's own square
   *  metre-bbox (lib/buildingTransfer · georefFromPick).
   *
   *  ⚠️ OPTIONAL ON PURPOSE and permanently so: every building picked before this field existed
   *  carries none, and the workspace blob is synced and never rewritten wholesale. Nothing may
   *  throw or misrender without it — it only ENABLES the two things that need a ground position
   *  (pre-selecting the current outlines in the picker, and carrying floor-stack annotations
   *  across a building change). Without it both fall back to the old behaviour, which says so. */
  geo?: SrcGeoref
}

export type PreparedMapOverlay =
  | {
      id: string
      kind: 'circle'
      layer: LayerId
      center: LngLat
      radiusM: number
      color: string
      fillOpacity?: number
      lineOpacity?: number
      lineWidth?: number
      lineDasharray?: number[]
    }
  | {
      id: string
      kind: 'line'
      layer: LayerId
      coords: LngLat[]
      color: string
      width?: number
      dasharray?: number[]
    }

/** Whiteboard annotation. All positions are normalized 0..1 in plan-image space,
 *  so they stick to the plan across zoom/pan. */
export type BoardTool = 'pan' | 'lasso' | 'draw' | 'line' | 'area' | 'text' | 'symbol' | 'shape' | 'resource' | 'scale' | 'measure'
export type BoardKind = 'draw' | 'area' | 'text' | 'symbol' | 'shape' | 'resource'
/** Plan point. The optional storey is backward compatible: legacy points inherit BoardAnno.floor. */
export type BoardPoint = [x: number, y: number] | [x: number, y: number, floor: number]
export interface BoardAnno extends SymbolProps {
  // `symbol`, `label`, `subtitle`, `fields`, `notes`, `count`, `rotation`, `color`
  // are inherited from SymbolProps — a Plan symbol now carries the same attribute
  // set as a Map Entity. (`color` doubles as the draw/resource accent + trail colour.)
  id: string
  kind: BoardKind
  pts?: BoardPoint[]         // draw/area vertices; magnetic lines may span floors per point
  x?: number                 // text / symbol / shape / resource: anchor
  y?: number
  text?: string              // text label / resource name
  /** kind 'text': box width as a fraction of the plan width (0..1) — the plan-space analogue
   *  of `Entity.noteW`. Same unit as `sizeN`, so the box keeps its proportions across zoom and
   *  prints 1:1. ABSENT = the legacy auto-width one-liner (no wrapping, no width grip); its
   *  presence is what makes a note a text box. See `NOTE_W` in lib/notes for the clamps. */
  wN?: number
  // --- kind 'shape' (Pfeil / Rauch / Rechteck — the plan mirror of Entity kind 'shape') ---
  shape?: ShapeKind
  /** shape size as a fraction of the plan width (0..1) — the plan-space analogue of Entity.sizeM */
  sizeN?: number
  /** aerial-appliance boom reach as a fraction of the plan width (0..1) — the plan-space analogue of
   *  Entity.reachM (the Hubretter cage distance from the truck; bearing = `rotation2`). */
  reachN?: number
  width?: number             // draw stroke width
  dashed?: boolean           // draw: render dashed instead of solid (mirrors Drawing.dashed). Absent = solid.
  arrow?: boolean            // draw: an arrowhead at the last vertex (Messpfeil / Rettungsachse line presets)
  arrowStop?: boolean        // draw: the Entwicklungsgrenze bar across the arrowhead (Drawing.arrowStop)
  marker?: string            // draw: a letter repeated along the line (e.g. 'R' for Rettungsachse)
  // ⚠️ NO LONGER inert on a plan (the comment here said it was): once the sheet is calibrated
  // against its printed Maßstab, a line prints its Länge and an area its Fläche, exactly as the
  // Lage does — uncalibrated, the read-out is the «zuerst kalibrieren» nudge instead.
  showDistance?: boolean     // draw/area: print the measured length / area beside the ink
  labelDx?: number           // draw: per-line screen-space nudge of the label off the ink (parity w/ map)
  labelDy?: number
  // FKS hose-line annotations (draw/line only) — mirror Drawing's fields for cross-surface parity
  teilstueck?: boolean       // forward "E"-fork coupling at the line end (instead of an arrowhead)
  content?: 'S' | 'W' | 'H' | 'P' // FKS device letter at the end (Schaumrohr/Wasserwerfer/Hydroschild/Pulver)
  lineNo?: number            // Druckleitung number in a small box on the line (= Leitung identity, see Drawing)
  floorTag?: number          // storey the line works on, signed badge (+2 / 0 / -1)
  endDx?: number             // draw: screen-space nudge of the FKS end-tag off other symbols
  endDy?: number
  fillOpacity?: number       // area: polygon fill opacity (0..1); absent = a sensible default
  t?: string                 // resource: HH:MM of last move
  trail?: TrailPoint[]       // resource: breadcrumb history, oldest → newest
  // resource: the linked Atemschutz Trupp this chip REPRESENTS (position tracking).
  // draw/line: the Atemschutz link ANCHOR — the Trupp this hose was picked for (mirrors
  // Trupp.lineId). Two meanings, one field, told apart by `kind`; both say "belongs to that Trupp".
  truppId?: string
  /** floor-stack only: which storey TILE this anno belongs to (0 = EG). x/y (and
   *  pts/trail) are then normalized 0..1 WITHIN that tile, so floors stay
   *  independent when storeys are added/removed. Absent = floor 0. NOTE: this is a
   *  tile INDEX, distinct from Entity.floor's signed badge value (see SymbolProps). */
  floor?: number
  /** The signed STOREY BADGE on a plan symbol (+2 / 0 / -1) — the plan-space twin of
   *  `Entity.floor`, which is why it cannot simply BE `floor`: that name is already taken
   *  here by the floor-stack tile index above. Wired on the plain Modul boards only; on the
   *  Gebäude floor-stack the tile the symbol sits on already says which storey it is on, so
   *  a second answer there would be one that can disagree with itself. */
  storey?: number
  /** locked: the anno ignores tap-select / drag so it can't be moved by accident or swallow
   *  taps meant for things over it (a big Sektor-Fläche under the work on Modul 1). A lock chip
   *  on it unlocks it with a short hold. Absent = editable. The plan-space twin of
   *  `Drawing.locked` — same field name, same meaning, so a Leitung behaves the same on both
   *  surfaces. ⚠️ NOT `tacticalLocked`, which locks the whole surface for a viewer.
   *  Draw/area only, exactly like the map (a symbol is never locked on either surface). */
  locked?: boolean
  /** Magnetic relationship intent at the first/last vertex (draw/line only). */
  startAttachment?: LineAttachment
  endAttachment?: LineAttachment
}
/** One past position of a team on a plan, in normalized 0..1 plan space. */
/** a recorded breadcrumb. `floor` = the storey the team was on at time `t` (floor-stack
 *  only), so the position history spans floors — a team that walked up was a floor below
 *  a minute ago. Absent = the anno's current floor (legacy points). */
export interface TrailPoint { x: number; y: number; t: string; floor?: number }
/** Per-document annotation store, keyed by PlanDocument id. */
export type BoardDoc = Record<string, BoardAnno[]>

export interface SymbolMeta { cat: string; name: string; svg: string }
export interface SymbolLibrary { order: string[]; symbols: SymbolMeta[] }

/** Atemschutzüberwachung: one breathing-apparatus team (Trupp) under live monitoring.
 *  Swiss FKS/CSSP model — the digital Atemschutz-Überwachungstafel tracks TIME SINCE LAST
 *  FUNKKONTAKT as the primary safety signal; each contact resets the timer, and no contact
 *  within the interval escalates to `ueberfaellig`. Cylinder pressure is logged at each
 *  contact (last + lowest) as a record, with Rückzug/Mindest shown as static reminders — it
 *  is NOT extrapolated into a countdown. Status: angemeldet → aktiv → rueckzug → ueberfaellig
 *  (contact overdue), or `raus` once the team is out. */
/** the editable descriptive fields of a Trupp, shared by the create / edit / re-deploy form */
/** `color: null` from the form means «zurück auf automatisch» — distinct from `undefined`, which
 *  is «this form doesn't carry a colour». See Trupp.color. */
export type TruppFields = { name: string; members?: string[]; auftrag?: Trupp['auftrag']; ziel?: string; lineNo?: number; funkkanal?: number; pressure: number; leaderPersonId?: string; memberPersonIds?: string[]; color?: string | null }

/**
 * One Beilage to the Einsatzrapport — a photo that belongs to the REPORT rather than to the
 * running picture: an ID document, a damage close-up, a handed-over form.
 *
 * Deliberately its own collection, not a Verlauf row with a flag. A Verlauf row is a timed
 * observation in an append-only record of what happened; «Ausweis Herr Meier» is neither, and
 * putting it there would both bury it among the tactical lines and force a document photo into
 * the legal chronology. It also prints differently: journal photos ride small beside their text,
 * a Beilage prints large enough to READ, which is the entire point of photographing a document.
 *
 * Stored like every other incident medium (the media store, the same upload path as a journal
 * photo): it syncs to the devices on this Einsatz and goes with the incident.
 */
export interface ReportAttachment {
  id: string
  /** server-relative media URL (/api/media/<id>). A blob: URL means the upload is still running
   *  — the Rapport preflight already warns about media that has not landed yet. */
  url: string
  /** what this shows, printed under the image («Ausweis Lenker», «Schaden Nordfassade») */
  caption?: string
  /** when it was added (ISO) — printed with the caption, so a set of photos has an order */
  at: string
}

/** One entry in a Trupp's contact/pressure log. `registered` = angemeldet (the cylinder read at
 *  the Tafel, before anyone goes anywhere), `entry` = eingerückt (or re-deployed), `contact`
 *  = a radio check (pressure unchanged, carries the current reading), `pressure` = a new reading. */
export interface TruppReading {
  t: string
  bar: number
  /**
   * What this row of the per-Trupp log IS.
   *
   * ⚠️ `alarm` and `rueckzug` are the two moments the printed Atemschutz-Journal is actually read
   * for — when the Trupp hit its Alarmdruck, and when it was ordered back — and neither used to
   * be distinguishable on it. The Alarmdruck reading printed as an ordinary «Druck» among a
   * column of them, and a Rückzug was written down as a plain «Kontakt», which it also is (it
   * resets the safety clock) but is not ONLY. Both are recorded as their own kind, so the sheet
   * can say so without the reader reconstructing it from the numbers.
   *
   * ⚠️ `exit` and `resume` complete the CHRONOLOGY (19.08.). The Austritt lived only in the
   * sheet's header, so the log simply stopped mid-Einsatz, and a Wiedereinstieg after a Rückzug
   * was written down as a plain `contact` — true (the Trupp was reached) but not the whole
   * truth, and the one row saying the crew went back IN was indistinguishable from a radio
   * check. The safety clock is unchanged: a `resume` resets it exactly like a Kontakt.
   *
   * Rows written before these kinds existed keep theirs — the log is append-only.
   */
  kind: 'registered' | 'entry' | 'contact' | 'pressure' | 'alarm' | 'rueckzug' | 'exit' | 'resume'
}

export interface Trupp {
  id: string
  /** Taken off the Tafel (ISO), rather than removed from the record.
   *
   * ⚠️ A Trupp that was ever registered is part of what happened, and the Atemschutz page of the
   * Rapport is a safety document: a crew that went in under PA and was then deleted from the board
   * used to leave no trace on paper at all. So the delete stamps this and everything LIVE filters
   * it out (IncidentWorkspace derives the board list once, at the source, so nothing downstream —
   * alarms, markers, roster locks — can keep seeing it); the Rapport reads the unfiltered slice.
   * Cleared again by the delete's own «Rückgängig». */
  removedAt?: string
  /** group leader's name = the Trupp title (also the linked plan chip's label) */
  name: string
  /** other team members (for the board card; the chip shows only the leader) */
  members?: string[]
  /** the Trupp's order type; the actual order + location goes in `ziel` */
  auftrag?: 'retten' | 'loeschen' | 'absuchen' | 'sichern' | 'erkunden' | 'anderes'
  /** the actual order + location in plain words ("2. OG Wohnung links, Person vermisst").
   *  Required when `auftrag === 'anderes'` (carries the custom order). */
  ziel?: string
  /** the Leitung this Trupp works on — the SAME 1–99 number the DrawEditor stamps on a hose
   *  (`Drawing.lineNo` / `BoardAnno.lineNo`), which is what joins the two: one number, one
   *  Leitung, on whichever surface it is drawn. */
  lineNo?: number
  /** the drawing explicitly picked for this Trupp (mirrors `Drawing.truppId`). The ANCHOR; the
   *  number above is the identity. Either one alone renders the tag — see lib/truppLines. */
  lineId?: string
  /** @deprecated legacy free-text designation ("1", "Ltg 2", "Res"), replaced 2026-08-05 by the
   *  numeric `lineNo` so it matches what is drawn. Still READ (rendered on the card as typed, and
   *  parsed for the auto-match when it holds a plain number) but never written again — an incident
   *  is a legal record, so old Trupps keep the text their Überwacher typed. */
  lineNumber?: string
  /** Funkkanal the Trupp is on; seeded from the synced default (FKS-Standard: 11) */
  funkkanal?: number
  /** Where this card sits when the board is ordered by hand (Reihenfolge · «Wie gesetzt»).
   *  SYNCED, not a device pref: two operators looking at the same board have to see the same
   *  board. Absent on older Trupps — they fall back to their position in the list, which is the
   *  creation order they were shown in before this existed. */
  order?: number
  /**
   * The Trupp's colour, wherever it is drawn: map marker, plan chip, its dot on the board.
   *
   * ABSENT = automatic, which is the normal case: the station's colour for this Auftrag if one is
   * configured (deploymentConfig · atemschutzAuftragColors), else the next palette colour nobody
   * else is wearing (lib/teamColors). A value here is a DELIBERATE pick — from the Trupp form or
   * from the placed symbol — and is used exactly as chosen, including when another Trupp already
   * wears it: «alle Löschtrupps rot» is a thing an EL is allowed to want. Colour still means
   * IDENTITY by default (ten Trupps, ten colours); this is the override, not a new scheme.
   */
  color?: string
  /** pressure (bar) at entry — the baseline shown until the first contact reading */
  entryPressureBar: number
  /** ISO timestamp the team entered the field (Einsatzzeit clock starts). Empty while `angemeldet`. */
  entryTime: string
  /** ISO timestamp of the last contact (Funkkontakt). Reset by the Kontakt button and by any
   *  pressure update; seeded to entryTime on Eingerückt. Empty while `angemeldet`. The contact
   *  clock (now − this) is the safety signal: overdue past the interval ⇒ überfällig alarm. */
  lastContactTime: string
  /** last recorded cylinder pressure (bar) + when (ISO) — logged for the record, never predicted */
  lastPressureBar?: number
  lastPressureTime?: string
  /** lowest cylinder pressure seen so far (bar) */
  lowestBar?: number
  /** append-only contact/pressure log — the per-Trupp Verlauf shown (collapsed) on the card */
  readings?: TruppReading[]
  /** ISO timestamp the team came out (set on Raus) */
  exitTime?: string
  /** lifecycle phase. `angemeldet` = registered but not yet entered (no contact clock); manual
   *  transitions angemeldet → aktiv (eingerückt) → rueckzug → raus. `ueberfaellig` is the one
   *  auto-overlay, derived while in the field when contact runs past the interval. */
  status: 'angemeldet' | 'aktiv' | 'rueckzug' | 'ueberfaellig' | 'raus'
  /** linked plan resource chip — placed manually on the building plan (Gebäude floor-stack or
   *  Modul 6), NOT auto-created. Unset until the user presses "Platzieren". A Trupp is tracked
   *  at exactly ONE place: either a plan chip (annoId+planId) or a Lage-map marker (entityId) —
   *  placing on one surface removes it from the other. */
  annoId?: string
  /** which plan document the chip lives on (e.g. 'gebaeude' or 'modul6') */
  planId?: string
  /** linked Lage-map team marker (Entity kind 'team') — the map alternative to annoId/planId */
  entityId?: string
  /** optional structured roster refs (Mannschaft). `name`/`members` stay the display
   *  snapshots for back-compat + offline rendering; these link to Person ids when the
   *  name was picked from the roster (enables present-first ordering, never display). */
  leaderPersonId?: string
  memberPersonIds?: string[]
}

/** A canonical local brigade crew member. Provider identities attach optional sync provenance;
 *  manual and CSV-created personnel require none. Distinct from login users. */
export interface Person {
  id: string
  externalIdentities?: { provider: string; externalId: string; syncedAt: string }[]
  displayName: string
  firstName?: string
  lastName?: string
  /** Dienstgrad key referencing the per-station roster.ranks config (see src/lib/rank.ts);
   *  undefined = no rank. Imported from Divera/CSV; drives officer-first picker sort + filters. */
  rank?: string
  active: boolean
  /** Recorded on THIS Einsatz without being on the Mannschaftsliste — a guest, mutual aid, an
   *  AdF whose roster entry never synced. Derived at render time from an attendance entry with
   *  no roster row (see AnwesenheitView · guests); never stored on a Personnel record, because
   *  «was here tonight» is a statement about the Einsatz and not about the Wehr. */
  guest?: boolean
  updatedAt: string
}

/** One executed block of presence. `to` absent = still here. */
export interface PresenceInterval {
  from: string
  to?: string
}

/** Per-incident attendance: who is physically present. Keyed by Person id. `left` keeps
 *  the earlier presence (not deleted); the snapshot survives roster name edits / report. */
export interface AttendanceEntry {
  status: 'present' | 'left'
  /** DERIVED first arrival — the shape the rapport / statistics export / QR sheet read. */
  checkedInAt?: string
  /** DERIVED last departure; absent while the person came back. */
  leftAt?: string
  displayNameSnapshot: string
  /** free remark on this person for THIS incident («Fahrer TLF», «verletzt, abgelöst 21:40»).
   *  Printed with the row on the Personalblatt. Deliberately per incident, not on the roster:
   *  it describes what somebody did here, not who they are. */
  note?: string
  /** when that remark was last written (ISO).
   *  ⚠️ It exists for ONE question: who is the Einsatzleiter NOW. Nothing stops two people from
   *  carrying «Einsatzleiter» after a handover — the app warns and does not block — and without a
   *  time the answer fell out of a sort order, so the Verlauf, the journal's «EL» and the Rapport
   *  could each name a different one. Absent on entries written before this existed; those sort
   *  last, which is the safe end. */
  noteAt?: string
  /** Every executed block, oldest first — the truth (see lib/attendanceIntervals). Absent on an
   *  entry written before blocks existed, which projects its checkedInAt/leftAt pair instead. */
  intervals?: PresenceInterval[]
  /**
   * Where this person is RIGHT NOW: at the Einsatzort, or still at the Magazin.
   *
   * The question it answers is «wen könnte ich noch nachziehen», which is a question about this
   * minute and nothing else — so it is ONE state per person, not a second kind of presence block.
   * It is deliberately not history: a record of every walk between the Magazin and the scene
   * would be a lot of rows nobody ever reads, and the Verlauf already carries the changes.
   *
   * Absent on every entry written before 2026-08-09, and on anybody not present — those read as
   * `'scene'` (see lib/attendanceOrt · ortOf), because before this existed «anwesend» meant «here».
   */
  ort?: AttendanceOrt
}

/** `'scene'` = am Einsatzort · `'station'` = im Magazin. See AttendanceEntry.ort. */
export type AttendanceOrt = 'scene' | 'station'
export type AttendanceState = Record<string, AttendanceEntry>

/** One planned availability block of the Schichtenplanung (see lib/shifts). A PLAN — it never
 *  writes attendance; executing it is the ordinary Anwesenheit tick, which stamps the real time. */
export interface Shift {
  /** `'sh'+Date.now()` — prefixed timestamp, like every other id here */
  id: string
  personId: string
  /** ISO start of the planned availability */
  from: string
  /** ISO end */
  to: string
  /** agreed with the person (drawn solid) rather than still a proposal (drawn hollow). Tapping
   *  the bar flips it — the one thing about a shift that changes constantly while planning. */
  confirmed?: boolean
  /** the ShiftBand this shift was entered into (see the Schichten grid). ABSENT = freihändig: the
   *  shift was drawn on the Zeitplan axis and belongs to no column at all.
   *
   *  Membership is STORED, never derived from matching times. Nobody lands in a band because their
   *  clock happens to fit, and nobody drops out because somebody nudged the band by five minutes —
   *  which also means a shift whose times were since dragged away still shows in its column,
   *  hatched, carrying its real time. */
  bandId?: string
  note?: string
}

/** A named time window of the Schichtenplanung — one column of the Schichten grid («Früh 07–12»).
 *
 *  A band is INERT: creating one writes this single row and nothing else. It assigns nobody, reads
 *  no existing times and proposes nothing; every one of its cells starts empty, including for
 *  people who already hold exactly these hours freihändig. That is a sync argument as much as a UX
 *  one — if creating a band wrote shifts, two devices creating the same band would each produce a
 *  full set for 66 people, and mergeById would have to resolve duplicates of something that should
 *  never have existed. An inert row cannot collide. */
export interface ShiftBand {
  /** `'bd'+Date.now()` — prefixed timestamp, like every other id here */
  id: string
  /** what the crew calls this watch — «Früh», «Nacht» */
  label: string
  /** ISO start of the window */
  from: string
  /** ISO end */
  to: string
}

/** One append-only Mittel (material-use) event: the running TOTAL used for a material+unit, from
 *  an optional source, at the moment it was saved. The current picture is derived as the latest
 *  event per `material + unit + source` key (see lib/mittel). `menge === 0` hides the line but
 *  keeps the history; events are never edited or removed (append-only doctrine). Custom,
 *  incident-local materials/sources carry no config id and key off their snapshot label. */
export type MittelStatus = 'zurueck' | 'vorOrt' | 'defekt'
export interface MittelEntry {
  id: string
  /** config catalogue id; undefined ⇒ custom / incident-local material */
  materialId?: string
  /** material label snapshot (survives a later catalogue rename) */
  label: string
  /** Stk / l / Sack / m / Flasche … */
  unit: string
  /** config source id; undefined ⇒ no source chosen */
  sourceId?: string
  /** source label snapshot */
  sourceLabel?: string
  /** current total used, integer ≥ 0 (0 = hidden but kept) */
  menge: number
  /** Retablierung state of the line (equipment only): back in, left on site, or defective.
   *  Undefined = im Einsatz / not yet accounted. Rides the same append-only events. */
  status?: MittelStatus
  /** free remark on this material line («2 Rollen an Werkhof übergeben», «Flasche defekt»).
   *  Carried on the event like `menge`, so the current picture takes the latest one and the
   *  history keeps what was written when. Printed with the line on the Rapport. */
  note?: string
  /** Nominal total stock of an incident-local line — what «noch N» counts down from. A
   *  catalogue material takes this from the deployment config; a hand-added one has nowhere
   *  else to get it, so it is carried on the event (latest wins, like `note`). */
  stock?: number
  /** Explicit removal of a line. `menge: 0` used to double as the tombstone, but a hand-added
   *  line now SURVIVES being stepped to zero (0 = nothing used, same as a catalogue row), so
   *  the removal needs to say so itself. Set once; the events stay, as always. */
  deleted?: boolean
  /** ISO timestamp the event was saved */
  at: string
  /** author display name snapshot, when known */
  by?: string
}
// A saved map view (camera bookmark): the full Lage camera — position, zoom and rotation —
// so the crew can flip between framings (e.g. a north-up overview and the map rotated to how
// they're physically standing in front of the Einsatzort) with a single tap. Synced per
// incident so the whole command team shares the same reference framings.
export interface CameraView {
  id: string
  name: string
  center: LngLat
  zoom: number
  bearing: number
}

/** Outcome of «Wieder öffnen» on an archived Einsatz. `cancelled` is the operator backing out
 *  of the confirm — nothing failed, so nothing should be offered again. */
export type ReactivateResult = 'ok' | 'cancelled' | 'failed'
