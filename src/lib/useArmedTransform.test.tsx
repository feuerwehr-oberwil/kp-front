// @vitest-environment jsdom
/**
 * ✥ / ⟳ armed as a surface MODE — the half of the selection bar that exists because the bar is
 * pinned bottom-centre and a downward pull off it runs the finger off the screen (02.09.).
 *
 * The hook IS the gesture on both surfaces: the Karte hands it the map container, the Kroki its
 * `.wb-canvas`, and everything below — what a delta means, where the write lands — is the bar's
 * own writers, unchanged. So what has to hold here is the mode's grammar: it wins the press over
 * whatever the surface would have done with it, it disarms for every reason it should, and a tap
 * that never travels changes nothing at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useArmedTransform, type ArmMode } from './useArmedTransform'
import { DRAG_DEADZONE_PX } from './useHoldToDrag'
import { transformingChrome } from './transformChrome'

afterEach(cleanup)

const CENTRE = { x: 200, y: 200 }

interface HarnessProps {
  enabled?: boolean
  resetKey?: string
  onMove?: (dx: number, dy: number, phase: 'start' | 'move' | 'end') => void
  onRotate?: (deg: number, phase: 'start' | 'move' | 'end') => void
  onGrab?: (grabbing: boolean) => void
  /** what the surface itself would have done with the press — a pan, a marquee, a placement */
  onSurface?: (what: string) => void
}

function Harness({ enabled = true, resetKey = 'sel-1', onMove = () => {}, onRotate, onGrab, onSurface = () => {} }: HarnessProps) {
  const surface = useRef<HTMLDivElement>(null)
  const arm = useArmedTransform({
    enabled, resetKey, onMove, onRotate, onGrab,
    surface: () => surface.current,
    centreClient: () => CENTRE,
  })
  return (
    <>
      <div data-testid="surface" ref={surface}
        onPointerDown={() => onSurface('down')} onClick={() => onSurface('click')} />
      {/* the bar, which the mode never takes a press away from */}
      <div data-arm-exempt>
        <button onClick={() => arm.toggle('move')}>✥</button>
        <button onClick={() => arm.toggle('rotate')}>⟳</button>
        <output data-testid="state">{`${arm.armed ?? 'off'}:${arm.turn ? Math.round(arm.turn.deg) : '—'}`}</output>
        <output data-testid="turn">{arm.turn ? `${arm.turn.cx},${arm.turn.cy}→${arm.turn.px},${arm.turn.py}` : ''}</output>
      </div>
    </>
  )
}

const surface = () => screen.getByTestId('surface')
const state = () => screen.getByTestId('state').textContent
const armWith = (glyph: '✥' | '⟳') => fireEvent.click(screen.getByRole('button', { name: glyph }))
const dragSurface = (from: [number, number], to: [number, number], pointerId = 7) => {
  fireEvent.pointerDown(surface(), { pointerId, isPrimary: true, clientX: from[0], clientY: from[1] })
  fireEvent.pointerMove(window, { pointerId, clientX: to[0], clientY: to[1] })
  fireEvent.pointerUp(window, { pointerId, clientX: to[0], clientY: to[1] })
}

describe('the armed mode’s lifecycle', () => {
  it('arms on the toggle, disarms on the same one, and hands over to the other', () => {
    render(<Harness onRotate={() => {}} />)
    expect(state()).toBe('off:—')
    armWith('✥')
    expect(state()).toBe('move:—')
    armWith('⟳')                       // only ever one of the two
    expect(state()).toBe('rotate:—')
    armWith('⟳')
    expect(state()).toBe('off:—')
  })

  it('disarms on Esc, on a different selection, and when the bar itself goes', () => {
    const { rerender } = render(<Harness />)
    armWith('✥')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(state()).toBe('off:—')

    armWith('✥')
    rerender(<Harness resetKey="sel-2" />)
    expect(state()).toBe('off:—')

    armWith('✥')
    rerender(<Harness enabled={false} />)   // read-only, no selection, or a tool armed
    expect(state()).toBe('off:—')
  })
})

describe('a drag on the surface while ✥ is armed', () => {
  it('moves by the drag delta and takes the surface’s pan for the gesture', () => {
    const onMove = vi.fn()
    const onGrab = vi.fn()
    const onSurface = vi.fn()
    render(<Harness onMove={onMove} onGrab={onGrab} onSurface={onSurface} />)
    armWith('✥')
    dragSurface([120, 300], [180, 340])
    expect(onMove.mock.calls).toEqual([[0, 0, 'start'], [60, 40, 'move'], [60, 40, 'end']])
    expect(onGrab.mock.calls).toEqual([[true], [false]])
    // the press never reached the surface: no pan, no marquee, no placement under an armed drag
    expect(onSurface).not.toHaveBeenCalled()
  })

  it('steps the selection’s own geometry grips aside for the drag, and back on release', () => {
    render(<Harness />)
    armWith('✥')
    expect(transformingChrome()).toBe(false)
    fireEvent.pointerDown(surface(), { pointerId: 9, isPrimary: true, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 100, clientY: 104 })
    expect(transformingChrome()).toBe(false)     // still inside the deadzone: nothing has moved
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 100, clientY: 180 })
    expect(transformingChrome()).toBe(true)
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 100, clientY: 180 })
    expect(transformingChrome()).toBe(false)
  })

  it('allows drag after drag, from wherever the finger lands', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    armWith('✥')
    dragSurface([100, 100], [140, 100], 1)
    dragSurface([300, 300], [300, 260], 2)
    expect(onMove.mock.calls.filter((c) => c[2] === 'end')).toEqual([[40, 0, 'end'], [0, -40, 'end']])
    expect(state()).toBe('move:—')   // and it stays armed
  })

  it('writes nothing at all for a press that never leaves the deadzone', () => {
    const onMove = vi.fn()
    const onSurface = vi.fn()
    render(<Harness onMove={onMove} onSurface={onSurface} />)
    armWith('✥')
    dragSurface([100, 100], [100 + DRAG_DEADZONE_PX - 1, 100])
    fireEvent.click(surface())
    // no undo step, no Verlauf row — and the click is swallowed, so the selection stays put
    expect(onMove).not.toHaveBeenCalled()
    expect(onSurface).not.toHaveBeenCalled()
  })

  it('leaves the bar’s own grips alone, so the mode can be tapped off again', () => {
    const onMove = vi.fn()
    render(<Harness onMove={onMove} />)
    armWith('✥')
    armWith('✥')
    expect(state()).toBe('off:—')
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('a drag on the surface while ⟳ is armed', () => {
  it('follows the pointer’s bearing around the selection centre, free of any raster', () => {
    const onRotate = vi.fn()
    render(<Harness onRotate={onRotate} />)
    armWith('⟳')
    // press due EAST of the centre, then swing to due SOUTH: a quarter turn clockwise
    fireEvent.pointerDown(surface(), { pointerId: 3, isPrimary: true, clientX: CENTRE.x + 100, clientY: CENTRE.y })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: CENTRE.x, clientY: CENTRE.y + 100 })
    expect(onRotate.mock.calls[0]).toEqual([0, 'start'])
    expect(onRotate.mock.calls[1][0]).toBeCloseTo(90, 6)
    // …and the guide has the pivot AND the fingertip, which is what it draws the radius between
    expect(screen.getByTestId('turn').textContent).toBe('200,200→200,300')
    // …and on past half a circle, which is where a plainly wrapped angle would fall back to −90
    fireEvent.pointerMove(window, { pointerId: 3, clientX: CENTRE.x - 100, clientY: CENTRE.y })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: CENTRE.x, clientY: CENTRE.y - 100 })
    expect(onRotate.mock.calls[onRotate.mock.calls.length - 1][0]).toBeCloseTo(270, 6)
    fireEvent.pointerUp(window, { pointerId: 3, clientX: CENTRE.x, clientY: CENTRE.y - 100 })
    expect(onRotate.mock.calls[onRotate.mock.calls.length - 1]).toEqual([270, 'end'])
    expect(state()).toBe('rotate:—')   // the read-out belongs to the gesture only
  })
})

describe('what the mode refuses', () => {
  it('takes no press at all while it is off — the surface keeps its own gestures', () => {
    const onMove = vi.fn()
    const onSurface = vi.fn()
    render(<Harness onMove={onMove} onSurface={onSurface} />)
    dragSurface([100, 100], [180, 180])
    fireEvent.click(surface())
    expect(onMove).not.toHaveBeenCalled()
    expect(onSurface.mock.calls.flat()).toEqual(['down', 'click'])
  })

  it('cannot be armed on a surface that hands over no bar (viewer / locked)', () => {
    const onMove = vi.fn()
    render(<Harness enabled={false} onMove={onMove} />)
    armWith('✥')
    expect(state()).toBe('off:—')
    dragSurface([100, 100], [180, 180])
    expect(onMove).not.toHaveBeenCalled()
  })
})

// the exported kind is the pair the bar paints — a third mode would need a button
const _modes: ArmMode[] = ['move', 'rotate']
