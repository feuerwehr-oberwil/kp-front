// @vitest-environment jsdom
// The way out of a layer (overlays/layer): a tap beside it only closes it, one Esc closes one
// layer, the native back closes the top layer.

import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetLayers, useLayer } from './layer'

afterEach(() => { cleanup(); resetLayers() })

function Card({ name, onClose = () => {}, throughBars }: { name: string; onClose?: () => void; throughBars?: boolean }) {
  const [open, setOpen] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  useLayer({ open, onClose: () => { setOpen(false); onClose() }, inside: [ref], throughBars })
  return open ? <div ref={ref} role="dialog" aria-label={name}><input aria-label={`${name}-feld`} /></div> : null
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 0)))

describe('useLayer', () => {
  it('a tap beside the layer only closes it – the press never reaches what lies under it', () => {
    const under = vi.fn()
    render(<><button onPointerDown={under} onClick={under}>Karte</button><Card name="Gebäude" /></>)
    const map = screen.getByRole('button', { name: 'Karte' })
    fireEvent.pointerDown(map)
    fireEvent.pointerUp(map)
    fireEvent.click(map)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(under).not.toHaveBeenCalled()
    // the next tap is an ordinary one again
    fireEvent.pointerDown(map)
    fireEvent.click(map)
    expect(under).toHaveBeenCalledTimes(2)
  })

  it('throughBars: a rail tile closes the layer AND gets its tap; the map beside it still only closes it', () => {
    const tile = vi.fn()
    const under = vi.fn()
    const { rerender } = render(<><nav className="navrail"><button onClick={tile}>Symbol</button></nav><button onClick={under}>Karte</button><Card name="Gebäude" throughBars /></>)
    const sym = screen.getByRole('button', { name: 'Symbol' })
    fireEvent.pointerDown(sym)
    fireEvent.pointerUp(sym)
    fireEvent.click(sym)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tile).toHaveBeenCalledTimes(1)
    // a fresh card: the map beside it is swallowed as before
    rerender(<><nav className="navrail"><button onClick={tile}>Symbol</button></nav><button onClick={under}>Karte</button><Card key="2" name="Gebäude" throughBars /></>)
    const map = screen.getByRole('button', { name: 'Karte' })
    fireEvent.pointerDown(map)
    fireEvent.pointerUp(map)
    fireEvent.click(map)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(under).not.toHaveBeenCalled()
  })

  it('a press inside the layer is its own', () => {
    render(<Card name="Gebäude" />)
    fireEvent.pointerDown(screen.getByRole('textbox'))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('one Esc closes the top layer alone and the surface below never hears it', () => {
    const surface = vi.fn()
    window.addEventListener('keydown', surface)
    render(<><Card name="unten" /><Card name="oben" /></>)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'oben' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'unten' })).toBeTruthy()
    expect(surface).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(surface).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', surface)
  })

  it('Esc in a field of the layer is the field\'s – the layer stays', () => {
    render(<Card name="Ansichten" />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('the native back closes the top layer, one per press; a close by hand takes its entry away', async () => {
    const start = window.history.length
    render(<><Card name="unten" /><Card name="oben" /></>)
    await tick()
    // two layers, ONE entry
    expect(window.history.length).toBe(start + 1)
    await act(async () => {
      window.history.back()
      await new Promise((r) => window.addEventListener('popstate', r, { once: true }))
    })
    await tick()
    expect(screen.queryByRole('dialog', { name: 'oben' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'unten' })).toBeTruthy()
    // the one still open stands on a fresh entry; Esc closes it and the entry is walked back
    expect((window.history.state as Record<string, unknown> | null)?.kpLayer).toBe(true)
    const walked = new Promise((r) => window.addEventListener('popstate', r, { once: true }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await tick()
    await act(async () => { await walked })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect((window.history.state as Record<string, unknown> | null)?.kpLayer).toBeUndefined()
  })
})
