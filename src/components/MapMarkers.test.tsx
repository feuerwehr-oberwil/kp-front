// @vitest-environment jsdom
/**
 * The Formen on the Karte: what a finger can actually land on, and what a selected one shows.
 *
 * jsdom lays nothing out, so the pad's own pixels are CSS (03-map.css · .shape-glyph::before).
 * What is pinned here is the wiring that decides WHICH box the pad hugs — a Form opts out of the
 * marker's square long-side pad, and the box left for the pad is the shape's own, per axis.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import type { Entity, LngLat } from '../types'

vi.mock('react-map-gl/maplibre', () => ({
  Marker: ({ children }: { children: ReactNode }) => <div data-testid="marker">{children}</div>,
}))

import { MapMarkers } from './MapMarkers'

afterEach(cleanup)

const at: LngLat = [7.6, 47.5]
const shape = (id: string, extra: Partial<Entity>): Entity =>
  ({ id, kind: 'shape', layer: 'lage', coord: at, shape: 'square', sizeM: 45, ...extra }) as Entity
// a run of 300 m, stored the way both surfaces store one (lib/shapes · rotationBox)
const rotation = shape('rot', { shape: 'rotation', sizeM: 345, aspect: 0.13, rotation: 40 })
const rechteck = shape('sq', { shape: 'square', sizeM: 45 })

const show = (entities: Entity[], selectedId: string | null = null) => render(
  <MapMarkers entities={entities} byName={{}} isVisible={() => true} selectedId={selectedId}
    zoom={18} draggable project={() => ({ x: 0, y: 0 })} unproject={() => at} setDragPan={() => {}}
    onSelect={() => {}} onMarkerDragStart={() => {}} onMarkerMove={() => {}} onMarkerDragEnd={() => {}}
    onDelete={() => {}} onShapeTransform={() => {}} />,
)
describe('what a finger lands on when it reaches for a Form', () => {
  // ⚠️ THE «Klickfläche der Rotation» regression (01.09.). The marker's own pad is ONE square of
  // max(width, height): on a Rechteck that is its box, on a Rotation it is a square as wide as
  // the run is long — hundreds of px of hit area over empty ground above and below the loop.
  // A Form's pad follows its own box instead, which is why the marker's square is switched off.
  it('gives a Form no square long-side pad — its hit box is its own box', () => {
    const { container } = show([rotation])
    const marker = container.querySelector('.marker')!
    expect(marker.className).toContain('marker-shape')
  })

  it('…while a placed symbol keeps the square pad it was written for', () => {
    const { container } = show([{ id: 's1', kind: 'symbol', layer: 'lage', coord: at, symbol: 'Feuer' } as Entity])
    expect(container.querySelector('.marker')!.className).not.toContain('marker-shape')
  })

  /**
   * ⚠️ 02.09.: a selected Form wears NO halo and its body drags nothing. It is selected to be
   * worked with its own precise grips — the ends, the axes, the cage — and moved from the fixed
   * selection bar's ✥, dragged for the small adjustment or armed for the whole surface. A 104px
   * ring around a metres-true shape said nothing those grips do not, over the ground they sit on;
   * and a body drag meant a mis-aimed reach for an end grip nudged the whole loop instead.
   */
  it('gives a selected Form no halo, and no body drag either', () => {
    const onMarkerDragStart = vi.fn()
    const onMarkerMove = vi.fn()
    const { container } = render(
      <MapMarkers entities={[rechteck]} byName={{}} isVisible={() => true} selectedId="sq"
        zoom={18} draggable project={() => ({ x: 0, y: 0 })} unproject={() => at} setDragPan={() => {}}
        onSelect={() => {}} onMarkerDragStart={onMarkerDragStart} onMarkerMove={onMarkerMove}
        onMarkerDragEnd={() => {}} onDelete={() => {}} onShapeTransform={() => {}} />,
    )
    expect(container.querySelector('.sel-halo')).toBeNull()
    const glyph = container.querySelector('.shape-glyph')!
    fireEvent.pointerDown(glyph, { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 190, clientY: 160 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 190, clientY: 160 })
    expect(onMarkerDragStart).not.toHaveBeenCalled()
    expect(onMarkerMove).not.toHaveBeenCalled()
  })

  it('…and a placed symbol keeps both, because its body IS its move path', () => {
    const symbol = { id: 's1', kind: 'symbol', layer: 'lage', coord: at, symbol: 'Feuer' } as Entity
    const onMarkerMove = vi.fn()
    const { container } = render(
      <MapMarkers entities={[symbol]} byName={{}} isVisible={() => true} selectedId="s1"
        zoom={18} draggable project={() => ({ x: 0, y: 0 })} unproject={() => at} setDragPan={() => {}}
        onSelect={() => {}} onMarkerDragStart={() => {}} onMarkerMove={onMarkerMove}
        onMarkerDragEnd={() => {}} onDelete={() => {}} onShapeTransform={() => {}} />,
    )
    expect(container.querySelector('.sel-halo')).toBeTruthy()
    const ts = container.querySelector('.marker')!
    fireEvent.pointerDown(ts, { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 190, clientY: 160 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 190, clientY: 160 })
    expect(onMarkerMove).toHaveBeenCalled()
  })

  // the box the pad hugs: a Rechteck's is square, a Rotation's is long and flat — and it is the
  // SAME element on both, so one rule covers both kinds and both surfaces
  it('leaves each kind its own two-sided box for the pad to hug', () => {
    const { container } = show([rechteck])
    const sq = container.querySelector<HTMLElement>('.shape-glyph')!
    expect(parseFloat(sq.style.height)).toBeCloseTo(parseFloat(sq.style.width), 6)
    cleanup()
    const { container: c2 } = show([rotation])
    const rot = c2.querySelector<HTMLElement>('.shape-glyph')!
    expect(parseFloat(rot.style.height)).toBeCloseTo(parseFloat(rot.style.width) * 0.13, 3)
    // …and it turns with the run, so the pad drawn inside it does too
    expect(rot.style.transform).toContain('rotate(40deg)')
  })
})

// ── the edit chrome of a selected Form (01.09. vocabulary) ───────────────────────────────────
// On the object itself only GEOMETRY grips, and every one of them from the one blue family —
// the near-black ink fill these wore is gone. Moving, turning and deleting the whole thing are
// the fixed SelectionBar's (MapView), which is why the Rotation has nothing but its two ends.
describe('what a selected Form shows on the Karte', () => {
  const S = appConfig.copy.shapes
  const noInlineFill = (g: Element) => expect((g as HTMLElement).style.background).toBe('')

  it('gives a Rotation its two end grips and nothing else', () => {
    const { container } = show([rotation], 'rot')
    const ends = container.querySelectorAll('.handle.shape-end')
    expect(ends).toHaveLength(2)
    for (const g of ends) {
      expect(g.getAttribute('aria-label')).toBe(S.endHint)
      // its press-and-hold IS the gesture, so the global hold-tooltip must not claim the release
      expect(g.hasAttribute('data-holdaction')).toBe(true)
      noInlineFill(g)
    }
    // each end sets the run's length AND its bearing, so there is nothing for a knob or a size
    // grip to say — and no stem to tether one by
    expect(container.querySelector('.shape-stem')).toBeNull()
    expect(container.querySelector('.shape-rotate')).toBeNull()
    expect(container.querySelector('.shape-resize, .shape-width')).toBeNull()
  })

  it('…and a Rechteck the knob and one grip per axis, from the same family', () => {
    const { container } = show([rechteck], 'sq')
    expect(container.querySelector('.shape-rotate')).toBeTruthy()
    expect(container.querySelector('.shape-resize.shape-axis-x')).toBeTruthy()
    expect(container.querySelector('.shape-width.shape-axis-y')).toBeTruthy()
    for (const g of container.querySelectorAll('.handle')) noInlineFill(g)
  })
})
