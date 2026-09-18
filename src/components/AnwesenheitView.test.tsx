// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

/* The search field is also the entry for somebody who is not on the Mannschaftsliste (11.09.):
 * the «+» and its dialog are gone, so a typed name that the roster cannot answer is offered as the
 * last row of the list. What has to hold is that the name lands ONCE, exactly as typed — the
 * dialog it replaced committed on a button, this commits on a row that carries the query itself. */
describe('the search field records somebody who is not on the Mannschaftsliste', () => {
  const A = appConfig.copy.anwesenheit
  const offer = (name: string) => new RegExp(A.addGuest.replace('{name}', name))
  const search = () => screen.getByPlaceholderText(A.searchPlaceholder)

  it('offers nothing until a name is typed', () => {
    mount({ onAddGuest: vi.fn() })
    expect(screen.queryByRole('button', { name: /als Gast|as a guest/ })).toBeNull()
  })

  it('takes the typed name as a guest exactly once, and clears the search', () => {
    const onAddGuest = vi.fn()
    mount({ onAddGuest })
    fireEvent.change(search(), { target: { value: 'Muster Felix' } })
    fireEvent.click(screen.getByRole('button', { name: offer('Muster Felix') }))
    expect(onAddGuest).toHaveBeenCalledTimes(1)
    expect(onAddGuest).toHaveBeenCalledWith('Muster Felix')
    expect((search() as HTMLInputElement).value).toBe('')
  })

  it('does not offer a name that is already standing in the list', () => {
    mount({ onAddGuest: vi.fn() })
    fireEvent.change(search(), { target: { value: 'Meier Anna' } })
    expect(screen.getByRole('button', { name: /Meier Anna/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: offer('Meier Anna') })).toBeNull()
  })

  it('stays a plain search for a session that may not write', () => {
    mount({ canEdit: false })
    fireEvent.change(search(), { target: { value: 'Muster Felix' } })
    expect(screen.queryByRole('button', { name: offer('Muster Felix') })).toBeNull()
    expect(screen.getByText(A.noMatches)).toBeTruthy()
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

  it('inflects in English too, once the locale overlay applies', async () => {
    await applyLocale('en')
    const Z = appConfig.copy.zeitplan
    expect(Z.peopleCount(1)).toBe('1 person')
    expect(Z.bandsCount(1)).toBe('1 shift')
    expect(fillTemplate(Z.sheetContentBands, { people: Z.peopleCount(1), bands: Z.bandsCount(1), t: '13:13' }))
      .toBe('1 person · 1 shift · as of 13:13')
  })
})

/* «Nur Anwesende» (18.09.2026) — the one-tap ✓ between the search field and the funnel. It
 * replaced a planning-tab-only toggle that started ON, so the two things that have to hold are
 * that it starts OFF (a list that opens already hiding people lies about the Mannschaft) and
 * that it ANDs with everything else on the line instead of becoming a second, competing mode. */
describe('«Nur Anwesende» — the one-tap quick filter', () => {
  const A = appConfig.copy.anwesenheit
  const crew: Person[] = [
    { id: 'p1', displayName: 'Meier Anna', active: true, updatedAt: 't' },
    { id: 'p2', displayName: 'Muster Felix', active: true, updatedAt: 't' },
    { id: 'p3', displayName: 'Meier Beat', active: true, updatedAt: 't' },
    { id: 'p4', displayName: 'Keller Rita', active: true, updatedAt: 't' },
  ]
  // Anna is here, Felix is at the Magazin, Beat has gone home, Rita was never ticked.
  const attendance = {
    p1: { status: 'present', intervals: [{ from: '2026-09-18T10:00:00.000Z' }] },
    p2: { status: 'present', ort: 'station', intervals: [{ from: '2026-09-18T10:00:00.000Z' }] },
    p3: { status: 'left', intervals: [{ from: '2026-09-18T09:00:00.000Z', to: '2026-09-18T10:00:00.000Z' }] },
  } as unknown as AttendanceState
  const toggle = () => screen.getByRole('button', { name: A.onlyPresent })
  const names = () => crew.filter((p) => screen.queryByText(p.displayName)).map((p) => p.displayName)

  beforeEach(() => sessionStorage.clear())

  it('starts off and shows the whole Mannschaft', () => {
    mount({ people: crew, attendance })
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(names()).toHaveLength(4)
  })

  it('narrows to whoever is «Vor Ort» — not the Magazin, not the gegangenen', () => {
    mount({ people: crew, attendance })
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(names()).toEqual(['Meier Anna'])
  })

  it('composes with the search (AND, never OR)', () => {
    mount({ people: crew, attendance })
    fireEvent.click(toggle())
    fireEvent.change(screen.getByPlaceholderText(A.searchPlaceholder), { target: { value: 'Meier' } })
    // «Meier» alone answers Anna AND Beat; Beat has gone home, so the ✓ takes him out
    expect(names()).toEqual(['Meier Anna'])
    fireEvent.change(screen.getByPlaceholderText(A.searchPlaceholder), { target: { value: 'Muster' } })
    expect(screen.getByText(A.noMatches)).toBeTruthy()
  })

  it('is offered on the crew list, not only while planning', () => {
    mount({ people: crew, attendance })
    expect(toggle()).toBeTruthy()
  })

  it('is remembered for this incident and forgotten for the next one', () => {
    mount({ people: crew, attendance, incidentId: 'i1' })
    fireEvent.click(toggle())
    cleanup()

    mount({ people: crew, attendance, incidentId: 'i1' })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(names()).toEqual(['Meier Anna'])
    cleanup()

    // a different Einsatz starts on the whole Mannschaft again — the stamp is what makes the
    // memory a reload-survivor rather than a setting that follows you around
    mount({ people: crew, attendance, incidentId: 'i2' })
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(names()).toHaveLength(4)
  })
})
