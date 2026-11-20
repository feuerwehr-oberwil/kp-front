// «Üben» · Karte & Zeichnen: what the topic's steps read off the Lage and build into it.
//
// The scene the chain works on: a Fahrzeug by Hydrant H1, the LEITUNG from the Fahrzeug to the
// Eingang (with its arrow) and the ZUBRINGER from H1 to the Fahrzeug (coupled at both ends).
//
// Lenient (owner pick, 20.11.2026 – lib/ueben/model): any placed Fahrzeug counts, named or not,
// anywhere near H1 – also on top of it. A Leitung end counts as AT a place when it is coupled to it
// (the magnetic attachment) or lies within a few metres of it.
//
// The builders (`withVehicle` …) are what a step's `setup` and «Lösung» share: each returns the
// Lage with that piece in it, unchanged when it already is.

import { appConfig } from '../../../config/appConfig'
import { fillTemplate } from '../../format'
import { haversineM, midCoord } from '../../geo'
import { newId } from '../../ids'
import { objectAttachment } from '../../lineAttachments'
import { DEFAULT_INK } from '../../lineStyle'
import { seedSymbolProps } from '../../symbols'
import type { Doc } from '../../workspace'
import type { Drawing, Entity, LineEndpoint, LngLat } from '../../../types'
import { control, type GoalState, type Hint, type Snapshot, type UiState } from '../model'
import { offsetM, SITE_IDS, type Site } from '../site'

/** «by H1»: closer than this. The Eingang is some 50 m from H1 – a Fahrzeug parked there is not
 *  at the hydrant. */
export const NEAR_M = 40
/** how close a Leitung end must lie to a place when it is not coupled to it */
export const END_AT_M = 15
/** a Fahrzeug closer to H1 than this stands ON it: the two cannot be told apart under a finger */
const APART_M = 8

const T = () => appConfig.copy.ueben.topics.karte
export const vehicleName = () => appConfig.symbols.vehicleName
export const isVehicle = (e: Entity) => e.kind === 'symbol' && e.symbol === vehicleName() && !e.live

/** Where «Zeigen» and «Lösung» put the Fahrzeug: 12 m from H1, on the Eingang's side. */
export const besideH1 = (h1: LngLat): LngLat => offsetM(h1, 11, 5)

/** The Fahrzeug the topic is about: the placed one nearest H1, and how far it stands from it. */
export function vehicleAt(entities: readonly Entity[], h1: Entity): { e: Entity; d: number } | null {
  return entities.filter(isVehicle).map((e) => ({ e, d: haversineM(e.coord, h1.coord) })).sort((a, b) => a.d - b.d)[0] ?? null
}

export const missing = (name: string): GoalState => ({ s: 'wrong', reason: fillTemplate(appConfig.copy.ueben.siteMissing, { name }) })

export const lines = (drawings: readonly Drawing[]) => drawings.filter((d) => d.kind === 'line' && d.role !== 'wand' && d.coords.length >= 2)
export const endOf = (l: Drawing, end: LineEndpoint) => (end === 'start' ? l.coords[0] : l.coords[l.coords.length - 1])
const attachmentOf = (l: Drawing, end: LineEndpoint) => (end === 'start' ? l.startAttachment : l.endAttachment)
/** is the line's `end` coupled to `target`? */
export const coupled = (l: Drawing, end: LineEndpoint, target: Entity) => {
  const a = attachmentOf(l, end)
  return a?.target.kind === 'object' && a.target.id === target.id
}
/** metres from the line's `end` to `target` – 0 when that end is coupled to it */
const endMiss = (l: Drawing, end: LineEndpoint, target: Entity) => (coupled(l, end, target) ? 0 : haversineM(endOf(l, end), target.coord))

/** How far a line misses «a → b» in its better orientation, and which way it runs: `forward` = it
 *  starts at `a`, so its arrow (at the last point) is at `b`. */
export function lineMiss(l: Drawing, a: Entity, b: Entity): { atA: number; atB: number; forward: boolean } {
  const fwd = { atA: endMiss(l, 'start', a), atB: endMiss(l, 'end', b), forward: true }
  const rev = { atA: endMiss(l, 'end', a), atB: endMiss(l, 'start', b), forward: false }
  const over = (x: typeof fwd) => Math.max(0, x.atA - END_AT_M) + Math.max(0, x.atB - END_AT_M)
  return over(rev) < over(fwd) ? rev : fwd
}
export const joins = (x: ReturnType<typeof lineMiss>) => x.atA <= END_AT_M && x.atB <= END_AT_M
/** a plain arrowhead – the Entwicklungsgrenze («Pfeil mit Stopp») and the Teilstück say other things */
export const hasArrow = (l: Drawing) => !!l.arrow && !l.arrowStop && !l.teilstueck

/** The Leitung Fahrzeug → Eingang: `done` = it joins the two and its arrow is at the Eingang,
 *  `joined` = the last line that joins them, `last` = the last line at all. */
export function leitungOf(snap: Snapshot, vehicle: Entity, eingang: Entity) {
  const ls = lines(snap.drawings).map((l) => ({ l, x: lineMiss(l, vehicle, eingang) }))
  const joined = ls.filter((v) => joins(v.x))
  return { done: joined.find((v) => v.x.forward && hasArrow(v.l)), joined: joined[joined.length - 1], last: ls[ls.length - 1] }
}

/** The Zubringer H1 ↔ Fahrzeug: `coupled` = a line that hangs on both, `loose` = the last line
 *  that lies at both but hangs on only one or none – and the place it does not hang on. */
export function zubringerOf(snap: Snapshot, h1: Entity, vehicle: Entity): { coupled?: Drawing; loose?: { l: Drawing; free: 'h1' | 'vehicle' } } {
  const on = (l: Drawing, t: Entity) => coupled(l, 'start', t) || coupled(l, 'end', t)
  const ls = lines(snap.drawings)
  const both = ls.filter((l) => on(l, h1) && on(l, vehicle))
  if (both.length) return { coupled: both[both.length - 1] }
  const near = ls.filter((l) => joins(lineMiss(l, h1, vehicle)))
  const l = near[near.length - 1]
  return l ? { loose: { l, free: on(l, vehicle) ? 'h1' : 'vehicle' } } : {}
}

/** A point ON the line, for a tap that selects it: a middle point, or the middle of a straight one. */
export const onLine = (l: Drawing): LngLat => (l.coords.length > 2 ? l.coords[Math.floor(l.coords.length / 2)] : midCoord(l.coords[0], l.coords[1]))

// ── builders ────────────────────────────────────────────────────────────────────────────────────

const newVehicle = (at: LngLat): Entity => ({ id: newId('p'), kind: 'symbol', layer: appConfig.gps.layerId, coord: at, ...seedSymbolProps(vehicleName(), []) })
const newLine = (coords: LngLat[], props: Partial<Drawing>): Drawing => ({ id: newId('d'), kind: 'line', coords, color: DEFAULT_INK, width: 4, ...props })

/** A Fahrzeug by H1 – one that stands there stays, one far off is brought, none is placed. With
 *  `apart`, one standing ON the hydrant steps beside it (a Leitung between the two needs room). */
export function withVehicle(doc: Doc, site: Site, apart = false): Doc {
  if (!site.h1) return doc
  const v = vehicleAt(doc.entities, site.h1)
  const spot = besideH1(site.h1.coord)
  if (!v) return { ...doc, entities: [...doc.entities, newVehicle(spot)] }
  if (v.d <= NEAR_M && !(apart && v.d < APART_M)) return doc
  return { ...doc, entities: doc.entities.map((e) => (e.id === v.e.id ? { ...e, coord: spot } : e)) }
}

/** …and the Leitung with its arrow from that Fahrzeug to the Eingang, coupled to the Fahrzeug. A
 *  line that joins the two already gets its arrow, at the Eingang's end. */
export function withLeitung(doc: Doc, site: Site): Doc {
  const d = withVehicle(doc, site)
  const v = site.h1 ? vehicleAt(d.entities, site.h1) : null
  if (!v || !site.eingang) return d
  const { done, joined } = leitungOf(d, v.e, site.eingang)
  if (done) return d
  if (!joined) return { ...d, drawings: [...d.drawings, newLine([v.e.coord, site.eingang.coord], { arrow: true, startAttachment: objectAttachment(v.e.id) })] }
  const l = joined.l
  const turned: Drawing = joined.x.forward ? l : { ...l, coords: [...l.coords].reverse(), startAttachment: l.endAttachment, endAttachment: l.startAttachment }
  return { ...d, drawings: d.drawings.map((x) => (x.id === l.id ? { ...turned, arrow: true, arrowStop: undefined, teilstueck: undefined } : x)) }
}

/** …and the Zubringer from H1 to the Fahrzeug, coupled at both ends. */
export function withZubringer(doc: Doc, site: Site): Doc {
  const d = withLeitung(withVehicle(doc, site, true), site)
  const v = site.h1 ? vehicleAt(d.entities, site.h1) : null
  if (!v || !site.h1 || zubringerOf(d, site.h1, v.e).coupled) return d
  return { ...d, drawings: [...d.drawings, newLine([site.h1.coord, v.e.coord], { startAttachment: objectAttachment(site.h1.id), endAttachment: objectAttachment(v.e.id) })] }
}

/** The Lage without the lines `gone` names. */
export const withoutLines = (doc: Doc, gone: (l: Drawing) => boolean): Doc => {
  const drawings = doc.drawings.filter((l) => !(l.kind === 'line' && gone(l)))
  return drawings.length === doc.drawings.length ? doc : { ...doc, drawings }
}

// ── what every step's «Zeigen» shares ───────────────────────────────────────────────────────────

/** Not on the Karte yet: the ring stands on its tile. */
export const toKarte = (ui: UiState): Hint | null =>
  ui.mode === 'map' ? null : { anchor: control('.nav-item[data-mode="map"]'), words: T().hint.karte }

const ADD = '.vrail [data-tool="symbol"]'
export const ADD_TILE = ADD

/** The Linie tool, armed: the ring walks to it (a phone has it in «Hinzufügen»), then the map
 *  shows `draw`. */
export function drawLine(ui: UiState, draw: Extract<NonNullable<Hint['gesture']>, { kind: 'drag' }>, words: string): Hint {
  const h = T().hint
  if (ui.tool === 'line') return { anchor: { kind: 'map', at: draw.from }, words, gesture: draw }
  if (ui.phone && ui.paletteOpen) return { anchor: control('.sym-modal [data-tool="line"]'), words: h.linePick }
  return { anchor: control(ui.phone ? ADD : '.vrail [data-tool="line"]'), words: ui.phone ? h.linePhone : h.lineTablet, gesture: draw }
}

/** `l` selected (its sheet and its points are up): a tap on the line until it is. */
export const selectLine = (ui: UiState, l: Drawing): Hint | null =>
  ui.selectedDrawingId === l.id ? null : { anchor: { kind: 'map', at: onLine(l) }, words: T().hint.lineTap, gesture: { kind: 'tap', at: onLine(l) } }

/** the site – H1, the Eingang and the whole Übungsgebäude – plus the Fahrzeug and its lines */
export function focus(site: Site, snap: Snapshot): LngLat[] {
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
