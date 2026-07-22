export type LngLat = [number, number]

export type LayerId = string

export interface LayerDef {
  id: LayerId
  group: string
  label: string
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

export type EntityKind = 'symbol' | 'vehicle' | 'note' | 'photo' | 'shape' | 'team'

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
 *  Rendered as arrows in the symbol's own colour (red/blue/orange): a horizontal
 *  arrow in one of the four cardinal directions, and/or vertical up/down arrows
 *  (which pair with the symbol's Geschoss number). A "bounded" flag adds the
 *  Entwicklungsgrenze bar at the arrow tip (→|). Absent / all-empty = no spread. */
export interface Spread {
  /** horizontal spread direction — left (W) or right (E) only; absent = none.
   *  (FKS: horizontal development is always left/right; up/down is vertical.) */
  h?: 'E' | 'W'
  /** horizontal spread is bounded (bar at the tip) */
  hBounded?: boolean
  /** vertical spread to upper / lower storeys */
  up?: boolean
  down?: boolean
  /** vertical spread is bounded (bar at the tip) */
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
}

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
  /** externally sourced (e.g. live GPS) — read-only: not draggable, editable or persisted */
  live?: boolean
  // --- kind 'shape' ---
  shape?: ShapeKind
  sizeM?: number        // shape size on the ground, in metres
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
  /** Druckleitung number shown in a small box on the line (e.g. 1. Druckleitung). */
  lineNo?: number
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
  /** Wiedervorlage (reminder) lifecycle. The journal is append-only (see kp-front-journal),
   *  so a reminder is never a row with a mutated status: the `created` row carries op+dueAt,
   *  and `done`/`snoozed` are their OWN later rows referencing the same `id`. The open set and
   *  effective due time are DERIVED from these events (see lib/reminders.ts), never edited in place. */
  reminder?: { op: 'created' | 'done' | 'snoozed'; id: string; dueAt?: string }
  /** enrichment patch: this row carries later-arriving fields (transcript, uploaded media
   *  URL) for the row with id `patchOf`. The journal store folds patches onto their target
   *  at display time and hides the patch row itself — rows are never edited in place
   *  (append-only record; same pattern as the reminder lifecycle above). */
  patchOf?: string
  /** patch payload only: corrected text for the target row. Patch rows carry a filler
   *  `text: ''`, so a text correction needs its own field — the store folds it onto the
   *  target's `text` at display time (append-only correction, same as transcript). */
  textEdit?: string
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
}

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
  // --- kind 'shape' (Pfeil / Rauch / Rechteck — the plan mirror of Entity kind 'shape') ---
  shape?: ShapeKind
  /** shape size as a fraction of the plan width (0..1) — the plan-space analogue of Entity.sizeM */
  sizeN?: number
  width?: number             // draw stroke width
  dashed?: boolean           // draw: render dashed instead of solid (mirrors Drawing.dashed). Absent = solid.
  arrow?: boolean            // draw: an arrowhead at the last vertex (Messpfeil / Rettungsachse line presets)
  marker?: string            // draw: a letter repeated along the line (e.g. 'R' for Rettungsachse)
  // showDistance carried for data-model + preset parity with the Lage `Drawing`; NOT rendered on a
  // plan (a building sheet has no metric scale) — the line's free-text `label` covers that case.
  showDistance?: boolean     // draw (Messpfeil): map renders a geodesic length; plan stores it inert
  labelDx?: number           // draw: per-line screen-space nudge of the label off the ink (parity w/ map)
  labelDy?: number
  // FKS hose-line annotations (draw/line only) — mirror Drawing's fields for cross-surface parity
  teilstueck?: boolean       // forward "E"-fork coupling at the line end (instead of an arrowhead)
  content?: 'S' | 'W' | 'H' | 'P' // FKS device letter at the end (Schaumrohr/Wasserwerfer/Hydroschild/Pulver)
  lineNo?: number            // Druckleitung number in a small box on the line
  floorTag?: number          // storey the line works on, signed badge (+2 / 0 / -1)
  endDx?: number             // draw: screen-space nudge of the FKS end-tag off other symbols
  endDy?: number
  fillOpacity?: number       // area: polygon fill opacity (0..1); absent = a sensible default
  t?: string                 // resource: HH:MM of last move
  trail?: TrailPoint[]       // resource: breadcrumb history, oldest → newest
  truppId?: string           // resource: linked Atemschutz Trupp (this chip represents that team)
  /** floor-stack only: which storey TILE this anno belongs to (0 = EG). x/y (and
   *  pts/trail) are then normalized 0..1 WITHIN that tile, so floors stay
   *  independent when storeys are added/removed. Absent = floor 0. NOTE: this is a
   *  tile INDEX, distinct from Entity.floor's signed badge value (see SymbolProps). */
  floor?: number
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
export type TruppFields = { name: string; members?: string[]; auftrag?: Trupp['auftrag']; ziel?: string; lineNumber?: string; funkkanal?: number; pressure: number; leaderPersonId?: string; memberPersonIds?: string[] }

/** One entry in a Trupp's contact/pressure log. `entry` = eingerückt (or re-deployed), `contact`
 *  = a radio check (pressure unchanged, carries the current reading), `pressure` = a new reading. */
export interface TruppReading {
  t: string
  bar: number
  kind: 'entry' | 'contact' | 'pressure'
}

export interface Trupp {
  id: string
  /** group leader's name = the Trupp title (also the linked plan chip's label) */
  name: string
  /** other team members (for the board card; the chip shows only the leader) */
  members?: string[]
  /** the Trupp's order type; the actual order + location goes in `ziel` */
  auftrag?: 'retten' | 'loeschen' | 'absuchen' | 'sichern' | 'erkunden' | 'anderes'
  /** the actual order + location in plain words ("2. OG Wohnung links, Person vermisst").
   *  Required when `auftrag === 'anderes'` (carries the custom order). */
  ziel?: string
  /** hose / line designation the Trupp works on (e.g. "1", "Leitung 2") */
  lineNumber?: string
  /** Funkkanal the Trupp is on; seeded from the synced default (FKS-Standard: 11) */
  funkkanal?: number
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
  /** @deprecated compatibility projection; use externalIdentities. */
  diveraId?: number
  displayName: string
  firstName?: string
  lastName?: string
  /** Dienstgrad key referencing the per-station roster.ranks config (see src/lib/rank.ts);
   *  undefined = no rank. Imported from Divera/CSV; drives officer-first picker sort + filters. */
  rank?: string
  active: boolean
  updatedAt: string
}

/** Per-incident attendance: who is physically present. Keyed by Person id. `left` keeps
 *  the earlier presence (not deleted); the snapshot survives roster name edits / report. */
export interface AttendanceEntry {
  status: 'present' | 'left'
  checkedInAt?: string
  leftAt?: string
  displayNameSnapshot: string
}
export type AttendanceState = Record<string, AttendanceEntry>

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
  /** ISO timestamp the event was saved */
  at: string
  /** author display name snapshot, when known */
  by?: string
}
export type MittelLog = MittelEntry[]

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
