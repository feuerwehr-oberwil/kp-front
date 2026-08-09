// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WheelPopover } from './WheelPicker'

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

  it('does NOT loop the incident-day wheel — running off that end means the day does not exist', () => {
    const days = [new Date(2026, 7, 8), new Date(2026, 7, 9)]
    render(
      <WheelPopover anchor={anchor} initial={new Date(2026, 7, 8, 22, 47)} days={days}
        onCommit={vi.fn()} onClose={() => {}} />,
    )
    expect(wheel('Tag').querySelectorAll('[role="option"]')).toHaveLength(2)
  })
})
