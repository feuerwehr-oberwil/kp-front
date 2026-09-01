// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SelectionBar } from './SelectionBar'
import { appConfig } from '../config/appConfig'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'

beforeAll(() => {
  const el = Element.prototype as unknown as Record<string, unknown>
  el.setPointerCapture ??= () => {}
  el.releasePointerCapture ??= () => {}
})
afterEach(cleanup)

const C = appConfig.copy.drawingEditor
const grip = () => screen.getByRole('button', { name: C.move })
const dial = () => screen.queryByRole('button', { name: appConfig.copy.shapes.rotate })

const drag = (el: Element, from: [number, number], to: [number, number]) => {
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: to[0], clientY: to[1], pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: to[0], clientY: to[1], pointerId: 1 })
}

describe('SelectionBar · the one bar every selection is transformed from', () => {
  it('streams the ✥ drag as a client-px delta, in one start/move/end gesture', () => {
    const onMove = vi.fn()
    render(<SelectionBar onMove={onMove} onRotate={() => {}} onDelete={() => {}} />)
    drag(grip(), [100, 100], [160, 130])
    expect(onMove.mock.calls).toEqual([[0, 0, 'start'], [60, 30, 'move'], [60, 30, 'end']])
  })

  it('writes nothing for a tap, or for a press that never leaves the deadzone', () => {
    const onMove = vi.fn()
    render(<SelectionBar onMove={onMove} onDelete={() => {}} />)
    drag(grip(), [100, 100], [100 + DRAG_DEADZONE_PX - 1, 100])
    expect(onMove).not.toHaveBeenCalled()
  })

  it('turns sideways travel into degrees and shows the running angle', () => {
    const onRotate = vi.fn()
    render(<SelectionBar onMove={() => {}} onRotate={onRotate} onDelete={() => {}} />)
    // 2px per degree (SelectionBar · PX_PER_DEG): 120px right = +60°
    fireEvent.pointerDown(dial()!, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(dial()!, { clientX: 320, clientY: 200, pointerId: 1 })
    expect(onRotate.mock.calls).toEqual([[0, 'start'], [60, 'move']])
    expect(dial()!.textContent).toContain('+60°')
    // …and back the other way, with no raster snapping the value on the way
    fireEvent.pointerMove(dial()!, { clientX: 155, clientY: 200, pointerId: 1 })
    expect(onRotate).toHaveBeenLastCalledWith(-22.5, 'move')
    expect(dial()!.textContent).toContain('−22°')
    fireEvent.pointerUp(dial()!, { clientX: 155, clientY: 200, pointerId: 1 })
    expect(onRotate).toHaveBeenLastCalledWith(-22.5, 'end')
    expect(dial()!.textContent).not.toContain('°') // the read-out belongs to the gesture only
  })

  it('leaves the ⟳ out entirely for a selection with no angle — never a dead button', () => {
    render(<SelectionBar onMove={() => {}} onDelete={() => {}} />)
    expect(dial()).toBeNull()
    expect(grip()).toBeTruthy()
  })

  it('says «Löschen» in words and fires it on a plain tap', () => {
    const onDelete = vi.fn()
    render(<SelectionBar onMove={() => {}} onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.delete }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('opts its two drag grips out of the hold-tooltip, which would eat their release', () => {
    render(<SelectionBar onMove={() => {}} onRotate={() => {}} onDelete={() => {}} />)
    expect(grip().hasAttribute('data-holdaction')).toBe(true)
    expect(dial()!.hasAttribute('data-holdaction')).toBe(true)
  })
})
