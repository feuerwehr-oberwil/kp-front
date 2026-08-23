// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { AtemschutzAlarmMeldungen, atemschutzAlarmRows } from './AtemschutzAlarmMeldung'
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
      { id: 'a', name: 'Meier', reason: 'contact' },
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
    render(
      <>
        <AtemschutzAlarmMeldungen
          trupps={[trupp({ id: 'a', name: 'Meier', lastContactTime: ago(600) })]}
          severities={{ a: 2 }}
          intervalMin={5}
          graceSec={60}
          onGoToTrupp={(id) => went.push(id)}
        />
        <Meldeleiste />
      </>,
    )
    fireEvent.click(document.querySelector('button.ml-open')!)
    expect(document.querySelectorAll('.ml-act button')).toHaveLength(1)
    fireEvent.click(document.querySelector('.ml-act button')!)
    expect(went).toEqual(['a', 'a'])
  })
})
