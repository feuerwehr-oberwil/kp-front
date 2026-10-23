import { afterEach, beforeAll, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AtemschutzView } from './AtemschutzView'
import { appConfig } from '../config/appConfig'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { fillTemplate } from '../lib/format'
import { clearAllDrafts } from '../lib/draftKeep'
import type { AttendanceState, Trupp } from '../types'

// What the AtemschutzView test files (`AtemschutzView.<topic>.test.tsx`) share: the hooks, the
// fixtures and the form helpers. Each file still declares its own
// `vi.mock('../lib/useIsPhone', …)` — vi.mock is hoisted per test file and cannot live here —
// and calls `registerAtemschutzViewHooks()` once at the top level.

/** cleanup, the kept drafts, and the jsdom gaps (matchMedia, scrollIntoView) */
export function registerAtemschutzViewHooks() {
  afterEach(cleanup)
  // ⚠️ …and the kept DRAFTS with it (lib/draftKeep is a module-level store): a form that was
  // deliberately left blocked here — «Anderes» without its word — would otherwise hand its
  // half-typed crew to the next test in this file.
  afterEach(clearAllDrafts)
  beforeAll(() => {
    window.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    Element.prototype.scrollIntoView = () => {}
  })
}

export const az = appConfig.copy.atemschutz
/** «Trupp anmelden» names the door AND the form's own button (staging r3 N19, one word) — the
 *  door is the first on the page, the form's submit the last */
export const firstBtn = (name: string) => screen.getAllByRole('button', { name })[0]
/** the phone's «Druck» — its name carries the last reported bar since 26.09.2026 («Druck 240 bar») */
export const druckName = new RegExp(`^${az.actPressure} \\d+ bar$`)
export const lastBtn = (name: string) => { const all = screen.getAllByRole('button', { name }); return all[all.length - 1] }
// the doctrine the form starts a fresh cylinder at — the number a closed «Luft & Funk» prints
export const dz = atemschutzDoctrine()
export const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

// one Trupp in the field, contact fresh (no alarm, so nothing scrolls/flashes on mount),
// with an entry + a pressure reading in its log
export const aktivTrupp = (): Trupp => ({
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

export const noop = () => {}
export const propsFor = (over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => ({
    trupps: [aktivTrupp()], truppColors: { tr1: '#e8392b' }, canEdit: true,
    personnel: [], attendance: {} as AttendanceState,
    muted: false, onToggleMuted: noop,
    createTrupp: noop, placeTrupp: noop, placeTargets: [],
    markerOptions: () => [], adoptMarker: noop, focusTruppOnPlan: noop,
    recordContact: vi.fn(), recordPressure: vi.fn(), setTruppStatus: noop,
    editTrupp: noop, reactivateTrupp: noop, deleteTrupp: noop, restoreTrupp: noop,
    leitungOptions: () => [], showTruppLine: noop, truppsWithLine: new Set<string>(),
    unlinkTruppLine: noop,
    ...over,
})

export const mount = (over: Partial<Parameters<typeof AtemschutzView>[0]> = {}) => {
  const props = propsFor(over)
  render(<AtemschutzView {...props} />)
  return props
}

/** Name a Gruppenführer by hand in the open Trupp form. Since 04.09. the SEARCH field is the
 *  guest entry (TruppTeam): type the name, then take the Gast row the list grows for it. */
export const typeGuest = (name: string) => {
  fireEvent.change(screen.getByLabelText(az.teamSearchPlaceholder), { target: { value: name } })
  fireEvent.click(screen.getByRole('option', { name: fillTemplate(az.teamGuestAdd, { name }) }))
}
/** the form's Eingangsdruck / Funkkanal rows (30.09.2026: each opens its number sheet) */
export const pressureRow = (label: string = az.pressureLabel) => screen.getByRole('button', { name: new RegExp(`^${label} \\d+ bar$`) })
export const kanalRow = () => screen.getByRole('button', { name: new RegExp(`^${az.funkkanalSection} \\d+$`) })
/** open the Druck sheet from the form's row and tap a bar — it fills the draft and closes */
export const pickPressure = (bar: number, label: string = az.pressureLabel) => {
  fireEvent.click(pressureRow(label))
  fireEvent.click(within(screen.getByRole('group', { name: label })).getByRole('button', { name: String(bar) }))
}
/** Answering the Auftrag in the open form. Not required to register since 14.09. (see «a Trupp
 *  may be registered without an Auftrag» in AtemschutzView.board.test) — the tests that pick one are about its value. */
export const pickAuftrag = (label = 'Retten') =>
  fireEvent.click(within(screen.getByRole('group', { name: az.auftragLabel })).getByRole('button', { name: label }))
