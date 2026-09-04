// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AnwesenheitView } from './AnwesenheitView'
import { appConfig } from '../config/appConfig'
import { applyLocale } from '../config/copy'
import { fillTemplate } from '../lib/format'
import type { AttendanceState, Person } from '../types'

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

const people: Person[] = [{ id: 'p1', displayName: 'Meier Anna', active: true, updatedAt: 't' }]
const noop = () => {}
const mount = (over: Partial<Parameters<typeof AnwesenheitView>[0]> = {}) => {
  const props = {
    people, attendance: {} as AttendanceState, canEdit: true, loading: false, error: false,
    blockedIds: new Set<string>(), truppOfPerson: new Map<string, string>(), onMarkPresent: noop, onMarkLeft: noop, onClear: noop,
    onJumpToTrupp: noop, onReload: vi.fn(),
    ...over,
  }
  render(<AnwesenheitView {...props} />)
  return props
}

describe('the roster refreshes itself, so the header carries no refresh button', () => {
  it('shows nothing while the roster is fine', () => {
    mount()
    // «Aktualisieren» said the wrong thing twice: attendance follows live and never needed it, and
    // the roster it really refreshed only moves when an admin syncs Divera — which usePersonnel
    // now picks up in the background.
    expect(screen.queryByRole('button', { name: appConfig.copy.anwesenheit.reload })).toBeNull()
  })

  it('offers a retry once a fetch has actually failed', () => {
    const props = mount({ error: true })
    const retry = screen.getByRole('button', { name: appConfig.copy.anwesenheit.reload })
    expect(retry.textContent).toContain(appConfig.copy.anwesenheit.retry)
    fireEvent.click(retry)
    expect(props.onReload).toHaveBeenCalled()
  })

  it('says it is working while the retry is in flight, and cannot be pressed twice', () => {
    mount({ error: true, loading: true })
    const retry = screen.getByRole('button', { name: appConfig.copy.anwesenheit.reload })
    expect(retry.textContent).toContain(appConfig.copy.anwesenheit.loading)
    expect(retry.hasAttribute('disabled')).toBe(true)
  })
})

// A guest is not on the Mannschaftsliste — they exist only as an attendance entry, synthesised
// into a row. The clock button looked its person up in the ROSTER, so for a guest it found
// nobody and the sheet silently did not open. That sheet is also the only place «Person
// entfernen» lives (the row's tap deliberately refuses to cycle a guest back to «frei», because
// that tap would delete the only record they were ever here) — so a guest could be added and
// then never removed, with both routes out failing quietly.
describe('a guest can be opened and removed like anybody else', () => {
  const A = appConfig.copy.anwesenheit
  const withGuest: AttendanceState = {
    g1: { status: 'present', displayNameSnapshot: 'Muster Felix', intervals: [{ from: '2026-08-07T10:00:00.000Z' }] },
  } as unknown as AttendanceState

  it('opens the Zeiten sheet for a guest', () => {
    mount({ attendance: withGuest })
    const clock = screen.getByRole('button', { name: A.openBlocks.replace('{name}', 'Muster Felix') })
    fireEvent.click(clock)
    expect(screen.getByRole('button', { name: new RegExp(A.removeGuest) })).toBeTruthy()
  })

  it('removes the guest through it', () => {
    const onClear = vi.fn()
    mount({ attendance: withGuest, onClear })
    fireEvent.click(screen.getByRole('button', { name: A.openBlocks.replace('{name}', 'Muster Felix') }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(A.removeGuest) }))
    expect(onClear).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1', guest: true }))
  })
})

// The print-dialog line («24 Personen · 1 Schicht · Stand 13:13», PaperSheet's `sheetContent(Bands)`)
// used to interpolate a bare count, so «1 Schichten»/«1 Personen» printed on paper. Both counts now
// inflect on their own (`zeitplan.peopleCount`/`bandsCount`, same function-per-count idiom as
// `intake.objectPlans`) before they are dropped into the template — this pins the singular AND the
// composed sentence PaperSheet actually renders, in German and in one overlay locale.
describe('the Zeitplan print sheet inflects its two counts correctly', () => {
  afterEach(() => applyLocale('de-CH'))

  it('says «1 Person» / «1 Schicht», not the bare number, in German', () => {
    const Z = appConfig.copy.zeitplan
    expect(Z.peopleCount(1)).toBe('1 Person')
    expect(Z.peopleCount(2)).toBe('2 Personen')
    expect(Z.bandsCount(1)).toBe('1 Schicht')
    expect(Z.bandsCount(2)).toBe('2 Schichten')
  })

  it('composes the Schichtplan sheet line the way PaperSheet does', () => {
    const Z = appConfig.copy.zeitplan
    expect(fillTemplate(Z.sheetContentBands, { people: Z.peopleCount(24), bands: Z.bandsCount(1), t: '13:13' }))
      .toBe('24 Personen · 1 Schicht · Stand 13:13')
    expect(fillTemplate(Z.sheetContentBands, { people: Z.peopleCount(1), bands: Z.bandsCount(1), t: '13:13' }))
      .toBe('1 Person · 1 Schicht · Stand 13:13')
  })

  it('composes the Verfügbarkeiten sheet line (no Schichten count) the same way', () => {
    const Z = appConfig.copy.zeitplan
    expect(fillTemplate(Z.sheetContent, { people: Z.peopleCount(1), t: '13:13' })).toBe('1 Person · Stand 13:13')
  })

  it('inflects in English too, once the locale overlay applies', () => {
    applyLocale('en')
    const Z = appConfig.copy.zeitplan
    expect(Z.peopleCount(1)).toBe('1 person')
    expect(Z.bandsCount(1)).toBe('1 shift')
    expect(fillTemplate(Z.sheetContentBands, { people: Z.peopleCount(1), bands: Z.bandsCount(1), t: '13:13' }))
      .toBe('1 person · 1 shift · as of 13:13')
  })
})
