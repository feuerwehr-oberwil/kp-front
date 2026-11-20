import { describe, expect, it } from 'vitest'
import { appConfig } from '../../../config/appConfig'
import type { Doc } from '../../workspace'
import type { Drawing } from '../../../types'
import { offsetM, siteOf, siteScene } from '../site'
import { fahrzeug } from './fahrzeug'
import { leitung } from './leitung'
import { loesen } from './loesen'
import { punkte } from './punkte'
import { lines, vehicleAt, withLeitung, withVehicle, withZubringer } from './scene'
import { verbinden } from './verbinden'

// the reasons a goal gives, and the changes the later goals read – the chain itself (setup and
// «Lösung» of every step) is lib/ueben/catalogue.test
const C = appConfig.copy.ueben.topics.karte.steps
const scene = (): Doc => siteScene([7.55, 47.51])
const site = (d: Doc) => siteOf(d.entities)
const check = (step: { goals: readonly { check: (snap: Doc, s: ReturnType<typeof siteOf>, since: Doc) => unknown }[] }, i: number, d: Doc, since: Doc = d) => step.goals[i].check(d, site(d), since)
const patchLine = (d: Doc, id: string, patch: Partial<Drawing>): Doc => ({ ...d, drawings: d.drawings.map((l) => (l.id === id ? { ...l, ...patch } : l)) })
const vehicle = (d: Doc) => vehicleAt(d.entities, site(d).h1!)!.e
const theLine = (d: Doc) => lines(d.drawings)[0]

describe('Üben · Karte · Fahrzeug', () => {
  it('lenient: any Fahrzeug near H1 counts, also on top of it; one far off says how far', () => {
    const d = withVehicle(scene(), site(scene()))
    const move = (east: number): Doc => ({ ...d, entities: d.entities.map((e) => (e.id === vehicle(d).id ? { ...e, coord: offsetM(site(d).h1!.coord, east, 0) } : e)) })
    expect(check(fahrzeug, 0, move(0))).toEqual({ s: 'ok' })
    expect(check(fahrzeug, 0, move(35))).toEqual({ s: 'ok' })
    expect(check(fahrzeug, 0, move(80))).toEqual({ s: 'wrong', reason: C.fahrzeug.far.replace('{m}', '80') })
  })
})

describe('Üben · Karte · Leitung', () => {
  const d = withLeitung(scene(), site(scene()))
  it('the arrow is checked: missing, or pointing at the Fahrzeug', () => {
    const l = theLine(d)
    expect(check(leitung, 0, d)).toEqual({ s: 'ok' })
    expect(check(leitung, 0, patchLine(d, l.id, { arrow: undefined }))).toEqual({ s: 'wrong', reason: C.leitung.noArrow })
    const back = patchLine(d, l.id, { coords: [...l.coords].reverse(), startAttachment: undefined, endAttachment: l.startAttachment })
    expect(check(leitung, 0, back)).toEqual({ s: 'wrong', reason: C.leitung.arrowBack })
  })
  it('a line that stops short says by how much', () => {
    const l = theLine(d)
    const short = patchLine(d, l.id, { coords: [l.coords[0], offsetM(site(d).eingang!.coord, 0, -30)] })
    expect(check(leitung, 0, short)).toEqual({ s: 'wrong', reason: C.leitung.endFar.replace('{m}', '30') })
  })
})

describe('Üben · Karte · Verbinden', () => {
  const d = withZubringer(scene(), site(scene()))
  const z = lines(d.drawings).find((l) => !l.arrow)!
  it('a Leitung that only LIES at the Fahrzeug is not connected – and the goal names the loose end', () => {
    expect(check(verbinden, 0, d)).toEqual({ s: 'ok' })
    expect(check(verbinden, 0, patchLine(d, z.id, { endAttachment: undefined }))).toEqual({ s: 'wrong', reason: C.verbinden.looseVehicle })
    expect(check(verbinden, 0, patchLine(d, z.id, { startAttachment: undefined }))).toEqual({ s: 'wrong', reason: C.verbinden.looseH1 })
  })
  it('«verschoben» is a change: the Fahrzeug against where it stood when the goal\'s turn began', () => {
    const moved: Doc = { ...d, entities: d.entities.map((e) => (e.id === vehicle(d).id ? { ...e, coord: offsetM(e.coord, 10, 0) } : e)) }
    expect(check(verbinden, 1, d, d)).toEqual({ s: 'open' })
    expect(check(verbinden, 1, moved, d)).toEqual({ s: 'ok' })
  })
})

describe('Üben · Karte · Punkte, Lösen', () => {
  const d = withZubringer(scene(), site(scene()))
  const l = theLine(d)
  it('a point more, then a point fewer – each against the Lage of its own turn', () => {
    const more = patchLine(d, l.id, { coords: [l.coords[0], offsetM(l.coords[0], 5, 5), l.coords[1]] })
    expect(check(punkte, 0, d, d)).toEqual({ s: 'open' })
    expect(check(punkte, 0, more, d)).toEqual({ s: 'ok' })
    expect(check(punkte, 1, more, more)).toEqual({ s: 'open' })
    expect(check(punkte, 1, d, more)).toEqual({ s: 'ok' })
  })
  it('let go, removed, back', () => {
    const freed = patchLine(d, l.id, { startAttachment: undefined })
    const gone: Doc = { ...freed, drawings: freed.drawings.filter((x) => x.id !== l.id) }
    expect(check(loesen, 0, d, d)).toEqual({ s: 'open' })
    expect(check(loesen, 0, freed, d)).toEqual({ s: 'ok' })
    expect(check(loesen, 1, freed, freed)).toEqual({ s: 'open' })
    expect(check(loesen, 1, gone, freed)).toEqual({ s: 'ok' })
    expect(check(loesen, 2, gone, gone)).toEqual({ s: 'open' })
    expect(check(loesen, 2, freed, gone)).toEqual({ s: 'ok' })
  })
})
