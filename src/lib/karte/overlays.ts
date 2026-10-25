// «Karte & Objekte» — what the viewer draws over the map, as MapView's prepared overlays
// (docs/karte-objekte.md). Pure: components/karte/useKarteOverlays memoises these builders and
// hands the list to MapView; the order of the list is the order the map stacks them in.
//
//   · `stationOverlays`: the offline hatching, the underground buildings, every object's buildings
//     (one overlay per colour), the selection in the strong style, Gefahrgut's rings;
//   · `pointerOverlays`: what the mouse is over or the finger holds, and the hydrant line —
//     overlays of their own, so a hover never rebuilds (and re-sends) the station's outlines.

import { appConfig } from '../../config/appConfig'
import { lookupErg } from '../erg'
import { ergRingsFor, type ErgRingMode } from '../ergRings'
import { UNDER_DASH } from '../underground'
import type { LayerId, LngLat, PreparedMapOverlay } from '../../types'
import { tileRing, type TileXY } from './availability'
import type { ObjectCategory } from './categories'
import { ringAt } from './places'
import type { Hover, ObjectOutlines, Sel } from './selection'

/** the layer ids the viewer draws under that are not in the deployment's list */
export const OBJECTS_LAYER = 'karte-objekte' as LayerId
export const ALWAYS_LAYER = 'karte-immer' as LayerId
/** the hatching over map area this device holds no base map for (offline only) */
export const UNCACHED_LAYER = 'karte-ohne-karte' as LayerId
/** «Unterirdische Bauten» (lib/underground), its own Ebenen row */
export const UNDERGROUND_LAYER = 'karte-unterirdisch' as LayerId

/** Gefahrgut's state as the tool holds it (components/karte/useKarteTools) */
export interface ErgState { un: string; mode: ErgRingMode; center: LngLat | null; at: Date }

type Categories = ReadonlyMap<string, Pick<ObjectCategory, 'id' | 'color'>>

/** Every object's buildings but the selected one's: one overlay per colour, in the order the
 *  catalogue first meets each colour — each over its underground garages / shelters (a
 *  named row's, review round 3: dashed, barely filled), so a house drawn over its garage keeps its
 *  solid line. Both fade in when they first stand (MapLayers · fadeIn): the rings answer a viewport
 *  fetch after the map, and used to land in one frame. */
function objectOverlays(outlines: ObjectOutlines, cats: Categories, hidden: (id: string) => boolean, selId: string | null, ink: string): PreparedMapOverlay[] {
  const byColor = new Map<string, { id: string; rings: LngLat[][]; under: LngLat[][] }>()
  for (const [id, b] of outlines) {
    if (id === selId || hidden(id)) continue
    const c = cats.get(id)
    const key = c?.color ?? ink
    const slot = byColor.get(key) ?? { id: c ? `karte-objects-${c.id}` : 'karte-objects', rings: [], under: [] }
    slot.rings.push(...b.rings)
    slot.under.push(...b.under)
    byColor.set(key, slot)
  }
  const out: PreparedMapOverlay[] = []
  for (const [color, slot] of byColor) if (slot.under.length) out.push({ id: `${slot.id}-under`, kind: 'polygons', layer: OBJECTS_LAYER, rings: slot.under, color, fillOpacity: 0.05, lineWidth: 1.6, lineOpacity: 0.85, lineDasharray: UNDER_DASH, fadeIn: true })
  for (const [color, slot] of byColor) out.push({ id: slot.id, kind: 'polygons', layer: OBJECTS_LAYER, rings: slot.rings, color, fillOpacity: 0.14, lineWidth: 1.6, lineOpacity: 0.85, fadeIn: true })
  return out
}

/** The selection: EVERY building of the selected object in the strong style and its own colour,
 *  the one building a tap hit dashed in blue (what the switch's house level opens), a selected
 *  building's outline — found again once its cell has loaded (a searched address flies first). */
function selectionOverlays(p: { outlines: ObjectOutlines; cats: Categories; ink: string; blue: string; sel: Sel | null; selId: string | null; ringsNear: (at: LngLat) => readonly LngLat[][] }): PreparedMapOverlay[] {
  const { sel, selId } = p
  const out: PreparedMapOverlay[] = []
  const mine = selId ? p.outlines.get(selId) : null
  const mineColor = (selId && p.cats.get(selId)?.color) ?? p.ink
  if (mine?.under.length) out.push({ id: 'karte-object-sel-under', kind: 'polygons', layer: ALWAYS_LAYER, rings: mine.under, color: mineColor, fillOpacity: 0.1, lineWidth: 2.5, lineOpacity: 1, lineDasharray: UNDER_DASH })
  if (mine) out.push({ id: 'karte-object-sel', kind: 'polygons', layer: ALWAYS_LAYER, rings: mine.rings, color: mineColor, fillOpacity: 0.3, lineWidth: 3, lineOpacity: 1 })
  if (sel?.kind === 'object' && sel.hit) out.push({ id: 'karte-object-hit', kind: 'polygons', layer: ALWAYS_LAYER, rings: [sel.hit.ring], color: p.blue, fillOpacity: 0, lineWidth: 2.5, lineOpacity: 1, lineDasharray: [2, 1.4] })
  const bRing = sel?.kind === 'building' ? sel.ring ?? ringAt(p.ringsNear(sel.at), sel.at) : null
  if (bRing) out.push({ id: 'karte-building', kind: 'polygons', layer: ALWAYS_LAYER, rings: [bRing], color: p.blue, fillOpacity: 0.16, lineWidth: 2.5, lineOpacity: 1 })
  return out
}

/** Gefahrgut's isolation and protection rings, once it has a UN number and a centre */
function ergOverlays(erg: ErgState): PreparedMapOverlay[] {
  const { center } = erg
  if (!erg.un || !center) return []
  const row = lookupErg(erg.un)?.tih?.[0]
  return ergRingsFor(row, erg.mode, erg.at, center).map((ring): PreparedMapOverlay => {
    const iso = ring.kind === 'isolation'
    return {
      id: `karte-erg-${ring.kind}`, kind: 'circle', layer: ALWAYS_LAYER, center, radiusM: ring.radiusM,
      color: iso ? appConfig.ergRings.isolationColor : appConfig.ergRings.protectColor,
      fillOpacity: iso ? appConfig.ergRings.isolationFillOpacity : 0, lineWidth: appConfig.drawing.circleLineWidth, lineDasharray: iso ? undefined : [2, 2],
    }
  })
}

/** The station's overlays, bottom first: offline, the hatched tiles with no base map behind them;
 *  the Einsatzgebiet's underground structures (`underground`, null while its row is off — under
 *  every object, an object's own dashed garage keeps its colour on top); the objects; the
 *  selection; Gefahrgut's rings (`erg`, null unless the tool is armed). */
export function stationOverlays(p: {
  outlines: ObjectOutlines
  cats: Categories
  /** an object whose category is hidden in Ebenen */
  hidden: (id: string) => boolean
  /** «has plans» (01-tokens · --obj-plans), and the theme's blue and faint ink */
  ink: string
  blue: string
  hatchInk: string
  sel: Sel | null
  selId: string | null
  ringsNear: (at: LngLat) => readonly LngLat[][]
  underground: PreparedMapOverlay | null
  uncached: readonly TileXY[]
  erg: ErgState | null
}): PreparedMapOverlay[] {
  const out: PreparedMapOverlay[] = []
  if (p.uncached.length) out.push({ id: 'karte-uncached', kind: 'polygons', layer: UNCACHED_LAYER, rings: p.uncached.map(tileRing), color: p.hatchInk, hatch: true, fillOpacity: 0.55, lineWidth: 0, lineOpacity: 0 })
  if (p.underground) out.push(p.underground)
  out.push(...objectOverlays(p.outlines, p.cats, p.hidden, p.selId, p.ink))
  out.push(...selectionOverlays(p))
  if (p.erg) out.push(...ergOverlays(p.erg))
  return out
}

/** What the mouse is over OR what the finger is holding (owner, review round 7, point 7): ONE
 *  outline, so «this is what you are about to open» looks the same whichever hand lit it — all of
 *  an object's buildings brighter, the one under the pointer in white; a plain building thin blue.
 *  And the dashed line from the selected place to the hydrant shown from «In der Nähe». */
export function pointerOverlays(p: { outlined: Hover | null; outlines: ObjectOutlines; cats: Categories; ink: string; blue: string; hydrantLine: [LngLat, LngLat] | null }): PreparedMapOverlay[] {
  const { outlined } = p
  const out: PreparedMapOverlay[] = []
  if (outlined?.kind === 'object') {
    const b = p.outlines.get(outlined.id)
    if (b) out.push({ id: 'karte-hover-object', kind: 'polygons', layer: ALWAYS_LAYER, rings: b.rings, color: p.cats.get(outlined.id)?.color ?? p.ink, fillOpacity: 0.16, lineWidth: 2.6, lineOpacity: 1 })
    if (outlined.ring) out.push({ id: 'karte-hover-house', kind: 'polygons', layer: ALWAYS_LAYER, rings: [outlined.ring], color: '#ffffff', fillOpacity: 0, lineWidth: 2.5, lineOpacity: 1 })
  } else if (outlined?.kind === 'plain') {
    out.push({ id: 'karte-hover-plain', kind: 'polygons', layer: ALWAYS_LAYER, rings: [outlined.ring], color: p.blue, fillOpacity: 0, lineWidth: 2, lineOpacity: 1 })
  }
  if (p.hydrantLine) out.push({ id: 'karte-hydrant-line', kind: 'line', layer: ALWAYS_LAYER, coords: p.hydrantLine, color: p.blue, width: 3, dasharray: [2, 1.5] })
  return out
}
