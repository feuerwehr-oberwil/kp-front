// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WheelPopover } from './WheelPicker'
import { fmtWheelDay } from '../lib/zeitplanFormat'
import { DateTimeField } from './TimeField'
import { noteServerTime, resetServerClock } from '../lib/serverClock'

afterEach(cleanup)

// the popover only draws wheels on a COARSE pointer; a fine pointer gets a text field instead
beforeEach(() => {
  // jsdom has no scroll implementation; the wheel calls scrollTo when a row is tapped
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('coarse'), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }))
})

const anchor = { left: 100, top: 100, bottom: 140, right: 300, width: 200, height: 40, x: 100, y: 100, toJSON: () => ({}) } as DOMRect

function open(initial: Date, onCommit = vi.fn()) {
  render(<WheelPopover anchor={anchor} initial={initial} onCommit={onCommit} onClose={() => {}} />)
  return onCommit
}

const wheel = (label: string) => screen.getByRole('listbox', { name: label })

describe('WheelPicker · looping clock wheels', () => {
  it('repeats the hours so the column has no ends to run into', () => {
    open(new Date(2026, 7, 8, 22, 47))
    // 24 hours several times over — the copies are what make the wrap invisible
    const hours = wheel('Stunde').querySelectorAll('[role="option"]')
    expect(hours.length).toBeGreaterThan(24)
    expect(hours.length % 24).toBe(0)
    const minutes = wheel('Minute').querySelectorAll('[role="option"]')
    expect(minutes.length % 60).toBe(0)
  })

  it('marks exactly ONE row selected, however many copies hold that value', () => {
    open(new Date(2026, 7, 8, 22, 47))
    expect(wheel('Stunde').querySelectorAll('[aria-selected="true"]')).toHaveLength(1)
    expect(wheel('Stunde').querySelector('[aria-selected="true"]')?.textContent).toBe('22')
    expect(wheel('Minute').querySelector('[aria-selected="true"]')?.textContent).toBe('47')
  })

  it('commits the value under the band, whichever copy of it was tapped', () => {
    const onCommit = open(new Date(2026, 7, 8, 22, 47))
    // the LAST «00» on the strip — a copy far past where a non-looping wheel would have ended
    const zeros = [...wheel('Stunde').querySelectorAll('[role="option"]')].filter((b) => b.textContent === '00')
    expect(zeros.length).toBeGreaterThan(1)
    fireEvent.click(zeros[zeros.length - 1])
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ h: 0, mi: 47 }))
  })

  // UX pick B2·28 (25.11.2026): a tap on the time under the band types it – «23:39», OK
  it('a tap on the selected hour swaps the wheels for a typed field that commits', () => {
    const days = [new Date(2026, 10, 24)]
    const onCommit = vi.fn()
    render(<WheelPopover anchor={anchor} initial={new Date(2026, 10, 24, 23, 42)} days={days} dayAlways onCommit={onCommit} onClose={() => {}} />)
    fireEvent.click(wheel('Stunde').querySelector('[aria-selected="true"]')!)
    expect(screen.queryByRole('listbox', { name: 'Stunde' })).toBeNull()
    const field = screen.getByRole('textbox', { name: 'Stunde / Minute' })
    expect(field).toHaveProperty('value', '23:42')
    fireEvent.change(field, { target: { value: '23:39' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onCommit).toHaveBeenCalledWith({ y: 2026, mo: 11, d: 24, h: 23, mi: 39 })
  })
  // owner, UX journeys sign-off (26.11.2026): «2359 isn't a time, 23:53 is» – the colon is required,
  // and a value that is not HH:MM commits nothing and says so under the field
  describe('the typed time is HH:MM', () => {
    const typeAndOk = (value: string, key: 'click' | 'enter' = 'click') => {
      const onCommit = vi.fn()
      render(<WheelPopover anchor={anchor} initial={new Date(2026, 10, 25, 23, 42)} onCommit={onCommit} onClose={() => {}} />)
      fireEvent.click(wheel('Stunde').querySelector('[aria-selected="true"]')!)
      const field = screen.getByRole('textbox', { name: 'Stunde / Minute' })
      fireEvent.change(field, { target: { value } })
      if (key === 'enter') fireEvent.keyDown(field, { key: 'Enter' })
      else fireEvent.click(screen.getByRole('button', { name: 'OK' }))
      return { onCommit, field, message: screen.queryByRole('alert')?.textContent ?? null }
    }

    it('commits «23:53»', () => {
      const { onCommit, message } = typeAndOk('23:53')
      expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ h: 23, mi: 53 }))
      expect(message).toBeNull()
    })
    it.each(['2359', '24:00', '23:60', '23:', ''])('«%s» commits nothing and says HH:MM under the field', (value) => {
      const { onCommit, field, message } = typeAndOk(value)
      expect(onCommit).not.toHaveBeenCalled()
      expect(message).toBe('Zeit als HH:MM, z. B. 23:53')
      expect(field.getAttribute('aria-invalid')).toBe('true')
    })
    it('Enter with «2359» only shows the message', () => {
      const { onCommit, message } = typeAndOk('2359', 'enter')
      expect(onCommit).not.toHaveBeenCalled()
      expect(message).toBe('Zeit als HH:MM, z. B. 23:53')
    })
  })
  // owner, UX journeys sign-off (26.11.2026): «day – time» on one line, opened ABOVE the field so
  // it covers nothing under it (the Rückmeldung's «Entfällt» under the Einsatzende)
  it('types on one line, the day first, and opens above its field when it fits', () => {
    const low = { ...anchor, top: 420, bottom: 460 } as DOMRect
    const days = [new Date(2026, 10, 25)]
    render(<WheelPopover anchor={low} initial={new Date(2026, 10, 25, 23, 42)} days={days} dayAlways onCommit={() => {}} onClose={() => {}} />)
    const pop = screen.getByRole('dialog')
    const wheelTop = parseFloat(pop.style.top)
    fireEvent.click(wheel('Minute').querySelector('[aria-selected="true"]')!)
    const field = screen.getByRole('textbox', { name: 'Stunde / Minute' })
    const day = screen.getByRole('combobox', { name: 'Tag' })
    expect(field.parentElement).toBe(day.parentElement)
    expect(day.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the wheels stood below the field; the typed line stands above it
    expect(wheelTop).toBeGreaterThan(low.bottom)
    expect(parseFloat(pop.style.top)).toBeLessThan(low.top)
  })
  it('a tap on another row still only moves the wheel', () => {
    open(new Date(2026, 7, 8, 22, 47))
    const other = [...wheel('Minute').querySelectorAll('[role="option"]')].find((b) => b.textContent === '30')!
    fireEvent.click(other)
    expect(screen.getByRole('listbox', { name: 'Minute' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does NOT loop the incident-day wheel — running off that end means the day does not exist', () => {
    const days = [new Date(2026, 7, 8), new Date(2026, 7, 9)]
    render(
      <WheelPopover anchor={anchor} initial={new Date(2026, 7, 8, 22, 47)} days={days}
        onCommit={vi.fn()} onClose={() => {}} />,
    )
    expect(wheel('Tag').querySelectorAll('[role="option"]')).toHaveLength(2)
  })
})

// 05.10.2026
describe('DateTimeField · one date control', () => {
  it('labels days «Mo 05.10.» — no comma that wraps the phone column', () => {
    expect(fmtWheelDay(new Date(2026, 9, 5))).toBe('Mo 05.10.')
  })

  it('offers a bounded day column, not day/month/year wheels, and commits the picked day', () => {
    const onCommit = vi.fn()
    const days = [new Date(2026, 9, 3), new Date(2026, 9, 4), new Date(2026, 9, 5)]
    render(<DateTimeField ariaLabel="Ende" value={new Date(2026, 9, 5, 13, 6).toISOString()} days={days} onCommit={onCommit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ende' }))
    expect(screen.queryByRole('listbox', { name: 'Monat' })).toBeNull()
    const day = wheel('Tag')
    expect(day.className).toContain('wheel-day')
    expect([...day.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Sa 03.10.', 'So 04.10.', 'Mo 05.10.'])
    fireEvent.click(screen.getByRole('option', { name: 'Sa 03.10.' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(new Date(onCommit.mock.calls[0][0]).getTime()).toBe(new Date(2026, 9, 3, 13, 6).getTime())
  })

  it('keeps a stamp outside the offered days on its own day', () => {
    const days = [new Date(2026, 9, 4), new Date(2026, 9, 5)]
    render(<DateTimeField ariaLabel="Ende" value={new Date(2026, 8, 20, 8, 0).toISOString()} days={days} onCommit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ende' }))
    expect(wheel('Tag').querySelector('[aria-selected="true"]')?.textContent).toBe('So 20.09.')
  })

  // owner pick A «Ein Feld» (12.11.2026): the day quiet, the clock loud, the year only off the
  // Einsatz's year — `days` start on the alarm day, so that is the year the field reads against
  it('reads «05.10. 13:06», and the year only when it is not the Einsatz year', () => {
    const days = [new Date(2026, 9, 5)]
    render(<>
      <DateTimeField ariaLabel="A" value={new Date(2026, 9, 5, 13, 6).toISOString()} days={days} onCommit={vi.fn()} />
      <DateTimeField ariaLabel="B" value={new Date(2025, 11, 31, 23, 50).toISOString()} days={days} onCommit={vi.fn()} />
      <DateTimeField ariaLabel="C" days={days} onCommit={vi.fn()} />
    </>)
    expect(screen.getByRole('button', { name: 'A' }).textContent).toBe('05.10. 13:06')
    expect(screen.getByRole('button', { name: 'B' }).textContent).toBe('31.12.2025 23:50')
    expect(screen.getByRole('button', { name: 'C' }).textContent).toBe('--.--. --:--')
  })

  // owner pick A «Gestapelt» (13.11.2026, the QR-Erfassung's Personen rows): the word + day on a
  // small line above the clock; same year rule, same empty shape, the full name stays accessible
  it('stacked: «von 05.10.» over «13:06», the year rule, and an empty field in the same shape', () => {
    const days = [new Date(2026, 9, 5)]
    render(<>
      <DateTimeField ariaLabel="von, Amrein Patrick" stacked="von" value={new Date(2026, 9, 5, 13, 6).toISOString()} days={days} onCommit={vi.fn()} />
      <DateTimeField ariaLabel="bis, Baumann Michael" stacked="bis" value={new Date(2025, 11, 31, 23, 50).toISOString()} days={days} onCommit={vi.fn()} />
      <DateTimeField ariaLabel="von, Frei Nina" stacked="von" days={days} onCommit={vi.fn()} />
    </>)
    const lines = (name: string) => [...screen.getByRole('button', { name }).children].map((el) => el.textContent)
    expect(lines('von, Amrein Patrick')).toEqual(['von 05.10.', '13:06'])
    expect(lines('bis, Baumann Michael')).toEqual(['bis 31.12.2025', '23:50'])
    expect(lines('von, Frei Nina')).toEqual(['von --.--.', '--:--'])
  })

  it('always shows the day column, and an empty field opens where it is told to', () => {
    const days = [new Date(2026, 9, 5)]
    render(<DateTimeField ariaLabel="Ende" days={days} opensOn={new Date(2026, 9, 5, 23, 50).toISOString()} onCommit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ende' }))
    expect(wheel('Tag').querySelector('[aria-selected="true"]')?.textContent).toBe('Mo 05.10.')
    expect(wheel('Stunde').querySelector('[aria-selected="true"]')?.textContent).toBe('23')
  })

  // every «Jetzt» is the deployment's clock (docs/rapport.md › Times) — the picker's used to be
  // the device's, so the button beside the field and the one inside it stamped different times
  it('«Jetzt» in the picker takes the server clock, not the device clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 5, 13, 10)) // the device runs four minutes fast
    noteServerTime(new Date(2026, 9, 5, 13, 6).toISOString())
    try {
      const onCommit = vi.fn()
      render(<DateTimeField ariaLabel="Ende" days={[new Date(2026, 9, 5)]} onCommit={onCommit} />)
      fireEvent.click(screen.getByRole('button', { name: 'Ende' }))
      fireEvent.click(screen.getByRole('button', { name: 'Jetzt' }))
      expect(new Date(onCommit.mock.calls[0][0]).getTime()).toBe(new Date(2026, 9, 5, 13, 6).getTime())
    } finally {
      resetServerClock()
      vi.useRealTimers()
    }
  })
})
