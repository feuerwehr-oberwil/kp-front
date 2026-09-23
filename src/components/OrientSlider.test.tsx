// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OrientSlider } from './OrientSlider'

afterEach(cleanup)

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
/** one frame of the thumb moving — the browser's `input` event (React's onChange) */
const move = (deg: number) => fireEvent.input(slider(), { target: { value: String(deg) } })
/** the browser's release: the NATIVE `change` event, value unchanged since the last `input` */
const release = () => fireEvent.change(slider())

describe('OrientSlider — the Gebäude orientation preview', () => {
  it('previews while the thumb moves and commits exactly once on the native change', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider())
    move(20); move(40)
    expect(shown()).toBe(40)
    expect(commit).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider()) // pointerup alone commits nothing any more
    expect(commit).not.toHaveBeenCalled()
    release()
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(40)
    expect(shown()).toBe(40)
    release() // a stray second change has nothing left to commit
    expect(commit).toHaveBeenCalledOnce()
  })

  it('a pointercancel with no change after it (iOS: the touch became a scroll) drops the preview and commits nothing', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider())
    move(-65)
    expect(shown()).toBe(-65)
    fireEvent.pointerCancel(slider())
    expect(shown()).toBe(0)
    fireEvent.blur(slider())
    expect(commit).not.toHaveBeenCalled()
  })

  it('a pointercancel followed by a native change: the change wins — one commit, where the drag ended', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider())
    move(-30); move(-65)
    fireEvent.pointerCancel(slider())
    expect(shown()).toBe(0)
    release()
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(-65)
    expect(shown()).toBe(-65)
  })

  it('the keyboard commits once per step (each arrow is an input + a change)', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    for (const deg of [1, 2, 3]) { move(deg); release() }
    expect(commit.mock.calls).toEqual([[1], [2], [3]])
    expect(shown()).toBe(3)
  })

  it('the popover closing with a preview still live drops it', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    move(120)
    expect(shown()).toBe(120)
    act(() => { screen.getByText('close').click() })
    expect(screen.queryByRole('slider')).toBeNull()
    expect(shown()).toBe(0)
    expect(commit).not.toHaveBeenCalled()
  })
})
