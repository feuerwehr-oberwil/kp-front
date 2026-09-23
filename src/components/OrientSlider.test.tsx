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
          pending={preview != null}
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

describe('OrientSlider — the Gebäude orientation preview', () => {
  it('previews while the thumb moves and commits once on release', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider())
    fireEvent.change(slider(), { target: { value: '40' } })
    expect(shown()).toBe(40)
    expect(commit).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider())
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(40)
    expect(shown()).toBe(40)
  })

  it('a pointercancel (iOS: the touch became a scroll) drops the preview and commits nothing', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.pointerDown(slider())
    fireEvent.change(slider(), { target: { value: '-65' } })
    expect(shown()).toBe(-65)
    fireEvent.pointerCancel(slider())
    expect(shown()).toBe(0)
    expect(commit).not.toHaveBeenCalled()
    // …and the blur that may follow has nothing left to commit
    fireEvent.blur(slider())
    expect(commit).not.toHaveBeenCalled()
  })

  it('the popover closing with a preview still live drops it', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.change(slider(), { target: { value: '120' } })
    expect(shown()).toBe(120)
    act(() => { screen.getByText('close').click() })
    expect(screen.queryByRole('slider')).toBeNull()
    expect(shown()).toBe(0)
    expect(commit).not.toHaveBeenCalled()
  })

  it('an arrow key commits its step, as before', () => {
    const commit = vi.fn()
    render(<Harness onCommit={commit} />)
    fireEvent.change(slider(), { target: { value: '1' } })
    fireEvent.keyUp(slider(), { key: 'ArrowRight' })
    expect(commit).toHaveBeenCalledWith(1)
  })
})
