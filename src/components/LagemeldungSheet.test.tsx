// @vitest-environment jsdom
// The Lagemeldung composer (F3, layout ★A): the draft arrives ticked, a tier-0 line asks once
// before it goes, hidden items say why and come back on a tap, and «Gemeldet» hands over the text,
// the fact snapshot and the next booking — nothing is written by the sheet itself.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LagemeldungSheet, type LageSend } from './LagemeldungSheet'
import { ReminderBanner } from './ReminderBanner'
import { Meldeleiste } from './Meldeleiste'
import { hhmm } from '../lib/format'
import type { LageAnchorRef, LageInput } from '../lib/lagemeldung'
import type { OpenReminder } from '../lib/reminders'

afterEach(cleanup)

const T0 = Date.parse('2026-10-09T19:12:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const input = (over: Partial<LageInput> = {}): LageInput => ({
  now: T0 + 25 * 60_000,
  title: 'Brand MFH',
  symbols: [{ id: 'p1', kind: 'symbol', symbol: 'VKF Rettungen', fields: { Status: 'vermisst' }, floor: 3 }, { id: 'f1', kind: 'symbol', symbol: 'VKF Feuer', floor: 2 }],
  trupps: [],
  doctrine: { contactIntervalMin: 10, contactGraceSec: 60, alarmBar: 60, cylinderLiters: 6.8, estConsumptionLPerMin: 60 },
  rows: [{ id: 'r1', t: '', at: at(20), icon: 'type', text: 'Gas abgestellt', kind: 'journal' }],
  reminders: [],
  fahrzeuge: [{ id: 'tlf', vorOrt: at(4) }],
  fleet: [{ id: 'tlf', label: 'TLF' }],
  present: 6,
  ...over,
})

function mount(over: { input?: LageInput; anchor?: LageAnchorRef | null; intervalMin?: number; onRhythmOff?: () => void } = {}) {
  const sent: LageSend[] = []
  let closed = 0
  render(
    <LagemeldungSheet
      getInput={() => over.input ?? input()}
      anchor={over.anchor ?? null}
      intervalMin={over.intervalMin ?? 20}
      onClose={() => { closed++ }}
      onSend={(r) => sent.push(r)}
      onRhythmOff={over.onRhythmOff}
    />,
  )
  return { sent, closed: () => closed }
}

describe('LagemeldungSheet', () => {
  it('an Erstmeldung arrives ticked, every line NEU, the next one booked at the rhythm', () => {
    const { sent } = mount()
    expect(screen.getByText(/Erstmeldung/)).toBeTruthy()
    expect(screen.getByText('1 Person vermisst, 3. OG.')).toBeTruthy()
    expect(screen.getByText(`Nächste Meldung ca. ${hhmm(new Date(T0 + 45 * 60_000))}.`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Gemeldet/ }))
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('Menschen: 1 Person vermisst, 3. OG.')
    expect(sent[0].text).not.toContain('\n') // one line in the Verlauf
    expect(sent[0].next).toEqual({ kind: 'every', min: 20 })
    expect(sent[0].anchor.facts['pers.vermisst']).toBe(1)
  })

  it('a tier-0 line asks «trotzdem weglassen?» before it goes — and is stored as declined', () => {
    const { sent } = mount()
    const untick = screen.getByRole('button', { name: /Aus der Meldung nehmen: 1 Person vermisst/ })
    fireEvent.click(untick)
    expect(screen.getByRole('alert').textContent).toContain('trotzdem weglassen')
    expect(untick.getAttribute('aria-pressed')).toBe('true') // not yet
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Weglassen' }))
    fireEvent.click(screen.getByRole('button', { name: /Gemeldet/ }))
    expect(sent[0].text).not.toContain('vermisst')
    expect(sent[0].anchor.declined).toEqual(['pers.vermisst'])
  })

  it('a line is edited in place and keeps its key', () => {
    const { sent } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Gas abgestellt.' }))
    const field = screen.getByRole('textbox', { name: 'Zeile bearbeiten' })
    fireEvent.change(field, { target: { value: 'Gas am Hauptschieber abgestellt.' } })
    fireEvent.blur(field)
    fireEvent.click(screen.getByRole('button', { name: /Gemeldet/ }))
    expect(sent[0].text).toContain('Gas am Hauptschieber abgestellt.')
    expect(sent[0].anchor.facts['hz.gas']).toBe('ab')
  })

  it('«seit» hides the unchanged with its reason; one tap adds it back', () => {
    const anchor: LageAnchorRef = { id: 'a', at: T0 + 5 * 60_000, anchor: { v: 1, mode: 'seit', facts: { 'pers.vermisst': 1, 'lage.kern': ['Brand MFH', 'Feuer 2. OG'], 'mittel.vorOrt': ['TLF'], 'mittel.adf': 6 } } }
    const { sent } = mount({ anchor })
    // tier 0 is repeated even though unchanged
    expect(screen.getByText('1 Person vermisst, 3. OG.')).toBeTruthy()
    expect(screen.queryByText('Brand MFH. Feuer 2. OG.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Ausgeblendet/ }))
    expect(screen.getByText('Brand MFH. Feuer 2. OG.')).toBeTruthy()
    expect(screen.getAllByText(`unverändert seit ${hhmm(new Date(T0 + 5 * 60_000))}`).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '«Brand MFH. Feuer 2. OG.» in die Meldung nehmen' }))
    fireEvent.click(screen.getByRole('button', { name: /Gemeldet/ }))
    expect(sent[0].text).toContain('Lage: Brand MFH. Feuer 2. OG.')
  })

  it('«Vollständig» says everything again', () => {
    const anchor: LageAnchorRef = { id: 'a', at: T0 + 5 * 60_000, anchor: { v: 1, mode: 'seit', facts: { 'lage.kern': ['Brand MFH', 'Feuer 2. OG'] } } }
    mount({ anchor })
    expect(screen.queryByText('Brand MFH. Feuer 2. OG.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Vollständig' }))
    expect(screen.getByText('Brand MFH. Feuer 2. OG.')).toBeTruthy()
  })

  it('the rhythm is picked on the «Nächste» line; «Übergabe» books nothing', () => {
    const { sent } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Übergabe' }))
    expect(screen.getByText('Nächste Meldung bei Übergabe.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Gemeldet/ }))
    expect(sent[0].next).toEqual({ kind: 'handover' })
    expect(sent[0].text.endsWith('Nächste Meldung bei Übergabe.')).toBe(true)
  })

  it('an own line goes into «Zusatz»', () => {
    const { sent } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Eigene Zeile' }))
    const field = screen.getByRole('textbox', { name: 'Eigene Zeile' })
    fireEvent.change(field, { target: { value: 'Presse vor Ort' } })
    fireEvent.blur(field)
    fireEvent.click(screen.getByRole('button', { name: /Gemeldet/ }))
    expect(sent[0].text).toContain('Zusatz: Presse vor Ort.')
  })

  it('says how long it takes on the radio', () => {
    mount()
    expect(screen.getByRole('status').textContent).toMatch(/≈ \d+ s\d+ Wörter/)
  })

  it('the Funkansicht shows the same text in big type and can send from there', () => {
    const { sent } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Funkansicht' }))
    const dialog = screen.getByRole('dialog', { name: /Funkansicht/ })
    expect(dialog.textContent).toContain('1 Person vermisst, 3. OG.')
    fireEvent.click(within(dialog).getByRole('button', { name: /Gemeldet/ }))
    expect(sent).toHaveLength(1)
  })

  it('nothing is written on close', () => {
    const { sent } = mount()
    fireEvent.click(screen.getByRole('button', { name: /schliessen|Schliessen/i }))
    expect(sent).toHaveLength(0)
  })
})

describe('ReminderBanner · the Lagemeldung booking', () => {
  const booking: OpenReminder = { id: 'lgm-a1', rowId: 'r', text: 'Lagemeldung', dueAt: at(25), createdAt: at(5), notes: [], purpose: 'lagemeldung' }
  it('offers [Lagemeldung] [+10′] and the engine\'s count instead of [Erledigt]', () => {
    let opened = 0
    const snoozed: string[] = []
    render(
      <>
        <ReminderBanner due={[booking]} onDone={() => {}} onSnooze={(r) => snoozed.push(r.id)} onLagemeldung={() => { opened++ }} lageSub="letzte 21:17 · 5 Änderungen, 1 dringend" />
        <Meldeleiste />
      </>,
    )
    expect(screen.getByText(/Lagemeldung fällig/)).toBeTruthy()
    expect(screen.getByText('letzte 21:17 · 5 Änderungen, 1 dringend')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Erledigt/ })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Lagemeldung' })[0])
    fireEvent.click(screen.getByRole('button', { name: '+10′' }))
    expect(opened).toBe(1)
    expect(snoozed).toEqual(['lgm-a1'])
  })
  it('without the door (a device that may not send) it is the ordinary Wiedervorlage', () => {
    render(<><ReminderBanner due={[booking]} onDone={() => {}} onSnooze={() => {}} /><Meldeleiste /></>)
    expect(screen.getByRole('button', { name: /Erledigt/ })).toBeTruthy()
  })
})
