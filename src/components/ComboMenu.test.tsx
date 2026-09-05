// @vitest-environment jsdom
// The one thing that can make this control silently useless: a menu anchored with `bottom`
// while the base class still says `top: calc(100% + 4px)`. Under position:fixed that top is
// viewport-bottom + 4, so the two together squeeze the menu into a 0-height sliver off screen —
// "the dropdown does nothing" on a phone bottom sheet. The guard is one inline `top: 'auto'`,
// it now lives in ComboMenu for every picker at once, and nothing else asserts it.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Combo } from './Combo'

afterEach(cleanup)

const picker = <Combo value="" options={['Anna Meier', 'Hans Müller']} placeholder="Name wählen …" onChange={vi.fn()} />

/** Open the picker with its trigger pinned at `top` in a 768px-tall viewport. */
function openAt(top: number) {
  render(picker)
  const trigger = screen.getByRole('button', { name: /Name wählen/ })
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(24, top, 200, 40))
  fireEvent.click(trigger)
  return screen.getByRole('listbox')
}

/** The same picker inside a clipping ancestor (a bottom Sheet's `.ip-body`), both boxes pinned. */
function openInSheet(sheet: DOMRect, trigger: DOMRect) {
  const { container } = render(<div style={{ overflowY: 'auto' }}>{picker}</div>)
  vi.spyOn(container.firstElementChild as HTMLElement, 'getBoundingClientRect').mockReturnValue(sheet)
  const btn = screen.getByRole('button', { name: /Name wählen/ })
  vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(trigger)
  fireEvent.click(btn)
  return screen.getByRole('listbox')
}

describe('ComboMenu · where the portalled menu lands', () => {
  it('hangs a low trigger\'s menu off the BOTTOM edge, with top neutralised', () => {
    // 768 − 740 − 12 = 16px below, 688px above → it opens upwards
    const menu = openAt(700)
    expect(menu.style.top).toBe('auto')
    expect(menu.style.bottom).toBe('72px') // 768 − 700 + 4
  })

  it('drops a high trigger\'s menu below it and leaves bottom alone', () => {
    const menu = openAt(100)
    expect(menu.style.top).toBe('144px') // 140 + 4
    expect(menu.style.bottom).toBe('')
  })

  it('opens UPWARD past a short sheet\'s top edge, into the free viewport above it', () => {
    // A 260px bottom sheet with the picker as its first field — «Material erfassen», the EL
    // sheet's Einsatzleiter. Below the trigger the SHEET has 176px; above it the sheet has ~20,
    // the viewport 528. Nothing clips a menu portalled to <body>, so it takes the 528.
    const menu = openInSheet(new DOMRect(0, 508, 375, 260), new DOMRect(24, 540, 200, 40))
    expect(menu.style.top).toBe('auto')
    expect(menu.style.bottom).toBe('232px') // 768 − 540 + 4 → its bottom edge clears the trigger
    expect(menu.style.maxHeight).toBe('440px')
  })

  it('still refuses to spill past a short sheet\'s BOTTOM edge when it opens downward', () => {
    // a 400px panel ending far above the fold: 400 − 140 − 12 = 248px below is room enough, so
    // the menu drops — and is sized off the PANEL (248), not off the 616px the window has left
    const menu = openInSheet(new DOMRect(0, 0, 375, 400), new DOMRect(24, 100, 200, 40))
    expect(menu.style.top).toBe('144px')
    expect(menu.style.maxHeight).toBe('248px')
  })

  it('matches the trigger\'s width and takes the room that is actually there', () => {
    const menu = openAt(100)
    expect(menu.style.width).toBe('200px')
    expect(menu.style.left).toBe('24px')
    // 768 − 140 − 12 = 616, capped at the 440 ceiling
    expect(menu.style.maxHeight).toBe('440px')
  })
})
