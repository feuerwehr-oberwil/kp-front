// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight } from './ReportPreflight'

afterEach(() => { cleanup(); vi.useRealTimers() })

const START = new Date(2026, 7, 14, 19, 42)

const INCIDENT = {
  id: 'i1', title: 'Brand Gebäude', address: 'Musterstrasse 3',
  started_at: START.toISOString(), closed_at: null,
} as unknown as React.ComponentProps<typeof ReportPreflight>['incident']

function setup() {
  render(
    <ReportPreflight
      incident={INCIDENT}
      reportMeta={{ alarmiertAt: START.toISOString() }}
      events={[]}
      annotatedPlanCount={0} truppCount={0} attendanceCount={0} mittelCount={0}
      mapContentCount={0}
      onSaveMeta={vi.fn()}
    />,
  )
}

/** The «Jetzt» button belonging to a labelled time field. */
const jetztFor = (label: RegExp) => {
  const field = screen.getByText(label).closest('label, .ip-field') as HTMLElement
  return field.querySelector('button.ip-btn') as HTMLElement
}

const futureWarnings = () => screen.queryAllByText(/Liegt in der Zukunft/)

// ⚠️ The Rapport is a SURFACE, not a dialog: it is opened early in an Einsatz and left open for
// hours. Anything that compares a stamp against «now» therefore has to read a live clock — a
// «now» captured when the surface mounted is only correct for the first few minutes of its life.
describe('Zeiten · «Jetzt» never warns about the time it just wrote', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 14, 20, 5)) // Rapport opened 23 min into the Einsatz
  })

  it('is clean straight after mounting', () => {
    setup()
    fireEvent.click(jetztFor(/^Ende Einsatz$/))
    expect(futureWarnings()).toHaveLength(0)
  })

  it('is still clean after the surface has been open for two hours', () => {
    setup()
    // …which is the ordinary case: the Rapport is filled in across the whole Einsatz, and the
    // Einsatzende is stamped at the end of it. The mount-time «now» made this warn «Liegt in
    // der Zukunft» about a time the operator had just stamped as NOW.
    vi.setSystemTime(new Date(2026, 7, 14, 22, 5))
    fireEvent.click(jetztFor(/^Ende Einsatz$/))
    expect(futureWarnings()).toHaveLength(0)
  })

  it('…and the same for the Rückmeldung an die ELZ', () => {
    setup()
    vi.setSystemTime(new Date(2026, 7, 14, 22, 5))
    fireEvent.click(jetztFor(/^Zeit Rückmeldung ELZ$/))
    expect(futureWarnings()).toHaveLength(0)
  })

  it('still warns about a time that IS in the future — the check has to keep working', () => {
    setup()
    fireEvent.click(jetztFor(/^Ende Einsatz$/))
    expect(futureWarnings()).toHaveLength(0)
    // the clock goes BACKWARDS relative to the stamp: same thing as picking tomorrow by hand
    vi.setSystemTime(new Date(2026, 7, 13, 20, 5))
    fireEvent.click(jetztFor(/^Zeit Rückmeldung ELZ$/)) // any interaction re-renders the form
    expect(futureWarnings().length).toBeGreaterThan(0)
  })
})
