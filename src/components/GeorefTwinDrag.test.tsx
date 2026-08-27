// @vitest-environment jsdom
/**
 * Dragging a mirrored Karte object on a georeferenced sheet moves the SOURCE object.
 *
 * Until 27.08. it did not: TwinMark swallowed pointerdown and answered taps only, while
 * `startEntityMove`'s doc had long claimed the projection as one of its two call sites. What
 * follows pins the two halves the gesture is actually made of — the board turning a pixel delta
 * into a point on the sheet, and the fit folding that point back into a ground coordinate.
 * (TwinMark's own tap-vs-drag rule lives in GeorefTwinMark.test.tsx.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Entity } from '../types'
import { GeorefTwinsBoard } from './GeorefTwinsBoard'
import { fitSimilarity } from '../lib/georef'
import type { BoardTwin } from '../lib/georefTwins'

afterEach(cleanup)

const tlf = { id: 'e1', kind: 'symbol', layer: 'lage', coord: [8.0005, 47.0005], label: 'TLF Oberwil' } as Entity
const twinAt = (x: number, y: number): BoardTwin => ({ key: 'modul2:e1', kind: 'symbol', entityId: 'e1', pt: { x, y }, entity: tlf })

const SW = 1000, SH = 500
const renderBoard = (onMove?: typeof vi.fn extends never ? never : ((t: BoardTwin, p: { x: number; y: number }, ph: 'start' | 'move' | 'end') => void)) =>
  render(<GeorefTwinsBoard twins={[twinAt(0.5, 0.5)]} byName={{}} sW={SW} sH={SH} sizePx={40}
    onOpen={() => {}} onMove={onMove} />)

const mark = () => screen.getByRole('button')
const drag = (to: [number, number]) => {
  const m = mark()
  fireEvent.pointerDown(m, { pointerId: 1, clientX: 200, clientY: 200 })
  fireEvent.pointerMove(m, { pointerId: 1, clientX: to[0], clientY: to[1] })
  fireEvent.pointerUp(m, { pointerId: 1, clientX: to[0], clientY: to[1] })
}

describe('a twin dragged across the sheet', () => {
  it('turns the pixel travel into a point in the SHEET’s own space', () => {
    const onMove = vi.fn()
    renderBoard(onMove)
    // +100px across a 1000px sheet = +0.1; +50px down a 500px sheet = +0.1
    drag([300, 250])
    const [twin, pt, phase] = onMove.mock.calls[onMove.mock.calls.length - 1]
    expect(phase).toBe('end')
    expect(twin.entityId).toBe('e1')          // the source on the Karte, never the projection
    expect(pt.x).toBeCloseTo(0.6, 6)
    expect(pt.y).toBeCloseTo(0.6, 6)
  })

  // a point off the paper is not a place on that document, and would fold back through the fit
  // as a ground coordinate nobody aimed at
  it('clamps to the sheet rather than naming a point off the paper', () => {
    const onMove = vi.fn()
    renderBoard(onMove)
    drag([5000, 5000])
    const [, pt] = onMove.mock.calls[onMove.mock.calls.length - 1]
    expect(pt).toEqual({ x: 1, y: 1 })
  })

  it('offers no drag at all when the surface does not pass one (locked / viewer)', () => {
    renderBoard(undefined)
    expect(mark().className).not.toContain('grab')
  })
})

describe('the fold back through the fit', () => {
  // three pairs, axis-aligned: 1 sheet unit across = 0.001° lng, and the sheet's y grows
  // DOWNWARD while latitude grows upward — the flip the fit has to get right
  const fit = fitSimilarity([
    { plan: { x: 0, y: 0 }, lngLat: { lng: 8.0, lat: 47.001 }, kind: 'gesetzt' },
    { plan: { x: 1, y: 0 }, lngLat: { lng: 8.001, lat: 47.001 }, kind: 'gesetzt' },
    { plan: { x: 0, y: 1 }, lngLat: { lng: 8.0, lat: 47.0 }, kind: 'gesetzt' },
  ], 1)

  it('sends a drag to the right eastward, and a drag downward southward', () => {
    expect(fit).toBeTruthy()
    const from = fit!.toMap({ x: 0.5, y: 0.5 })
    expect(fit!.toMap({ x: 0.6, y: 0.5 }).lng).toBeGreaterThan(from.lng)
    expect(fit!.toMap({ x: 0.5, y: 0.6 }).lat).toBeLessThan(from.lat)
  })

  // the mark must land where it was dropped: toPlan/toMap are exact inverses, so what the
  // residual costs is how well the SHEET matches the ground — not where the symbol appears
  it('round-trips a plan point through the map and back', () => {
    const pt = { x: 0.37, y: 0.62 }
    const back = fit!.toPlan(fit!.toMap(pt))
    expect(back.x).toBeCloseTo(pt.x, 9)
    expect(back.y).toBeCloseTo(pt.y, 9)
  })
})
