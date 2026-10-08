// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useNodeHold, NODE_HOLD_ARM_MS, NODE_HOLD_FIRE_MS, NODE_HOLD_MOVE_PX } from './nodeHold'
import { installHoldTooltip } from './holdTooltip'

// The hold is the ONE gesture that removes geometry, so its three promises are worth pinning:
// nothing shows before it arms, a drag never arms it, and letting go early does nothing.
function Harness({ onFire, enabled = true }: { onFire: () => void; enabled?: boolean }) {
  const hold = useNodeHold()
  return (
    <div
      data-testid="node"
      data-armed={hold.armed ? String(Math.round(hold.armed.progress * 100)) : 'none'}
      {...hold.press('n0', onFire, enabled)}
    />
  )
}

const down = (el: HTMLElement) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
const moveTo = (x: number) => window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: 100 }))
const up = () => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))

describe('useNodeHold', () => {
  beforeEach(() => vi.useFakeTimers())
  // ⚠️ explicit: this suite renders the same harness five times, and without a teardown the
  // previous DOM stays mounted (no globals/auto-cleanup in this project's vitest setup)
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('shows nothing until it arms — a node being MOVED must never flash a red mark', () => {
    const fire = vi.fn()
    const { getByTestId } = render(<Harness onFire={fire} />)
    const node = getByTestId('node')
    act(() => { down(node) })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_ARM_MS - 50) })
    expect(node.dataset.armed).toBe('none')
    act(() => { vi.advanceTimersByTime(100) })
    expect(node.dataset.armed).not.toBe('none')
    expect(fire).not.toHaveBeenCalled()
  })

  it('fires once the ring is full, and not a moment earlier', () => {
    const fire = vi.fn()
    const { getByTestId } = render(<Harness onFire={fire} />)
    act(() => { down(getByTestId('node')) })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS - 100) })
    expect(fire).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(150) })
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('a drag cancels it silently — past the tolerance it is a reshape, not a delete', () => {
    const fire = vi.fn()
    const { getByTestId } = render(<Harness onFire={fire} />)
    const node = getByTestId('node')
    act(() => { down(node) })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_ARM_MS + 100) })
    expect(node.dataset.armed).not.toBe('none')
    act(() => { moveTo(100 + NODE_HOLD_MOVE_PX + 5) })
    expect(node.dataset.armed).toBe('none')
    act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS) })
    expect(fire).not.toHaveBeenCalled()
  })

  it('letting go early does nothing at all', () => {
    const fire = vi.fn()
    const { getByTestId } = render(<Harness onFire={fire} />)
    act(() => { down(getByTestId('node')) })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS - 200) })
    act(() => { up() })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(fire).not.toHaveBeenCalled()
    expect(getByTestId('node').dataset.armed).toBe('none')
  })

  // a line already at its minimum keeps a draggable node that simply never offers the delete
  it('never arms when the shape is at its floor', () => {
    const fire = vi.fn()
    const { getByTestId } = render(<Harness onFire={fire} enabled={false} />)
    act(() => { down(getByTestId('node')) })
    act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS + 500) })
    expect(getByTestId('node').dataset.armed).toBe('none')
    expect(fire).not.toHaveBeenCalled()
  })

  // The Plan's Messen node was a <button> labelled «Gedrückt halten zum Löschen» without
  // `data-holdaction`, so on touch the app-wide hold-tooltip popped that label at 350 ms —
  // INSIDE the 825 ms ring — with a buzz, and swallowed the release (08.10.). The hook's props
  // now carry the opt-out, so a handle that spreads them cannot forget it.
  it('its props opt the handle out of the hold-tooltip — no label bubble mid-delete', () => {
    const uninstall = installHoldTooltip()
    try {
      const fire = vi.fn()
      function Handle() {
        const hold = useNodeHold()
        return <button data-testid="handle" aria-label="Gedrückt halten zum Löschen" {...hold.press('m0', fire)}><svg /></button>
      }
      const { getByTestId } = render(<Handle />)
      const handle = getByTestId('handle')
      expect(handle.hasAttribute('data-holdaction')).toBe(true)
      act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, pointerType: 'touch' })) })
      act(() => { vi.advanceTimersByTime(NODE_HOLD_ARM_MS + 200) }) // past the tooltip's 350 ms beat
      expect(document.querySelector('.hold-tip')).toBeNull()
      act(() => { vi.advanceTimersByTime(NODE_HOLD_FIRE_MS) })
      expect(fire).toHaveBeenCalledTimes(1)
      expect(document.querySelector('.hold-tip')).toBeNull()
    } finally { uninstall() }
  })
})
