// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BandGrid } from './BandGrid'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { Person, Shift, ShiftBand } from '../types'

afterEach(cleanup)

// TimeField picks its input mode from the pointer type; jsdom has no matchMedia, so pin it to the
// desktop (typing) variant — the wheel popover is TimeField's own concern.
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

// local wall clock, so «07–12» in an assertion is the same 07–12 the grid prints
const T = (h: number, m = 0) => {
  const d = new Date(2026, 6, 26, h, m, 0, 0)
  return d.toISOString()
}
const person = (id: string, displayName: string, rank?: string): Person =>
  ({ id, displayName, active: true, updatedAt: T(0), ...(rank ? { rank } : {}) })
const früh: ShiftBand = { id: 'bd1', label: 'Früh', from: T(7), to: T(12) }
const spät: ShiftBand = { id: 'bd2', label: 'Spät', from: T(12), to: T(17) }

const PEOPLE = [person('p1', 'Steiner T.'), person('p2', 'Meier A.'), person('p3', 'Bucher N.')]

const mount = (over: Partial<Parameters<typeof BandGrid>[0]> = {}) => {
  const props = {
    people: PEOPLE, shifts: [] as Shift[], bands: [früh, spät], canEdit: true, startedAt: T(7),
    attendance: {}, onAddShift: vi.fn(), onSetShiftTime: vi.fn(), onReplaceShift: vi.fn(),
    onRemoveShift: vi.fn(),
    onCreateBand: vi.fn(), onSaveBand: vi.fn(), onRemoveBand: vi.fn(), onCycleCell: vi.fn(),
    onSetCellState: vi.fn(),
    ...over,
  }
  render(<BandGrid {...props} />)
  return props
}

/** one person's row — the name cell is a button now, so the nearest div IS the row */
const rowOf = (name: string) => screen.getByText(name).closest('div')!
/** the band cells of that row, left to right; [0] is the name cell, which opens the person sheet */
const cellsOf = (name: string) => within(rowOf(name)).getAllByRole('button').slice(1)

describe('the empty state', () => {
  it('carries the big button — the only state where creating a band is the sole sensible action', () => {
    const S = appConfig.copy.schichten
    mount({ bands: [] })
    expect(screen.getByText(S.emptyTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: S.addBandFirst }))
    expect(screen.getByText(S.sheetAddTitle)).toBeTruthy()
  })

  it('offers no way in at all without edit rights', () => {
    mount({ bands: [], canEdit: false })
    expect(screen.queryByRole('button', { name: appConfig.copy.schichten.addBandFirst })).toBeNull()
  })
})

describe('the grid', () => {
  it('lists the WHOLE crew, in the order it was handed, with an empty cell per band', () => {
    mount()
    expect(screen.getByText('Bucher N.')).toBeTruthy() // nothing offered, still a row
    expect(cellsOf('Bucher N.')).toHaveLength(2)
    expect(cellsOf('Bucher N.')[0].textContent).toBe('')
  })

  it('draws the two on-band states with the Zeitplan\'s own words', () => {
    const S = appConfig.copy.schichten
    mount({ shifts: [
      { id: 'sh1', personId: 'p1', from: T(7), to: T(12), bandId: 'bd1' },
      { id: 'sh2', personId: 'p1', from: T(12), to: T(17), bandId: 'bd2', confirmed: true },
    ] })
    expect(cellsOf('Steiner T.')[0].textContent).toBe(S.available)
    expect(cellsOf('Steiner T.')[1].textContent).toBe(S.confirmed)
  })

  it('names a drifted shift AGAINST its column, not in absolute hours', () => {
    // Früh ends at 12:00 and so does this stretch, so the only news is where it starts
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(9), to: T(14), bandId: 'bd1', confirmed: true }] })
    expect(cellsOf('Meier A.')[0].textContent).toBe('ab 09:00')
  })

  it('takes a full range, on two lines, when BOTH ends differ from the column', () => {
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(8), to: T(10), bandId: 'bd1' }] })
    expect(cellsOf('Meier A.')[0].textContent).toBe('08:00–10:00')
  })

  it('shows somebody as available when their own offer covers a band, without a second tap', () => {
    // they drew 06–13 on the axis, so they ARE free for 07–12 — the grid does not ask again
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(6), to: T(13) }] })
    expect(cellsOf('Meier A.')[0].textContent).toBe(appConfig.copy.schichten.available)
    // …and it is only an AVAILABILITY: assignment is never derived
    expect(cellsOf('Meier A.')[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the real hours where an offer covers only part of a band', () => {
    // «frei» there would promise hours nobody offered
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(10), to: T(20) }] })
    // Früh 07–12 is covered only from 10:00, and runs to its end — so «ab 10:00» is the whole news
    expect(cellsOf('Meier A.')[0].textContent).toBe('ab 10:00')
    // …while Spät 12–17 lies wholly inside 10–20, which is plainly «frei»
    expect(cellsOf('Meier A.')[1].textContent).toBe(appConfig.copy.schichten.available)
  })

  it('leaves the cells empty for somebody whose times never reach the band', () => {
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(20), to: T(23) }] })
    expect(cellsOf('Meier A.')[0].textContent).toBe('')
  })

  it('marks own times that reach NO column, so that row cannot read as «has offered nothing»', () => {
    // 18–20 misses Früh 07–12 and Spät 12–17 entirely, so every cell is empty and only the mark
    // can say this person has told us something
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(18), to: T(20) }] })
    const row = rowOf('Meier A.')
    expect(within(row).getByText('18:00–20:00')).toBeTruthy()
  })

  it('names the further times rather than listing them all in a 112px column', () => {
    mount({ shifts: [
      { id: 'sh1', personId: 'p2', from: T(18), to: T(20) },
      { id: 'sh2', personId: 'p2', from: T(21), to: T(23) },
    ] })
    const row = rowOf('Meier A.')
    expect(within(row).getByText('18:00–20:00 +1')).toBeTruthy()
  })

  it('drops the mark once a column already carries those hours', () => {
    // the badge plus two cells printed the same 09–14 three times across one row
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(9), to: T(14) }] })
    const row = rowOf('Meier A.')
    expect(within(row).queryByText('09:00–14:00')).toBeNull()
    expect(cellsOf('Meier A.')[0].textContent).toBe('ab 09:00')
  })

  it('hands a cell tap straight to the cycle, band and person named', () => {
    const props = mount()
    fireEvent.click(cellsOf('Meier A.')[1])
    expect(props.onCycleCell).toHaveBeenCalledWith(spät, PEOPLE[1])
  })

  it('says «teilweise» where a window holds both states, and asks instead of cycling', () => {
    const S = appConfig.copy.schichten
    const props = mount({ shifts: [
      { id: 'sh1', personId: 'p2', from: T(9), to: T(11) },
      { id: 'sh2', personId: 'p2', from: T(10), to: T(20), confirmed: true },
    ] })
    // Früh 07–12: nothing until 09, offered until 10, assigned from 10 — no single word is true
    expect(cellsOf('Meier A.')[0].textContent).toContain(S.partial)
    fireEvent.click(cellsOf('Meier A.')[0])
    // …and a tap asks rather than flipping one of the two back and forth
    expect(props.onCycleCell).not.toHaveBeenCalled()
    expect(screen.getByText(S.resolveTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: S.resolveConfirmed }))
    expect(props.onSetCellState).toHaveBeenCalledWith(früh, PEOPLE[1], 'confirmed')
  })

  it('names the hours the question is about, not just its shape', () => {
    mount({ shifts: [
      { id: 'sh1', personId: 'p2', from: T(9), to: T(11) },
      { id: 'sh2', personId: 'p2', from: T(10), to: T(20), confirmed: true },
    ] })
    fireEvent.click(cellsOf('Meier A.')[0])
    const sheet = screen.getByText(appConfig.copy.schichten.resolveTitle).closest('div')!.parentElement!
    expect(within(sheet).getByText('09:00–10:00')).toBeTruthy() // verfügbar
    expect(within(sheet).getByText('10:00–12:00')).toBeTruthy() // geplant
  })

  it('leaves the cell exactly as it was when the question is cancelled', () => {
    const S = appConfig.copy.schichten
    const props = mount({ shifts: [
      { id: 'sh1', personId: 'p2', from: T(9), to: T(11) },
      { id: 'sh2', personId: 'p2', from: T(10), to: T(20), confirmed: true },
    ] })
    fireEvent.click(cellsOf('Meier A.')[0])
    fireEvent.click(screen.getByRole('button', { name: S.resolveCancel }))
    expect(props.onSetCellState).not.toHaveBeenCalled()
    expect(props.onCycleCell).not.toHaveBeenCalled()
  })

  it('marks a head number whose people do not all cover the whole watch', () => {
    mount({ shifts: [
      { id: 'sh1', personId: 'p1', from: T(7), to: T(12), bandId: 'bd1', confirmed: true },
      { id: 'sh2', personId: 'p2', from: T(10), to: T(12), bandId: 'bd1', confirmed: true },
    ] })
    const head = screen.getByText('Früh').closest('button')!
    expect(within(head).getByText('2').textContent).toBe('2·')
  })

  it('opens that person\'s own times from their name — no tab change to add «kann erst ab 14:00»', () => {
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(9), to: T(14) }] })
    fireEvent.click(within(rowOf('Meier A.')).getAllByRole('button')[0])
    expect(screen.getByText(fillTemplate(appConfig.copy.zeitplan.editTitle, { name: 'Meier A.' }))).toBeTruthy()
    // the same sheet the Zeitplan opens: the plan above, what actually happened below
    expect(screen.getByText(appConfig.copy.zeitplan.actualSection)).toBeTruthy()
  })

  it('names hours no column is showing, drifted-out members included', () => {
    // a member of Früh dragged to 20:30–21 belongs to no visible column any more
    mount({ shifts: [{ id: 'sh1', personId: 'p2', from: T(20, 30), to: T(21), bandId: 'bd1', confirmed: true }] })
    expect(cellsOf('Meier A.')[0].textContent).toBe('')
    expect(within(rowOf('Meier A.')).getByText('20:30–21:00')).toBeTruthy()
  })

  it('freezes every control without edit rights, and the grid still reads', () => {
    mount({ canEdit: false, shifts: [{ id: 'sh1', personId: 'p1', from: T(7), to: T(12), bandId: 'bd1' }] })
    expect(cellsOf('Steiner T.')[0].hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: appConfig.copy.schichten.addBand })).toBeNull()
  })
})

describe('the column heads', () => {
  it('counts WHOLE people, verfügbar and eingeteilt apart — countable against the cells below', () => {
    mount({ shifts: [
      { id: 'sh1', personId: 'p1', from: T(7), to: T(12), bandId: 'bd1', confirmed: true },
      { id: 'sh2', personId: 'p2', from: T(9), to: T(14), bandId: 'bd1', confirmed: true },
      { id: 'sh3', personId: 'p3', from: T(7), to: T(12), bandId: 'bd1' },
    ] })
    const head = screen.getByText('Früh').closest('button')!
    expect(within(head).getByText('1')).toBeTruthy() // verfügbar
    // two assigned, one of them only partly covering — still two PEOPLE, and «1,6» never was one
    expect(within(head).getByText('2')).toBeTruthy()
  })

  it('opens the band on its head, and creating one goes through the ＋', () => {
    const S = appConfig.copy.schichten
    mount()
    fireEvent.click(screen.getByText('Früh').closest('button')!)
    expect(screen.getByText(S.sheetEditTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.closeDialog }))
    fireEvent.click(screen.getByRole('button', { name: S.addBand }))
    expect(screen.getByText(S.sheetAddTitle)).toBeTruthy()
  })

  it('falls back to the hours when a band was never named — creating one is never blocked', () => {
    mount({ bands: [{ id: 'bd3', label: '', from: T(22), to: T(6) }] })
    expect(screen.getByText('22:00–06:00')).toBeTruthy()
  })

  it('says the grid scrolls only once it actually does — from the fourth column', () => {
    const S = appConfig.copy.schichten
    mount()
    expect(screen.queryByText(S.scrollHint)).toBeNull()
    cleanup()
    mount({ bands: [früh, spät, { ...früh, id: 'bd3' }, { ...spät, id: 'bd4' }] })
    expect(screen.getByText(S.scrollHint)).toBeTruthy()
  })
})

describe('the band sheet', () => {
  it('drafts the next band where the last one ended, running just as long', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.schichten.addBand }))
    // TimeField is one trigger on every device now (the desktop text branch is gone), so the
    // value is what the button READS
    const from = screen.getByLabelText(`${appConfig.copy.zeitplan.from} – ${appConfig.copy.schichten.sheetAddTitle}`)
    expect(from.textContent).toBe('17:00')
  })

  it('creates the band with whatever was typed, trimmed', () => {
    const props = mount()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.schichten.addBand }))
    fireEvent.change(screen.getByPlaceholderText(appConfig.copy.schichten.labelPlaceholder), { target: { value: '  Nacht ' } })
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.schichten.create }))
    expect(props.onCreateBand).toHaveBeenCalledWith('Nacht', T(17), T(22))
  })

  it('offers deleting only on an existing band, and says what survives it', () => {
    const S = appConfig.copy.schichten
    const props = mount()
    fireEvent.click(screen.getByText('Früh').closest('button')!)
    expect(screen.getByText(S.removeBandHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: S.removeBand }))
    expect(props.onRemoveBand).toHaveBeenCalledWith('bd1')
  })
})
