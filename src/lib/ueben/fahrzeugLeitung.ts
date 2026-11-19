// «Üben» · Karte & Wasser 1: «Fahrzeug mit Leitung» – the TLF BESIDE Hydrant H1, a Leitung WITH
// ITS ARROW from the TLF to the Eingang (the owner's own example, 19.11.2026: «place a vehicle with
// a hose attached»; round 2: beside the hydrant, not on it, and the arrow is checked – it is what
// says where the water flows).
//
// A TLF is the generic Fahrzeug (appConfig.symbols.vehicleName) named «TLF» – the palette places a
// «Fahrzeug» and its Bezeichnung names it, exactly as on an Einsatz. A Leitung end counts as AT a
// place when it is coupled to it (the magnetic attachment) or lies within a few metres of it. The
// arrow is the line's `arrow` at its LAST point (types · Drawing.arrow), so the line must run TLF →
// Eingang with `arrow` on; drawn the other way round, «Richtung umkehren» turns it.

import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../format'
import { haversineM, midCoord } from '../geo'
import { newId } from '../ids'
import { seedSymbolProps } from '../symbols'
import type { Drawing, Entity, LngLat } from '../../types'
import type { Drill, GoalState, Hint, Snapshot, SolveApi, UiState } from './model'
import { offsetM, SITE_IDS, type Site } from './site'

/** the TLF stands BESIDE H1: not on the hydrant (closer than this) … */
export const TLF_MIN_M = 8
/** … and not so far that the Zuleitung to it is a Leitung of its own */
export const TLF_MAX_M = 25
/** how close a Leitung end must lie to the TLF / the Eingang when it is not coupled */
export const END_AT_M = 15

const C = () => appConfig.copy.ueben.drills.fahrzeugLeitung
const vehicleName = () => appConfig.symbols.vehicleName

const isVehicle = (e: Entity) => e.kind === 'symbol' && e.symbol === vehicleName() && !e.live
const isTlf = (e: Entity) => isVehicle(e) && /\bTLF\b/i.test(e.label ?? '')
const unnamed = (e: Entity) => isVehicle(e) && !(e.label ?? '').trim()

/** Where «Zeigen» and «Lösung» put the TLF: 12 m from H1, on the Eingang's side. */
export const besideH1 = (h1: LngLat): LngLat => offsetM(h1, 11, 5)

/** The vehicle the drill is about: the TLF nearest H1, else an unnamed Fahrzeug nearest H1
 *  (one just placed, its Bezeichnung still open). An MTF is not a TLF, so it is never picked. */
export function tlfCandidate(entities: readonly Entity[], h1: Entity): { e: Entity; named: boolean; d: number } | null {
  const near = (xs: Entity[]) => xs.map((e) => ({ e, d: haversineM(e.coord, h1.coord) })).sort((a, b) => a.d - b.d)[0]
  const tlf = near(entities.filter(isTlf))
  if (tlf) return { ...tlf, named: true }
  const any = near(entities.filter(unnamed))
  return any ? { ...any, named: false } : null
}

const missing = (name: string): GoalState => ({ s: 'wrong', reason: fillTemplate(appConfig.copy.ueben.siteMissing, { name }) })

function checkTlf(snap: Snapshot, site: Site): GoalState {
  if (!site.h1) return missing(appConfig.copy.ueben.site.hydrant)
  const c = tlfCandidate(snap.entities, site.h1)
  if (!c) return { s: 'open' }
  const m = Math.round(c.d)
  if (c.d < TLF_MIN_M) return { s: 'wrong', reason: C().tlfOnTop }
  if (c.d > TLF_MAX_M) return { s: 'wrong', reason: fillTemplate(c.named ? C().tlfFar : C().vehicleFar, { m }) }
  // beside H1, the Bezeichnung still open: not wrong yet, only not done
  return c.named ? { s: 'ok' } : { s: 'open' }
}

const lines = (drawings: readonly Drawing[]) => drawings.filter((d) => d.kind === 'line' && d.role !== 'wand' && d.coords.length >= 2)
const endOf = (l: Drawing, end: 'start' | 'end') => (end === 'start' ? l.coords[0] : l.coords[l.coords.length - 1])

/** metres from the line's `end` to `target` – 0 when that end is coupled to it */
function endMiss(line: Drawing, end: 'start' | 'end', target: Entity): number {
  const att = end === 'start' ? line.startAttachment : line.endAttachment
  if (att?.target.kind === 'object' && att.target.id === target.id) return 0
  return haversineM(endOf(line, end), target.coord)
}

/** How far a line misses «TLF → Eingang» in its better orientation, and which way it runs:
 *  `forward` = it starts at the TLF, so its arrow (at the last point) is at the Eingang. */
export function lineMiss(line: Drawing, tlf: Entity, eingang: Entity): { atTlf: number; atEingang: number; forward: boolean } {
  const fwd = { atTlf: endMiss(line, 'start', tlf), atEingang: endMiss(line, 'end', eingang), forward: true }
  const rev = { atTlf: endMiss(line, 'end', tlf), atEingang: endMiss(line, 'start', eingang), forward: false }
  const over = (x: typeof fwd) => Math.max(0, x.atTlf - END_AT_M) + Math.max(0, x.atEingang - END_AT_M)
  return over(rev) < over(fwd) ? rev : fwd
}
const connects = (x: ReturnType<typeof lineMiss>) => x.atTlf <= END_AT_M && x.atEingang <= END_AT_M
/** a plain arrowhead – the Entwicklungsgrenze («Pfeil mit Stopp») and the Teilstück say other things */
const hasArrow = (l: Drawing) => !!l.arrow && !l.arrowStop && !l.teilstueck

/** The Leitung the operator works on: the last one that joins TLF and Eingang, else the last one. */
function leitungOf(snap: Snapshot, tlf: Entity, eingang: Entity) {
  const ls = lines(snap.drawings).map((l) => ({ l, x: lineMiss(l, tlf, eingang) }))
  const joined = ls.filter((v) => connects(v.x))
  return { done: joined.find((v) => v.x.forward && hasArrow(v.l)), joined: joined[joined.length - 1], last: ls[ls.length - 1] }
}

function checkLeitung(snap: Snapshot, site: Site): GoalState {
  const eingang = site.eingang
  if (!eingang) return missing(appConfig.copy.ueben.site.eingang)
  const tlf = site.h1 ? tlfCandidate(snap.entities, site.h1) : null
  if (!tlf?.named) return { s: 'open' }
  const { done, joined, last } = leitungOf(snap, tlf.e, eingang)
  if (done) return { s: 'ok' }
  if (joined) return { s: 'wrong', reason: hasArrow(joined.l) ? C().arrowBack : C().noArrow }
  if (!last) return { s: 'open' }
  if (last.x.atTlf > END_AT_M) return { s: 'wrong', reason: fillTemplate(C().startFar, { m: Math.round(last.x.atTlf) }) }
  return { s: 'wrong', reason: fillTemplate(C().endFar, { m: Math.round(last.x.atEingang) }) }
}

const ADD = '.vrail [data-tool="symbol"]'

function hint(snap: Snapshot, ui: UiState, site: Site, goal: number): Hint | null {
  const h = C().hint
  if (ui.mode !== 'map') return { anchor: { kind: 'control', sel: '.nav-item[data-mode="map"]' }, words: h.karte }
  if (!site.h1 || !site.eingang) return null
  const spot = besideH1(site.h1.coord)
  const cand = tlfCandidate(snap.entities, site.h1)
  if (goal === 0) {
    if (cand && (cand.d < TLF_MIN_M || cand.d > TLF_MAX_M)) return { anchor: { kind: 'map', at: cand.e.coord }, words: h.drag, gesture: { kind: 'drag', from: cand.e.coord, to: spot } }
    if (cand && !cand.named) {
      return ui.selectedId === cand.e.id
        ? { anchor: { kind: 'control', sel: '[data-field="label"]' }, words: h.name }
        : { anchor: { kind: 'map', at: cand.e.coord }, words: h.tapVehicle, gesture: { kind: 'tap', at: cand.e.coord } }
    }
    if (ui.tool === 'symbol' && ui.pending === vehicleName()) return { anchor: { kind: 'map', at: spot }, words: h.tapBeside, gesture: { kind: 'tap', at: spot } }
    if (ui.paletteOpen) return { anchor: { kind: 'control', sel: `[data-sym="${vehicleName()}"]` }, words: h.pick }
    return { anchor: { kind: 'control', sel: ADD }, words: ui.phone ? h.addPhone : h.addTablet, gesture: { kind: 'tap', at: spot } }
  }
  const from = cand?.e.coord ?? spot
  const draw = { kind: 'drag' as const, from, to: site.eingang.coord }
  // a Leitung that joins the two but lacks its arrow, or runs the wrong way: its editor's controls
  const joined = cand ? leitungOf(snap, cand.e, site.eingang).joined : undefined
  if (joined) {
    if (ui.selectedDrawingId === joined.l.id) {
      return hasArrow(joined.l)
        ? { anchor: { kind: 'control', sel: '[data-field="lineReverse"]' }, words: h.reverse }
        : { anchor: { kind: 'control', sel: '[data-field="lineEnd"]' }, words: h.arrow }
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
  const cand = tlfCandidate(snap.entities, site.h1)
  let tlf: Entity
  if (cand) {
    const beside = cand.d >= TLF_MIN_M && cand.d <= TLF_MAX_M
    tlf = { ...cand.e, coord: beside ? cand.e.coord : spot, label: 'TLF' }
    if (!beside || !cand.named) api.patchEntity(cand.e.id, { coord: tlf.coord, label: 'TLF' })
  } else {
    tlf = { id: newId('p'), kind: 'symbol', layer: appConfig.gps.layerId, coord: spot, ...seedSymbolProps(vehicleName(), []), label: 'TLF' }
    api.addEntity(tlf)
  }
  const now = { ...snap, entities: [...snap.entities.filter((e) => e.id !== tlf.id), tlf] }
  const { done, joined } = leitungOf(now, tlf, site.eingang)
  if (done) return
  if (joined) {
    // the Leitung is there: give it its arrow, at the Eingang's end (a backwards one is turned round)
    const l = joined.l
    api.patchDrawing(l.id, joined.x.forward
      ? { arrow: true, arrowStop: undefined, teilstueck: undefined }
      : { arrow: true, arrowStop: undefined, teilstueck: undefined, coords: [...l.coords].reverse(), startAttachment: l.endAttachment, endAttachment: l.startAttachment })
    return
  }
  api.addLine([tlf.coord, site.eingang.coord], { startAttachment: { target: { kind: 'object', id: tlf.id }, routing: 'direct' } }, { arrow: true })
}

/** A second run starts from the problem: the TLF and Fahrzeuge placed for it and every Leitung
 *  touching them leave the Lage (one undoable commit). */
function prepare(doc: { entities: Entity[]; drawings: Drawing[] }) {
  const gone = doc.entities.filter((e) => isTlf(e) || unnamed(e))
  if (!gone.length) return doc
  const ids = new Set(gone.map((e) => e.id))
  const touches = (l: Drawing) =>
    [l.startAttachment, l.endAttachment].some((a) => a?.target.kind === 'object' && ids.has(a.target.id))
    || gone.some((e) => haversineM(l.coords[0], e.coord) <= END_AT_M || haversineM(l.coords[l.coords.length - 1], e.coord) <= END_AT_M)
  return { entities: doc.entities.filter((e) => !ids.has(e.id)), drawings: doc.drawings.filter((l) => !(l.kind === 'line' && touches(l))) }
}

/** the site – H1, the Eingang and the whole Übungsgebäude – plus the TLF and the Leitung placed */
function focus(site: Site, snap: Snapshot): LngLat[] {
  const pts = [site.h1?.coord, site.eingang?.coord].filter((c): c is LngLat => !!c)
  pts.push(...(snap.drawings.find((d) => d.id === SITE_IDS.gebaeude)?.coords ?? []))
  const cand = site.h1 ? tlfCandidate(snap.entities, site.h1) : null
  if (cand) pts.push(cand.e.coord)
  if (cand && site.eingang) {
    const { last } = leitungOf(snap, cand.e, site.eingang)
    if (last) pts.push(endOf(last.l, 'start'), endOf(last.l, 'end'))
  }
  return pts
}

export const fahrzeugLeitung: Drill = {
  id: 'fahrzeugLeitung',
  module: 'karteWasser',
  goals: [{ id: 'tlf', check: checkTlf }, { id: 'leitung', check: checkLeitung }],
  focus,
  hint,
  solve,
  prepare,
}
