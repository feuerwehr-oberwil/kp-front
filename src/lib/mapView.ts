// Pure helpers extracted from MapView: world-scaled symbol/shape sizing, GeoJSON
// feature builders, and the symbol-kind predicates. No React — safe to unit-test.
import type { Entity, LayerId, LngLat } from '../types'
import { appConfig } from '../config/appConfig'
import { ROTATABLE, VEHICLE_SYMBOLS } from '../lib/symbols'
import { lookbackPoint } from './lineStyle'
import type { LineTone } from './truppLines'

export const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] }

export const vis = (on: boolean) => ({ visibility: (on ? 'visible' : 'none') as 'visible' | 'none' })

/** Native Lage drawing chrome must leave with its canvas strokes during Karte ↔ Modul pairing. */
export const nativeDrawingChromeVisible = (drawingsVisible: boolean, georefOn: boolean) =>
  drawingsVisible && !georefOn

/** A label is the line's tap target, except when it carries the one alarm that needs immediate
 * action: an overdue linked Atemschutz-Trupp. Warn/fine/out labels still open line details. */
export const lineLabelAction = (truppId: string | undefined, tone: LineTone | undefined) =>
  truppId && tone === 'crit'
    ? { kind: 'trupp' as const, id: truppId }
    : { kind: 'drawing' as const }

// ── Trupp marker geometry (mirrors `.team-dot` / `.wb-resource-pill`, 09-whiteboard.css) ────
// A Trupp marker is a STRIP — [dot][gap][name] — so where the strip is anchored decides what the
// coordinate MEANS. Both halves of the map have to agree on it: MapMarkers anchors the marker,
// MapView's label pass measures the same boxes without a DOM.
/** `.team-dot i` — the dot IS the position, so it is what sits on the coordinate. */
export const TEAM_DOT_PX = 13
/** `.team-dot` gap — the distance the name hangs off the dot. */
export const TEAM_DOT_GAP = 6
/** The selected pill's accent cap, centre-to-left-edge: 1px border + 8px padding + half of the
 *  4px cap — so selecting a Trupp swaps the chrome without moving the point it states. */
export const TEAM_PILL_CAP_PX = 11

// Symbol size tied to the real world (m), scaling with zoom — but clamped into a
// NARROW band: at normal Einsatz zooms a symbol looks almost constant (like a map
// pin), never grows past the roof (no "Offizier as big as a house") and shrinks
// slightly when zooming out, so a cluster doesn't clump together.
const SIZE_M: Record<string, number> = { vehicle: 11, command: 10, hydrant: 6, symbol: 8, area: 8 }
// the band (px). `mul` is the global S/M/L factor (lib/prefs · symbolMul); it
// scales the whole band, so the ceiling/floor grow along with it.
const SYM_MIN = 28
const SYM_MAX = 48
export const pxPerM = (lat: number, z: number) => Math.pow(2, z) / (156543.03392 * Math.cos((lat * Math.PI) / 180))
export const symPx = (kind: string, lat: number, z: number, mul = 1) =>
  Math.max(SYM_MIN, Math.min(SYM_MAX, (SIZE_M[kind] ?? 8) * pxPerM(lat, z))) * mul
// shapes are sized in real-world metres so they grow/shrink with zoom like a
// ground footprint (a smoke cloud covering an area, an arrow spanning a street)
export const shapePx = (sizeM: number | undefined, lat: number, z: number) => Math.max(24, Math.min(900, (sizeM ?? 40) * pxPerM(lat, z)))
// directional tactical symbols that support drag-to-rotate (ladders, fans, vehicles…)
// — set derived from the symbol presets (lib/symbols · ROTATABLE)
export const isRotatableSym = (e: Entity) => e.kind === 'symbol' && !!e.symbol && ROTATABLE.has(e.symbol)
// a placed generic vehicle — rendered like the live GPS glyph, with its typed name baked in
export const isVehicleSym = (e: Entity) => e.kind === 'symbol' && e.symbol === appConfig.symbols.vehicleName

/**
 * The layer an entity actually belongs to. Vehicles answer «Fahrzeuge» whatever their stored
 * layer says: only the live GPS glyphs were ever put on that layer, so a TLF someone placed by
 * hand sat on «Taktische Zeichen» and could not be toggled away with the rest of the fleet —
 * two kinds of the same thing on two different switches.
 *
 * Resolved at read time rather than migrated, so every Einsatz already in the database toggles
 * correctly too, without rewriting a single stored workspace. New placements store the right
 * layer anyway (see IncidentWorkspace · placeSymbol), so this is a compatibility shim for old
 * data, not a permanent indirection.
 */
export const effectiveLayer = (e: Entity): LayerId =>
  (e.kind === 'symbol' && e.symbol && VEHICLE_SYMBOLS.has(e.symbol)
    ? appConfig.gps.layerId
    : e.layer)
// Accidental-rotation self-heal: a rotate gesture that ends ALMOST north (within ±threshold°)
// snaps back to exactly 0 — the common case of a two-finger zoom that drags the bearing a few
// degrees off heals itself, while deliberate rotation past the threshold sticks. Returns the
// corrected bearing (0) or null when the bearing should stay as released.
export const snapNorth = (bearing: number, threshold = 6): number | null => {
  const b = ((bearing % 360) + 360) % 360 // normalise to [0, 360)
  const d = Math.min(b, 360 - b) // angular distance to north
  return d > 0 && d <= threshold ? 0 : null
}

/** `initialViewState` for a map instance: the live view when we have one (so a WebGL
 *  context-loss remount resumes the operator's framing instead of snapping back to the
 *  incident's initial one), else the incident's opening view. */
export const resumeViewState = (
  live: { center: LngLat; zoom: number; bearing: number } | null,
  center: LngLat,
  zoom: number,
  bearing: number,
) => (live
  ? { longitude: live.center[0], latitude: live.center[1], zoom: live.zoom, bearing: live.bearing }
  : { longitude: center[0], latitude: center[1], zoom, bearing })

/** How many insertable segments a measured / edited path has. An area closes back to its first
 *  point, so it has one more than a line of the same vertices — but only once it IS a ring
 *  (two points are still just a line). Shared by the tap-the-line hit test and the "+" handles
 *  drawn at each midpoint, so the two routes offer exactly the same insert positions. */
export const pathSegmentCount = (points: number, isArea: boolean): number =>
  points < 2 ? 0 : isArea && points >= 3 ? points : points - 1

export type FC = { type: 'FeatureCollection'; features: any[] }
export const fc = (features: any[]): FC => ({ type: 'FeatureCollection', features })
export const lineFeat = (coords: LngLat[], props: any = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props })
export const polyFeat = (coords: LngLat[], props: any = {}) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] }, properties: props })

/** Web-Mercator northing — the y half of the projection, without a map instance. */
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/** Web-Mercator world pixel at a zoom. On a NORTH-UP map these are screen pixels up to a pan,
 *  so a distance measured here is a distance on screen — which is what the decorations below
 *  need and what saves them from asking the map to project every vertex on every render. */
export function worldPx(c: LngLat, z: number): [number, number] {
  const s = 256 * Math.pow(2, z)
  return [((c[0] + 180) / 360) * s, (0.5 - mercY(c[1]) / (2 * Math.PI)) * s]
}

/**
 * Bearing (deg, screen) the Teilstück fork caps a hose line with.
 *
 * ⚠️ NOT the raw last segment. A hose is drawn with a finger or a mouse and its final vertex is
 * routinely a few pixels from the one before it — at that length the segment carries almost no
 * direction, so a fork aimed by it stands ACROSS the line instead of capping it. The printed
 * Kroki never had this because kroki.py looks a fixed distance back from the tip for its
 * reference point (`_lookback`), and `lineStyle · lookbackPoint` is the same walk for the same
 * reason on the arrowheads. `minPx` mirrors the server's `max(10, width · 2.5)`.
 */
export function forkBearing(coords: LngLat[], zoom: number, minPx: number): number {
  const px = coords.map((c) => worldPx(c, zoom))
  const tip = px[px.length - 1]
  const ref = lookbackPoint(px, minPx)
  return (Math.atan2(tip[1] - ref[1], tip[0] - ref[0]) * 180) / Math.PI
}
