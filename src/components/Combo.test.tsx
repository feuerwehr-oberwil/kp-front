// @vitest-environment jsdom
// The «nur Offiziere» toggle is offered on every rank-aware picker (Einsatzleiter, Rückmeldung
// ELZ …), but a station without Dienstgrade — no personnel source, or a roster that carries
// none — has nothing for it to select. It used to render anyway, so the one thing it could do
// was empty the list. These cover both directions, plus the stale-filter trap.

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Combo } from './Combo'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

const NAMES = ['Anna Meier', 'Hans Müller', 'Laura Keller']
const OFFICERS_ONLY = appConfig.copy.combo.officersOnly
// a ranked option renders its Dienstgrad chip inside the same button ("Kpl Hans Müller"),
// so option lookups match on the name, not on the button's whole accessible name
const opt = (name: string) => new RegExp(name)

function openMenu(rankOf: (name: string) => string | undefined) {
  render(
    <Combo value="" options={NAMES} placeholder="Name wählen …" officerFilter rankOf={rankOf} onChange={vi.fn()} />,
  )
  fireEvent.click(screen.getByRole('button', { name: /Name wählen/ }))
}

describe('Combo — officer filter', () => {
  it('offers «nur Offiziere» when the options actually hold an officer', () => {
    openMenu((n) => (n === 'Hans Müller' ? 'hptm' : 'fwm'))
    expect(screen.getByRole('button', { name: OFFICERS_ONLY })).toBeTruthy()
  })

  it('hides it when no option resolves to an officer rank', () => {
    openMenu((n) => (n === 'Hans Müller' ? 'kpl' : 'fwm'))
    expect(screen.queryByRole('button', { name: OFFICERS_ONLY })).toBeNull()
    NAMES.forEach((n) => expect(screen.getByRole('button', { name: opt(n) })).toBeTruthy())
  })

  it('hides it when the roster carries no ranks at all', () => {
    openMenu(() => undefined)
    expect(screen.queryByRole('button', { name: OFFICERS_ONLY })).toBeNull()
  })

  it('filters down to the officers once toggled', () => {
    openMenu((n) => (n === 'Hans Müller' ? 'hptm' : 'fwm'))
    fireEvent.click(screen.getByRole('button', { name: OFFICERS_ONLY }))
    expect(screen.getByRole('button', { name: /Hans Müller/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: opt('Anna Meier') })).toBeNull()
  })

  it('a filter left on from a ranked roster does not survive into a rankless one', () => {
    // the toggle is gone with the ranks, so a surviving `officersOnly` would leave an empty
    // list and no control to undo it — the state has to be ignored, not just unrendered
    const { rerender } = render(
      <Combo value="" options={NAMES} placeholder="Name wählen …" officerFilter
        rankOf={(n) => (n === 'Hans Müller' ? 'hptm' : 'fwm')} onChange={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Name wählen/ }))
    fireEvent.click(screen.getByRole('button', { name: OFFICERS_ONLY }))
    expect(screen.queryByRole('button', { name: opt('Anna Meier') })).toBeNull()

    rerender(
      <Combo value="" options={NAMES} placeholder="Name wählen …" officerFilter
        rankOf={() => undefined} onChange={vi.fn()} />,
    )
    NAMES.forEach((n) => expect(screen.getByRole('button', { name: opt(n) })).toBeTruthy())
  })
})

// A name typed into a roster field is recorded as a Gast on the Anwesenheit the moment it is
// committed. Every keystroke used to be a commit, so «Muster Felix» would have put thirteen
// people on the list — one per prefix. `onInput` is what separates typing from finishing.
describe('Combo — the free-type escape', () => {
  function typeGuest(onCommit: (v: string) => void) {
    function Harness() {
      const [v, setV] = useState('')
      return (
        <Combo value={v} options={NAMES} placeholder="Name wählen …" allowCustom
          onInput={setV} onChange={(x) => { setV(x); onCommit(x) }} />
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /Name wählen/ }))
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.combo.customDefault }))
    return screen.getByPlaceholderText('Name wählen …')
  }

  it('streams keystrokes without committing any of them', () => {
    const onCommit = vi.fn()
    const input = typeGuest(onCommit)
    fireEvent.change(input, { target: { value: 'Mu' } })
    fireEvent.change(input, { target: { value: 'Muster Felix' } })
    expect(onCommit).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('Muster Felix')
  })

  it('commits the whole name once, when the field is left', () => {
    const onCommit = vi.fn()
    const input = typeGuest(onCommit)
    fireEvent.change(input, { target: { value: 'Muster Felix' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('Muster Felix')
  })
})
