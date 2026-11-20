// «Üben» · «Fahrzeug mit Leitung» – a Fahrzeug by Hydrant H1, a Leitung WITH ITS ARROW from the
// Fahrzeug to the Eingang (the owner's own example, 19.11.2026: «place a vehicle with a hose
// attached»; the arrow is checked – it is what says where the water flows).
//
// Lenient (owner pick, 20.11.2026 – lib/ueben/model): any placed Fahrzeug counts, named or not,
// anywhere near H1 – also on top of it. Only one clearly somewhere else says so, or the Leitung
// could not be told from a stray line. A Leitung end counts as AT a place when it is coupled to it
// (the magnetic attachment) or lies within a few metres of it. The arrow is the line's `arrow` at
// its LAST point (types · Drawing.arrow), so the line must run Fahrzeug → Eingang with `arrow` on;
// drawn the other way round, «Richtung umkehren» turns it.

import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../format'
import { haversineM, midCoord } from '../geo'
import { newId } from '../ids'
import { seedSymbolProps } from '../symbols'
import type { Drawing, Entity, LngLat } from '../../types'
import type { Drill, GoalState, Hint, Snapshot, SolveApi, UiState } from './model'
import { offsetM, SITE_IDS, type Site } from './site'

/** «by H1»: closer than this. The Eingang is some 50 m from H1 – a Fahrzeug parked there is not
 *  at the hydrant. */
export const NEAR_M = 40
/** how close a Leitung end must lie to the Fahrzeug / the Eingang when it is not coupled */
export const END_AT_M = 15

const C = () => appConfig.copy.ueben.drills.fahrzeugLeitung
const vehicleName = () => appConfig.symbols.vehicleName

const isVehicle = (e: Entity) => e.kind === 'symbol' && e.symbol === vehicleName() && !e.live

/** Where «Zeigen» and «Lösung» put the Fahrzeug: 12 m from H1, on the Eingang's side. */
export const besideH1 = (h1: LngLat): LngLat => offsetM(h1, 11, 5)

/** The Fahrzeug the drill is about: the placed one nearest H1, and how far it stands from it. */
export function vehicleAt(entities: readonly Entity[], h1: Entity): { e: Entity; d: number } | null {
  return entities.filter(isVehicle).map((e) => ({ e, d: haversineM(e.coord, h1.coord) })).sort((a, b) => a.d - b.d)[0] ?? null
}

const missing = (name: string): GoalState => ({ s: 'wrong', reason: fillTemplate(appConfig.copy.ueben.siteMissing, { name }) })

function checkVehicle(snap: Snapshot, site: Site): GoalState {
  if (!site.h1) return missing(appConfig.copy.ueben.site.hydrant)
  const v = vehicleAt(snap.entities, site.h1)
  if (!v) return { s: 'open' }
  return v.d <= NEAR_M ? { s: 'ok' } : { s: 'wrong', reason: fillTemplate(C().far, { m: Math.round(v.d) }) }
}

const lines = (drawings: readonly Drawing[]) => drawings.filter((d) => d.kind === 'line' && d.role !== 'wand' && d.coords.length >= 2)
const endOf = (l: Drawing, end: 'start' | 'end') => (end === 'start' ? l.coords[0] : l.coords[l.coords.length - 1])

/** metres from the line's `end` to `target` – 0 when that end is coupled to it */
function endMiss(line: Drawing, end: 'start' | 'end', target: Entity): number {
  const att = end === 'start' ? line.startAttachment : line.endAttachment
  if (att?.target.kind === 'object' && att.target.id === target.id) return 0
  return haversineM(endOf(line, end), target.coord)
}

/** How far a line misses «Fahrzeug → Eingang» in its better orientation, and which way it runs:
 *  `forward` = it starts at the Fahrzeug, so its arrow (at the last point) is at the Eingang. */
export function lineMiss(line: Drawing, vehicle: Entity, eingang: Entity): { atVehicle: number; atEingang: number; forward: boolean } {
  const fwd = { atVehicle: endMiss(line, 'start', vehicle), atEingang: endMiss(line, 'end', eingang), forward: true }
  const rev = { atVehicle: endMiss(line, 'end', vehicle), atEingang: endMiss(line, 'start', eingang), forward: false }
  const over = (x: typeof fwd) => Math.max(0, x.atVehicle - END_AT_M) + Math.max(0, x.atEingang - END_AT_M)
  return over(rev) < over(fwd) ? rev : fwd
}
const connects = (x: ReturnType<typeof lineMiss>) => x.atVehicle <= END_AT_M && x.atEingang <= END_AT_M
/** a plain arrowhead – the Entwicklungsgrenze («Pfeil mit Stopp») and the Teilstück say other things */
const hasArrow = (l: Drawing) => !!l.arrow && !l.arrowStop && !l.teilstueck

/** The Leitung the operator works on: the last one that joins Fahrzeug and Eingang, else the last one. */
function leitungOf(snap: Snapshot, vehicle: Entity, eingang: Entity) {
  const ls = lines(snap.drawings).map((l) => ({ l, x: lineMiss(l, vehicle, eingang) }))
  const joined = ls.filter((v) => connects(v.x))
  return { done: joined.find((v) => v.x.forward && hasArrow(v.l)), joined: joined[joined.length - 1], last: ls[ls.length - 1] }
}

function checkLeitung(snap: Snapshot, site: Site): GoalState {
  const eingang = site.eingang
  if (!eingang) return missing(appConfig.copy.ueben.site.eingang)
  const v = site.h1 ? vehicleAt(snap.entities, site.h1) : null
  if (!v) return { s: 'open' }
  const { done, joined, last } = leitungOf(snap, v.e, eingang)
  if (done) return { s: 'ok' }
  if (joined) return { s: 'wrong', reason: hasArrow(joined.l) ? C().arrowBack : C().noArrow }
  if (!last) return { s: 'open' }
  if (last.x.atVehicle > END_AT_M) return { s: 'wrong', reason: fillTemplate(C().startFar, { m: Math.round(last.x.atVehicle) }) }
  return { s: 'wrong', reason: fillTemplate(C().endFar, { m: Math.round(last.x.atEingang) }) }
}

const ADD = '.vrail [data-tool="symbol"]'

function hint(snap: Snapshot, ui: UiState, site: Site, goal: number): Hint | null {
  const h = C().hint
  if (ui.mode !== 'map') return { anchor: { kind: 'control', sel: '.nav-item[data-mode="map"]' }, words: h.karte }
  if (!site.h1 || !site.eingang) return null
  const spot = besideH1(site.h1.coord)
  const v = vehicleAt(snap.entities, site.h1)
  if (goal === 0) {
    if (v) return { anchor: { kind: 'map', at: v.e.coord }, words: h.drag, gesture: { kind: 'drag', from: v.e.coord, to: spot } }
    if (ui.tool === 'symbol' && ui.pending === vehicleName()) return { anchor: { kind: 'map', at: spot }, words: h.tapBeside, gesture: { kind: 'tap', at: spot } }
    if (ui.paletteOpen) return { anchor: { kind: 'control', sel: `[data-sym="${vehicleName()}"]` }, words: h.pick }
    return { anchor: { kind: 'control', sel: ADD }, words: ui.phone ? h.addPhone : h.addTablet, gesture: { kind: 'tap', at: spot } }
  }
  const from = v?.e.coord ?? spot
  const draw = { kind: 'drag' as const, from, to: site.eingang.coord }
  // a Leitung that joins the two but lacks its arrow, or runs the wrong way: its editor's controls
  const joined = v ? leitungOf(snap, v.e, site.eingang).joined : undefined
  if (joined) {
    if (ui.selectedDrawingId === joined.l.id) {
      return hasArrow(joined.l)
        ? { anchor: { kind: 'control', sel: '[data-field="lineReverse"] button' }, words: h.reverse }
        : { anchor: { kind: 'control', sel: '[data-field="lineEnd"] [data-value="arrow"]' }, words: h.arrow }
    }
    const mid = midCoord(endOf(joined.l, 'start'), endOf(joined.l, 'end'))
    return { anchor: { kind: 'map', at: mid }, words: h.lineTap, gesture: { kind: 'tap', at: mid } }
  }
  if (ui.tool === 'line') return { anchor: { kind: 'map', at: from }, words: h.lineDraw, gesture: draw }
  if (ui.phone && ui.paletteOpen) return { anchor: { kind: 'control', sel: '.sym-modal [data-tool="line"]' }, words: h.linePick }
  const words = lines(snap.drawings).length ? h.lineFix : ui.phone ? h.linePhone : h.lineTablet
  return { anchor: { kind: 'control', sel: ui.phone ? ADD : '.vrail [data-tool="line"]' }, words, gesture: draw }
}

function solve(snap: Snapshot, site: Site, api: SolveApi): void {
  if (!site.h1 || !site.eingang) return
  const spot = besideH1(site.h1.coord)
  const v = vehicleAt(snap.entities, site.h1)
  let vehicle: Entity
  if (v) {
    vehicle = v.d <= NEAR_M ? v.e : { ...v.e, coord: spot }
    if (vehicle !== v.e) api.patchEntity(v.e.id, { coord: spot })
  } else {
    vehicle = { id: newId('p'), kind: 'symbol', layer: appConfig.gps.layerId, coord: spot, ...seedSymbolProps(vehicleName(), []) }
    api.addEntity(vehicle)
  }
  const now = { ...snap, entities: [...snap.entities.filter((e) => e.id !== vehicle.id), vehicle] }
  const { done, joined } = leitungOf(now, vehicle, site.eingang)
  if (done) return
  if (joined) {
    // the Leitung is there: give it its arrow, at the Eingang's end (a backwards one is turned round)
    const l = joined.l
    api.patchDrawing(l.id, joined.x.forward
      ? { arrow: true, arrowStop: undefined, teilstueck: undefined }
      : { arrow: true, arrowStop: undefined, teilstueck: undefined, coords: [...l.coords].reverse(), startAttachment: l.endAttachment, endAttachment: l.startAttachment })
    return
  }
  api.addLine([vehicle.coord, site.eingang.coord], { startAttachment: { target: { kind: 'object', id: vehicle.id }, routing: 'direct' } }, { arrow: true })
}

/** A second run starts from the problem: every placed Fahrzeug and every Leitung touching one
 *  leave the Lage (one undoable commit). */
function prepare(doc: { entities: Entity[]; drawings: Drawing[] }) {
  const gone = doc.entities.filter(isVehicle)
  if (!gone.length) return doc
  const ids = new Set(gone.map((e) => e.id))
  const touches = (l: Drawing) =>
    [l.startAttachment, l.endAttachment].some((a) => a?.target.kind === 'object' && ids.has(a.target.id))
    || gone.some((e) => haversineM(l.coords[0], e.coord) <= END_AT_M || haversineM(l.coords[l.coords.length - 1], e.coord) <= END_AT_M)
  return { entities: doc.entities.filter((e) => !ids.has(e.id)), drawings: doc.drawings.filter((l) => !(l.kind === 'line' && touches(l))) }
}

/** the site – H1, the Eingang and the whole Übungsgebäude – plus the Fahrzeug and the Leitung placed */
function focus(site: Site, snap: Snapshot): LngLat[] {
  const pts = [site.h1?.coord, site.eingang?.coord].filter((c): c is LngLat => !!c)
  pts.push(...(snap.drawings.find((d) => d.id === SITE_IDS.gebaeude)?.coords ?? []))
  const v = site.h1 ? vehicleAt(snap.entities, site.h1) : null
  if (v) pts.push(v.e.coord)
  if (v && site.eingang) {
    const { last } = leitungOf(snap, v.e, site.eingang)
    if (last) pts.push(endOf(last.l, 'start'), endOf(last.l, 'end'))
  }
  return pts
}

export const fahrzeugLeitung = {
  id: 'fahrzeugLeitung',
  goals: [{ id: 'fahrzeug', check: checkVehicle }, { id: 'leitung', check: checkLeitung }],
  focus,
  hint,
  solve,
  prepare,
} as const satisfies Drill
