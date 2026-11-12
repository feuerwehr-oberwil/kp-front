// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./KrokiFramingPanel', () => ({ KrokiFramingPanel: () => null }))

import { ReportPreflight } from './ReportPreflight'

// The Rapport asks whether it is on a phone (useIsPhone → matchMedia) to decide whether the
// Kroki map may be mounted; jsdom implements no matchMedia. Pinned to «not a phone», which is
// the surface these tests are about.
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})


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
    fireEvent.click(jetztFor(/^Einsatzende$/))
    expect(futureWarnings()).toHaveLength(0)
  })

  it('is still clean after the surface has been open for two hours', () => {
    setup()
    // …which is the ordinary case: the Rapport is filled in across the whole Einsatz, and the
    // Einsatzende is stamped at the end of it. The mount-time «now» made this warn «Liegt in
    // der Zukunft» about a time the operator had just stamped as NOW.
    vi.setSystemTime(new Date(2026, 7, 14, 22, 5))
    fireEvent.click(jetztFor(/^Einsatzende$/))
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
    fireEvent.click(jetztFor(/^Einsatzende$/))
    expect(futureWarnings()).toHaveLength(0)
    // the clock goes BACKWARDS relative to the stamp: same thing as picking tomorrow by hand
    vi.setSystemTime(new Date(2026, 7, 13, 20, 5))
    fireEvent.click(jetztFor(/^Zeit Rückmeldung ELZ$/)) // any interaction re-renders the form
    expect(futureWarnings().length).toBeGreaterThan(0)
  })
})

// ⚠️ WHICH DAY a correction in the Alarmierungs-/Ausrückzeiten grid lands on. A field that does
// not open on the day its value is already on opens the wheel on TODAY and writes TODAY back. On this grid that reaches the printed Rapport: correcting a Monday-night
// Ausrückzeit on Wednesday morning filed it as Wednesday, silently.
describe('Zeiten · a correction stays on the day the stamp is already on', () => {
  const MON = new Date(2026, 7, 10, 22, 0) // alarmiert Monday night…
  const WED = new Date(2026, 7, 12, 9, 0) // …rapport written Wednesday morning

  beforeEach(() => {
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})
    vi.useFakeTimers()
    vi.setSystemTime(WED)
  })

  /** the day the freshest onSaveMeta call put the group's Alarmierungszeit on */
  const savedGroupDay = (onSaveMeta: ReturnType<typeof vi.fn>) => {
    const calls = onSaveMeta.mock.calls
    const meta = calls[calls.length - 1][0] as { gruppen?: { alarmedAt?: string }[] }
    const iso = meta.gruppen?.[0]?.alarmedAt
    return iso ? new Date(iso).toDateString() : undefined
  }

  it('re-committing an Ausrückzeit does not move it to today', () => {
    const onSaveMeta = vi.fn()
    const alarmedAt = new Date(2026, 7, 10, 22, 5).toISOString()
    render(
      <ReportPreflight
        incident={{ ...INCIDENT, started_at: MON.toISOString() }}
        // an unconfigured group still gets a row (gruppenRows · orphans), so the grid is on
        // screen without a deployment config
        reportMeta={{ alarmiertAt: MON.toISOString(), gruppen: [{ id: 'gruppe-1', alarmedAt, manual: true }] }}
        events={[]}
        annotatedPlanCount={0} truppCount={0} attendanceCount={0} mittelCount={0}
        mapContentCount={0}
        onSaveMeta={onSaveMeta}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Gruppe 1' }))
    // committed without touching the day — the correction is to the CLOCK, not to the day
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(savedGroupDay(onSaveMeta)).toBe(new Date(2026, 7, 10).toDateString())
  })
})

// Every grid row is date + time since 12.11.2026 (docs/rapport.md › Times): the day used to be
// GUESSED from the alarm after the commit. Now what the row shows before «OK» is what is stored.
describe('Zeiten · a grid row over midnight stores the day that was shown', () => {
  const ALARM = new Date(2026, 7, 10, 23, 50) // alarmiert Monday 23:50…

  beforeEach(() => {
    Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})
    window.matchMedia = ((q: string) => ({
      matches: q.includes('coarse'), media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 11, 1, 0)) // …the Rapport written at 01:00
  })

  it('an empty row opens on the alarm, and 00:15 on the Tuesday is filed on the Tuesday', () => {
    const onSaveMeta = vi.fn()
    render(
      <ReportPreflight
        incident={{ ...INCIDENT, started_at: ALARM.toISOString() }}
        reportMeta={{ alarmiertAt: ALARM.toISOString(), gruppen: [{ id: 'gruppe-1', manual: true }] }}
        events={[]}
        annotatedPlanCount={0} truppCount={0} attendanceCount={0} mittelCount={0}
        mapContentCount={0}
        onSaveMeta={onSaveMeta}
      />,
    )
    const field = screen.getByRole('button', { name: 'Gruppe 1' })
    expect(field.textContent).toBe('--.--. --:--')
    fireEvent.click(field)
    const wheel = (name: string) => screen.getByRole('listbox', { name })
    // preselected on the alarm day — visible before anything is committed
    expect(wheel('Tag').querySelector('[aria-selected="true"]')?.textContent).toBe('Mo 10.08.')
    fireEvent.click(within(wheel('Tag')).getByRole('option', { name: 'Di 11.08.' }))
    fireEvent.click(within(wheel('Stunde')).getAllByRole('option', { name: '00' })[0])
    fireEvent.click(within(wheel('Minute')).getAllByRole('option', { name: '15' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    const meta = onSaveMeta.mock.calls[onSaveMeta.mock.calls.length - 1][0] as { gruppen?: { alarmedAt?: string }[] }
    expect(meta.gruppen?.[0]?.alarmedAt).toBe(new Date(2026, 7, 11, 0, 15).toISOString())
    expect(screen.getByRole('button', { name: 'Gruppe 1' }).textContent).toBe('11.08. 00:15')
  }, 15_000) // the whole Rapport is mounted and three wheels are driven: slow on a loaded runner
})
