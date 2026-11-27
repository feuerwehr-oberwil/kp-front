// @vitest-environment jsdom
/**
 * The repeated marker of a line (—R— Rettungsachse, ▲ Haltelinie) through the real MapView: one
 * DOM marker per glyph, so only the glyphs inside the canvas plus a margin are created
 * (MapView · markerPointsAlong). `<Map>` is a stand-in and the map instance a fake with MapLibre's
 * Web Mercator (512 px tiles) on a 1024 × 768 canvas; the test counts the LineMarkers MapView
 * renders. What rests on the fake: that MapLibre places a Marker where its lng/lat projects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { forwardRef, type ReactNode } from 'react'
import type { Drawing, LngLat } from '../types'
import { markerParamsAlong, markerSpacing, lerpPoint } from '../lib/lineStyle'

type MapProps = Record<string, unknown> & { children?: ReactNode }
const captured: { props: MapProps | null } = { props: null }

vi.mock('react-map-gl/maplibre', () => ({
  default: forwardRef<unknown, MapProps>(function MapStandIn(props, _ref) {
    captured.props = props
    return <div data-testid="map">{props.children as ReactNode}</div>
  }),
  Marker: ({ children, longitude, latitude }: { children?: ReactNode; longitude: number; latitude: number }) =>
    <div data-ll={`${longitude},${latitude}`}>{children}</div>,
  Source: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Layer: () => null,
  useControl: () => null,
  useMap: () => ({ current: undefined }),
}))
vi.mock('./LineMarker', () => ({ LineMarker: () => <i data-line-marker="" /> }))

// maplibre-gl mints its worker URL from a Blob at import time; jsdom has no createObjectURL
window.URL.createObjectURL ??= () => 'blob:test'
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const { MapView } = await import('./MapView')
const noop = () => {}

const W = 1024, H = 768
const LAT0 = 47.515, LNG0 = 7.555
const view = { center: [LNG0, LAT0] as LngLat, zoom: 19 }
const world = () => 512 * 2 ** view.zoom
const mx = (lng: number) => ((lng + 180) / 360) * world()
const my = (lat: number) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * world()
const project = ([lng, lat]: LngLat) => ({ x: mx(lng) - mx(view.center[0]) + W / 2, y: my(lat) - my(view.center[1]) + H / 2 })

/** The map instance after `load`: Web Mercator around `view`, a 1024 × 768 canvas at ratio 1 */
function fakeMap() {
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const m: Record<string, unknown> = {
    project: (c: LngLat | { lng: number; lat: number }) => project(Array.isArray(c) ? c : [c.lng, c.lat]),
    unproject: () => ({ lng: LNG0, lat: LAT0 }),
    getCenter: () => ({ lng: view.center[0], lat: view.center[1] }),
    getZoom: () => view.zoom,
    getBearing: () => 0,
    getPixelRatio: () => 1,
    getCanvas: () => canvas,
    getCanvasContainer: () => document.createElement('div'),
    getContainer: () => document.createElement('div'),
    isStyleLoaded: () => true,
    getStyle: () => ({ layers: [] }),
  }
  const nothing: unknown = new Proxy(() => undefined, { get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : nothing) })
  return new Proxy(m, { get: (t, k) => (k in t ? t[k as string] : typeof k === 'string' ? nothing : undefined) })
}

// 200 m east–west through the centre: 100 m either side (1° lng = 111 320 m × cos lat)
const halfDeg = 100 / (111_320 * Math.cos((LAT0 * Math.PI) / 180))
const haltelinie = (dLat = 0): Drawing => ({
  id: 'h1', kind: 'line', marker: '▲', color: '#e8392b',
  coords: [[LNG0 - halfDeg, LAT0 + dLat], [LNG0 + halfDeg, LAT0 + dLat]],
})

function mount(drawings: Drawing[]) {
  const p = () => captured.props as Record<string, (e: unknown) => void>
  const { container, rerender } = render(<Lage drawings={drawings} />)
  act(() => { p().onLoad({ target: fakeMap() }) })
  /** pan / zoom the fake, then the moveend MapView re-renders on */
  const moveTo = (center: LngLat, zoom: number) => {
    view.center = center; view.zoom = zoom
    act(() => { p().onMoveEnd({ originalEvent: undefined, viewState: { longitude: center[0], latitude: center[1], zoom, bearing: 0, pitch: 0, padding: {} } }) })
  }
  const glyphs = () => [...container.querySelectorAll('[data-line-marker]')].map((el) => el.parentElement!.dataset.ll!)
  return { glyphs, moveTo, rerender }
}
function Lage({ drawings }: { drawings: Drawing[] }) {
  return <MapView
    entities={[]} layers={[]} byName={{}} initialCenter={view.center} preparedOverlays={[]}
    isVisible={() => true} selectedId={null} onSelect={noop} onMapClick={noop}
    drawings={drawings} drawingsVisible draft={[]} draftKind={null} draggable={false}
    onMarkerDragStart={noop} onMarkerMove={noop} onMarkerDragEnd={noop} onView={noop}
    freehand={null} onFreehand={noop} drawColor="#000" drawWidth={3} drawDashed={false}
    selectedDrawingId={null} onSelectDrawing={noop} onDelete={noop}
  />
}

/** every glyph of the whole line at the current zoom, unclipped – the rhythm the Plan draws too */
const fullRhythm = (d: Drawing) => markerParamsAlong(d.coords.map((c) => { const q = project(c); return [q.x, q.y] as [number, number] }), markerSpacing(d.marker))
  .map(({ seg, t }) => { const c = lerpPoint(d.coords[seg], d.coords[seg + 1], t); return `${c[0]},${c[1]}` })

beforeEach(() => { captured.props = null; view.center = [LNG0, LAT0]; view.zoom = 19 })
afterEach(cleanup)

// the clip window: the canvas plus one canvas extent on each side, so 3 × 1024 px across
const WINDOW_GLYPHS = Math.floor((3 * W) / 15) + 1

describe('a Haltelinie\'s ▲ chain on the Karte', () => {
  it('creates only the glyphs inside the canvas and its margin – independent of the line\'s length', () => {
    const { glyphs, moveTo } = mount([haltelinie()])
    // z19: the 200 m (≈ 1 980 px) fit the window, every glyph stays
    expect(glyphs()).toHaveLength(fullRhythm(haltelinie()).length)
    moveTo(view.center, 21)
    expect(fullRhythm(haltelinie()).length).toBeGreaterThan(500) // ≈ 7 900 px of line
    expect(glyphs().length).toBeLessThanOrEqual(WINDOW_GLYPHS)
  })

  it('keeps the rhythm when the window moves: every glyph stands where the whole chain has one', () => {
    const { glyphs, moveTo } = mount([haltelinie()])
    moveTo(view.center, 21)
    const before = glyphs()
    // a pan of 700 px east (0.05 m/px at z21)
    moveTo([LNG0 + 700 * (halfDeg * 2) / 7_900, LAT0], 21)
    const after = glyphs()
    const whole = new Set(fullRhythm(haltelinie()))
    expect(after.every((g) => whole.has(g))).toBe(true)
    // the glyphs both windows hold are the same ground points, not shifted ones
    expect(after.filter((g) => before.includes(g)).length).toBeGreaterThan(WINDOW_GLYPHS / 2)
  })

  it('a line fully off screen creates no glyph', () => {
    const { glyphs, moveTo } = mount([haltelinie()])
    moveTo([LNG0, LAT0 + 0.02], 19) // ≈ 2 200 m north
    expect(glyphs()).toHaveLength(0)
  })
})
