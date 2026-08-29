// @vitest-environment jsdom
// The 29.08. Tapzonen rework: three of the Trupp card's readouts are also tap targets — the
// Druck opens the pending stepper directly, the contact clock folds its timing rows, the
// Verlauf footer previews the latest event and expands the log. The invariant under test:
// every zone is OPEN-ONLY. Tapping a zone never logs a reading, never counts as Kontakt —
// only the explicit buttons commit.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AtemschutzView } from './AtemschutzView'
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
const mount = (over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => {
  const props = {
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
  }
  render(<AtemschutzView {...props} />)
  return props
}

describe('the Druck zone (tap the readout, land in the Druckmeldung)', () => {
  it('opens the pending stepper directly — opening logs nothing, «Bestätigen» does', () => {
    const props = mount()
    // collapsed: the readout wears the «Druckmeldung ›» cue; the stepper is not on screen
    expect(screen.queryByRole('button', { name: az.pressureConfirm })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.zoneDruck) }))
    expect(props.recordPressure).not.toHaveBeenCalled()
    // …and one explicit confirm logs the (unchanged) value — a valid Druckmeldung
    fireEvent.click(screen.getByRole('button', { name: az.pressureConfirm }))
    expect(props.recordPressure).toHaveBeenCalledWith('tr1', 240)
  })

  it('± adjusts a PENDING value; ✕ folds the zone back up without logging', () => {
    const props = mount()
    const step = atemschutzDoctrine().pressureStep
    fireEvent.click(screen.getByRole('button', { name: new RegExp(az.zoneDruck) }))
    // hold-to-repeat steppers fire their first step on pointer-down
    fireEvent.pointerDown(screen.getByLabelText(az.pressureDown.replace('{step}', String(step))))
    fireEvent.click(screen.getByRole('button', { name: az.cancel }))
    expect(props.recordPressure).not.toHaveBeenCalled()
    // collapsed again, still showing the logged value
    expect(screen.getByRole('button', { name: new RegExp(az.zoneDruck) }).textContent).toContain('240 bar')
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
    expect(row.textContent).toContain(az.verlaufEntries.replace('{n}', '2'))
    // the older entry row is behind the fold until the footer is tapped
    expect(screen.queryByText(az.readingKind.entry)).toBeNull()
    fireEvent.click(row)
    expect(screen.getByText(az.readingKind.entry)).toBeTruthy()
  })
})
