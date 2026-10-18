// @vitest-environment jsdom
/**
 * North-snap on release, through the real MapView (owner, review round 6, 18.10.2026: «add a
 * small snap to north too like other places»; picked ±5° on release, Karte AND Einsatz — both
 * render this MapView). `<Map>` is replaced by a stand-in that hands its props to the test, so the
 * test fires MapLibre's own event sequence at MapView's handlers: `rotatestart` with the hand's
 * event, then `moveend` when the camera comes to rest, and reads what MapView asks the map to do.
 * The decision itself is pure and tested in lib/mapTwist.test.ts; the real-map check on a phone
 * is e2e/karte-north-snap.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { forwardRef, type ReactNode } from 'react'

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

/** the map instance MapView talks to after `load`: the north-snap's slice is real, every other
 *  call MapView's effects make answers inertly (a point, a lng/lat, an element, nothing) */
function fakeMap(bearing: number) {
  const m = {
    bearing,
    moving: false,
    getBearing: () => m.bearing,
    isMoving: () => m.moving,
    easeTo: vi.fn((o: { bearing: number; duration?: number }) => { m.bearing = o.bearing }),
    touchZoomRotate: { disableRotation: vi.fn(), _touchRotate: null },
  }
  const inert: Record<string, unknown> = {
    project: () => ({ x: 0, y: 0 }),
    unproject: () => ({ lng: 7.555, lat: 47.515 }),
    getCenter: () => ({ lng: 7.555, lat: 47.515 }),
    getZoom: () => 16,
    getCanvas: () => document.createElement('canvas'),
    getCanvasContainer: () => document.createElement('div'),
    getContainer: () => document.createElement('div'),
    isStyleLoaded: () => true,
    getStyle: () => ({ layers: [] }),
  }
  // anything else (`map.keyboard.enable()`, `map.on(…)`, …): callable, its members too, does nothing
  const nothing: unknown = new Proxy(() => undefined, { get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : nothing) })
  return new Proxy(m, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : k in inert ? inert[k as string] : typeof k === 'string' ? nothing : undefined),
  }) as typeof m
}

const touch = (type: string) => ({ type, touches: [] })
const mouse = (type: string) => ({ type, button: 2 })
const key = { type: 'keydown', key: 'ArrowLeft', shiftKey: true }
const view = (bearing: number) => ({ longitude: 7.555, latitude: 47.515, zoom: 16, bearing, pitch: 0, padding: {} })

function mount(bearing: number) {
  render(
    <MapView
      entities={[]} layers={[]} byName={{}} initialCenter={[7.555, 47.515]} preparedOverlays={[]}
      isVisible={() => true} selectedId={null} onSelect={noop} onMapClick={noop}
      drawings={[]} drawingsVisible draft={[]} draftKind={null} draggable={false}
      onMarkerDragStart={noop} onMarkerMove={noop} onMarkerDragEnd={noop} onView={noop}
      freehand={null} onFreehand={noop} drawColor="#000" drawWidth={3} drawDashed={false}
      selectedDrawingId={null} onSelectDrawing={noop} onDelete={noop}
    />,
  )
  const map = fakeMap(bearing)
  const p = () => captured.props as Record<string, (e: unknown) => void>
  act(() => p().onLoad({ target: map }))
  return {
    map,
    /** a turn that began with `start` and came to rest at the map's bearing, ended by `end` */
    turn(start: unknown, end: unknown) {
      act(() => p().onRotateStart({ originalEvent: start, viewState: view(map.bearing) }))
      act(() => p().onMoveEnd({ originalEvent: end, viewState: view(map.bearing) }))
    },
    /** a camera move that ends with no rotate start (a pan, a programmatic ease's own end) */
    rest(end: unknown) { act(() => p().onMoveEnd({ originalEvent: end, viewState: view(map.bearing) })) },
  }
}

beforeEach(() => { captured.props = null })
afterEach(cleanup)

describe('MapView — a hand turn that comes to rest just off north settles on north', () => {
  it('switches MapLibre\'s own (7°, 1 s) bearingSnap off — one rule, not two', () => {
    mount(0)
    expect(captured.props?.bearingSnap).toBe(0)
  })

  it('two fingers let go 3° off north: eases to exactly 0, briefly', () => {
    const { map, turn } = mount(3)
    turn(touch('touchmove'), touch('touchend'))
    expect(map.easeTo).toHaveBeenCalledTimes(1)
    expect(map.easeTo.mock.calls[0][0]).toMatchObject({ bearing: 0 })
    expect(map.easeTo.mock.calls[0][0].duration).toBeLessThanOrEqual(250)
  })

  it('…from the other side too (bearing −4°, i.e. 356°)', () => {
    const { map, turn } = mount(-4)
    turn(touch('touchmove'), touch('touchend'))
    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 0 }))
  })

  it('let go 12° off north: stays where it was let go', () => {
    const { map, turn } = mount(12)
    turn(touch('touchmove'), touch('touchend'))
    expect(map.easeTo).not.toHaveBeenCalled()
  })

  it('the mouse\'s right-drag turn snaps the same way', () => {
    const { map, turn } = mount(2)
    turn(mouse('mousemove'), mouse('mouseup'))
    expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 0 }))
  })

  it('the keyboard\'s turn never snaps', () => {
    const { map, turn } = mount(3)
    turn(key, key)
    expect(map.easeTo).not.toHaveBeenCalled()
  })

  it('a programmatic bearing (compass, saved view, a plan\'s alignment) never snaps', () => {
    const { map, turn } = mount(3)
    turn(undefined, undefined)
    expect(map.easeTo).not.toHaveBeenCalled()
  })

  it('never during the gesture: nothing happens before the camera comes to rest', () => {
    const { map } = mount(3)
    act(() => (captured.props as Record<string, (e: unknown) => void>).onRotateStart({ originalEvent: touch('touchmove'), viewState: view(3) }))
    act(() => (captured.props as Record<string, (e: unknown) => void>).onRotate({ originalEvent: touch('touchmove'), viewState: view(3) }))
    expect(map.easeTo).not.toHaveBeenCalled()
  })

  it('the snap\'s own ease ending does not snap again, and a later pan alone never snaps', () => {
    const { map, turn, rest } = mount(3)
    turn(touch('touchmove'), touch('touchend'))
    rest(undefined) // the snap ease's own moveend
    map.bearing = 4 // e.g. a plan alignment left it there
    rest(touch('touchend')) // then a one-finger pan ends
    expect(map.easeTo).toHaveBeenCalledTimes(1)
  })

  it('a map still moving when the turn ends (a new gesture took over) is left alone', () => {
    const { map, turn } = mount(3)
    map.moving = true
    turn(touch('touchmove'), touch('touchend'))
    expect(map.easeTo).not.toHaveBeenCalled()
  })
})
