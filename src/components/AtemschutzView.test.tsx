// @vitest-environment jsdom
// The 29.08. card rework, as it stands after the same-day revision: the contact clock folds
// its timing rows and the Verlauf footer previews the latest event and expands the log — both
// OPEN-ONLY (showing never logs, never counts as Kontakt). The Druck stepper is back inline
// (a Druckmeldung must never cost an opening tap); its ± only stages a pending value and the
// explicit «Bestätigen» commits.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AtemschutzView } from './AtemschutzView'
import s from './Atemschutz.module.css'
import { appConfig } from '../config/appConfig'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import type { AttendanceState, Trupp } from '../types'

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
})

const az = appConfig.copy.atemschutz
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

// one Trupp in the field, contact fresh (no alarm, so nothing scrolls/flashes on mount),
// with an entry + a pressure reading in its log
const aktivTrupp = (): Trupp => ({
  id: 'tr1', name: 'Steiner', members: ['Huber'],
  entryPressureBar: 300, entryTime: iso(10 * 60_000),
  lastContactTime: iso(2 * 60_000),
  lastPressureBar: 240, lastPressureTime: iso(4 * 60_000), lowestBar: 240,
  status: 'aktiv',
  readings: [
    { t: iso(10 * 60_000), bar: 300, kind: 'entry' },
    { t: iso(4 * 60_000), bar: 240, kind: 'pressure' },
  ],
})

const noop = () => {}
const propsFor = (over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => ({
    trupps: [aktivTrupp()], truppColors: { tr1: '#e8392b' }, canEdit: true,
    personnel: [], attendance: {} as AttendanceState,
    muted: false, onToggleMuted: noop,
    createTrupp: noop, placeTrupp: noop, placeTargets: [],
    markerOptions: () => [], adoptMarker: noop, focusTruppOnPlan: noop,
    recordContact: vi.fn(), recordPressure: vi.fn(), setTruppStatus: noop,
    editTrupp: noop, reactivateTrupp: noop, deleteTrupp: noop, restoreTrupp: noop,
    leitungOptions: () => [], showTruppLine: noop, truppsWithLine: new Set<string>(),
    pickTruppLine: noop, unlinkTruppLine: noop,
    ...over,
})
const mount = (over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => {
  const props = propsFor(over)
  render(<AtemschutzView {...props} />)
  return props
}

describe('the inline Druckmeldung', () => {
  it('offers ± immediately and commits only after a changed value is confirmed', () => {
    const props = mount()
    const step = atemschutzDoctrine().pressureStep
    const down = screen.getByLabelText(az.pressureDown.replace('{step}', String(step)))
    expect(screen.queryByRole('button', { name: az.pressureConfirm })).toBeNull()
    fireEvent.pointerDown(down)
    expect(props.recordPressure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: az.pressureConfirm }))
    expect(props.recordPressure).toHaveBeenCalledWith('tr1', 240 - step)
  })

  it('✕ throws away a pending pressure without hiding the immediate controls', () => {
    const props = mount()
    const step = atemschutzDoctrine().pressureStep
    fireEvent.pointerDown(screen.getByLabelText(az.pressureDown.replace('{step}', String(step))))
    fireEvent.click(screen.getByRole('button', { name: az.cancel }))
    expect(props.recordPressure).not.toHaveBeenCalled()
    expect(screen.getByLabelText(az.pressureDown.replace('{step}', String(step)))).toBeTruthy()
    expect(screen.queryByRole('button', { name: az.pressureConfirm })).toBeNull()
  })
})

describe('the Kontakt zone (tap the clock, fold the times)', () => {
  it('shows and hides the timing rows — and never records a Kontakt', () => {
    const props = mount()
    expect(screen.queryByText(az.lastContactAt)).toBeNull() // collapsed by default
    const clock = screen.getByRole('button', { name: new RegExp(az.clockOk) })
    fireEvent.click(clock)
    expect(screen.getByText(az.lastContactAt)).toBeTruthy()
    expect(screen.getByText(az.nextContactDue)).toBeTruthy()
    expect(props.recordContact).not.toHaveBeenCalled()
    fireEvent.click(clock)
    expect(screen.queryByText(az.lastContactAt)).toBeNull()
  })
})

describe('the Verlauf footer (the removed «Draussen: hh:mm» line, generalised)', () => {
  it('previews the LATEST event with its bar, and expands the full log in place', () => {
    mount()
    const row = screen.getByRole('button', { name: new RegExp(`${az.verlauf}.*${az.readingKind.pressure}`) })
    expect(row.textContent).toContain('240 bar')
    expect(row.textContent).not.toContain('2 Einträge')
    // the older entry row is behind the fold until the footer is tapped
    expect(screen.queryByText(az.readingKind.entry)).toBeNull()
    fireEvent.click(row)
    expect(screen.getByText(az.readingKind.entry)).toBeTruthy()
  })
})

describe('pointing to a Trupp', () => {
  it('replays the whole-card highlight when the same notification is tapped again', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const one = propsFor({ focus: { id: 'tr1', nonce: 1 } })
    const view = render(<AtemschutzView {...one} />)
    expect(scroll).toHaveBeenCalledTimes(1)
    view.rerender(<AtemschutzView {...one} focus={{ id: 'tr1', nonce: 2 }} />)
    expect(scroll).toHaveBeenCalledTimes(2)
    scroll.mockRestore()
  })

  it('opens «Auftrag offen» directly on a highlighted Auftrag field', () => {
    mount({ trupps: [{ ...aktivTrupp(), auftrag: undefined }] })
    fireEvent.click(screen.getByRole('button', { name: az.auftragOpen }))
    const art = screen.getByText(az.auftragLabel).closest('div')
    expect(art?.classList.contains(s.formFlash)).toBe(true)
  })
})
