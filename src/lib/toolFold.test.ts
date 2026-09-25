import { describe, it, expect } from 'vitest'
import { ADD_TOOLS, addFace, addTools, barTools } from './toolFold'
import { appConfig } from '../config/appConfig'

/** the two real lists, widened: the config's literal types make them two different tuples */
const MAP: { id: string; sep?: boolean; slot?: boolean }[] = [...appConfig.copy.mapTools]
const PLAN: { id: string; sep?: boolean; slot?: boolean }[] = [...appConfig.copy.planTools]

describe('what the phone bar keeps', () => {
  // + the footer (Ansichten · Ebenen / Einpassen) = five tiles on the Karte, four on a Plan
  it('is Auswahl · «+» · Messen on the Karte', () =>
    expect(barTools(MAP).map((t) => t.id)).toEqual(['select', 'symbol-slot', 'measure']))

  it('…and on a Plan — same bar, the plan\'s own ids', () =>
    expect(barTools(PLAN).map((t) => t.id)).toEqual(['pan', 'symbol-slot', 'measure']))

  it('carries no dividers', () =>
    expect([...barTools(MAP), ...barTools(PLAN)].some((t) => t.sep)).toBe(false))
})

describe('what moves into the «+» sheet', () => {
  // ⚠️ Notiz is `note` on the Karte and `text` on a Plan; Trupp is `team` and `resource`
  it('is Linie · Fläche · Absperrkreis · Notiz · Trupp (+ the Karte\'s Grundgerüst), on both surfaces', () => {
    expect(addTools(MAP).map((t) => t.id)).toEqual(['line', 'area', 'circle', 'note', 'team', 'grundgeruest'])
    expect(addTools(PLAN).map((t) => t.id)).toEqual(['line', 'area', 'circle', 'text', 'resource'])
  })

  // nothing may fall between the bar and the sheet
  it('loses no tool', () => {
    for (const list of [MAP, PLAN]) {
      const real = list.filter((t) => !t.sep)
      expect(barTools(list).length + addTools(list).length).toBe(real.length)
    }
  })

  // the slim read-only rail has none of them: its bar is simply its list
  it('leaves a list without add tools alone', () => {
    const slim = [{ id: 'select' }, { id: 'measure' }]
    expect(barTools(slim)).toEqual(slim)
    expect(addTools(slim)).toEqual([])
  })
})

describe('the «+» tile\'s face', () => {
  it('is the armed tool out of the sheet', () => expect(addFace(MAP, 'area')?.id).toBe('area'))
  it('is nothing for a tool that has its own tile', () => expect(addFace(MAP, 'measure')).toBeNull())
  it('is nothing with nothing armed', () => expect(addFace(MAP, 'select')).toBeNull())
  it('knows every id it claims', () => expect(ADD_TOOLS.every((id) => [...MAP, ...PLAN].some((t) => t.id === id))).toBe(true))
})
