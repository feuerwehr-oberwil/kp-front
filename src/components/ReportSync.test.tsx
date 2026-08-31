// @vitest-environment jsdom
//
// The Einsatzrapport is open on two devices at once — that is the ordinary case, not the exotic
// one: the Einsatzleiter fills it in on the iPad while the Front-Operator corrects the Zeiten on
// the laptop. Until 25.08. this surface seeded its fifteen fields from `reportMeta` ONCE and then
// ignored the prop, so it showed the state it had opened on and, on the next keystroke in ANY
// field, wrote all fifteen of those stale values back over whatever the other device had filled
// in since. Field report: «der Einsatzrapport synchronisiert nicht zwischen den Geräten».
//
// These tests pin the two halves of the fix (ReportPreflight · useSyncedField / dirtyMeta):
// what this operator did NOT touch follows the blob, and what they did NOT touch is not written.
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReportMeta } from '../lib/workspace'

// ⚠️ Required, not an optimisation: ReportPreflight imports KrokiFramingPanel statically, which
// pulls maplibre-gl into the module graph, and jsdom cannot load it at all.
vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight } from './ReportPreflight'

beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

afterEach(cleanup)

const INCIDENT = {
  id: 'i1', title: 'Brand Gebäude', address: 'Musterstrasse 3',
  started_at: '2026-08-25T19:42:00Z', closed_at: null,
} as unknown as React.ComponentProps<typeof ReportPreflight>['incident']

/** The sheet, plus a `sync()` that plays a change made on the OTHER device into the prop. */
function setup(reportMeta: ReportMeta = {}) {
  const onSaveMeta = vi.fn()
  const view = (m: ReportMeta) => (
    <ReportPreflight
      incident={INCIDENT}
      reportMeta={m}
      events={[]}
      annotatedPlanCount={0}
      truppCount={0}
      attendanceCount={0}
      mittelCount={0}
      mapContentCount={0}
      onSaveMeta={onSaveMeta}
    />
  )
  const { rerender } = render(view(reportMeta))
  return { onSaveMeta, sync: (m: ReportMeta) => rerender(view(m)) }
}

const field = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement | HTMLInputElement
const kurzbericht = () => field('Kurzbericht')
const bemerkungen = () => field('Bemerkungen')
/** the blob as the LAST save left it */
const saved = (onSaveMeta: ReturnType<typeof vi.fn>) => onSaveMeta.mock.lastCall?.[0] as ReportMeta

describe('Rapport · Angaben von anderen Geräten', () => {
  it('adopts a field the other device filled in', () => {
    const { sync } = setup({ summary: 'Alt' })
    expect(kurzbericht().value).toBe('Alt')

    sync({ summary: 'Neu vom iPad' })
    expect(kurzbericht().value).toBe('Neu vom iPad')
  })

  it('never writes back a field this device did not touch', () => {
    // The bug, in three steps: open the sheet, let the other device fill in the Kurzbericht,
    // then type one character somewhere else. That keystroke used to carry all fifteen fields.
    const { onSaveMeta, sync } = setup({ summary: 'Alt' })
    sync({ summary: 'Neu vom iPad' })

    fireEvent.change(bemerkungen(), { target: { value: 'Wasserschaden im UG' } })

    expect(saved(onSaveMeta).remarks).toBe('Wasserschaden im UG')
    expect(saved(onSaveMeta).summary).toBe('Neu vom iPad')
  })

  it('keeps what this device is typing, and still passes the rest through', () => {
    const { onSaveMeta, sync } = setup({ summary: 'Alt', kontaktperson: 'Frau Meier' })

    fireEvent.change(kurzbericht(), { target: { value: 'Brand im Keller' } })
    expect(saved(onSaveMeta).summary).toBe('Brand im Keller')

    // …and the other device answers with its own view of the blob, Kontaktperson included
    sync({ summary: 'Brand im Keller', kontaktperson: 'Herr Keller' })
    fireEvent.change(kurzbericht(), { target: { value: 'Brand im Keller, gelöscht' } })

    expect(saved(onSaveMeta).summary).toBe('Brand im Keller, gelöscht')
    expect(saved(onSaveMeta).kontaktperson).toBe('Herr Keller')
  })

  it('does not yank text out from under the caret — it adopts on blur', () => {
    const { onSaveMeta, sync } = setup({ summary: 'Alt' })
    kurzbericht().focus()

    sync({ summary: 'Neu vom iPad' })
    expect(kurzbericht().value).toBe('Alt')

    // ⚠️ …and while it waits, the field is NOT dirty: a save triggered from elsewhere on the
    // sheet must carry the blob's value, never the stale text still standing in the box.
    fireEvent.change(bemerkungen(), { target: { value: 'x' } })
    expect(saved(onSaveMeta).summary).toBe('Neu vom iPad')

    // a REAL blur — `fireEvent.blur` fires the event without moving the focus, and «where is
    // the caret» is the question the adoption waits on
    act(() => kurzbericht().blur())
    expect(kurzbericht().value).toBe('Neu vom iPad')
  })

  it('a value only this device knows is not lost when the sync answers late', () => {
    const { onSaveMeta, sync } = setup({})
    fireEvent.change(kurzbericht(), { target: { value: 'Ölspur' } })

    // the blob has not caught up yet — it still answers with the state before that keystroke
    sync({})
    expect(kurzbericht().value).toBe('Ölspur')

    fireEvent.change(bemerkungen(), { target: { value: 'Feuerwehr Musterdorf' } })
    expect(saved(onSaveMeta).summary).toBe('Ölspur')
  })

  it('an unchanged field is absent from the payload — a round trip is not an edit', () => {
    // `endedAt` lives on screen as a `dtLocal` string and in the blob as an ISO stamp; the
    // conversion between them drops the seconds. Reading that as a change would put this
    // device's copy of every clock back into the blob on every keystroke.
    const { onSaveMeta } = setup({ endedAt: '2026-08-25T21:14:37.000Z', summary: 'Alt' })
    fireEvent.change(bemerkungen(), { target: { value: 'k' } })

    expect(saved(onSaveMeta).endedAt).toBe('2026-08-25T21:14:37.000Z')
    expect(saved(onSaveMeta).summary).toBe('Alt')
  })
})
