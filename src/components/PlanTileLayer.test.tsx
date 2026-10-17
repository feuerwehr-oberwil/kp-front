// @vitest-environment jsdom
// What the tile layer tells a listening surface (lib/planSharpness, owner review round 3,
// 17.10.2026: «zoomed in quickly, everything is blurry because it's not downloaded yet»): the
// current view's detail tiles are pending → «loading», they land → «sharp», one cannot be had →
// «failed»; and once sharp, the next level over the SAME area is fetched ahead.

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanTileLayer } from './PlanTileLayer'
import { PlanSharpnessContext, resetWarmedTiles, type PlanSharpness } from '../lib/planSharpness'
import type { TileManifest, TileSource } from '../lib/planTiles'

// an A4 landscape in four levels; the underlay is z1 (1024 × 724, 2 × 2 tiles)
const MANIFEST: TileManifest = {
  tileSize: 512,
  complete: true,
  pages: [{
    page: 0, widthPt: 842, heightPt: 595,
    levels: [
      { z: 0, width: 512, height: 362, cols: 1, rows: 1 },
      { z: 1, width: 1024, height: 724, cols: 2, rows: 2 },
      { z: 2, width: 2048, height: 1448, cols: 4, rows: 3 },
      { z: 3, width: 4096, height: 2896, cols: 8, rows: 6 },
    ],
  }],
}
const FIT_W = 400, FIT_H = 400 * (595 / 842)
// each test its own revision: the layer remembers decoded tile URLs for the session
let version = 100
const source = (): TileSource => ({ base: '/api/reference/plan%3Atest', version: ++version, page: null })

function mount(scale: number, prefetchNext = false) {
  const reports: PlanSharpness[] = []
  const src = source()
  const hooks = { report: (s: PlanSharpness) => { reports.push(s) }, prefetchNext }
  const view = render(
    <PlanSharpnessContext.Provider value={hooks}>
      <PlanTileLayer source={src} manifest={MANIFEST} fitW={FIT_W} fitH={FIT_H} scale={scale} pos={{ x: 0, y: 0 }} vw={400} vh={300}
        onAspect={() => {}} onReady={() => {}} onFail={() => {}} />
    </PlanSharpnessContext.Provider>,
  )
  const imgs = (z: number) => Array.from(view.container.querySelectorAll('img')).filter((i) => i.getAttribute('src')!.startsWith(`${src.base}/tiles/${src.version}/0/${z}/`))
  const settle = () => act(() => { vi.advanceTimersByTime(100) })
  const last = () => reports[reports.length - 1]
  return { view, imgs, settle, last, reports, src }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetWarmedTiles()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('PlanTileLayer · sharpness', () => {
  it('says nothing while the underlay is cold, «loading» while the zoomed-in tiles are on their way, «sharp» once they land', () => {
    const t = mount(8)
    t.settle()
    const detail = t.imgs(3)
    expect(detail.length).toBeGreaterThan(0)
    // the reader's own «PDF wird geladen …» covers a cold underlay — no chip on top of it
    expect(t.last()).toBe('sharp')
    act(() => { for (const i of t.imgs(1)) fireEvent.load(i) })
    expect(t.last()).toBe('loading')
    act(() => { for (const i of detail.slice(1)) fireEvent.load(i) })
    expect(t.last()).toBe('loading')
    act(() => { fireEvent.load(detail[0]) })
    expect(t.last()).toBe('sharp')
  })

  it('a detail tile that cannot be had (offline, not stored) leaves the view «failed», not loading forever', () => {
    const t = mount(8)
    t.settle()
    act(() => { for (const i of t.imgs(1)) fireEvent.load(i) })
    const [bad, ...rest] = t.imgs(3)
    act(() => { for (const i of rest) fireEvent.load(i) })
    act(() => { fireEvent.error(bad) })
    expect(t.last()).toBe('failed')
  })

  it('at a zoom the underlay already serves, nothing is pending', () => {
    const t = mount(1)
    t.settle()
    act(() => { for (const i of t.imgs(1)) fireEvent.load(i) })
    expect(t.imgs(2)).toHaveLength(0)
    expect(t.imgs(3)).toHaveLength(0)
    expect(t.last()).toBe('sharp')
  })

  it('goes back to «sharp» when it leaves (the surface must not keep a stale chip)', () => {
    const t = mount(8)
    t.settle()
    act(() => { for (const i of t.imgs(1)) fireEvent.load(i) })
    expect(t.last()).toBe('loading')
    t.view.unmount()
    expect(t.last()).toBe('sharp')
  })

  it('once the view is sharp, fetches the next level over the same area — and only when asked to', () => {
    const off = mount(2, false)
    off.settle()
    expect(fetch).not.toHaveBeenCalled()
    cleanup()

    const t = mount(2, true)
    t.settle()
    // not before the sheet itself is on the glass
    expect(fetch).not.toHaveBeenCalled()
    act(() => { for (const i of t.imgs(1)) fireEvent.load(i) })
    // z1 is the underlay; a 2× zoom of this view would ask for z2 — its tiles over the visible
    // area (2 columns × 3 rows here), not the whole level (4 × 3)
    const asked = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(asked.length).toBe(6)
    expect(asked.every((u) => u.startsWith(`${t.src.base}/tiles/${t.src.version}/0/2/`))).toBe(true)
  })

  it('does not fetch ahead while the current view is still loading', () => {
    const t = mount(4, true)
    t.settle()
    act(() => { for (const i of t.imgs(1)) fireEvent.load(i) })
    const detail = t.imgs(2)
    expect(detail.length).toBeGreaterThan(0)
    expect(fetch).not.toHaveBeenCalled()
    act(() => { for (const i of detail) fireEvent.load(i) })
    const asked = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((u) => u.includes('/0/3/'))).toBe(true)
  })
})
