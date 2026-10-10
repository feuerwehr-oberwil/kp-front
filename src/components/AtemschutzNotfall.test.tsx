// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { AtemschutzNotfallMeldungen, NotfallBanner, NotfallHold } from './AtemschutzNotfall'
import { ageWords, notfallFactLine } from '../lib/notfall'
import { atemschutzAlarmRows } from './AtemschutzAlarmMeldung'
import { Meldeleiste } from './Meldeleiste'
import { NODE_HOLD_FIRE_MS } from '../lib/nodeHold'
import type { Trupp } from '../types'

// The Atemschutznotfall (F1, 08.10.2026): raised by a HOLD, never a tap; the top row of the strip
// on every surface but the Tafel; and on the Tafel a banner whose first offer is the
// Sicherungstrupp. These pin the three claims a reviewer would test by hand.

const NOW = Date.parse('2026-10-08T02:20:00Z')
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString()
const trupp = (over: Partial<Trupp> & Pick<Trupp, 'id' | 'name'>): Trupp => ({
  status: 'aktiv', entryTime: ago(900), lastContactTime: ago(60), entryPressureBar: 300, ...over,
} as Trupp)
const inNotfall = trupp({
  id: 'a', no: 2, name: 'Keller Anna', members: ['Frei Nina'], notfallAt: ago(130),
  lastPressureBar: 180, lastPressureTime: ago(400), funkkanal: 11,
})
const sitr = trupp({ id: 's', no: 4, name: 'Meier Beat', status: 'angemeldet', entryTime: '', lastContactTime: '', auftrag: 'sichern' })

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('NotfallHold — a hold, never a tap', () => {
  it('fires once the ring is full, and not a moment before', () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const { getByRole } = render(<NotfallHold onFire={fired} />)
    const btn = getByRole('button')
    fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS - 100) })
    expect(fired).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(200) })
    expect(fired).toHaveBeenCalledTimes(1)
    // the click that ends the completed hold does nothing more
    fireEvent.pointerUp(window)
    fireEvent.click(btn, { detail: 1 })
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('lets go early ⇒ nothing happened; a plain tap only says how', () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const { getByRole } = render(<NotfallHold onFire={fired} />)
    const btn = getByRole('button')
    fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 })
    act(() => { vi.advanceTimersByTime(400) })
    fireEvent.pointerUp(window)
    act(() => { vi.advanceTimersByTime(1000) })
    fireEvent.click(btn, { detail: 1 })
    expect(fired).not.toHaveBeenCalled()
  })

  it('names itself AND the gesture for a screen reader, and keeps the hold-tooltip off it', () => {
    const { getByRole } = render(<NotfallHold end onFire={() => {}} />)
    const btn = getByRole('button')
    expect(btn.getAttribute('aria-label')).toBe('Notfall beendet – Gedrückt halten beendet den Notfall')
    expect(btn.hasAttribute('data-holdaction')).toBe(true)
  })
})

describe('the facts', () => {
  it('reads like the radio: since when, where, how much air and how old, which channel', () => {
    const [since, place, bar, kanal] = notfallFactLine(inNotfall, NOW, 'Löschen – 2. OG links · Gebäude · 2. OG')
    expect(since).toMatch(/^seit \d\d:\d\d$/)
    expect(place).toBe('Löschen – 2. OG links · Gebäude · 2. OG')
    expect(bar).toBe('180 bar · vor 7 min')
    expect(kanal).toBe('Kanal 11')
    // never reported: the Eingangsdruck says so instead of an age
    expect(notfallFactLine({ ...inNotfall, lastPressureBar: undefined, lastPressureTime: undefined }, NOW)[1]).toBe('300 bar · Eingangsdruck')
  })

  it('ages in the shortest honest unit', () => {
    expect([ageWords(12), ageWords(400), ageWords(3600), ageWords(5400)]).toEqual(['12 s', '7 min', '1 h', '1 h 30 min'])
  })
})

describe('NotfallBanner — the first offer is the Sicherungstrupp', () => {
  it('sends the one ready Sicherungstrupp in, naming it on the button', () => {
    const deployed: string[] = []
    const { getByText, container } = render(
      <NotfallBanner t={inNotfall} now={NOW} ready={[sitr]} inside={[]} canEdit
        onDeploySafety={(id) => deployed.push(id)} onGo={() => {}} />,
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Trupp 2 (Keller Anna / Frei Nina)')
    expect(container.textContent).toContain('2:10') // the Notfall clock
    fireEvent.click(getByText('Sicherungstrupp einsetzen'))
    expect(deployed).toEqual(['s'])
    expect(container.textContent).toContain('Meier Beat')
  })

  it('says when nobody is ready, and offers the board’s own «Bestimmen» door', () => {
    const defined = vi.fn()
    const { getByText, queryByText } = render(
      <NotfallBanner t={inNotfall} now={NOW} ready={[]} inside={[]} canEdit onDefineSafety={defined}
        onDeploySafety={() => {}} onGo={() => {}} />,
    )
    expect(getByText('Kein Sicherungstrupp bereit')).toBeTruthy()
    expect(queryByText('Sicherungstrupp einsetzen')).toBeNull()
    fireEvent.click(getByText('Sicherungstrupp bestimmen'))
    expect(defined).toHaveBeenCalled()
  })

  it('names a Sicherungstrupp already inside instead of offering a second one; a viewer gets no act', () => {
    const inside = { ...sitr, status: 'aktiv' as const, entryTime: ago(50), lastContactTime: ago(50) }
    const { container, queryByText } = render(
      <NotfallBanner t={inNotfall} now={NOW} ready={[]} inside={[inside]} canEdit={false}
        onDeploySafety={() => {}} onGo={() => {}} />,
    )
    expect(container.textContent).toMatch(/Sicherungstrupp Meier Beat drin seit \d\d:\d\d/)
    expect(queryByText('Sicherungstrupp einsetzen')).toBeNull()
    expect(queryByText('Sicherungstrupp bestimmen')).toBeNull()
  })
})

describe('the Notfall on the Meldeleiste', () => {
  it('stands at the TOP, above the überfällig row, with no ✕ and «Sicherungstrupp einsetzen» first', () => {
    const went: string[] = []
    const deployed: string[] = []
    const overdue = trupp({ id: 'b', name: 'Huber', lastContactTime: ago(900) })
    render(
      <>
        <AtemschutzNotfallMeldungen trupps={[overdue, inNotfall, sitr]} onGoToTrupp={(id) => went.push(id)}
          onDeploySafety={(id) => deployed.push(id)} />
        <Meldeleiste />
      </>,
    )
    const rows = [...document.querySelectorAll('.ml-row')]
    expect(rows[0].querySelector('.ml-title')?.textContent).toMatch(/^Notfall – Trupp 2 \(Keller Anna \/ Frei Nina\)/)
    expect(document.querySelectorAll('.ml-x')).toHaveLength(0)
    const acts = [...rows[0].querySelectorAll('.ml-act button')].map((b) => b.textContent)
    expect(acts).toEqual(['Sicherungstrupp einsetzen', 'Zum Trupp'])
    fireEvent.click([...rows[0].querySelectorAll('.ml-act button')][0])
    expect(deployed).toEqual(['s'])
    expect(went).toEqual(['a'])
  })

  it('steps aside on the Tafel, whose banner stands there instead', () => {
    render(<><AtemschutzNotfallMeldungen trupps={[inNotfall]} onBoard onGoToTrupp={() => {}} /><Meldeleiste /></>)
    expect(document.querySelectorAll('.ml-row')).toHaveLength(0)
  })

  it('is never ALSO an überfällig/Alarmdruck row — one emergency, one row', () => {
    const late = { ...inNotfall, lastContactTime: ago(900), lastPressureBar: 40 }
    expect(atemschutzAlarmRows([late], { a: 2 }, NOW, 5, 60, { alarmBar: 100, alarmBarRueckzug: 50 })).toEqual([])
  })
})
