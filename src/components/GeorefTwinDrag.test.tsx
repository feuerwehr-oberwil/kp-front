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
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Entity } from '../types'
import { GeorefTwinsBoard } from './GeorefTwinsBoard'
import { fitSimilarity } from '../lib/georef'
import type { BoardTwin } from '../lib/georefTwins'

afterEach(cleanup)

const tlf = { id: 'e1', kind: 'symbol', layer: 'lage', coord: [8.0005, 47.0005], label: 'TLF Oberwil' } as Entity
const TWIN_FIT = fitSimilarity([
  { plan: { x: 0, y: 0 }, lngLat: { lng: 8, lat: 47 } },
  { plan: { x: 1, y: 0 }, lngLat: { lng: 8.001, lat: 47 } },
], 1)!
const twinAt = (x: number, y: number): BoardTwin => ({ key: 'modul2:e1', kind: 'symbol', entityId: 'e1', pt: { x, y }, entity: tlf, fit: TWIN_FIT })

const SW = 1000, SH = 500
const renderBoard = (onMove?: typeof vi.fn extends never ? never : ((t: BoardTwin, p: { x: number; y: number }, ph: 'start' | 'move' | 'end') => void)) =>
  render(<GeorefTwinsBoard twins={[twinAt(0.5, 0.5)]} byName={{}} sW={SW} sH={SH} sizePx={40} planWidthM={100}
    selectedKey="modul2:e1" onOpen={() => {}} onMove={onMove} />)

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
  /**
   * ⚠️ THE regression test for «bewegt sich viel zu weit» (27.08.).
   *
   * The board is re-rendered mid-drag with the projection already moved — that is the whole point
   * of a twin following its source. So the cumulative delta from the mark has to be added to where
   * the twin STOOD when the finger went down, not to its live position. Adding it to the live prop
   * re-applied the whole travel on every sample: 25 → 75 → 150 → 250 px for four samples of 25.
   *
   * The earlier test missed this by holding `pt` fixed for the whole gesture, which is the one
   * thing the real board never does.
   */
  it('follows the finger 1:1 even though the twin moves under it', () => {
    let pt = { x: 0.2, y: 0.2 }
    const seen: { x: number; y: number }[] = []
    const Live = () => {
      const [p, setP] = useState(pt)
      return <GeorefTwinsBoard twins={[{ ...twinAt(p.x, p.y) }]} byName={{}} sW={SW} sH={SH} sizePx={40} planWidthM={100}
        selectedKey="modul2:e1" onOpen={() => {}} onMove={(_t, next) => { seen.push(next); pt = next; setP(next) }} />
    }
    render(<Live />)
    const m = screen.getByRole('button')
    fireEvent.pointerDown(m, { pointerId: 1, clientX: 100, clientY: 100 })
    for (const step of [25, 50, 75, 100]) {
      fireEvent.pointerMove(m, { pointerId: 1, clientX: 100 + step, clientY: 100 })
    }
    fireEvent.pointerUp(m, { pointerId: 1, clientX: 200, clientY: 100 })
    // 100px of travel across a 1000px sheet = exactly +0.1, however many samples it took
    expect(pt.x).toBeCloseTo(0.3, 9)
    expect(pt.y).toBeCloseTo(0.2, 9)
    // …and it never overshot on the way, which is what «viel zu weit» looked like
    for (const s of seen) expect(s.x).toBeLessThanOrEqual(0.3 + 1e-9)
  })

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

  it('moves immediately without requiring a selection tap first', () => {
    const onOpen = vi.fn()
    const onMove = vi.fn()
    render(<GeorefTwinsBoard twins={[twinAt(0.5, 0.5)]} byName={{}} sW={SW} sH={SH} sizePx={40} planWidthM={100}
      onOpen={onOpen} onMove={onMove} />)
    expect(mark().className).toContain('grab')
    drag([300, 250])
    expect(onMove).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps automatic floor and count badges upright on a differently oriented Modul', () => {
    const directional = {
      ...tlf,
      symbol: 'VKF Luefter mobil', rotation: 35, floor: 1, count: 2,
    } as Entity
    const turned = { ...twinAt(0.5, 0.5), entity: directional, fit: { ...TWIN_FIT, rotationDeg: 40 } }
    render(<GeorefTwinsBoard twins={[turned]} byName={{ 'VKF Luefter mobil': '<svg viewBox="0 0 10 10" />' }}
      sW={SW} sH={SH} sizePx={28} planWidthM={100} onOpen={() => {}} />)
    const glyph = document.querySelector<HTMLElement>('.ts-rot')!
    expect(glyph.style.transform).toContain('rotate(75deg)')
    for (const badge of document.querySelectorAll('.sym-floor, .sym-count')) {
      expect(badge.closest('.ts-rot')).toBeNull()
      expect((badge as HTMLElement).style.transform).toBe('')
    }
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
