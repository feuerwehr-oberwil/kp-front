// @vitest-environment jsdom
/**
 * A freehand Linie on the Karte, through the real MapView and its canvas gestures
 * (useMapCanvasGestures). `<Map>` is a stand-in and the map instance a fake with a linear
 * projection: the test fires MapLibre's own `mousedown` / `mousemove` / `mouseup` / `touch*`
 * events at the handlers MapView binds, flushes one animation frame per sample, and reads what
 * the `s-fh` preview `<Source>` is handed and what reaches `onFreehand`. What rests on the stand-in:
 * that react-map-gl hands MapLibre the `data` it gets – the real map's draw is the e2e journeys'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { forwardRef, Profiler, type ReactNode } from 'react'
import type { LngLat } from '../types'

type MapProps = Record<string, unknown> & { children?: ReactNode }
type FeatureCollection = { features: { geometry: { coordinates: LngLat[] } }[] }
const captured: { props: MapProps | null; fh: FeatureCollection | null } = { props: null, fh: null }
const capture = (props: MapProps) => { captured.props = props }
const captureFh = (data: FeatureCollection) => { captured.fh = data }

vi.mock('react-map-gl/maplibre', () => ({
  default: forwardRef<unknown, MapProps>(function MapStandIn(props, _ref) {
    capture(props)
    return <div data-testid="map">{props.children as ReactNode}</div>
  }),
  Marker: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Source: ({ id, data, children }: { id: string; data: FeatureCollection; children?: ReactNode }) => {
    if (id === 's-fh') captureFh(data)
    return <div>{children}</div>
  },
  Layer: () => null,
  useControl: () => null,
  useMap: () => ({ current: undefined }),
}))

// maplibre-gl mints its worker URL from a Blob at import time; jsdom has no createObjectURL
window.URL.createObjectURL ??= () => 'blob:test'
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

const { MapView } = await import('./MapView')
const noop = () => {}

// 1 px = 1e-5° on both axes around the station, y down
const LNG0 = 7.55, LAT0 = 47.52, K = 1e5
const toLL = (x: number, y: number): LngLat => [LNG0 + x / K, LAT0 - y / K]

type Handler = (e: unknown) => void

/** The map instance after `load`: a linear projection and the handlers MapView binds with `on`;
 *  every other call answers inertly. */
function fakeMap() {
  const handlers: Record<string, Handler[]> = {}
  const m: Record<string, unknown> = {
    project: (c: LngLat | { lng: number; lat: number }) => {
      const [lng, lat] = Array.isArray(c) ? c : [c.lng, c.lat]
      return { x: (lng - LNG0) * K, y: (LAT0 - lat) * K }
    },
    unproject: (p: [number, number] | { x: number; y: number }) => {
      const [x, y] = Array.isArray(p) ? p : [p.x, p.y]
      const [lng, lat] = toLL(x, y)
      return { lng, lat }
    },
    on: (type: string, fn: Handler) => { (handlers[type] ??= []).push(fn) },
    off: (type: string, fn: Handler) => { handlers[type] = (handlers[type] ?? []).filter((h) => h !== fn) },
    getCenter: () => ({ lng: LNG0, lat: LAT0 }),
    getZoom: () => 18,
    getBearing: () => 0,
    getCanvas: () => document.createElement('canvas'),
    getCanvasContainer: () => document.createElement('div'),
    getContainer: () => document.createElement('div'),
    isStyleLoaded: () => true,
    getStyle: () => ({ layers: [] }),
  }
  // anything else (`map.dragPan.disable()`, `map.keyboard.enable()`, …): callable, does nothing
  const nothing: unknown = new Proxy(() => undefined, { get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : nothing) })
  const map = new Proxy(m, { get: (t, k) => (k in t ? t[k as string] : typeof k === 'string' ? nothing : undefined) })
  const fire = (type: string, e: unknown) => act(() => { for (const h of handlers[type] ?? []) h(e) })
  return { map, fire }
}

// one animation frame per sample: the queue is flushed by the test, never by a clock
let frames: FrameRequestCallback[] = []
const flushFrame = () => act(() => { const q = frames; frames = []; for (const f of q) f(0) })
beforeEach(() => {
  captured.props = null; captured.fh = null; frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((f) => { frames.push(f); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount() {
  const onFreehand = vi.fn<(coords: LngLat[]) => void>()
  const n = { commits: 0 }
  render(
    <Profiler id="map" onRender={() => { n.commits++ }}>
      <MapView
        entities={[]} layers={[]} byName={{}} initialCenter={[LNG0, LAT0]} preparedOverlays={[]}
        isVisible={() => true} selectedId={null} onSelect={noop} onMapClick={noop}
        drawings={[]} drawingsVisible draft={[]} draftKind={null} draggable={false}
        onMarkerDragStart={noop} onMarkerMove={noop} onMarkerDragEnd={noop} onView={noop}
        freehand="line" onFreehand={onFreehand} drawColor="#e8392b" drawWidth={4} drawDashed={false}
        selectedDrawingId={null} onSelectDrawing={noop} onDelete={noop}
      />
    </Profiler>,
  )
  const { map, fire } = fakeMap()
  act(() => { (captured.props as Record<string, Handler>).onLoad({ target: map }) })
  flushFrame()
  return { fire, onFreehand, n }
}

/** 40 samples after the press, zigzagging 20 px – far over the thinning tolerance, so the
 *  committed line keeps every one of them */
const SAMPLES: [number, number][] = Array.from({ length: 41 }, (_, i) => [100 + i * 10, 300 + (i % 2) * 20])
const mouse = (x: number, y: number) => {
  const [lng, lat] = toLL(x, y)
  return { lngLat: { lng, lat }, point: { x, y }, originalEvent: { type: 'mousemove' } }
}

describe('a freehand Linie on the Karte', () => {
  // The preview renders MapView once per frame (useMapCanvasGestures · fhPath); the draft
  // magnet no longer adds a render per sample on top (lib/useDraftMagnet · sameShown).
  it('renders MapView once per frame for a 40-sample stroke with no snap target near – not once more per sample', () => {
    const { fire, n } = mount()
    n.commits = 0
    fire('mousedown', mouse(...SAMPLES[0]))
    for (const p of SAMPLES.slice(1)) { fire('mousemove', mouse(...p)); flushFrame() }
    const during = n.commits
    fire('mouseup', mouse(...SAMPLES[40]))
    // 40 frames, the press, and the magnet once (leaving the start radius ends its claim)
    expect(during).toBeLessThanOrEqual(42)
  })

  it('commits every sample, and the preview holds the stroke while it is drawn', () => {
    const { fire, onFreehand } = mount()
    fire('mousedown', mouse(...SAMPLES[0]))
    for (const p of SAMPLES.slice(1, 21)) { fire('mousemove', mouse(...p)); flushFrame() }
    expect(captured.fh?.features[0].geometry.coordinates).toEqual(SAMPLES.slice(0, 21).map(([x, y]) => toLL(x, y)))
    for (const p of SAMPLES.slice(21)) { fire('mousemove', mouse(...p)); flushFrame() }
    fire('mouseup', mouse(...SAMPLES[40]))
    expect(onFreehand).toHaveBeenCalledTimes(1)
    expect(onFreehand.mock.calls[0][0]).toEqual(SAMPLES.map(([x, y]) => toLL(x, y)))
    // the release empties the preview: nothing stale under the committed line
    expect(captured.fh?.features).toEqual([])
  })

  it('a second finger cancels the stroke and leaves no preview behind', () => {
    const { fire, onFreehand } = mount()
    const t = (x: number, y: number, touches: number) => ({ ...mouse(x, y), originalEvent: { type: 'touchmove', touches: Array.from({ length: touches }) } })
    fire('touchstart', t(...SAMPLES[0], 1))
    for (const p of SAMPLES.slice(1, 10)) { fire('touchmove', t(...p, 1)); flushFrame() }
    expect(captured.fh?.features).toHaveLength(1)
    fire('touchmove', t(...SAMPLES[10], 2))
    flushFrame()
    expect(captured.fh?.features).toEqual([])
    fire('touchend', t(...SAMPLES[10], 0))
    expect(onFreehand).not.toHaveBeenCalled()
  })
})
