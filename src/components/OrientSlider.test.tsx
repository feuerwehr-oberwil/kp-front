// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OrientSlider } from './OrientSlider'

afterEach(cleanup)

// jsdom has no layout and no pointer capture: the track is 360px wide from x=0, so one pixel is
// one degree (−180 at the left edge), and a captured pointer is every pointer.
beforeEach(() => {
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => true
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, right: 360, width: 360, top: 0, bottom: 44, height: 44, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
})

/** The Whiteboard's wiring in miniature: a committed angle, a live preview on top of it, and
 *  the popover (`open`) the slider lives in. `shown` is what the backdrop would be turned to. */
function Harness({ onCommit }: { onCommit: (deg: number) => void }) {
  const [committed, setCommitted] = useState(0)
  const [preview, setPreview] = useState<number | null>(null)
  const [open, setOpen] = useState(true)
  return (
    <>
      <output data-testid="shown">{preview ?? committed}</output>
      <button type="button" onClick={() => setOpen(false)}>close</button>
      {open && (
        <OrientSlider
          value={preview ?? committed}
          label="Drehung"
          onPreview={setPreview}
          onCommit={(deg) => { setPreview(null); setCommitted(deg); onCommit(deg) }}
          onAbandon={() => setPreview(null)}
        />
      )}
    </>
  )
}

const shown = () => Number(screen.getByTestId('shown').textContent)
const slider = () => screen.getByRole('slider', { name: 'Drehung' })
/** the finger at `deg` on the 1px-per-degree track */
const at = (deg: number) => ({ clientX: deg + 180, pointerId: 1 })

describe('OrientSlider – the Gebäude orientation preview', () => {
  it('is the app’s own slider, not a native range input', () => {
    render(<Harness onCommit={vi.fn()} />)
    expect(slider().tagName).not.toBe('INPUT')
    expect(slider().getAttribute('aria-valuetext')).toBe('0°')
  })

  it('previews while the thumb moves and commits exactly once on release', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider(), at(20))
    fireEvent.pointerMove(slider(), at(40))
    expect(shown()).toBe(40)
    expect(commit).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider(), at(40))
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(40)
    expect(shown()).toBe(40)
    fireEvent.pointerUp(slider(), at(40)) // a stray second release has nothing left to commit
    expect(commit).toHaveBeenCalledOnce()
  })

  it('a press that moves nothing commits nothing', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider(), at(0))
    fireEvent.pointerUp(slider(), at(0))
    expect(commit).not.toHaveBeenCalled()
  })

  it('a pointercancel (iOS: the browser took the touch) drops the preview and commits nothing', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider(), at(-30))
    fireEvent.pointerMove(slider(), at(-65))
    expect(shown()).toBe(-65)
    fireEvent.pointerCancel(slider(), at(-65))
    expect(shown()).toBe(0)
    fireEvent.pointerUp(slider(), at(-65))
    expect(commit).not.toHaveBeenCalled()
  })

  it('the keyboard commits once per step', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    for (let i = 0; i < 3; i++) fireEvent.keyDown(slider(), { key: 'ArrowRight' })
    expect(commit.mock.calls).toEqual([[1], [2], [3]])
    expect(shown()).toBe(3)
  })

  it('the popover closing with a preview still live drops it', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider(), at(120))
    expect(shown()).toBe(120)
    act(() => { screen.getByText('close').click() })
    expect(screen.queryByRole('slider')).toBeNull()
    expect(shown()).toBe(0)
    expect(commit).not.toHaveBeenCalled()
  })
})
