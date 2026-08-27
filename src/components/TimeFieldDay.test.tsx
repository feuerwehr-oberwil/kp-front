// @vitest-environment jsdom
//
// Which DAY a time field commits on. Only ever a question on an incident that spans more than
// one — but that is the case this control exists for, and both bugs pinned here wrote a stamp
// onto a day nobody chose, silently, on fields nobody re-reads.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeField } from './TimeField'
import { TimeBlockSheet } from './TimeBlockSheet'
import { AnwesenheitView } from './AnwesenheitView'
import { PersonShiftSheet } from './PersonShiftSheet'
import { BandGrid } from './BandGrid'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { AttendanceState, Person, Shift, ShiftBand } from '../types'

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

// ── and the three surfaces that hand the day down ──────────────────────────────────────────
//
// The wiring above is pinned on TimeBlockSheet in isolation, which is one layer short of the
// bug: what actually reached the workspace was each caller's own onCommit, and every one of
// them has to CHOOSE between the day the picker hands back and its own fallback rule. A caller
// that forwards the right day into the field and then ignores it on the way out is exactly as
// broken as one that never passed it. So each of the three is driven the way an operator drives
// it — open, tap the field, confirm without touching a wheel — on a Wednesday morning, with the
// value sitting on Monday night.
describe('correcting a stamp from an earlier day, on a multi-day Einsatz', () => {
  /** an ISO instant on one of the days above, in local time — the clock the field will show */
  const at = (day: Date, h: number, mi = 0) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi, 0, 0).toISOString()
  const wednesdayMorning = () => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 7, 12, 9, 0)) }
  const person: Person = { id: 'p1', displayName: 'Meier Anna', active: true, updatedAt: at(MON, 22) }
  /** confirm the picker without moving anything: the correction is to the CLOCK, not to the day */
  const confirmPicker = (fieldLabel: string) => {
    fireEvent.click(screen.getByRole('button', { name: fieldLabel }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  }
  const dayOf = (iso?: string) => (iso ? new Date(iso).toDateString() : undefined)

  it('Anwesenheit: a recorded block stays on the night it was recorded', () => {
    wednesdayMorning()
    const onSetTimes = vi.fn()
    const attendance = {
      p1: {
        status: 'left', displayNameSnapshot: person.displayName,
        intervals: [{ from: at(MON, 22, 15), to: at(TUE, 6) }],
      },
    } as unknown as AttendanceState
    render(
      <AnwesenheitView
        people={[person]} attendance={attendance} canEdit loading={false} error={false}
        blockedIds={new Set()} truppOfPerson={new Map()} startedAt={at(MON, 22)}
        onMarkPresent={() => {}} onMarkLeft={() => {}} onClear={() => {}}
        onJumpToTrupp={() => {}} onReload={() => {}} onSetTimes={onSetTimes} />,
    )
    fireEvent.click(screen.getByRole('button', {
      name: fillTemplate(appConfig.copy.anwesenheit.openBlocks, { name: person.displayName }),
    }))
    confirmPicker(`${appConfig.copy.anwesenheit.von} – ${person.displayName}`)
    expect(onSetTimes).toHaveBeenCalledTimes(1)
    expect(dayOf(onSetTimes.mock.calls[0][1].from)).toBe(MON.toDateString())
  })

  // ⚠️ The «bis», not the «von», on both planning surfaces: a start that lands on the wrong day
  // is caught downstream by keepStartBeforeEnd, which walks it back a day at a time until it sits
  // before its own end — so the «von» would pass here with no day wiring at all. The END has no
  // such net (an end two days late is simply a longer shift), which is also why the bug was
  // reproduced by hand on that field.
  it('Zeitplan: a planned shift keeps the night it was planned for', () => {
    wednesdayMorning()
    const onSetTime = vi.fn()
    const shift: Shift = { id: 'sh1', personId: person.id, from: at(MON, 22, 15), to: at(TUE, 6) }
    render(
      <PersonShiftSheet
        person={person} shifts={[shift]} blocks={[]} canEdit startedAt={at(MON, 22)}
        conflicts={new Set()} onAdd={() => {}} onSetTime={onSetTime} onToggle={() => {}}
        onRemove={() => {}} onClose={() => {}} />,
    )
    confirmPicker(`${appConfig.copy.anwesenheit.bis} – ${person.displayName}`)
    expect(onSetTime).toHaveBeenCalledTimes(1)
    expect(dayOf(onSetTime.mock.calls[0][1].to)).toBe(TUE.toDateString())
  })

  it('Schichten: re-timing a band does not drag the whole column to today', () => {
    wednesdayMorning()
    const onSaveBand = vi.fn()
    const S = appConfig.copy.schichten
    const band: ShiftBand = { id: 'bd1', label: 'Nacht', from: at(MON, 22), to: at(TUE, 6) }
    render(
      <BandGrid
        people={[person]} shifts={[]} bands={[band]} canEdit startedAt={at(MON, 22)}
        attendance={{}} onAddShift={() => {}} onSetShiftTime={() => {}} onReplaceShift={() => {}}
        onRemoveShift={() => {}} onCreateBand={() => {}} onSaveBand={onSaveBand}
        onRemoveBand={() => {}} onCycleCell={() => {}} onSetCellState={() => {}}
        onPutCellState={() => {}} />,
    )
    fireEvent.click(screen.getByText(band.label).closest('button')!)
    confirmPicker(`${appConfig.copy.zeitplan.to} – ${band.label}`)
    fireEvent.click(screen.getByRole('button', { name: S.save }))
    expect(onSaveBand).toHaveBeenCalledTimes(1)
    // (id, label, von, bis) — the bis is the one that went through the picker
    expect(dayOf(onSaveBand.mock.calls[0][3])).toBe(TUE.toDateString())
  })
})
