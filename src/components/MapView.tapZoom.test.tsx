// @vitest-environment jsdom
/**
 * A double tap zooms the Karte, it never draws (owner 20.10.2026, UX sweep M4: «Double tap should
 * be used as a map function … Definitely not for finishing something»). MapLibre's own double tap
 * and tap-and-drag stay on while a Linie / Fläche is tapped out node by node, and the node the
 * first tap laid before MapLibre knew it was a double tap is taken back when the zoom starts.
 * `<Map>` is a stand-in that hands its props to the test, so the test fires MapLibre's event
 * sequence (click, then zoomstart with the gesture's own event) at MapView's handlers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { forwardRef, type ReactNode } from 'react'
import type { LngLat } from '../types'

type MapProps = Record<string, unknown> & { children?: ReactNode }
const captured: { props: MapProps | null } = { props: null }

vi.mock('react-map-gl/maplibre', () => ({
  default: forwardRef<unknown, MapProps>(function MapStandIn(props, _ref) {
    captured.props = props
    return <div data-testid="map">{props.children as ReactNode}</div>
  }),
  Marker: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Source: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Layer: () => null,
  useControl: () => null,
  useMap: () => ({ current: undefined }),
}))

// maplibre-gl mints its worker URL from a Blob at import time; jsdom has no createObjectURL
window.URL.createObjectURL ??= () => 'blob:test'
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const { MapView } = await import('./MapView')
const noop = () => {}

afterEach(() => { cleanup(); captured.props = null })

/** a Karte with a node tool armed; `onMapClick` lays the node the way useMapActions does */
function mount(draftKind: 'line' | 'area' | null = 'line') {
  let draft: LngLat[] = []
  const onDraftDelete = vi.fn((i: number) => { draft = draft.filter((_, j) => j !== i) })
  const view = () => (
    <MapView
      entities={[]} layers={[]} byName={{}} initialCenter={[7.555, 47.515]} preparedOverlays={[]}
      isVisible={() => true} selectedId={null} onSelect={noop}
      onMapClick={(c) => { if (draftKind) draft = [...draft, c] }}
      drawings={[]} drawingsVisible draft={draft} draftKind={draftKind} placing={draftKind != null} draggable={false}
      onDraftDelete={onDraftDelete}
      onMarkerDragStart={noop} onMarkerMove={noop} onMarkerDragEnd={noop} onView={noop}
      freehand={null} onFreehand={noop} drawColor="#000" drawWidth={3} drawDashed={false}
      selectedDrawingId={null} onSelectDrawing={noop} onDelete={noop}
    />
  )
  const r = render(view())
  const p = () => captured.props as Record<string, (e: unknown) => void>
  return {
    onDraftDelete,
    draft: () => draft,
    /** a tap MapLibre reports as a click at a spot on the map, at `t` ms */
    tap(lng: number, t: number) {
      act(() => p().onClick({ lngLat: { lng, lat: 47.515 }, point: { x: 0, y: 0 }, features: [], originalEvent: { type: 'click', timeStamp: t } }))
      r.rerender(view())
    },
    /** MapLibre starts a zoom; `originalEvent` is the gesture's own DOM event */
    zoom(originalEvent: { type: string; timeStamp: number; touches?: unknown[] }) { act(() => p().onZoomStart({ originalEvent })) },
  }
}

describe('MapView — a double tap while drawing zooms and lays nothing', () => {
  it('a double tap (its second touchend) takes back the node its first tap laid — only that one', () => {
    const m = mount()
    m.tap(7.55, 0) // a corner, tapped just before
    m.tap(7.56, 300) // the double tap's first tap
    m.zoom({ type: 'touchend', timeStamp: 600, touches: [] })
    expect(m.onDraftDelete).toHaveBeenCalledTimes(1)
    expect(m.draft()).toEqual([[7.55, 47.515]])
  })

  it('tap-and-drag (a one-finger touchmove) does the same', () => {
    const m = mount('area')
    m.tap(7.55, 0)
    m.zoom({ type: 'touchmove', timeStamp: 350, touches: [{}] })
    expect(m.draft()).toEqual([])
  })

  it('a mouse double click laid two nodes — both go', () => {
    const m = mount()
    m.tap(7.55, 0); m.tap(7.551, 200)
    m.zoom({ type: 'dblclick', timeStamp: 210 })
    expect(m.draft()).toEqual([])
  })

  it('a pinch or the wheel leaves the draft alone', () => {
    const m = mount()
    m.tap(7.55, 0)
    m.zoom({ type: 'touchmove', timeStamp: 100, touches: [{}, {}] })
    m.zoom({ type: 'wheel', timeStamp: 200 })
    expect(m.onDraftDelete).not.toHaveBeenCalled()
  })

  it('a tap long before the zoom was a node, not half of a double tap', () => {
    const m = mount()
    m.tap(7.55, 0)
    m.zoom({ type: 'touchend', timeStamp: 1500, touches: [] })
    expect(m.onDraftDelete).not.toHaveBeenCalled()
  })
})
