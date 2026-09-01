// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { MapTwin } from '../lib/georefTwins'
import type { BoardAnno } from '../types'

vi.mock('react-map-gl/maplibre', () => ({
  Marker: ({ children, draggable, offset, style }: { children: ReactNode; draggable?: boolean; offset?: [number, number]; style?: Record<string, unknown> }) => (
    <div data-testid="marker" data-draggable={draggable ? 'true' : 'false'}
      data-offset={offset ? offset.join(',') : ''} data-z={String(style?.zIndex ?? '')}>{children}</div>
  ),
}))

import { GeorefTwinsMap } from './GeorefTwinsMap'

afterEach(cleanup)

const anno: BoardAnno = { id: 'a1', kind: 'symbol', symbol: 'Feuer', x: 0.5, y: 0.5, floor: 0 }
const twin = {
  key: 'modul1:a1', planId: 'modul1', planCode: 'Modul 1', annoId: 'a1',
  coord: [7.6, 47.5], anno, fit: { rotationDeg: 0 },
} as MapTwin
const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

// 1000 px per degree, the same little transform GeorefContentMap's test uses
const project = (c: [number, number]) => ({ x: (c[0] - 7.6) * 1000, y: (47.5 - c[1]) * 1000 })
const unproject = (p: { x: number; y: number }) => [7.6 + p.x / 1000, 47.5 - p.y / 1000] as [number, number]

describe('a Plan twin on the Karte', () => {
  // `null` is «this surface hands over no move at all» (locked / viewer); the default is the
  // ordinary editable Karte
  const show = (selectedKey?: string, zoom = 18, onMove: ((twin: MapTwin, coord: [number, number], phase: 'start' | 'move' | 'end') => void) | null = () => {}) => render(
    <GeorefTwinsMap twins={[twin]} byName={{ Feuer: svg }} zoom={zoom} selectedKey={selectedKey}
      onOpen={() => {}} onMove={onMove ?? undefined} project={project} unproject={unproject} />,
  )

  // ⚠️ THE D-03 regression (01.09.): a react-map-gl `draggable` Marker claims the pointer on
  // pointerdown and suppresses the map's pan, so every pan that started on a twin dragged the
  // twin. The gesture belongs to the shared hold (lib/mapTwinDrag), exactly as it does for the
  // native marker standing beside it.
  it('is never a draggable MapLibre Marker — the pan stays with the map', () => {
    show()
    expect(screen.getByTestId('marker').dataset.draggable).toBe('false')
    expect(screen.getByRole('button').className).toContain('grab')
  })

  it('offers no grab affordance at all when the surface passes no move (locked / viewer)', () => {
    show(undefined, 18, null)
    expect(screen.getByRole('button').className).not.toContain('grab')
  })

  it('shows its selection halo while staying non-draggable', () => {
    show('modul1:a1')
    expect(screen.getByTestId('marker').dataset.draggable).toBe('false')
    expect(screen.getByRole('button').querySelector('.sel-halo')).toBeTruthy()
  })

  it('does not move on the first touch travel — a flick across it is a map pan', () => {
    const onMove = vi.fn()
    show(undefined, 18, onMove)
    const mark = screen.getByRole('button')
    fireEvent.pointerDown(mark, { pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 140, clientY: 100 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 140, clientY: 100 })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('arms the move only after the still hold — the native 180 ms plus its buzz', () => {
    vi.useFakeTimers()
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', Object.assign(Object.create(Object.getPrototypeOf(navigator)), navigator, { vibrate }))
    try {
      const onMove = vi.fn()
      show(undefined, 18, onMove)
      const mark = screen.getByRole('button')
      fireEvent.pointerDown(mark, { pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: 100, clientY: 100 })
      act(() => { vi.advanceTimersByTime(200) })
      expect(vibrate).toHaveBeenCalled()
      expect(onMove.mock.calls[0]?.[2]).toBe('start')
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 140, clientY: 100 })
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 140, clientY: 100 })
      const [, coord, phase] = onMove.mock.calls[onMove.mock.calls.length - 1]
      expect(phase).toBe('end')
      // +40 px east across a 1000 px/deg transform = +0.04°, folded back by the caller's fit
      expect(coord[0]).toBeCloseTo(7.64, 6)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  // 30.08. doctrine (supersedes E9's quieter footprint band): a twin renders EXACTLY like a
  // native symbol standing beside it — same symPx band, so an F and its mirror are visually
  // one object. At z18 the band floor holds, at z21 a symbol's 8 m reach its 48 px ceiling.
  it('sizes like a native map symbol (symPx band), not a quieter twin band', () => {
    show(undefined, 18)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(28) // the native floor
    cleanup()
    show(undefined, 21)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(48) // the native ceiling
  })
})

// D-24/D-10: a projection is presentation-equivalent to the object beside it, and that includes
// answering to the surface's ONE label pass and stepping out of a fat-finger pile with it.
describe('a Plan twin inside the map\'s own arbitration', () => {
  const render1 = (extra: Partial<React.ComponentProps<typeof GeorefTwinsMap>> = {}) =>
    render(<GeorefTwinsMap twins={[{ ...twin, anno: { ...anno, label: 'Brandherd' } }]} byName={{ Feuer: svg }}
      zoom={18} captionMode="all" onOpen={() => {}} {...extra} />)

  it('drops its caption when the label pass says the box is taken', () => {
    render1()
    expect(screen.getByText('Brandherd')).toBeTruthy()
    cleanup()
    render1({ suppressedLabels: new Set(['tcap:modul1:a1']) })
    expect(screen.queryByText('Brandherd')).toBeNull()
  })

  it('steps out on the fan\'s hairline when a pile is opened over it', () => {
    const { container } = render1({ fanOffsets: { 'modul1:a1': { dx: 30, dy: -20 } } })
    const marker = screen.getByTestId('marker')
    expect(marker.dataset.offset).toBe('30,-20')
    // …and it clears the natives it was buried under, exactly as a fanned native does
    expect(marker.dataset.z).toBe('12')
    // the hairline points back at the true position
    expect(container.querySelector('.fan-spoke line')?.getAttribute('x2')).toBe('-30')
  })
})

// D-28, and the other half of D-08: once a Karte Leitung may dock onto a mirrored Plan symbol,
// the twin IS a node of this surface's relationship network — and says so like its neighbours.
describe('a Plan twin inside the map\'s relationship network', () => {
  it('wears the «Verbunden» ring when a line is hooked to it, and not while selected', () => {
    const { container, rerender } = render(<GeorefTwinsMap twins={[twin]} byName={{ Feuer: svg }}
      zoom={18} networkIds={new Set(['a1'])} onOpen={() => {}} />)
    expect(container.querySelector('.network-halo')).toBeTruthy()
    // the selection halo already says «this one» — two rings on one glyph say it twice
    rerender(<GeorefTwinsMap twins={[twin]} byName={{ Feuer: svg }} zoom={18}
      networkIds={new Set(['a1'])} selectedKey="modul1:a1" onOpen={() => {}} />)
    expect(container.querySelector('.network-halo')).toBeNull()
    expect(container.querySelector('.sel-halo')).toBeTruthy()
  })
})
