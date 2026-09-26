import { describe, it, expect, vi } from 'vitest'
import { abschlussOpenItems, abschlussOpenLabel, abschlussOpenPoints, controlChipLabel, countsAsOpen, insideAbschlussMessage, registeredAbschlussMessage } from './abschlussOpen'
import type { Trupp } from '../types'
import { ABSCHLUSS_STEPS } from './abschluss'
import { appConfig } from '../config/appConfig'

/**
 * «Einsatz abschliessen» named its offene Punkte and then left the operator to find them — the
 * print warning beside it had been offering the same list as links for weeks (18.09.2026). What
 * is pinned here is that EVERY kind of open point has a target, because a row that looks like a
 * link and goes nowhere is worse than the plain text it replaced.
 */
describe('abschlussOpenPoints', () => {
  it('lists the Mindestangaben first, then the Trupps, then the queue', () => {
    expect(abschlussOpenPoints(['zeiten', 'kurzbericht'], 2, 3)).toEqual([
      { kind: 'step', step: 'zeiten' },
      { kind: 'step', step: 'kurzbericht' },
      { kind: 'trupps', n: 2 },
      { kind: 'media', n: 3 },
    ])
  })
  it('says nothing about a Trupp that came back or a queue that is empty', () => {
    expect(abschlussOpenPoints([], 0, 0)).toEqual([])
  })
})

describe('what makes the Abschluss a «trotzdem»', () => {
  it('counts every missing Angabe and every Trupp still out — but not a pending upload', () => {
    expect(countsAsOpen({ kind: 'step', step: 'zeiten' })).toBe(true)
    expect(countsAsOpen({ kind: 'trupps', n: 1 })).toBe(true)
    // the Abschluss drains the queue itself; it is a fact about this device, not a gap
    expect(countsAsOpen({ kind: 'media', n: 4 })).toBe(false)
  })
})

describe('every open point is a link', () => {
  it('gives each of the eight Mindestangaben its own named row and target', () => {
    const go = { step: vi.fn(), trupps: vi.fn(), media: vi.fn() }
    const items = abschlussOpenItems(abschlussOpenPoints([...ABSCHLUSS_STEPS], 0, 0), go)
    expect(items).toHaveLength(ABSCHLUSS_STEPS.length)
    items.forEach((it, i) => {
      expect(it.label).toBe(appConfig.copy.abschluss.steps[ABSCHLUSS_STEPS[i]])
      expect(it.label.trim()).not.toBe('')
      it.onClick()
      expect(go.step).toHaveBeenLastCalledWith(ABSCHLUSS_STEPS[i])
    })
    expect(go.trupps).not.toHaveBeenCalled()
    expect(go.media).not.toHaveBeenCalled()
  })

  it('sends a Trupp still out to the Tafel and a queued capture to the Bereitschaft', () => {
    const go = { step: vi.fn(), trupps: vi.fn(), media: vi.fn() }
    const items = abschlussOpenItems(abschlussOpenPoints([], 2, 3), go)
    expect(items.map((i) => i.label)).toEqual([
      abschlussOpenLabel({ kind: 'trupps', n: 2 }),
      abschlussOpenLabel({ kind: 'media', n: 3 }),
    ])
    items[0].onClick()
    expect(go.trupps).toHaveBeenCalledTimes(1)
    items[1].onClick()
    expect(go.media).toHaveBeenCalledTimes(1)
  })

  it('names the counts, so a row reads as the fact it is', () => {
    expect(abschlussOpenLabel({ kind: 'trupps', n: 2 })).toContain('2')
    expect(abschlussOpenLabel({ kind: 'media', n: 3 })).toContain('3')
    expect(abschlussOpenLabel({ kind: 'trupps', n: 2 })).not.toContain('{n}')
    expect(abschlussOpenLabel({ kind: 'media', n: 3 })).not.toContain('{n}')
  })
})

describe('abschlussOpenPoints — the Suche (24.09.2026)', () => {
  it('asks about people still missing FIRST, and makes the Abschluss a «trotzdem»', () => {
    const pts = abschlussOpenPoints(['zeiten'], 0, 0, { vermisst: 2, openBereiche: [] })
    expect(pts[0]).toEqual({ kind: 'vermisst', n: 2 })
    expect(abschlussOpenLabel(pts[0])).toBe('2 Personen noch vermisst')
    expect(abschlussOpenLabel({ kind: 'vermisst', n: 1 })).toBe('1 Person noch vermisst')
    expect(countsAsOpen(pts[0])).toBe(true)
  })

  it('names an area not abgesucht as a HINT only — it never turns the button into «trotzdem»', () => {
    const pts = abschlussOpenPoints([], 0, 0, { vermisst: 0, openBereiche: ['1. OG Trakt 3', '2. OG'] })
    expect(pts).toEqual([{ kind: 'bereiche', names: ['1. OG Trakt 3', '2. OG'] }])
    expect(abschlussOpenLabel(pts[0])).toBe('Nicht abgesucht: 1. OG Trakt 3, 2. OG')
    expect(pts.some(countsAsOpen)).toBe(false)
  })

  it('both rows lead to the Suche; nothing is said without one', () => {
    const go = { step: vi.fn(), trupps: vi.fn(), media: vi.fn(), suche: vi.fn() }
    const items = abschlussOpenItems(abschlussOpenPoints([], 0, 0, { vermisst: 1, openBereiche: ['EG'] }), go)
    items.forEach((i) => i.onClick())
    expect(go.suche).toHaveBeenCalledTimes(2)
    expect(abschlussOpenPoints([], 0, 0, { vermisst: 0, openBereiche: [] })).toEqual([])
  })
})

describe('controlChipLabel — the Rapport head\'s one Kontrolle chip', () => {
  it('counts the open steps and the warnings each in its own words', () => {
    expect(controlChipLabel(4, 0)).toBe('4 noch offen')
    expect(controlChipLabel(0, 1)).toBe('1 Hinweis')
    expect(controlChipLabel(0, 3)).toBe('3 Hinweise')
    expect(controlChipLabel(4, 2)).toBe('4 noch offen · 2 Hinweise')
    expect(controlChipLabel(1, 1)).toBe('1 noch offen · 1 Hinweis')
  })
})

describe('registeredAbschlussMessage — who is still angemeldet', () => {
  const t = (over: Partial<Trupp>): Trupp => ({
    id: 'x', name: 'Muster Leo', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', ...over,
  })

  it('names one Trupp by number and Gruppenführer, and says it is the Sicherungstrupp', () => {
    expect(registeredAbschlussMessage([t({ no: 6, auftrag: 'sichern' })]))
      .toBe('1 Trupp noch angemeldet (#6 Muster Leo, Sicherungstrupp).')
  })

  it('counts several, and leaves out a number the record does not have', () => {
    expect(registeredAbschlussMessage([t({ no: 6, auftrag: 'sichern' }), t({ id: 'y', name: 'Meier', auftrag: 'loeschen' })]))
      .toBe('2 Trupps noch angemeldet (#6 Muster Leo, Sicherungstrupp · Meier).')
  })
})

describe('insideAbschlussMessage — the crews still inside, by name', () => {
  const t = (over: Partial<Trupp>): Trupp => ({
    id: 'x', name: 'Muster Leo', entryPressureBar: 300, entryTime: '2026-09-25T10:00:00Z', lastContactTime: '', status: 'aktiv', ...over,
  })
  it('names each Trupp with its number and whole crew', () => {
    expect(insideAbschlussMessage([t({ no: 1, members: ['Graf Eva'] })]))
      .toBe('1 Trupp ist noch drin: Trupp 1 (Muster Leo / Graf Eva).')
    expect(insideAbschlussMessage([t({ no: 1 }), t({ id: 'y', no: 2, name: 'Frei Nora' })]))
      .toBe('2 Trupps sind noch drin: Trupp 1 (Muster Leo), Trupp 2 (Frei Nora).')
  })
})
