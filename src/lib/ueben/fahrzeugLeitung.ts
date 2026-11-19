// «Üben» · Karte & Wasser 1: «Fahrzeug mit Leitung» – the TLF at Hydrant H1, a Leitung from it
// to the Eingang (the owner's own example, 19.11.2026: «place a vehicle with a hose attached»).
//
// A TLF is the generic Fahrzeug (appConfig.symbols.vehicleName) named «TLF» – the palette places a
// «Fahrzeug» and its Bezeichnung names it, exactly as on an Einsatz. A Leitung end counts as AT a
// place when it is coupled to it (the magnetic attachment) or lies within a few metres of it.

import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../format'
import { haversineM } from '../geo'
import { newId } from '../ids'
import { seedSymbolProps } from '../symbols'
import type { Drawing, Entity, LngLat } from '../../types'
import type { Drill, GoalState, Hint, Snapshot, UiState } from './model'
import { offsetM, type Site } from './site'

/** how close the TLF must stand to H1 – a Fahrzeug at a hydrant stands beside it, not on it */
export const TLF_AT_H1_M = 25
/** how close a Leitung end must lie to the TLF / the Eingang when it is not coupled */
export const END_AT_M = 15

const C = () => appConfig.copy.ueben.drills.fahrzeugLeitung
const vehicleName = () => appConfig.symbols.vehicleName

const isVehicle = (e: Entity) => e.kind === 'symbol' && e.symbol === vehicleName() && !e.live
const isTlf = (e: Entity) => isVehicle(e) && /\bTLF\b/i.test(e.label ?? '')
const unnamed = (e: Entity) => isVehicle(e) && !(e.label ?? '').trim()

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
  if (c.named) return c.d <= TLF_AT_H1_M ? { s: 'ok' } : { s: 'wrong', reason: fillTemplate(C().tlfFar, { m }) }
  return c.d <= TLF_AT_H1_M ? { s: 'open', note: C().nameIt } : { s: 'wrong', reason: fillTemplate(C().vehicleFar, { m }) }
}

const lines = (drawings: readonly Drawing[]) => drawings.filter((d) => d.kind === 'line' && d.role !== 'wand' && d.coords.length >= 2)

/** metres from the line's `end` to `target` – 0 when that end is coupled to it */
function endMiss(line: Drawing, end: 'start' | 'end', target: Entity): number {
  const att = end === 'start' ? line.startAttachment : line.endAttachment
  if (att?.target.kind === 'object' && att.target.id === target.id) return 0
  const p = end === 'start' ? line.coords[0] : line.coords[line.coords.length - 1]
  return haversineM(p, target.coord)
}

/** How far a line misses «TLF → Eingang», in its better orientation (water may be drawn either way). */
export function lineMiss(line: Drawing, tlf: Entity, eingang: Entity): { atTlf: number; atEingang: number } {
  const fwd = { atTlf: endMiss(line, 'start', tlf), atEingang: endMiss(line, 'end', eingang) }
  const rev = { atTlf: endMiss(line, 'end', tlf), atEingang: endMiss(line, 'start', eingang) }
  const over = (x: typeof fwd) => Math.max(0, x.atTlf - END_AT_M) + Math.max(0, x.atEingang - END_AT_M)
  return over(rev) < over(fwd) ? rev : fwd
}

function checkLeitung(snap: Snapshot, site: Site): GoalState {
  if (!site.eingang) return missing(appConfig.copy.ueben.site.eingang)
  const tlf = site.h1 ? tlfCandidate(snap.entities, site.h1) : null
  if (!tlf?.named) return { s: 'open', note: C().tlfFirst }
  const ls = lines(snap.drawings)
  if (!ls.length) return { s: 'open' }
  const misses = ls.map((l) => lineMiss(l, tlf.e, site.eingang!))
  if (misses.some((x) => x.atTlf <= END_AT_M && x.atEingang <= END_AT_M)) return { s: 'ok' }
  // the reason speaks about the line drawn last – the one the operator is looking at
  const last = misses[misses.length - 1]
  if (last.atTlf > END_AT_M) return { s: 'wrong', reason: fillTemplate(C().startFar, { m: Math.round(last.atTlf) }) }
  return { s: 'wrong', reason: fillTemplate(C().endFar, { m: Math.round(last.atEingang) }) }
}

const ADD = '.vrail [data-tool="symbol"]'
const toMap: Hint = { anchor: { kind: 'control', sel: '.nav-item[data-mode="map"]' }, words: '' }

function hint(snap: Snapshot, ui: UiState, site: Site, goal: number): Hint | null {
  const h = C().hint
  if (ui.mode !== 'map') return { ...toMap, words: h.karte }
  if (!site.h1 || !site.eingang) return null
  const h1 = site.h1.coord
  const cand = tlfCandidate(snap.entities, site.h1)
  if (goal === 0) {
    if (cand && cand.d > TLF_AT_H1_M) return { anchor: { kind: 'map', at: cand.e.coord }, words: h.drag, gesture: { kind: 'drag', from: cand.e.coord, to: h1 } }
    if (cand && !cand.named) {
      return ui.selectedId === cand.e.id
        ? { anchor: { kind: 'control', sel: '[data-field="label"]' }, words: h.name }
        : { anchor: { kind: 'map', at: cand.e.coord }, words: h.tapVehicle, gesture: { kind: 'tap', at: cand.e.coord } }
    }
    if (ui.tool === 'symbol' && ui.pending === vehicleName()) return { anchor: { kind: 'map', at: h1 }, words: h.tapH1, gesture: { kind: 'tap', at: h1 } }
    if (ui.paletteOpen) return { anchor: { kind: 'control', sel: `[data-sym="${vehicleName()}"]` }, words: h.pick }
    return { anchor: { kind: 'control', sel: ADD }, words: ui.phone ? h.addPhone : h.addTablet, gesture: { kind: 'tap', at: h1 } }
  }
  const from = cand?.e.coord ?? h1
  const draw = { kind: 'drag' as const, from, to: site.eingang.coord }
  if (ui.tool === 'line') return { anchor: { kind: 'map', at: from }, words: h.lineDraw, gesture: draw }
  if (ui.phone && ui.paletteOpen) return { anchor: { kind: 'control', sel: '.sym-modal [data-tool="line"]' }, words: h.linePick }
  const words = lines(snap.drawings).length ? h.lineFix : ui.phone ? h.linePhone : h.lineTablet
  return { anchor: { kind: 'control', sel: ui.phone ? ADD : '.vrail [data-tool="line"]' }, words, gesture: draw }
}

function solve(snap: Snapshot, site: Site, api: Parameters<Drill['solve']>[2]): void {
  if (!site.h1 || !site.eingang) return
  // beside the hydrant, on the Eingang's side: the Leitung then runs clear of the H1 glyph
  const spot = offsetM(site.h1.coord, 8, 4)
  const cand = tlfCandidate(snap.entities, site.h1)
  let tlf: Entity
  if (cand) {
    tlf = { ...cand.e, coord: cand.d <= TLF_AT_H1_M ? cand.e.coord : spot, label: 'TLF' }
    if (cand.d > TLF_AT_H1_M || !cand.named) api.patchEntity(cand.e.id, { coord: tlf.coord, label: 'TLF' })
  } else {
    tlf = { id: newId('p'), kind: 'symbol', layer: appConfig.gps.layerId, coord: spot, ...seedSymbolProps(vehicleName(), []), label: 'TLF' }
    api.addEntity(tlf)
  }
  if (checkLeitung({ ...snap, entities: [...snap.entities.filter((e) => e.id !== tlf.id), tlf] }, site).s !== 'ok') {
    api.addLine([tlf.coord, site.eingang.coord], { startAttachment: { target: { kind: 'object', id: tlf.id }, routing: 'direct' } })
  }
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

export const fahrzeugLeitung: Drill = {
  id: 'fahrzeugLeitung',
  module: 'karteWasser',
  goals: [{ id: 'tlf', check: checkTlf }, { id: 'leitung', check: checkLeitung }],
  focus: (site) => [site.h1?.coord, site.eingang?.coord].filter((c): c is LngLat => !!c),
  hint,
  solve,
  prepare,
}
