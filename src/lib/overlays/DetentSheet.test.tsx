// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// the on-screen keyboard, as the one hook every sheet asks (lib/useKeyboardInset)
const kb = { inset: 0 }
vi.mock('../useKeyboardInset', () => ({ useKeyboardInset: () => kb.inset }))
const { DetentSheet } = await import('./DetentSheet')

afterEach(() => { cleanup(); kb.inset = 0 })

const sheet = (detent: 'peek' | 'half' | 'full', onDetent = vi.fn()) => render(
  <DetentSheet detent={detent} onDetent={onDetent} ariaLabel="Suche" head={<span>Kopf</span>} peek={<span>Chips</span>}>
    <button type="button">Als vermisst melden</button>
  </DetentSheet>,
)

describe('DetentSheet', () => {
  it('stands on the KEYBOARD while it is up — the form and its button stay above it', () => {
    kb.inset = 300
    sheet('half')
    const el = screen.getByRole('region', { name: 'Suche' })
    expect(el.style.getPropertyValue('--detent-bottom')).toBe('300px')
    expect(el.className).toContain('is-kb')
  })

  it('without a keyboard its owner decides where it stands (above the nav bar)', () => {
    sheet('half')
    expect(screen.getByRole('region', { name: 'Suche' }).style.getPropertyValue('--detent-bottom')).toBe('')
  })

  it('at peek shows the head and the peek content, and hides the body', () => {
    sheet('peek')
    expect(screen.getByText('Chips')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Als vermisst melden' })).toBeNull()
  })

  it('a tap on the bar steps up; at full it comes back to half', () => {
    const on = vi.fn()
    const { container } = sheet('half', on)
    const grab = container.querySelector('.ui-sheet-grab')!
    fireEvent.pointerDown(grab, { clientY: 100 })
    fireEvent.pointerUp(grab, { clientY: 100 })
    expect(on).toHaveBeenLastCalledWith('full')
    cleanup()
    const on2 = vi.fn()
    const r2 = sheet('full', on2)
    const g2 = r2.container.querySelector('.ui-sheet-grab')!
    fireEvent.pointerDown(g2, { clientY: 100 })
    fireEvent.pointerUp(g2, { clientY: 100 })
    expect(on2).toHaveBeenLastCalledWith('half')
  })
})
