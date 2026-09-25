import { describe, expect, it } from 'vitest'
import { fitSimilarity, type GeorefPair } from './georef'
import { applyBoardToObjects, applyDocToObjects, bakeGeoBody, sheetAnnos, viewsOf, type TacticalObject } from './tacticalObjects'
import {
  canBeDone, doneBadge, doneName, doneOf, donePlace, doneRowText, doneStateText, doneStatusText, doneWord,
  isFireFamily, markDone, reopenedRowText,
} from './objectDone'
import { symbolLegendText } from './symbols'
import { krokiEntity } from './krokiPayload'
import { planAnnosForPdf } from './reportPdfDirect'
import { annoLogName } from './drawingEdit'
import { formatTime } from './format'
import { appConfig } from '../config/appConfig'
import type { BoardAnno, Entity } from '../types'

/* «Gelöscht / erledigt» statt löschen (review item 21b, 24.09.2026). The EG Feuer of the Übung
 * on 23.09. was DELETED when it was out, and the Rapport's plan then showed no fire at all. These
 * pin the words, the record's shape across the two bodies, and what reaches paper. */

const AT = '2026-09-23T18:40:00.000Z'
const HHMM = formatTime(new Date(AT))
const feuer = { symbol: 'VKF Feuer', label: 'Feuer' }
const luefter = { symbol: 'VKF Luefter mobil', label: 'Lüfter' }

describe('the words — one key, a family switch', () => {
  it('a Feuer is «gelöscht», everything else «erledigt»', () => {
    expect(isFireFamily('VKF Feuer')).toBe(true)
    expect(isFireFamily('VKF Rauch')).toBe(false) // same category, but smoke is never «gelöscht»
    expect(doneWord('VKF Feuer')).toBe('Gelöscht')
    expect(doneWord('VKF Rettungen', 'inline')).toBe('erledigt')
  })

  it('states the set state and the legend status with the time', () => {
    expect(doneStateText({ ...feuer, done: { at: AT } })).toBe(`Gelöscht ${HHMM}`)
    expect(doneStateText({ ...luefter, done: { at: AT } })).toBe(`Erledigt ${HHMM}`)
    expect(doneStatusText({ ...feuer, done: { at: AT } })).toBe(`gelöscht ${HHMM}`)
    expect(doneStateText(feuer)).toBeNull()
    expect(doneBadge({ done: { at: AT } })).toBe(HHMM)
  })

  it('writes the Verlauf rows with what and where — the row’s own timestamp is the when', () => {
    expect(doneRowText('Feuer', 'EG', 'VKF Feuer')).toBe('Feuer EG gelöscht')
    expect(doneRowText('Lüfter', '', 'VKF Luefter mobil')).toBe('Lüfter erledigt')
    expect(reopenedRowText('Feuer', 'EG')).toBe('Feuer EG wieder aktiv')
  })

  it('names the place the surface means — a storey, a span, or nothing at all', () => {
    expect(donePlace(0)).toBe('EG')
    expect(donePlace(1, 1)).toBe('1. OG')
    expect(donePlace(0, 2)).toBe('EG–2. OG')
    expect(donePlace(undefined, undefined)).toBe('') // never an EG nobody said
    expect(doneName({ symbol: 'VKF Feuer' })).toBe('Feuer') // never the pack's raw key
  })

  it('is tolerant of a malformed value — a renderer never throws over an old blob', () => {
    expect(doneOf({ done: { at: 'gestern' } })).toBeNull()
    expect(doneOf({ done: true as unknown as { at: string } })).toBeNull()
    expect(doneOf({ done: null as unknown as undefined })).toBeNull()
    expect(doneBadge({ done: { at: 'x' } })).toBeNull()
  })

  it('stamps who, when known, and only symbols can be done', () => {
    expect(markDone(AT, ' Muster Anna ')).toEqual({ at: AT, by: 'Muster Anna' })
    expect(markDone(AT)).toEqual({ at: AT })
    expect(canBeDone('symbol')).toBe(true)
    expect(canBeDone('area')).toBe(false)
    expect(canBeDone('draw')).toBe(false)
  })
})

describe('one object, two surfaces — `done` is a prop both bodies share', () => {
  const ORIGIN = { lng: 7.5525, lat: 47.5145 }
  const PAIRS: GeorefPair[] = [
    { plan: { x: 0, y: 0 }, lngLat: ORIGIN },
    { plan: { x: 1, y: 0 }, lngLat: { lng: ORIGIN.lng + 100 / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat } },
  ]
  const PLAN = { fit: fitSimilarity(PAIRS, 1)!, aspect: 1 }
  const anno = (over: Partial<BoardAnno> = {}): BoardAnno => ({ id: 's1', kind: 'symbol', x: 0.5, y: 0.2, ...feuer, ...over })
  const onSheet = (over: Partial<BoardAnno> = {}): TacticalObject[] =>
    [bakeGeoBody({ id: 's1', sheet: { planId: 'modul2', anno: anno(over) } }, PLAN, 'taktisch')]
  const fits = new Map([['modul2', PLAN]])

  it('set on the PLAN → the Karte draws it done, and a re-bake keeps it (it is not geometry)', () => {
    const next = applyBoardToObjects(onSheet(), 'modul2', [anno({ done: { at: AT } })], PLAN)
    const baked = bakeGeoBody(next[0], PLAN, 'taktisch')
    expect(viewsOf([baked]).entities[0].done).toEqual({ at: AT })
    expect(bakeGeoBody(baked, PLAN, 'taktisch')).toBe(baked) // idempotent: the same record back
  })

  it('set on the KARTE of a sheet-anchored symbol → written through onto the anno; no anchor flip', () => {
    const objects = onSheet()
    const next = applyDocToObjects(objects, { entities: [{ ...objects[0].entity!, done: { at: AT } }], drawings: [] }, fits)
    expect(next[0].sheet?.planId).toBe('modul2')
    expect(next[0].sheet?.anno.done).toEqual({ at: AT })
  })

  it('CLEARED on either surface clears the other body too — «Wieder aktiv» is not undone by a bake', () => {
    // plan clears → map body follows on the bake
    const fromPlan = applyBoardToObjects(onSheet({ done: { at: AT } }), 'modul2', [anno({ done: undefined })], PLAN)
    expect(doneOf(bakeGeoBody(fromPlan[0], PLAN, 'taktisch').entity)).toBeNull()
    // Karte clears → anno follows
    const objects = onSheet({ done: { at: AT } })
    const fromMap = applyDocToObjects(objects, { entities: [{ ...objects[0].entity!, done: undefined }], drawings: [] }, fits)
    expect(doneOf(fromMap[0].sheet?.anno)).toBeNull()
    expect(doneOf(bakeGeoBody(fromMap[0], PLAN, 'taktisch').entity)).toBeNull()
    // …and with the key ABSENT rather than present-but-undefined — a restored snapshot or a JSON
    // round trip hands the body back that way, and it still means «not done»
    const { done: _gone, ...bare } = objects[0].entity!
    const fromBare = applyDocToObjects(objects, { entities: [bare as Entity], drawings: [] }, fits)
    expect(doneOf(fromBare[0].sheet?.anno)).toBeNull()
    expect(doneOf(bakeGeoBody(fromBare[0], PLAN, 'taktisch').entity)).toBeNull()
  })

  it('MOVING it between the surfaces keeps it — the same object, still over', () => {
    // dragged on the Karte: the anchor flips to geo, the sheet body goes, `done` stays
    const objects = onSheet({ done: { at: AT } })
    const moved = applyDocToObjects(objects, { entities: [{ ...objects[0].entity!, coord: [ORIGIN.lng + 0.001, ORIGIN.lat] }], drawings: [] }, fits)
    expect(moved[0].sheet).toBeUndefined()
    expect(moved[0].entity?.done).toEqual({ at: AT })
    // …and dragged back onto the sheet: the anchor flips to the paper, `done` stays
    const shown = sheetAnnos(moved, 'modul2', PLAN)[0]
    const back = applyBoardToObjects(moved, 'modul2', [{ ...shown, x: 0.3, y: 0.3 }], PLAN)
    expect(back[0].sheet?.anno.done).toEqual({ at: AT })
  })

  it('a Karte symbol shown on a sheet carries it there too (the projection)', () => {
    const geo: TacticalObject = { id: 'g1', entity: { id: 'g1', kind: 'symbol', layer: 'taktisch', coord: [ORIGIN.lng + 0.0003, ORIGIN.lat - 0.0001], ...feuer, done: { at: AT } } }
    const shown = sheetAnnos([geo], 'modul2', PLAN)
    expect(shown[0]?.done).toEqual({ at: AT })
  })
})

describe('what reaches paper', () => {
  it('the legend line ends on the Status «gelöscht 20:40» — «Art · Bezeichnung · Status»', () => {
    expect(symbolLegendText({ ...feuer, done: { at: AT } }, 'auto')).toBe(`Feuer · gelöscht ${HHMM}`)
    expect(symbolLegendText({ symbol: 'VKF Rettungen', fields: { Status: 'gerettet' }, done: { at: AT } }, 'auto'))
      .toBe(`Rettung · gerettet · erledigt ${HHMM}`)
    expect(symbolLegendText(feuer, 'auto')).toBe('Feuer') // not done: nothing added
  })

  it('the Kroki entity and the plan/Gebäude anno carry the time the glyph is printed with', () => {
    const e: Entity = { id: 'e1', kind: 'symbol', layer: 'taktisch', coord: [7.5, 47.5], ...feuer, done: { at: AT } }
    expect(krokiEntity(e, {})).toMatchObject({ done: HHMM, caption: `Feuer · gelöscht ${HHMM}` })
    const [a] = planAnnosForPdf([{ id: 'a1', kind: 'symbol', x: 0.5, y: 0.5, ...feuer, done: { at: AT } }])
    expect(a).toMatchObject({ done: HHMM, caption: `Feuer · gelöscht ${HHMM}` })
    expect(planAnnosForPdf([{ id: 'a2', kind: 'symbol', x: 0.5, y: 0.5, ...feuer }])[0].done).toBeUndefined()
  })
})

describe('annoLogName — the plan names a removed object the way the Karte does', () => {
  it('names symbols, chips, drawings and notes; an empty Notiz is no row', () => {
    expect(annoLogName({ id: 'a', kind: 'symbol', symbol: 'VKF Feuer' })).toBe('Feuer')
    expect(annoLogName({ id: 'a', kind: 'symbol', symbol: 'VKF Feuer', label: 'Brandherd' })).toBe('Brandherd')
    expect(annoLogName({ id: 'a', kind: 'resource', text: 'Trupp 3' })).toBe('Trupp 3')
    expect(annoLogName({ id: 'a', kind: 'area', pts: [] })).toBe(appConfig.copy.log.drawKinds.area)
    expect(annoLogName({ id: 'a', kind: 'draw', pts: [], label: 'Leitung 1' })).toBe('Leitung 1')
    expect(annoLogName({ id: 'a', kind: 'text', text: 'Gasflaschen' })).toBe('Gasflaschen')
    expect(annoLogName({ id: 'a', kind: 'text', text: '  ' })).toBeNull()
  })
})
