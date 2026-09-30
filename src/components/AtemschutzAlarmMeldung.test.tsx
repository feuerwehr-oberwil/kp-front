// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { AtemschutzAlarmMeldungen, atemschutzAlarmRows } from './AtemschutzAlarmMeldung'
import { azChipRedundant } from '../lib/atemschutz'
import { Meldeleiste } from './Meldeleiste'
import type { Trupp } from '../types'

// What is pinned here is the claim the whole file exists for: a tone that sounds has a row, and
// the row names WHICH Trupp and WHY. The two reasons must not be one wording.

const DOCTRINE = { alarmBar: 100, alarmBarRueckzug: 50 }
const NOW = Date.parse('2026-08-23T10:00:00Z')
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString()

const trupp = (over: Partial<Trupp> & Pick<Trupp, 'id' | 'name'>): Trupp => ({
  status: 'aktiv', entryTime: ago(900), lastContactTime: ago(60), entryPressureBar: 300, ...over,
} as Trupp)

describe('atemschutzAlarmRows', () => {
  it('publishes only the tier the tone plays on — the amber «Kontakt fällig» lead stays board-only', () => {
    const t = [trupp({ id: 'a', name: 'Meier' }), trupp({ id: 'b', name: 'Huber' })]
    const rows = atemschutzAlarmRows(t, { a: 1, b: 2 }, NOW, 5, 60, DOCTRINE)
    expect(rows.map((r) => r.id)).toEqual(['b'])
  })

  it('names the reason per Trupp — one out of contact, one out of air, in the same alarm', () => {
    const t = [
      trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) }),
      trupp({ id: 'b', name: 'Huber', lastPressureBar: 90 }),
    ]
    const rows = atemschutzAlarmRows(t, { a: 2, b: 2 }, NOW, 5, 60, DOCTRINE)
    expect(rows).toEqual([
      { id: 'a', name: 'Meier', reason: 'contact', sinceContactSec: 600 },
      { id: 'b', name: 'Huber', reason: 'pressure', bar: 90, line: 100 },
    ])
  })

  it('carries the line the Trupp is actually held to — a Rückzug is measured lower (alarmBarFor)', () => {
    const t = [trupp({ id: 'a', name: 'Meier', status: 'rueckzug', lastPressureBar: 45 })]
    expect(atemschutzAlarmRows(t, { a: 2 }, NOW, 5, 60, DOCTRINE)[0])
      .toEqual({ id: 'a', name: 'Meier', reason: 'pressure', bar: 45, line: 50 })
  })

  it('says nothing while the fold is silent — no severities during replay means no rows', () => {
    expect(atemschutzAlarmRows([trupp({ id: 'a', name: 'Meier' })], {}, NOW, 5, 60, DOCTRINE)).toEqual([])
  })

  it('carries the whole crew — the row prints leader · members as far as the title fits', () => {
    const t = [trupp({ id: 'a', name: 'Meier A.', members: ['Keller B.', 'Weber C.'], lastContactTime: ago(600) })]
    expect(atemschutzAlarmRows(t, { a: 2 }, NOW, 5, 60, DOCTRINE)[0].members).toEqual(['Keller B.', 'Weber C.'])
  })
})

describe('the published rows', () => {
  afterEach(cleanup)

  it('gives every alarming Trupp its own row, worded for its own reason and impossible to wave away', () => {
    render(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[
            trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) }),
            trupp({ id: 'b', name: 'Huber', lastPressureBar: 90 }),
          ]}
          severities={{ a: 2, b: 2 }}
          intervalMin={5}
          graceSec={60}
          onGoToTrupp={() => {}}
        />
        <Meldeleiste />
      </>,
    )
    const rows = document.querySelectorAll('.ml-row')
    expect(rows).toHaveLength(2)
    // …and the two rows do NOT say the same thing: a radio check fixes one of them and not the other
    const titles = [...rows].map((r) => r.querySelector('.ml-title')?.textContent ?? '')
    expect(titles.some((t) => t.includes('überfällig') && t.includes('Meier'))).toBe(true)
    expect(titles.some((t) => t.includes('Alarmdruck') && t.includes('Huber'))).toBe(true)
    expect(titles.some((t) => t.includes('überfällig') && t.includes('Huber'))).toBe(false)
    // no ✕ anywhere on the strip — an überfällig Trupp is not dismissible
    expect(document.querySelectorAll('.ml-x')).toHaveLength(0)
    expect(document.querySelectorAll('.ml-act button')).toHaveLength(2) // «Zum Trupp», once per row
  })

  // The filled «Zum Trupp» button is what makes this row readable as actionable from across the
  // room; the tappable name is only the shortcut for the hand already on it. Losing the button
  // would be a regression, so both are pinned here.
  it('lets the name of the Trupp lead to the board too, without giving up the labelled button', () => {
    const went: string[] = []
    const acknowledged: string[] = []
    render(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })]}
          severities={{ a: 2 }}
          intervalMin={5}
          graceSec={60}
          onAcknowledge={() => acknowledged.push('mute')}
          onGoToTrupp={(id) => went.push(id)}
        />
        <Meldeleiste />
      </>,
    )
    fireEvent.click(document.querySelector('button.ml-open')!)
    expect(went).toEqual(['a'])
    expect(acknowledged).toEqual(['mute'])
    // …and the jump IS the dismissal now (28.08.): the operator stands on the board that shows
    // the alarm in full, and the strip was covering the controls they need next
    expect(document.querySelector('.ml-act button')).toBeNull()
  })

  // A viewer's device cannot end the alarm, so its row would stand for ever: it gets the one
  // extra, secondary button that hides the row HERE only, and the sub says it is read-only.
  it('gives a read-only device «Zur Kenntnis genommen», which hides that row on this device', () => {
    const went: string[] = []
    render(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })]}
          severities={{ a: 2 }}
          intervalMin={5}
          graceSec={60}
          canEdit={false}
          onGoToTrupp={(id) => went.push(id)}
        />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelector('.ml-sub')?.textContent).toMatch(/nur lesend$/)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ml-act button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Zur Kenntnis genommen', 'Zum Trupp'])
    expect(buttons[0].className).not.toMatch(/prim/)
    fireEvent.click(buttons[0])
    expect(document.querySelector('.ml-row')).toBeNull()
    expect(went).toEqual([]) // acknowledged, not navigated
  })

  it('shows an editor no such button and no read-only note', () => {
    render(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })]}
          severities={{ a: 2 }} intervalMin={5} graceSec={60} onGoToTrupp={() => {}}
        />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelectorAll('.ml-act button')).toHaveLength(1)
    expect(document.querySelector('.ml-sub')?.textContent).not.toMatch(/nur lesend/)
  })

  // the tone ⇔ row exception (see the component header): standing on the board, the strip only
  // covered the very controls the alarm points at — withheld, never acknowledged
  it('withholds the rows on the board itself, without muting, and hands them back on leaving', () => {
    const acknowledged: string[] = []
    const base = { intervalMin: 5, graceSec: 60, onGoToTrupp: () => {}, onAcknowledge: () => acknowledged.push('mute') }
    const overdue = trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })
    const { rerender } = render(
      <>
        <AtemschutzAlarmMeldungen trupps={[overdue]} severities={{ a: 2 }} {...base} onBoard />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelector('.ml-row')).toBeNull()
    expect(acknowledged).toEqual([]) // withheld is not acknowledged — the device keeps sounding
    // leaving the board mid-alarm brings the row straight back
    rerender(
      <>
        <AtemschutzAlarmMeldungen trupps={[overdue]} severities={{ a: 2 }} {...base} onBoard={false} />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelector('.ml-row')).not.toBeNull()
  })

  it('the visited bookkeeping survives a stay on the board — a dismissed row stays dismissed', () => {
    const base = { intervalMin: 5, graceSec: 60, onGoToTrupp: () => {} }
    const overdue = trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })
    const strip = (onBoard: boolean) => (
      <>
        <AtemschutzAlarmMeldungen trupps={[overdue]} severities={{ a: 2 }} {...base} onBoard={onBoard} />
        <Meldeleiste />
      </>
    )
    const { rerender } = render(strip(false))
    fireEvent.click(document.querySelector('button.ml-open')!) // «Zum Trupp» dismisses
    rerender(strip(true))
    rerender(strip(false))
    // the SAME emergency does not resurface just because the operator passed through the board
    expect(document.querySelector('.ml-row')).toBeNull()
  })

  it('a dismissed row returns when a NEW emergency starts', () => {
    const base = { intervalMin: 5, graceSec: 60, onGoToTrupp: () => {} }
    const overdue = trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })
    const { rerender } = render(
      <>
        <AtemschutzAlarmMeldungen trupps={[overdue]} severities={{ a: 2 }} {...base} />
        <Meldeleiste />
      </>,
    )
    fireEvent.click(document.querySelector('button.ml-open')!)
    expect(document.querySelector('.ml-open')).toBeNull() // dismissed by the jump
    // the alarm CLEARS (contact recorded) …
    rerender(
      <>
        <AtemschutzAlarmMeldungen trupps={[trupp({ id: 'a', name: 'Meier', lastContactTime: ago(10) })]} severities={{}} {...base} />
        <Meldeleiste />
      </>,
    )
    // …and a fresh crossing publishes a fresh row
    rerender(
      <>
        <AtemschutzAlarmMeldungen trupps={[overdue]} severities={{ a: 2 }} {...base} />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelector('.ml-open')).not.toBeNull()
  })
})

// Several Trupps in alarm for the SAME reason share one row (15.09.2026): two überfällige Trupps
// used to stack two full-height rows with two identical buttons over the map.
describe('several Trupps, one reason', () => {
  afterEach(cleanup)
  const base = { intervalMin: 5, graceSec: 60 }

  it('merges them into one row naming the leaders, most urgent first, and «Zum Trupp» lands on that one', () => {
    const went: string[] = []
    render(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[
            trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) }),
            trupp({ id: 'b', name: 'Huber', lastContactTime: ago(900) }),
          ]}
          severities={{ a: 2, b: 2 }} {...base} onGoToTrupp={(id) => went.push(id)}
        />
        <Meldeleiste />
      </>,
    )
    const rows = document.querySelectorAll('.ml-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('.ml-title')?.textContent).toContain('2 Trupps: Huber · Meier')
    expect(document.querySelectorAll('.ml-act button')).toHaveLength(1)
    fireEvent.click(document.querySelector('.ml-act button')!)
    expect(went).toEqual(['b']) // the longer without contact
  })

  it('keeps the two reasons apart, and a merged pressure row carries each Trupp\'s bar', () => {
    render(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[
            trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) }),
            trupp({ id: 'b', name: 'Huber', lastPressureBar: 90 }),
            trupp({ id: 'c', name: 'Keller', lastPressureBar: 70 }),
          ]}
          severities={{ a: 2, b: 2, c: 2 }} {...base} onGoToTrupp={() => {}}
        />
        <Meldeleiste />
      </>,
    )
    const titles = [...document.querySelectorAll('.ml-title')].map((t) => t.textContent ?? '')
    expect(titles).toHaveLength(2)
    expect(titles.some((t) => t.includes('überfällig') && t.includes('Meier'))).toBe(true)
    expect(titles.some((t) => t.includes('Alarmdruck') && t.includes('Keller 70 bar · Huber 90 bar'))).toBe(true)
  })

  it('a Trupp that crosses after the jump brings the row back naming only what is new', () => {
    const overdueA = trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })
    const { rerender } = render(
      <>
        <AtemschutzAlarmMeldungen trupps={[overdueA]} severities={{ a: 2 }} {...base} onGoToTrupp={() => {}} />
        <Meldeleiste />
      </>,
    )
    fireEvent.click(document.querySelector('.ml-act button')!)
    expect(document.querySelector('.ml-row')).toBeNull()
    rerender(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[overdueA, trupp({ id: 'b', name: 'Huber', lastContactTime: ago(700) })]}
          severities={{ a: 2, b: 2 }} {...base} onGoToTrupp={() => {}}
        />
        <Meldeleiste />
      </>,
    )
    const title = document.querySelector('.ml-title')?.textContent ?? ''
    expect(title).toContain('Huber')
    expect(title).not.toContain('Meier')
  })
})

// T1 (29.09.2026): the TopBar chip steps aside while its alarm already has a door on screen — the
// board's own badge, or a Meldeleiste row naming the same Trupp for the same reason. Never for
// the amber lead, and back the moment «Zum Trupp» took the row down.
describe('the TopBar chip and the strip', () => {
  afterEach(cleanup)
  const base = { intervalMin: 5, graceSec: 60, onGoToTrupp: () => {} }
  const red = { peak: 2 as const, urgent: { id: 'b', reason: 'pressure' as const } }

  it('hides a red chip on the board, or while a row names its Trupp for its reason', () => {
    expect(azChipRedundant(red, true, [])).toBe(true)
    expect(azChipRedundant(red, false, ['b:pressure'])).toBe(true)
    // a row for the same Trupp but the OTHER reason is a different emergency
    expect(azChipRedundant(red, false, ['b:contact', 'a:contact'])).toBe(false)
    expect(azChipRedundant(red, false, [])).toBe(false)
  })

  it('never hides the amber «Kontakt fällig» — it has no row and no badge', () => {
    const amber = { peak: 1 as const, urgent: { id: 'a', reason: 'contact' as const } }
    expect(azChipRedundant(amber, true, ['a:contact'])).toBe(false)
    expect(azChipRedundant({ peak: 0, urgent: null }, true, [])).toBe(false)
  })

  it('reports what the strip names, nothing while withheld, and drops a row «Zum Trupp» took down', () => {
    const reports: string[][] = []
    const onShown = (k: string[]) => reports.push(k)
    const last = () => reports[reports.length - 1]
    const t = [trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) }), trupp({ id: 'b', name: 'Huber', lastPressureBar: 90 })]
    const strip = (onBoard: boolean) => (
      <>
        <AtemschutzAlarmMeldungen trupps={t} severities={{ a: 2, b: 2 }} {...base} onBoard={onBoard} onShown={onShown} />
        <Meldeleiste />
      </>
    )
    const { rerender } = render(strip(false))
    expect(last()).toEqual(['a:contact', 'b:pressure'])
    rerender(strip(true))
    expect(last()).toEqual([])
    rerender(strip(false))
    // «Zum Trupp» on the pressure row: that row goes, and with it the chip's reason to hide
    const pressureRow = [...document.querySelectorAll('.ml-row')].find((r) => r.textContent?.includes('Alarmdruck'))!
    fireEvent.click(pressureRow.querySelector('.ml-act button')!)
    expect(last()).toEqual(['a:contact'])
    expect(azChipRedundant(red, false, last())).toBe(false)
  })

  // T13: the title is still the way in, but it does not wear a link look beside its own button
  it('draws the title without the underline, and «Zum Trupp» without a glyph', () => {
    render(
      <>
        <AtemschutzAlarmMeldungen trupps={[trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })]} severities={{ a: 2 }} {...base} />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelector('button.ml-open')?.className).toBe('ml-open plain')
    expect(document.querySelector('.ml-act button svg')).toBeNull()
  })
})
