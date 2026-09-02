// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SelectionBar } from './SelectionBar'
import { appConfig } from '../config/appConfig'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import { transformingChrome } from '../lib/transformChrome'

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
    render(<SelectionBar onMove={onMove} onRotate={() => {}} onDone={() => {}} />)
    drag(grip(), [100, 100], [160, 130])
    expect(onMove.mock.calls).toEqual([[0, 0, 'start'], [60, 30, 'move'], [60, 30, 'end']])
  })

  it('writes nothing for a tap, or for a press that never leaves the deadzone', () => {
    const onMove = vi.fn()
    render(<SelectionBar onMove={onMove} onDone={() => {}} />)
    drag(grip(), [100, 100], [100 + DRAG_DEADZONE_PX - 1, 100])
    expect(onMove).not.toHaveBeenCalled()
  })

  it('turns sideways travel into degrees, and prints none of them on the button', () => {
    const onRotate = vi.fn()
    render(<SelectionBar onMove={() => {}} onRotate={onRotate} onDone={() => {}} />)
    // 2px per degree (SelectionBar · PX_PER_DEG): 120px right = +60°
    fireEvent.pointerDown(dial()!, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(dial()!, { clientX: 320, clientY: 200, pointerId: 1 })
    expect(onRotate.mock.calls).toEqual([[0, 'start'], [60, 'move']])
    // …and back the other way, with no raster snapping the value on the way
    fireEvent.pointerMove(dial()!, { clientX: 155, clientY: 200, pointerId: 1 })
    expect(onRotate).toHaveBeenLastCalledWith(-22.5, 'move')
    fireEvent.pointerUp(dial()!, { clientX: 155, clientY: 200, pointerId: 1 })
    expect(onRotate).toHaveBeenLastCalledWith(-22.5, 'end')
    // ⚠️ the degrees are read on the SURFACE now (components/SelectionTurn): the button is its
    // icon and its armed state, never a number that appears mid-gesture and re-flows the bar
    expect(dial()!.textContent).not.toContain('°')
  })

  it('hides the selection’s geometry grips for the length of a grip drag', () => {
    render(<SelectionBar onMove={() => {}} onRotate={() => {}} onDone={() => {}} />)
    expect(transformingChrome()).toBe(false)
    fireEvent.pointerDown(grip(), { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(grip(), { clientX: 160, clientY: 100, pointerId: 1 })
    expect(transformingChrome()).toBe(true)
    fireEvent.pointerUp(grip(), { clientX: 160, clientY: 100, pointerId: 1 })
    expect(transformingChrome()).toBe(false)
  })

  it('leaves the ⟳ out entirely for a selection with no angle — never a dead button', () => {
    render(<SelectionBar onMove={() => {}} onDone={() => {}} />)
    expect(dial()).toBeNull()
    expect(grip()).toBeTruthy()
  })

  // ⚠️ «Löschen» left the bar on 02.09. — deleting belongs in the object's own editor sheet and
  // on the Delete key, not on chrome sitting two taps from every grip.
  it('offers «Fertig» rather than «Löschen», and ends the editing state on a tap', () => {
    const onDone = vi.fn()
    render(<SelectionBar onMove={() => {}} onDone={onDone} />)
    expect(screen.queryByRole('button', { name: appConfig.copy.delete })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.done }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('arms the surface on a TAP, and leaves a drag to be the small adjustment', () => {
    const onArm = vi.fn()
    const onMove = vi.fn()
    render(<SelectionBar onMove={onMove} onRotate={() => {}} onDone={() => {}} onArm={onArm} />)
    fireEvent.pointerDown(grip(), { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(grip(), { clientX: 100, clientY: 100, pointerId: 1 })
    expect(onArm.mock.calls).toEqual([['move']])
    expect(onMove).not.toHaveBeenCalled()
    // …and the drag that has always worked writes, without arming anything
    onArm.mockClear()
    drag(grip(), [100, 100], [160, 130])
    expect(onArm).not.toHaveBeenCalled()
    expect(onMove).toHaveBeenLastCalledWith(60, 30, 'end')
  })

  it('paints the armed grip and says what it now does', () => {
    render(<SelectionBar onMove={() => {}} onRotate={() => {}} onDone={() => {}} onArm={() => {}} armed="move" />)
    const armed = screen.getByRole('button', { name: C.moveArmed })
    expect(armed.className).toContain('on')
    expect(armed.getAttribute('aria-pressed')).toBe('true')
    // only ever one of the two, and the other one says so too
    expect(dial()!.getAttribute('aria-pressed')).toBe('false')
  })

  it('is exempt from the armed mode, so its own grips keep working while one is on', () => {
    render(<SelectionBar onMove={() => {}} onDone={() => {}} armed="move" onArm={() => {}} />)
    expect(screen.getByRole('toolbar', { name: C.selectionBar }).hasAttribute('data-arm-exempt')).toBe(true)
  })

  it('opts its two drag grips out of the hold-tooltip, which would eat their release', () => {
    render(<SelectionBar onMove={() => {}} onRotate={() => {}} onDone={() => {}} />)
    expect(grip().hasAttribute('data-holdaction')).toBe(true)
    expect(dial()!.hasAttribute('data-holdaction')).toBe(true)
  })
})
