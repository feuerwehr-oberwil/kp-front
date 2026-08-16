// @vitest-environment jsdom
//
// Which DAY a time field commits on. Only ever a question on an incident that spans more than
// one — but that is the case this control exists for, and both bugs pinned here wrote a stamp
// onto a day nobody chose, silently, on fields nobody re-reads.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeField } from './TimeField'
import { TimeBlockSheet } from './TimeBlockSheet'

afterEach(() => { cleanup(); vi.useRealTimers() })

beforeEach(() => {
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})
  // the popover draws its wheels only on a coarse pointer — a phone, which is what this is
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('coarse'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }))
})

const MON = new Date(2026, 7, 10) // the Einsatz starts Monday 22:00…
const TUE = new Date(2026, 7, 11)
const WED = new Date(2026, 7, 12) // …and it is still open on Wednesday morning
const DAYS = [MON, TUE, WED]

/** the day part of what onCommit was handed, as a plain date string */
const committedDay = (onCommit: ReturnType<typeof vi.fn>) => {
  const day = onCommit.mock.calls[0][1] as Date | undefined
  return day ? day.toDateString() : undefined
}

describe('TimeField · the day a stamp lands on', () => {
  // ⚠️ The popover hands a day back on EVERY commit once the incident spans more than one, so
  // whatever day the wheel happens to show becomes the answer. It seeded itself from `new Date()`
  // and copied only the clock off `value` — so correcting a Monday-night arrival on Wednesday
  // morning moved that person two days forward without a word.
  it('opens the day wheel on the day the value is already on, not on today', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0)) // Wednesday morning
    const onCommit = vi.fn()
    render(
      <TimeField ariaLabel="von" value="22:15" valueDay={MON} days={DAYS}
        onCommit={onCommit} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'von' }))
    // committed without touching a wheel — the correction is to the CLOCK, not to the day
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(committedDay(onCommit)).toBe(MON.toDateString())
  })

  // ⚠️ …and the field being right is only half of it: something has to HAND it the day. TimeField
  // has behaved correctly since the test above, but TimeBlockSheet never passed `valueDay`, so
  // every Zeitplan and Anwesenheit block re-opened on today and wrote today back. Reproduced by
  // hand on 16.08.: setting «bis» to Tuesday, then correcting only the MINUTE, moved it to today.
  // This pins the wiring, not the control — that is where the bug actually lived.
  it('a block sheet hands each end its own day, so correcting the clock cannot move it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0)) // Wednesday morning — neither end is today
    const onFrom = vi.fn()
    render(
      <TimeBlockSheet
        title="Schicht" subject="Müller Hans" sectionTitle="Zeiten" emptyLabel="keine"
        onClose={() => {}} days={DAYS}
        labels={{ from: 'von', to: 'bis', done: 'beendet', remove: 'entfernen',
                  fromStart: 'ab Beginn', reopen: 'noch da', flip: 'umschalten' }}
        blocks={[{
          key: 'a', from: '22:15', to: '06:00',
          fromDay: MON, toDay: TUE,           // ← the wiring under test
          head: { label: 'beendet', tone: 'done' as const },
          onFrom, onTo: () => {},
        }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'von – Müller Hans' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(committedDay(onFrom)).toBe(MON.toDateString())
  })

  // ⚠️ «Jetzt» used to hand back a bare HH:MM. Every caller then had to infer the day from a
  // neighbouring stamp, and those rules reach exactly one day either side: on an Einsatz running
  // since Monday, «Jetzt» pressed on Wednesday was filed on Tuesday.
  it('«Jetzt» says which day it means, wherever a day wheel is offered', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0))
    const onCommit = vi.fn()
    render(<TimeField ariaLabel="Ende" value="" days={DAYS} nowLabel="Jetzt" onCommit={onCommit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt' }))
    expect(onCommit).toHaveBeenCalledWith('09:00', expect.any(Date))
    expect(committedDay(onCommit)).toBe(WED.toDateString())
  })

  // …and a field with no day wheel keeps handing back a bare clock: its caller owns the day, and
  // handing one over would change what every single-day surface does with it.
  it('says nothing about the day where no day wheel exists', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0))
    const onCommit = vi.fn()
    render(<TimeField ariaLabel="Ende" value="" nowLabel="Jetzt" onCommit={onCommit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt' }))
    expect(onCommit).toHaveBeenCalledWith('09:00', undefined)
  })
})
